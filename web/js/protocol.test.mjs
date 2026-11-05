/**
 * Checks the decoders against bytes the car actually sent, and against the vendor's own reading.
 *
 * Every case below is a reply lifted verbatim out of `log/teljesscan/ftd2xx-proxy.log`, paired with
 * what the vendor's software printed for the same bytes on the same car. That pairing is the whole
 * value: it tests the decoders against a known-correct answer rather than against my understanding
 * of them, which is the mistake that kept this project stuck - a decoder agreeing with its author
 * proves nothing.
 *
 * The bytes are confirmed twice over. `log/teljesscan/Diagnosztikai napló.txt` is this app's own
 * trace from an Android phone at the car on the same day, and the replies in it are byte-identical
 * to the ones below - `57 14 A0 03 0B 00 AF …C9`, `5B 19 A0 02 1C 44 …ED`, `80 14 A0 01 BE 48 …EB`,
 * `B8 F1 12 05 58 01 27 C3 64 87`. So these cases are not an artefact of reading one capture one
 * way: the cable says the same thing to us as it does to the vendor's software.
 *
 * Run:  node js/protocol.test.mjs
 */
import * as P from './protocol.js';

let failures = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}

const bytes = (s) => Uint8Array.from(s.trim().split(/\s+/), (b) => parseInt(b, 16));
const shown = (store, addr) => store.entries.map(
  (e) => `${e.wide ? e.code.toString(16).padStart(4, '0') : e.code.toString(16).padStart(2, '0')}/`
       + `${e.param.toString(16).padStart(2, '0')}`
       + (P.faultText(addr, e.code) ? ' *' : ''));

/* -- the ABS over KWP2000, address 0x29 ------------------------------------------------------ */
// Vendor: "ABS* -> 4 errors", then 5E1F/A0, 5E16/20, 5E24/A0, 5E43/A0.
{
  const raw = bytes(`B8 29 F1 04 18 02 FF FF 7E
                     B8 F1 29 0E 58 04 5E 1F A0 5E 16 20 5E 24 A0 5E 43 A0 DC`);
  const split = P.splitKwpReply(raw);
  check('ABS: echo is ours, addressed to 0x29', split.echo.target, 0x29);
  check('ABS: answer comes back to the tester', split.answer.source, 0x29);
  const f = P.decodeKwpFaults(split.answer.data);
  check('ABS: four faults', f.count, 4);
  check('ABS: codes match the vendor report',
    shown(f, 0x29), ['5e1f/a0 *', '5e16/20 *', '5e24/a0 *', '5e43/a0 *']);
}

// Vendor: ABS VIN field "AY31060KP04220".
{
  const raw = bytes(`B8 29 F1 02 1A 90 E8
                     B8 F1 29 10 5A 90 41 59 33 31 30 36 30 4B 50 30 34 32 32 30 B9`);
  const a = P.splitKwpReply(raw).answer;
  let vin = '';
  for (const b of a.data.slice(2)) if (b >= 0x30 && b <= 0x5a) vin += String.fromCharCode(b);
  check('ABS: VIN', vin, 'AY31060KP04220');
}

// A refused clear must read as a refusal, not as silence or success.
{
  const raw = bytes('B8 29 F1 03 14 FF FF 77   B8 F1 29 03 7F 14 22 2A');
  const d = P.splitKwpReply(raw).answer.data;
  check('ABS: clear refused with 7F 14 22', [d[0], d[1], d[2]], [0x7f, 0x14, 0x22]);
}
// ...and the engine controller's acceptance as an acceptance.
{
  const raw = bytes('B8 12 F1 03 14 FF FF 4C   B8 F1 12 03 54 FF FF 0C');
  check('DME: clear accepted with 54', P.splitKwpReply(raw).answer.data[0], 0x54);
}

/* -- the engine controller over KWP2000, address 0x12 ---------------------------------------- */
// Vendor: "DME* -> 1 error", 27C3/64 - Failure oil status sensor.
{
  const raw = bytes('B8 12 F1 04 18 02 FF FF 45   B8 F1 12 05 58 01 27 C3 64 87');
  const f = P.decodeKwpFaults(P.splitKwpReply(raw).answer.data);
  check('DME: one fault', f.count, 1);
  check('DME: the code', shown(f, 0x12), ['27c3/64 *']);
}

/* -- the DS2 fault memories, whose entry size differs per module ------------------------------ */
// Vendor: LEW 0B/AF, 09/97, 04/17 - three bytes an entry, padded with six zeros.
{
  const a = P.splitReply(bytes(
    '57 05 04 01 57   57 14 A0 03 0B 00 AF 09 00 97 04 00 17 00 00 00 00 00 00 C9')).answer;
  check('LEW: three faults', shown(P.decodeFaults(a), 0x57), ['0b/af *', '09/97 *', '04/17 *']);
}
// Vendor: A/C 1C/44, 1E/42 - ten bytes an entry, no padding.
{
  const a = P.splitReply(bytes(
    '5B 05 04 01 5B   5B 19 A0 02 1C 44 17 54 44 A8 08 11 03 89 '
    + '1E 42 1E 54 44 A8 08 11 03 89 ED')).answer;
  check('A/C: two faults', shown(P.decodeFaults(a), 0x5b), ['1c/44 *', '1e/42 *']);
}
// Vendor: IKE BE/48 - fourteen bytes for a single entry, whose own data ends in a zero.
{
  const a = P.splitReply(bytes(
    '80 05 04 01 80   80 14 A0 01 BE 48 28 00 80 00 00 80 00 00 80 00 00 80 00 EB')).answer;
  check('IKE: one fault', shown(P.decodeFaults(a), 0x80), ['be/48 *']);
}

