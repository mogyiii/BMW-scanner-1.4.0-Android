/**
 * The cable's protocol, ported from the Android app's `VendorProtocol` and `VendorTransaction`.
 *
 * All of it was recovered from the vendor's own executable and its traffic, and every value here is
 * either read out of that binary or measured on the car. Nothing is guessed; where something is a
 * reading rather than a fact, the comment says so.
 *
 * The exchange:
 *
 *   DTR pulse
 *     <- 27-byte announcement; XOR zero, identity "V144Bn9", first byte is the scrambling key
 *     -> 0xA77A  the challenge response
 *     -> 0xB318  open the connection
 *     -> 0x83F0  K-line timing for this module
 *     -- the line moves to 9600 8E1 and stays there
 *     -> 0x46F1  identify       (DS2 service 00)
 *     -> 0xC731  fault memory   (DS2 service 04)
 *
 * Frames are `[len][cmd hi][cmd lo][param][payload][additive checksum]`, where `len` counts
 * everything but itself and the checksum. Every byte out is XORed with a key that starts as the
 * announcement's first byte and advances 0x4B per byte, never reset within a session.
 */

export const KEY_STEP = 0x4b;
export const ANNOUNCE_LEN = 27;
export const IDENTITY = 'V144Bn9';

export const CMD = {
  SIGN_ON: 0xa77a,   // parameter 'V', payload = the identity and twenty-five computed bytes
  OPEN:    0xb318,   // parameter = address, payload 01
  TIMING:  0x83f0,   // parameter = address, payload E5 50 47 66 <Delay2> <Delay>
  QUERY:   0x46f1,   // DS2 00  - identify
  FAULTS:  0xc731,   // DS2 04  - fault memory, payload is the page
  SHADOW:  0x9e56,   // DS2 14  - shadow fault memory, paged exactly like 04
  MILEAGE: 0x8de3,   // DS2 02 01 - the odometer, on the instrument cluster
  IKE_VIN: 0xc6e1,   // DS2 02 02 - the cluster's stored VIN
  EWS_LIVE: 0x5132,  // DS2 6B    - the immobiliser's status block, which carries engine speed
  ADFG:    0x71a0,   // DS2 0E  - the three assembly-release bytes
  CLEAR:   0x1bcf,   // DS2 05  - clear fault memory
  // The engine controller and the ABS are not DS2 modules; these map to KWP2000 services.
  KWP_IDENT: 0x06f3, // KWP 1A 80
  KWP_VIN:   0x0de7, // KWP 1A 90
  KWP_DTC:   0xc358, // KWP 18 02 FF FF
  KWP_CLEAR: 0x41ac, // KWP 14 FF FF
};

/**
 * The sign-on frame the vendor software produced for **this** cable.
 *
 * Replayable only because it answers this cable's own announcement; a response computed for a
 * different challenge would be bytes nobody has observed. `matchesRecordedCable` exists so callers
 * check rather than assume.
 */
export const SIGN_ON_FRAME = Uint8Array.from([
  0x22, 0xa7, 0x7a, 0x56, 0x31, 0x34, 0x34, 0x42, 0x6e, 0x39, 0x9d, 0x3e, 0xaf, 0x2e, 0xa9, 0x45,
  0x78, 0x80, 0xb7, 0xaa, 0xf6, 0xa9, 0xfc, 0x9f, 0xee, 0xd2, 0x7c, 0x59, 0x90, 0x79, 0x80, 0x59,
  0x84, 0x88, 0x03, 0xda,
]);

/** The 27 announcement bytes the sign-on frame answers, exactly as recorded. */
export const RECORDED_ANNOUNCEMENT = Uint8Array.from([
  0x9b, 0xcd, 0xaa, 0xaf, 0xaf, 0xd9, 0xf5, 0xa2, 0x9b, 0x17, 0x28, 0xfe, 0x72, 0xd1,
  0x17, 0x4c, 0x5e, 0x80, 0x38, 0x09, 0xed, 0x2e, 0xb5, 0xcf, 0xaa, 0x07, 0x2b,
]);

export const TIMING_PAYLOAD = Uint8Array.from([0xe5, 0x50, 0x47, 0x66, 0x28, 0x14]);

