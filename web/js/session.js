/**
 * One conversation with one module, and the scan that repeats it.
 *
 * The order below is not a design; it is what the vendor's software does, recorded off the wire and
 * then matched byte for byte. Two parts of it cost this project weeks and are worth stating plainly
 * at the point of use:
 *
 *  - **The connection is rebuilt for every address.** Reusing one connection works for two or three
 *    frames and then quietly rots, which looked for a long time like a protocol fault.
 *  - **The line moves to 9600 8E1 after `0x83F0` and never moves back**, and that command's own
 *    reply is read at 19200 before the move.
 */

import { PARITY } from './ftdi.js';
import * as P from './protocol.js';

/** Opens a session on one address, leaving the line at 9600 8E1 and ready for queries. */
async function connect(ftdi, addr, onTrace) {
  await ftdi.setBaudRate(19200);
  await ftdi.setLineProperties(8, PARITY.NONE);
  await ftdi.purge();

  await ftdi.setDtr(true);
  await new Promise((r) => setTimeout(r, 150));
  await ftdi.setDtr(false);

  const announcement = await ftdi.readExactly(P.ANNOUNCE_LEN, 1500);
  const decoded = P.decodeAnnouncement(announcement);
  if (!decoded) return null;
  if (!P.matchesRecordedCable(announcement)) {
    throw new Error(
      'A kábel máshogy jelentkezett be, mint amire a rögzített válaszunk szól. ' +
      'Nem küldök olyan választ, ami egy másik kihívásra készült.');
  }

  let key = decoded.key;
  const send = async (frame, label, quietMs = 800) => {
    await ftdi.purge();
    const { wire, nextKey } = P.scramble(frame, key);
    key = nextKey;
    await ftdi.write(wire);
    const reply = await ftdi.readUntilQuiet(quietMs, 3000);
    if (onTrace) onTrace(label, reply);
    return reply;
  };

  await send(P.SIGN_ON_FRAME, '0xA77A');
  await send(P.buildFrame(P.CMD.OPEN, addr, [0x01]), '0xB318');
  await send(P.buildFrame(P.CMD.TIMING, addr, P.TIMING_PAYLOAD), '0x83F0');

  // From here on, everything is 9600 8E1.
  await ftdi.setBaudRate(9600);
  await ftdi.setLineProperties(8, PARITY.EVEN);

  return { send };
}

/**
 * Reads a paged DS2 fault memory.
 *
 * Page 0 carries the count and page 1 every entry, so two reads are enough. Later pages do exist -
 * the climate module's page 2 returns its second fault on its own - but they are a different view of
 * what page 1 already gave in full, which is why this does not walk them. `0xC731` is the live fault
 * memory and `0x9E56` the shadow memory: the same structure, the same paging, a different store.
 */
async function readFaultStore(session, mod, command, label) {
  const counts = P.splitReply(await session.send(P.buildFrame(command, mod.addr, [0]), label));
  if (!counts || !counts.answer) return null;
  if (!P.isPositive(counts.answer)) {
    // `A2` is a refusal with a reason rather than a module that has no such store. The airbag
    // module gives it for the shadow memory until it is unlocked, and reporting that as "no shadow
    // store" would quietly hide a fault the vendor's software can see.
    return counts.answer[2] === 0xa2 ? { locked: true } : null;
  }
  if (counts.answer[3] === 0) return { count: 0, entries: [] };
  const page = P.splitReply(await session.send(P.buildFrame(command, mod.addr, [1]), label));
  if (page && P.isPositive(page.answer)) return P.decodeFaults(page.answer);
  return { count: counts.answer[3], entries: [] };
}

/**
 * Reads one DS2 module: identity, the assembly-release bytes, then both fault stores.
 *
 * The shadow memory is read because the vendor's report has a second error column for it and this
 * car has something in there - the SRS shows `no errors / 1 error`, a side-airbag fault that a
 * live-memory-only reading declares a clean module. Three modules answer `0x9E56`; the rest refuse
 * it, and a refusal is simply recorded as having no shadow store.
 */