/* -- identification: part number and hardware revision, against the vendor's BMWTNR/HW columns -- */
for (const [name, kwp, raw, part, hw] of [
  ['ZKE',  0, '00 10 A0 86 91 43 67 11 02 50 10 10 02 19 20 FB', '6.914.367', '11'],
  ['EWS',  0, '44 10 A0 86 90 56 66 03 81 81 07 02 02 04 08 DA', '6.905.666', '03'],
  ['LEW',  0, '57 10 A0 06 75 99 09 04 01 30 60 12 02 02 EE AD', '6.759.909', '04'],
  ['IHKA', 0, '5B 10 A0 86 91 68 82 25 15 32 0D 16 02 55 07 5F', '6.916.882', '25'],
  ['IKE',  0, '80 12 A0 F6 91 12 86 12 06 53 12 14 02 26 23 06 87 06', '6.911.286', '12'],
  ['SRS',  0, 'A4 10 A0 86 91 27 55 10 32 09 00 16 02 08 32 74', '6.912.755', '10'],
  ['LCM',  0, 'D0 10 A0 06 91 98 25 15 31 30 00 09 02 09 30 6C', '6.919.825', '15'],
  ['DME',  1, '5A 80 00 00 07 51 95 92 10 0C 00 0F 30 4C', '7.519.592', '10'],
  ['ABS',  1, '5A 80 00 00 06 75 90 45 04 04 00 06 00 06', '6.759.045', '04'],
  ['VTC1', 1, '5A 80 00 00 07 51 62 07 10 01 00 14 39 31', '7.516.207', '10'],
]) {
  const got = P.decodeIdent({ ident: bytes(raw), kwp: !!kwp });
  check(`${name}: BMWTNR and HW`, got && [got.part, got.hw], [part, hw]);
}

/* -- the cluster's own data: odometer and stored VIN ------------------------------------------ */
{
  const a = P.splitReply(bytes('80 05 02 01 86   80 08 A0 01 32 17 40 4C')).answer;
  check('IKE: odometer', P.decodeMileage(a), 321740);
}
{
  const a = P.splitReply(bytes('80 05 02 02 85   80 0A A0 02 4B 50 04 22 00 15')).answer;
  check('IKE: stored VIN', P.decodeIkeVin(a), 'KP04220');
}

/* -- the Valvetronic controller, which this project walked past for a fortnight ---------------- */
// Not in the vendor's DS2 probe list, only in its eight-address KWP one, so every sweep missed it.
{
  const raw = bytes(`B8 1B F1 02 1A 90 DA
                     B8 F1 1B 09 5A 90 30 30 30 30 30 30 30 A1`);
  const a = P.splitKwpReply(raw).answer;
  let vin = '';
  for (const b of a.data.slice(2)) if (b >= 0x30 && b <= 0x5a) vin += String.fromCharCode(b);
  check('VTC1: VIN field', vin, '0000000');   // the vendor prints exactly this
}

/* -- a mangled frame must be refused, not half-read ------------------------------------------ */
{
  const raw = bytes('B8 29 F1 04 18 02 FF FF 00');   // checksum deliberately wrong
  check('a bad KWP checksum yields no frames', P.splitKwpReply(raw).frames.length, 0);
}

/* -- the shadow memory over DS2, address 0xA4 ------------------------------------------------ */
// Vendor: "SRS -> no errors / 1 error", shadow entry 06/20.
{
  const page0 = P.splitReply(bytes('A4 05 14 00 B5   A4 05 A0 01 00'));
  check('SRS shadow: page 0 reports one entry', page0.answer[3], 1);
  const page1 = P.splitReply(bytes('A4 05 14 01 B4   A4 07 A0 01 06 20 24'));
  check('SRS shadow: positive', P.isPositive(page1.answer), true);
  check('SRS shadow: the entry', shown(P.decodeFaults(page1.answer), 0xa4), ['06/20 *']);
}
// Vendor: "ZKE -> no errors / no errors".
{
  const page0 = P.splitReply(bytes('00 05 14 00 11   00 05 A0 00 A5'));
  check('ZKE shadow: empty', P.decodeFaults(page0.answer).count, 0);
}

/* -- the assembly-release bytes, which the vendor prints as ADFG ------------------------------ */
for (const [name, raw, want] of [
  ['ZKE', '00 04 0E 0A   00 07 A0 55 42 20 90', '554220'],
  ['EWS', '44 04 0E 4E   44 07 A0 FF FF FF 1C', 'FFFFFF'],
  ['IKE', '80 04 0E 8A   80 07 A0 84 00 00 A3', '840000'],
  ['LCM', 'D0 04 0E DA   D0 07 A0 55 55 00 77', '555500'],
]) {
  const a = P.splitReply(bytes(raw)).answer;
  check(`${name}: ADFG`, P.hex(a.slice(3, -1)).replace(/ /g, ''), want);
}

/* -- the DS2 clear ---------------------------------------------------------------------------- */
{
  const a = P.splitReply(bytes('57 04 05 56   57 04 A0 F3')).answer;
  check('LEW: clear accepted', P.isPositive(a), true);
}
{
  const a = P.splitReply(bytes('A4 04 05 A5   A4 04 A1 01')).answer;
  check('SRS: a first clear attempt answering A1 is not positive', P.isPositive(a), false);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