export function matchesRecordedCable(announcement) {
  if (announcement.length !== RECORDED_ANNOUNCEMENT.length) return false;
  return RECORDED_ANNOUNCEMENT.every((b, i) => announcement[i] === b);
}

/** True when the announcement checksums and carries the expected identity. */
export function decodeAnnouncement(raw) {
  if (raw.length !== ANNOUNCE_LEN) return null;
  let x = 0;
  for (const b of raw) x ^= b;
  if (x !== 0) return null;
  const key = raw[0];
  let identity = '';
  for (let i = 1; i <= 7; i++) identity += String.fromCharCode(raw[i] ^ key);
  return { key, identity };
}

export function buildFrame(command, parameter, payload = []) {
  const frame = new Uint8Array(payload.length + 5);
  frame[0] = frame.length - 2;
  frame[1] = (command >> 8) & 0xff;
  frame[2] = command & 0xff;
  frame[3] = parameter & 0xff;
  frame.set(payload, 4);
  let sum = 0;
  for (let i = 0; i < frame.length - 1; i++) sum = (sum + frame[i]) & 0xff;
  frame[frame.length - 1] = sum;
  return frame;
}

/** XORs with the rolling key and returns the bytes plus the key the next byte would use. */
export function scramble(data, startKey) {
  let key = startKey & 0xff;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ key;
    key = (key + KEY_STEP) & 0xff;
  }
  return { wire: out, nextKey: key };
}

/**
 * Splits a reply into the request the K-line echoed back and the module's own answer.
 *
 * Both are DS2 frames end to end. The first is ours coming home, because a single-wire bus lets a
 * transmitter hear itself - an echo this project once recorded as a loopback defect.
 */
export function splitReply(raw, addr) {
  if (raw.length < 4) return null;
  const echoLen = raw[1];
  if (echoLen < 3 || echoLen > raw.length) return null;
  const echo = raw.slice(0, echoLen);
  if (echoLen === raw.length) return { echo, answer: null };
  const rest = raw.slice(echoLen);
  if (rest.length < 3) return { echo, answer: null };
  const n = rest[1];
  if (n < 3 || n > rest.length) return { echo, answer: null };
  // A DS2 frame opens with the address it came from. Checking it matters because a slow module's
  // reply can land inside the next command's read window - see `splitKwpReply` for the day that
  // cost us two modules that do not exist.
  if (addr !== undefined && rest[0] !== addr) return { echo, answer: null, strayFrom: rest[0] };
  return { echo, answer: rest.slice(0, n) };
}

/** DS2's positive acknowledgement sits at index 2. */
export const isPositive = (frame) => frame && frame.length > 2 && frame[2] === 0xa0;

/**
 * Splits a KWP2000 reply the same way, into our echoed request and the module's answer.
 *
 * The framing is `[B8][target][source][len][data…][checksum]`, where `len` counts only the data and
 * **the checksum is an XOR, not the additive sum ISO 14230 specifies**. Checked on the full capture:
 * `B8^29^F1^02^1A^86 = FE`, which is the byte on the wire. Until this was measured the KWP replies
 * were located by searching for a `0x58` byte and hoping, which worked on the engine controller by
 * luck and would have mis-split anything carrying a `0x58` in its data.
 */
export function splitKwpReply(raw, addr) {
  const frames = [];
  let i = 0;
  while (i + 5 <= raw.length) {
    if (raw[i] !== 0xb8) break;
    const len = raw[i + 3];
    const total = len + 5;
    if (i + total > raw.length) break;
    const frame = raw.slice(i, i + total);
    let x = 0;
    for (const b of frame) x ^= b;
    if (x !== 0) break;
    frames.push({ target: frame[1], source: frame[2], data: frame.slice(4, -1) });
    i += total;
  }
  // Ours comes home first; the module's answer is addressed to the tester, 0xF1.
  //
  // **And it has to have come from the module we asked.** Without that check the sweep reported
  // two modules this car does not have, at 0x33 and 0x6A, both carrying the engine controller's
  // identity byte for byte: the engine controller had answered an earlier request late, and its
  // reply landed inside the read window for an address that answers nothing at all. A reply is
  // only an answer if the right module sent it.
  const reply = frames.find((f) => f.target === 0xf1);
  if (reply && addr !== undefined && reply.source !== addr) {
    return { echo: frames[0] || null, answer: null, strayFrom: reply.source, frames };
  }
  return { echo: frames[0] || null, answer: reply || null, frames };
}

