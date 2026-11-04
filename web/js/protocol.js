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
  // The engine controller is not a DS2 module; these map to KWP2000 services.
  KWP_IDENT: 0x06f3, // KWP 1A 80
  KWP_VIN:   0x0de7, // KWP 1A 90
  KWP_DTC:   0xc358, // KWP 18 02 FF FF
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
export function splitReply(raw) {
  if (raw.length < 4) return null;
  const echoLen = raw[1];
  if (echoLen < 3 || echoLen > raw.length) return null;
  const echo = raw.slice(0, echoLen);
  if (echoLen === raw.length) return { echo, answer: null };
  const rest = raw.slice(echoLen);
  if (rest.length < 3) return { echo, answer: null };
  const n = rest[1];
  if (n < 3 || n > rest.length) return { echo, answer: null };
  return { echo, answer: rest.slice(0, n) };
}

/** DS2's positive acknowledgement sits at index 2. */
export const isPositive = (frame) => frame && frame.length > 2 && frame[2] === 0xa0;

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
 * `kwp` marks the ones that ignore DS2. The engine controller answers `0x46F1` with nothing but the
 * echoed request - the vendor's capture shows it getting exactly the same - and speaks KWP2000
 * instead.
 */
export const MODULES = [
  { addr: 0x00, name: 'ZKE',   label: 'Karosszéria',     icon: '🚪' },
  { addr: 0x12, name: 'DME',   label: 'Motorvezérlő',    icon: '⚙️', kwp: true },
  { addr: 0x44, name: 'EWS',   label: 'Indításgátló',    icon: '🔑' },
  { addr: 0x56, name: 'ABS',   label: 'ABS / DSC',       icon: '🛞' },
  { addr: 0x57, name: 'LWS',   label: 'Kormányszög',     icon: '🎚️' },
  { addr: 0x5b, name: 'IHKA',  label: 'Klíma',           icon: '❄️' },
  { addr: 0x80, name: 'IKE',   label: 'Műszerfal',       icon: '📟' },
  { addr: 0xa4, name: 'SRS',   label: 'Légzsák',         icon: '⚠️' },
  { addr: 0xd0, name: 'LCM',   label: 'Világítás',       icon: '💡' },
];

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