async function readDs2Module(ftdi, mod, onTrace) {
  const session = await connect(ftdi, mod.addr, onTrace);
  if (!session) return { ...mod, present: false, reason: 'nincs kapcsolat' };

  const ident = P.splitReply(await session.send(P.buildFrame(P.CMD.QUERY, mod.addr), '0x46F1'));
  if (!ident || !P.isPositive(ident.answer)) {
    return { ...mod, present: false, reason: 'nem válaszolt' };
  }

  const adfgReply = P.splitReply(await session.send(P.buildFrame(P.CMD.ADFG, mod.addr), '0x71A0'));
  const adfg = adfgReply && P.isPositive(adfgReply.answer)
    ? adfgReply.answer.slice(3, -1) : null;

  // `null` means the store did not answer, which is **not** the same as answering zero. The first
  // on-car run of this app reported the lighting module as having no faults when its fault read had
  // in fact produced nothing at all - the old code collapsed both cases to a count of zero, so a
  // failed read was displayed as a clean module. Both are passed through as they are from here on.
  const faults = await readFaultStore(session, mod, P.CMD.FAULTS, '0xC731');
  const shadow = await readFaultStore(session, mod, P.CMD.SHADOW, '0x9E56');

  // Two modules carry something the header wants. The cluster knows the mileage and its own stored
  // VIN; the immobiliser is told the engine speed, which is the only live value this app reads and
  // is not where anyone would look for it.
  let mileage = null;
  let vin = '';
  let live = null;
  if (mod.addr === 0x80) {
    const km = P.splitReply(await session.send(P.buildFrame(P.CMD.MILEAGE, mod.addr), '0x8DE3'));
    if (km) mileage = P.decodeMileage(km.answer);
    const v = P.splitReply(await session.send(P.buildFrame(P.CMD.IKE_VIN, mod.addr), '0xC6E1'));
    if (v) vin = P.decodeIkeVin(v.answer);
  }
  if (mod.addr === 0x44) {
    const s = P.splitReply(await session.send(P.buildFrame(P.CMD.EWS_LIVE, mod.addr), '0x5132'));
    if (s) live = P.decodeEwsLive(s.answer);
  }

  return { ...mod, present: true, ident: ident.answer, adfg, faults, shadow, mileage, vin, live };
}

/**
 * Reads a module that ignores DS2 - the engine controller and the ABS.
 *
 * The order is the capture's: the DS2 identify that gets no answer, then identification, VIN and the
 * fault memory over KWP. The dead `0x46F1` is sent because the vendor sends it and this project has
 * been bitten more than once by trimming a step that looked pointless. The vendor also sometimes
 * opens a diagnostic session first (`0x8378`, KWP `10 87`), but its very first pass at the ABS omits
 * that and still reads all four faults, so that one is genuinely optional and stays out.
 */
async function readKwpModule(ftdi, mod, onTrace) {
  const session = await connect(ftdi, mod.addr, onTrace);
  if (!session) return { ...mod, present: false, reason: 'nincs kapcsolat' };

  await session.send(P.buildFrame(P.CMD.QUERY, mod.addr), '0x46F1');
  const identReply = await session.send(P.buildFrame(P.CMD.KWP_IDENT, mod.addr), '0x06F3');
  const identFrames = P.splitKwpReply(identReply);
  if (!identFrames.answer) return { ...mod, present: false, reason: 'nem válaszolt' };

  const vinReply = P.splitKwpReply(await session.send(P.buildFrame(P.CMD.KWP_VIN, mod.addr), '0x0DE7'));
  let vin = '';
  if (vinReply.answer && vinReply.answer.data[0] === 0x5a) {
    for (const b of vinReply.answer.data.slice(2)) {
      if (b >= 0x30 && b <= 0x5a) vin += String.fromCharCode(b);
    }
  }

  // As on the DS2 side: no answer is reported as no answer, never as zero faults.
  const dtc = P.splitKwpReply(await session.send(P.buildFrame(P.CMD.KWP_DTC, mod.addr), '0xC358'));
  const faults = dtc.answer ? P.decodeKwpFaults(dtc.answer.data) : null;

  return { ...mod, present: true, ident: identFrames.answer.data, vin, faults, shadow: null };
}