/**
 * Decodes a KWP `58` response: a count, then three bytes per code.
 *
 * Verified against the vendor's own decoded report for this car - the ABS answers
 * `58 04 5E 1F A0 5E 16 20 5E 24 A0 5E 43 A0`, which it prints as four faults
 * `5E1F/A0`, `5E16/20`, `5E24/A0`, `5E43/A0`.
 */
export function decodeKwpFaults(data) {
  if (!data || data.length < 2 || data[0] !== 0x58) return { count: 0, entries: [] };
  const count = data[1];
  const entries = [];
  for (let i = 2; i + 2 < data.length + 1 && entries.length < count; i += 3) {
    if (i + 3 > data.length) break;
    entries.push({
      code: (data[i] << 8) | data[i + 1],
      param: data[i + 2],
      raw: data.slice(i, i + 3),
      wide: true,
    });
  }
  return { count, entries };
}

/**
 * Splits a fault-memory frame into its entries.
 *
 * The entry size is **not fixed** - it varies by module, so dividing by a constant mangles half of
 * them. Measured against the vendor's own decoded output for this car: `0x57` uses three bytes per
 * entry, `0x5B` ten, `0x80` fourteen. The size is the data length over the count with trailing zero
 * padding stripped first, because `0x57` pads six zeros past its three entries.
 *
 * Within an entry the code is the first byte and the parameter is the first non-zero byte after it:
 * `0B 00 AF` gives `0B/AF`, `1C 44 …` gives `1C/44`. **That rule is fitted to three modules and no
 * more**, which is why every entry keeps its raw bytes.
 */
export function decodeFaults(frame) {
  if (!frame || frame.length < 5) return { count: 0, entries: [] };
  const count = frame[3];
  if (count === 0) return { count: 0, entries: [] };

  let end = frame.length - 1;
  while (end > 4 && frame[end - 1] === 0) end--;
  const data = frame.slice(4, end);
  if (!data.length) return { count, entries: [] };

  const size = Math.floor(data.length / count);
  if (size < 2) return { count, entries: [] };

  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = data.slice(i * size, (i + 1) * size);
    if (e.length < size) break;
    let p = 1;
    while (p < e.length && e[p] === 0) p++;
    entries.push({ code: e[0], param: p < e.length ? e[p] : null, raw: e });
  }
  return { count, entries };
}

/**
 * The modules this car has, as the vendor's own scan found them.
 *
 * `kwp` marks the ones that ignore DS2 - the engine controller and the ABS, which the vendor's
 * report flags with an asterisk for the same reason. The engine controller answers `0x46F1` with
 * nothing but the echoed request and speaks KWP2000 instead.
 *
 * `0x1B` is the Valvetronic controller, and this project did not read it for a fortnight. It is not
 * in the vendor's DS2 probe list at all — only in its much shorter KWP one — so every sweep we ran
 * walked straight past it. It answers `5A 80 00 00 07 51 62 07 10 …`, which is part number
 * **7.516.207** and hardware `10`: the vendor's own `VTC1 · SKV20 - VVT Bank 1` row exactly. It was
 * found by following up a request to add one unrelated address for curiosity's sake.
 *
 * The ABS is at **0x29**, not 0x56. This project listed it at 0x56 for weeks and never got a reply,
 * because 0x56 was never an address at all: it is the letter `V`, the sign-on command's parameter,
 * read out of a command tally as though it were a module. The full capture shows `18 02 FF FF`
 * going to exactly two addresses, 0x12 and 0x29.
 *
 * `icon` is the id of an SVG `<symbol>` in `index.html`, not a character. Emoji were used at first
 * and look like filler; a symbol id means a pictogram can be replaced by editing one `<symbol>`
 * without touching any code.
 *
 * The human-readable label is not here. It is a translated string keyed on `icon` in `i18n.js`,
 * because the module abbreviations are the same in every language and their descriptions are not.
 */
