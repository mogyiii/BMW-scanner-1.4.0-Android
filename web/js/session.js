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

/** Reads one DS2 module: identity, then its fault memory. */
async function readDs2Module(ftdi, mod, onTrace) {
  const session = await connect(ftdi, mod.addr, onTrace);
  if (!session) return { ...mod, present: false, reason: 'nincs kapcsolat' };

  const ident = P.splitReply(await session.send(P.buildFrame(P.CMD.QUERY, mod.addr), '0x46F1'));
  if (!ident || !P.isPositive(ident.answer)) {
    return { ...mod, present: false, reason: 'nem válaszolt' };
  }

  // Page 0 carries the count and page 1 the entries; every page after that repeats page 1.
  const counts = P.splitReply(await session.send(P.buildFrame(P.CMD.FAULTS, mod.addr, [0]), '0xC731'));
  let faults = { count: 0, entries: [] };
  if (counts && P.isPositive(counts.answer) && counts.answer[3] > 0) {
    const page = P.splitReply(await session.send(P.buildFrame(P.CMD.FAULTS, mod.addr, [1]), '0xC731'));
    if (page && P.isPositive(page.answer)) faults = P.decodeFaults(page.answer);
    else faults = { count: counts.answer[3], entries: [] };
  }
  return { ...mod, present: true, ident: ident.answer, faults };
}

/**
 * Reads the engine controller, which ignores DS2.
 *
 * Its replies are KWP2000: `[format][target][source][service][data][additive checksum]`, with the
 * request echoed first as always. A positive answer to `18 02 FF FF` opens `58 <count>` and then
 * three bytes per code.
 */
async function readKwpModule(ftdi, mod, onTrace) {
  const session = await connect(ftdi, mod.addr, onTrace);
  if (!session) return { ...mod, present: false, reason: 'nincs kapcsolat' };

  await session.send(P.buildFrame(P.CMD.QUERY, mod.addr), '0x46F1');  // for the record; DS2 gets nothing
  const ident = await session.send(P.buildFrame(P.CMD.KWP_IDENT, mod.addr), '0x06F3');
  if (ident.length < 8) return { ...mod, present: false, reason: 'nem válaszolt' };

  const vinReply = await session.send(P.buildFrame(P.CMD.KWP_VIN, mod.addr), '0x0DE7');
  let vin = '';
  let run = '';
  for (const b of vinReply) {
    if (b >= 0x30 && b <= 0x5a) run += String.fromCharCode(b);
    else { if (run.length >= 5) vin = run; run = ''; }
  }
  if (!vin && run.length >= 5) vin = run;

  const dtcReply = await session.send(P.buildFrame(P.CMD.KWP_DTC, mod.addr), '0xC358');
  const at = dtcReply.indexOf(0x58);
  const entries = [];
  if (at >= 0 && at + 1 < dtcReply.length) {
    const count = dtcReply[at + 1];
    for (let i = at + 2; i + 2 < dtcReply.length && entries.length < count; i += 3) {
      entries.push({
        code: (dtcReply[i] << 8) | dtcReply[i + 1],
        param: dtcReply[i + 2],
        raw: dtcReply.slice(i, i + 3),
        wide: true,
      });
    }
  }
  return { ...mod, present: true, ident, vin, faults: { count: entries.length, entries } };
}

/** Walks every module, reporting each as it finishes so the tiles can fill in as it goes. */
export async function scan(ftdi, { onModule, onTrace, shouldStop } = {}) {
  const results = [];
  for (const mod of P.MODULES) {
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