/**
 * Clears one module's fault memory.
 *
 * In scope and nothing beyond it: `05` on DS2 and `14 FF FF` on KWP erase the stored list and
 * nothing else. The capture shows both outcomes plainly, and the caller is told which it got rather
 * than being left to assume success - the ABS refused the command outright with `7F 14 22`
 * ("conditions not correct"), and the engine controller accepted it and then reported the same
 * fault again on the next read, because that fault is live rather than merely stored.
 */
export async function clearFaults(ftdi, mod, onTrace) {
  const session = await connect(ftdi, mod.addr, onTrace);
  if (!session) return { ok: false, reason: 'nincs kapcsolat' };

  if (mod.kwp) {
    const reply = P.splitKwpReply(
      await session.send(P.buildFrame(P.CMD.KWP_CLEAR, mod.addr), '0x41AC'));
    if (!reply.answer) return { ok: false, reason: 'nem válaszolt' };
    const d = reply.answer.data;
    if (d[0] === 0x54) return { ok: true };
    if (d[0] === 0x7f) {
      return { ok: false, reason: d[2] === 0x22
        ? 'a vezérlő elutasította — a körülmények nem megfelelők (gyújtás 2-es állásban, motor leállítva)'
        : `a vezérlő elutasította (0x${d[2].toString(16).toUpperCase()})` };
    }
    return { ok: false, reason: 'értelmezhetetlen válasz' };
  }

  const reply = P.splitReply(await session.send(P.buildFrame(P.CMD.CLEAR, mod.addr), '0x1BCF'));
  if (!reply || !reply.answer) return { ok: false, reason: 'nem válaszolt' };
  if (P.isPositive(reply.answer)) return { ok: true };
  return { ok: false, reason: `a vezérlő elutasította (0x${reply.answer[2].toString(16).toUpperCase()})` };
}

/**
 * Unlocks a module's shadow memory and reads it, on the owner's explicit instruction.
 *
 * Never called by a scan. The two commands it sends are described in `protocol.js`; the short
 * version is that one of them is on the project's do-not-send list, because when it went on that
 * list nobody knew what it did, and what is known now is suggestive rather than conclusive. So it
 * is behind a button, it is named in the trace, and nothing else in the app reaches it.
 */
export async function unlockShadow(ftdi, mod, onTrace) {
  const session = await connect(ftdi, mod.addr, onTrace);
  if (!session) return { ok: false, reason: 'nincs kapcsolat' };

  const ident = P.splitReply(await session.send(P.buildFrame(P.CMD.QUERY, mod.addr), '0x46F1'));
  if (!ident || !P.isPositive(ident.answer)) return { ok: false, reason: 'nem válaszolt' };

  const arg = P.shadowUnlockArgument(ident.answer);
  if (!arg) return { ok: false, reason: 'az azonosító túl rövid a feloldáshoz' };

  await session.send(P.buildFrame(P.SHADOW_UNLOCK.PRIME, mod.addr, [0xff, 0xff]), '0x44DB');
  const grant = P.splitReply(
    await session.send(P.buildFrame(P.SHADOW_UNLOCK.GRANT, mod.addr, arg), '0xC751'));
  if (!grant || !P.isPositive(grant.answer)) {
    return { ok: false, reason: 'a vezérlő nem fogadta el a feloldást' };
  }

  const shadow = await readFaultStore(session, mod, P.CMD.SHADOW, '0x9E56');
  if (!shadow || shadow.locked) return { ok: false, reason: 'a feloldás után is zárolt' };
  return { ok: true, shadow };
}