export const MODULES = [
  { addr: 0x00, name: 'ZKE',   icon: 'zke' },
  { addr: 0x12, name: 'DME',   icon: 'dme',  kwp: true },
  { addr: 0x1b, name: 'VTC1',  icon: 'vtc',  kwp: true },
  { addr: 0x29, name: 'ABS',   icon: 'abs',  kwp: true },
  { addr: 0x44, name: 'EWS',   icon: 'ews' },
  { addr: 0x57, name: 'LEW',   icon: 'lew' },
  { addr: 0x5b, name: 'IHKA',  icon: 'ihka' },
  { addr: 0x80, name: 'IKE',   icon: 'ike' },
  { addr: 0xa4, name: 'SRS',   icon: 'srs' },
  { addr: 0xd0, name: 'LCM',   icon: 'lcm' },
];

/**
 * Every address the vendor's software probes, in its order.
 *
 * The vendor actually keeps two lists: fifty-six addresses it asks with the DS2 identify, and eight
 * it asks with the KWP one. Six of the KWP addresses are in neither of the first list nor anywhere
 * else — `13 18 1B 1E 29 34` — and until this was checked the sweep did not know about four of
 * them. They are merged here, because our sweep tries both protocols at every address and so does
 * not need the vendor's division.
 *
 * The rest are modules other cars have and this one does not — a gearbox controller, a navigation
 * unit, a telephone, and so on. A module that answers from an address not in `MODULES` is one this
 * software does not yet know how to present.
 */
export const PROBE_ADDRESSES = [
  0x00, 0x08, 0x12, 0x13, 0x16, 0x18, 0x1b, 0x1e, 0x22, 0x24, 0x28, 0x30, 0x32,
  0x33, 0x34, 0x3b, 0x40,
  0x44, 0x47, 0x48, 0x4a, 0x50, 0x51, 0x56, 0x57, 0x5a, 0x5b, 0x60, 0x65,
  0x66, 0x68, 0x6a, 0x6b, 0x70, 0x72, 0x74, 0x7f, 0x80, 0x81, 0x86, 0x98,
  0x9a, 0x9b, 0x9c, 0x9e, 0xa0, 0xa4, 0xa6, 0xa7, 0xac, 0xb0, 0xbb, 0xc0,
  0xc2, 0xc8, 0xce, 0xd0, 0xda, 0xe8, 0xed, 0xf0, 0xf5,
];

/**
 * `0x33` is not one of the vendor's, and is not a BMW address at all.
 *
 * It is the functional address every OBD-II car is required to answer on, added out of curiosity
 * about what this cable does when it meets something that is not a BMW. The honest expectation is
 * silence: a generic ISO 14230 module wants its own wake-up (a five-baud slow init, or the 25 ms
 * fast init) and `0x83F0` programs the BMW timing instead. Asking costs one identify request, which
 * is a read, so the experiment is free and the answer is worth having written down either way.
 */
export const CURIOSITY_ADDRESSES = new Set([0x33]);

/**
 * The two commands the airbag module wants before it will serve its shadow memory.
 *
 * Measured, after the app read `A2` — a refusal — where the vendor's software read `A0 01`. The
 * difference is these two, sent immediately before: DS2 `90 FF FF`, then DS2 `95` carrying four
 * bytes **taken from the module's own identity reply** (`…00 16 02 08 32 74` → `16 02 08 32`).
 * Both answer with a bare acknowledgement and no data.
 *
 * `0xC751` is in the Android app's `KNOWN_WRITES` list, put there when all that was known about it
 * was that it carried service `0x95` with an argument. What is known now is narrower: the argument
 * is not new data but the module's own bytes handed back, the reply carries nothing, and the
 * airbag module's identity read today is byte-identical to the vendor's reading of it after the
 * vendor had sent this twelve times. It behaves like an unlock. That is not the same as proof, so
 * the app never sends it as part of a scan — only when the owner asks for it by name.
 */
export const SHADOW_UNLOCK = { PRIME: 0x44db, GRANT: 0xc751 };

/** The four identity bytes `0xC751` has to carry: the last four before the checksum. */
export function shadowUnlockArgument(ident) {
  if (!ident || ident.length < 6) return null;
  return ident.slice(-5, -1);
}

/**
 * Fault descriptions, per module, for the codes this car actually produced.
 *
 * Every line is the vendor software's own text for the same code on the same car, taken from its
 * report - so these are not translations of a guess, they are a translation of a known-correct
 * answer. **The table is deliberately small.** The vendor keeps a description for some sixty modules
 * and a thousand codes; copying all of it is a separate job, and inventing the rest would turn a
 * verified reading into a plausible-looking fiction. An unknown code therefore gets no description
 * at all, and the raw bytes stay on screen either way.
 */
export const FAULT_TEXT = {
  0x12: {
    0x27c3: { en: 'Failure oil status sensor', hu: 'Olajszint-érzékelő hibás' },
  },
  0x29: {
    0x5e1f: { en: 'PT-CAN chassis number wrong / ECU not initialized',
              hu: 'PT-CAN alvázszám hibás / vezérlő nincs inicializálva' },
    0x5e16: { en: 'CAN timeout, instrument cluster', hu: 'CAN időtúllépés — műszerfal' },
    0x5e24: { en: 'Pressure sensor 1/2 not plausible', hu: 'Nyomásérzékelő 1/2 nem plauzibilis' },
    0x5e43: { en: 'Steering angle sensor, internal', hu: 'Kormányszög-érzékelő belső hiba' },
  },
  0x57: {
    0x0b: { en: 'Wrong LWS-ID', hu: 'Hibás LWS-azonosító' },
    0x09: { en: 'No CAN message (ASC)', hu: 'Nincs CAN üzenet (ASC)' },
    0x04: { en: '90 degrees difference of wiper too large (adjustment operation)',
            hu: '90 fokos eltérés túl nagy (beállítási művelet)' },
  },
  0x5b: {
    0x1c: { en: 'AUC sensor', hu: 'AUC érzékelő' },
    0x1e: { en: 'AUC heating', hu: 'AUC fűtés' },
  },
  0x80: {
    0xbe: { en: 'Data-filing difference to central light module (LCM)',
            hu: 'Adateltérés a központi világításmodulhoz (LCM)' },
  },
  0xa4: {
    0x06: { en: 'Side airbag, front right door, resistance too low',
            hu: 'Oldallégzsák, jobb első ajtó — túl kis ellenállás' },
  },
};

/**
 * Fault descriptions lifted out of the vendor binary, in English only.
 *
 * `tools/fault_text.py` reads these from the executable's own lookup tables rather than inventing
 * them. **A module appears here only if its table reproduces, exactly, every code whose text the
 * vendor printed for the test car** — the binary holds one table per module *variant*, fifteen of
 * them for the climate module alone, and picking the wrong one yields confident nonsense.
 *
 * The ABS is the reason that rule is written down. Its best candidate table has 115 codes and gets
 * two of this car's four exactly right; the other two are off by one and by ten, which is the
 * signature of a neighbouring variant. Shipping it would have added two correct descriptions and a
 * hundred plausible wrong ones, so it is not here.
 *
 * 78 descriptions across the steering sensor, the climate module and the instrument
 * cluster. `FAULT_TEXT` above wins where both have an entry,
 * because that one is translated and this one is not.
 */