/**
 * Looks for modules at addresses this software does not know about.
 *
 * The vendor probes fifty-seven addresses and this car answers on nine; another car will answer on
 * a different set. Anything that identifies itself from an address not in `MODULES` is a module
 * somebody else's car has, and its identity bytes are exactly what would be needed to add it. So
 * the sweep collects them and hands them over verbatim rather than trying to guess what they are.
 *
 * **Both protocols are tried at every address**, and the first version did not. It sent the DS2
 * identify only — which on this very car is the one thing the engine controller and the ABS do not
 * answer. A KWP-only module sitting at an address we have no tile for would have been swept past in
 * silence, which is the exact failure the sweep exists to prevent.
 *
 * It is a separate action because it is slow: every address needs its own connection.
 */
export async function findUnknown(ftdi, { onProgress, onTrace, shouldStop } = {}) {
  const known = new Set(P.MODULES.map((m) => m.addr));
  const todo = P.PROBE_ADDRESSES.filter((a) => !known.has(a));
  const found = [];

  for (let i = 0; i < todo.length; i++) {
    if (shouldStop && shouldStop()) break;
    const addr = todo[i];
    const hex = addr.toString(16).toUpperCase().padStart(2, '0');
    if (onProgress) onProgress({ done: i, total: todo.length, addr, found: found.length });
    try {
      const session = await connect(ftdi, addr, onTrace);
      if (!session) continue;

      const ds2 = P.splitReply(await session.send(P.buildFrame(P.CMD.QUERY, addr), `0x46F1 @${hex}`));
      if (ds2 && P.isPositive(ds2.answer)) {
        found.push({ addr, kwp: false, ident: ds2.answer, id: P.decodeIdent({ ident: ds2.answer }) });
        continue;
      }

      const kwp = P.splitKwpReply(
        await session.send(P.buildFrame(P.CMD.KWP_IDENT, addr), `0x06F3 @${hex}`));
      if (kwp.answer && kwp.answer.data.length > 1) {
        found.push({
          addr, kwp: true, ident: kwp.answer.data,
          id: P.decodeIdent({ ident: kwp.answer.data, kwp: true }),
        });
      }
    } catch (e) { /* one dead address must not end the sweep */ }
  }
  if (onProgress) onProgress({ done: todo.length, total: todo.length, found: found.length });
  return found;
}

/**
 * Walks every module, reporting each as it finishes so the tiles can fill in as it goes.
 *
 * `only` narrows it to a list of addresses, which is how a single module gets re-read after a clear.
 */
export async function scan(ftdi, { onModule, onTrace, shouldStop, only } = {}) {
  const results = [];
  for (const mod of P.MODULES) {
    if (only && !only.includes(mod.addr)) continue;
    if (shouldStop && shouldStop()) break;
    if (onModule) onModule({ ...mod, busy: true });
    let result;
    try {
      result = mod.kwp
        ? await readKwpModule(ftdi, mod, onTrace)
        : await readDs2Module(ftdi, mod, onTrace);
    } catch (e) {
      result = { ...mod, present: false, reason: e.message };
    }
    results.push(result);
    if (onModule) onModule(result);
  }
  return results;
}

/**
 * Checks the K-line's idle level before a scan.
 *
 * The cable runs off OBD pin 16 and works whether or not the ignition is on, but the K-line is
 * pulled up by the control modules and those are on the ignition-switched supply. A floating line
 * means they are asleep, and asleep modules look exactly like a protocol fault - a confusion that
 * cost this project two runs and an hour before anyone thought to measure it.
 */
export async function idleLevel(ftdi) {
  let high = 0;
  const total = 60;
  for (let i = 0; i < total; i++) {
    const r = await ftdi.device.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request: 0x0c, value: 0, index: 0 }, 1);
    if (r.data && r.data.byteLength && (r.data.getUint8(0) & 0x02)) high++;
  }
  return Math.round((high * 100) / total);
}