export const FAULT_TEXT_EXTRACTED = {
  0x57: {
    0x01: 'Terminal 30 defective',
    0x02: 'Sensor current out of range',
    0x03: '90 degrees difference of wiper too large (Normal operation)',
    0x04: '90 degrees difference of wiper too large (Adjustment operation)',
    0x05: 'EEPROM defective',
    0x06: 'AD-converter defective',
    0x07: 'ROM-Check Error',
    0x08: 'RAM-Check Error',
    0x09: 'No CAN message (ASC)',
    0x0a: 'Wrong CAN-Version',
    0x0b: 'Wrong LWS-ID',
    0x0c: 'CAN-Bus off',
    0x0d: 'LWS-gradient too large',
    0x0e: 'LWS-maximum exceeded',
    0x0f: 'Stack error / Case error',
  },
  0x5b: {
    0x00: 'Ventilation flap motor',
    0x01: 'Defroster flap motor',
    0x02: 'Footwell flap motor',
    0x03: 'Fresh air / Air circulation flap motor left',
    0x05: 'Fresh air / Air circulation flap motor right',
    0x0a: 'Pressure sensor, AUC Supply',
    0x0c: 'Evaporator sensor',
    0x11: 'Heat exchanger sensor',
    0x14: 'Inner temperature sensor',
    0x15: 'Relay Rear window defogger',
    0x16: 'Additional heater, Relay Windshield defogger',
    0x17: 'Auxiliary water pump',
    0x18: 'Water valve',
    0x19: 'Blower control voltage',
    0x1a: 'Sensor blower',
    0x1b: 'Communication with the Additional heater',
    0x1c: 'AUC sensor',
    0x1d: 'Pressure sensor',
    0x1e: 'AUC heating',
    0x1f: 'Latent heat storage system Cut off valve',
    0x20: 'Latent heat storage system Shut off valve',
    0x31: 'Solar sensor or Latent heat storage system Temperature sensor',
    0xfe: 'Wrong air conditioning unit mounted',
  },
  0x80: {
    0x3d: 'Acoustic transmitter disconnected (gong tone 1/2/3)',
    0x3e: 'Fault when activating indicator instruments',
    0x43: 'Overcurrent in instrument circuit',
    0x82: 'Oil-pressure sensor',
    0x86: 'Speedometer signal',
    0x87: 'Body bus (K-bus)',
    0x8a: 'Instrumentation bus (I-bus)',
    0x8b: 'Gong tone (T3)',
    0x8c: 'Voltage supply, terminal R, faulty',
    0x8e: 'EGS signal line disturbed',
    0x8f: 'Overvoltage in voltage supply',
    0x90: 'Voltage supply, terminal 15, faulty',
    0x91: 'Gong tone (T2)',
    0xbb: 'Gong tone (T1)',
    0xbc: 'Brake-fluid level',
    0xbd: 'Electronic braking-force distribution',
    0xbe: 'Data-filing difference to central light module (LCM)',
    0xc0: 'Internal fault, EEPROM checksum, coding incorrect/incomplete',
    0xc2: 'Distance signal from ABS/ASC/DSC control unit',
    0xc5: 'Speed signal from engine control unit',
    0xc6: 'Output PIN 6 (code EWS), blue plug',
    0xcc: 'Tank sensor 1, left',
    0xcd: 'Consumption signal from engine control unit 1',
    0xce: 'Outside-temperature sensor',
    0xd2: 'Service interval indicator (SIA) reset',
    0xd4: 'Coolant temperature sensor',
    0xd6: 'Oil temperature sensor',
    0xd9: 'Tank sensor 2, right',
    0xef: 'Consumption signal from engine control unit 2',
    0xf3: 'CAN-bus off',
    0xf4: 'No CAN message',
    0xf5: 'No CAN message (ASC1)',
    0xf6: 'No CAN message (DMER1)',
    0xf7: 'No CAN message (DMER2)',
    0xf8: 'No CAN message (DMER4)',
    0xf9: 'No CAN message (DMEL4)',
    0xfa: 'No CAN message (EML1)',
    0xfb: 'No CAN message (EGS1)',
    0xfc: 'No CAN message (MST1)',
    0xfe: 'No CAN message (DMER3)',
  },
};

/** The description for a code on a module, or an empty string when we do not have one. */
export function faultText(addr, code, lang = 'en') {
  const entry = FAULT_TEXT[addr] && FAULT_TEXT[addr][code];
  if (entry) return entry[lang] || entry.en || '';
  const extracted = FAULT_TEXT_EXTRACTED[addr];
  return (extracted && extracted[code]) || '';
}

/**
 * Decodes a module's identification into its BMW part number and hardware revision.
 *
 * Both are binary-coded decimal, and the part number's leading nibble is a filler that has to go:
 * the cluster answers `A0 F6 91 12 86 12 …`, whose nibbles are `F 6 9 1 1 2 8 6`, and the vendor
 * prints `6.911.286` with hardware `12`. The filler is not always `F` - the body module uses `8`
 * and the steering angle sensor `0` - so it is dropped by position rather than by value.
 *
 * **Checked on all nine modules at once**, which is the only reason this is here rather than in a
 * comment marked as a guess: 6914367, 7519592, 6759045, 6905666, 6759909, 6916882, 6911286,
 * 6912755, 6919825, with hardware 11, 10, 04, 03, 04, 25, 12, 10, 15 - the vendor's `BMWTNR` and
 * `HW` columns, in order, exactly.
 */
export function decodeIdent(mod) {
  // DS2 identity is `[addr][len][A0][…]`; KWP identity is the `5A 80 00 00 …` data block.
  const at = mod.kwp ? 4 : 3;
  const src = mod.ident;
  if (!src || src.length < at + 5) return null;
  let nibbles = '';
  for (const b of src.slice(at, at + 4)) {
    nibbles += (b >> 4).toString(16) + (b & 0x0f).toString(16);
  }
  const part = nibbles.slice(1);
  if (!/^\d{7}$/.test(part)) return null;
  const hw = src[at + 4];
  return {
    part: `${part[0]}.${part.slice(1, 4)}.${part.slice(4)}`,
    hw: hw.toString(16).toUpperCase().padStart(2, '0'),
  };
}

/**
 * Decodes engine speed out of the immobiliser's status block.
 *
 * **The engine speed is not on the engine controller.** Two captures and several thousand frames
 * were searched for an engine poll loop and there is none: the DME refuses `A2` and `22 20 00`
 * outright. The owner, who had actually watched the vendor software display rpm, said it was in the
 * **EWS** menu — and it is. The immobiliser has to know whether the engine is turning, so the DME
 * tells it, and `0x5132` hands the whole status block over.
 *
 * The sixth byte is the engine speed in hundreds. The evidence is a throttle blip the owner did on
 * purpose so it would be visible, caught at 1.3-second intervals:
 *
 * ```
 *   16:47:12.881   0F   1500
 *   16:47:15.789   07    700   back to idle
 *   16:47:21.097   14   2000   the blip
 *   16:47:22.414   08    800
 *   16:47:25.021   07    700
 * ```
 *
 * and the same byte reads `06`/`07` at idle in a capture from the previous day. Five independent
 * agreements: the screen the owner names, the poll rate they describe, idle matching the rpm they
 * read off the display, the spike landing exactly where they pressed the pedal, and the decay back
 * to idle afterwards.
 *
 * **The resolution really is 100 rpm.** Nothing else in the reply moves, so this is what the
 * immobiliser is told, not a value we have rounded.
 */
export function decodeEwsLive(answer) {
  if (!answer || answer.length < 8 || answer[2] !== 0xa0) return null;
  return { rpm: answer[5] * 100 };
}

/**
 * Decodes the instrument cluster's odometer, which is packed as binary-coded decimal.
 *
 * `A0 01 32 17 40` is 321740 km - two decimal digits per byte, which is why it reads as hex that
 * happens to look like the answer. The vendor's report for the same session says `321740 km`.
 *
 * Reading this is a read. Writing it has been out of scope since the first day of the project and
 * there is no code here that could.
 */
export function decodeMileage(answer) {
  if (!answer || answer.length < 8 || answer[2] !== 0xa0) return null;
  let digits = '';
  for (const b of answer.slice(4, -1)) {
    digits += (b >> 4).toString() + (b & 0x0f).toString();
  }
  if (!/^\d+$/.test(digits)) return null;
  const km = parseInt(digits, 10);
  return Number.isFinite(km) && km > 0 ? km : null;
}

/**
 * Decodes the cluster's stored VIN: two ASCII letters, then the rest as BCD.
 *
 * `A0 02 4B 50 04 22 00` is `KP` followed by `04220`, and the vendor prints `KP04220` for the same
 * bytes - seven characters, so the final BCD nibble is padding and is dropped.
 */
export function decodeIkeVin(answer) {
  if (!answer || answer.length < 7 || answer[2] !== 0xa0) return '';
  const body = answer.slice(4, -1);
  let out = String.fromCharCode(body[0], body[1]);
  for (const b of body.slice(2)) out += (b >> 4).toString() + (b & 0x0f).toString();
  return out.slice(0, 7);
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
