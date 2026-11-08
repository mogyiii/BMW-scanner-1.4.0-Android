/**
 * The page with this car's real readings in it, and no cable attached.
 *
 * Opened with `?demo=1`. Every byte below was recorded on 2026-11-05 - from this app's own trace at
 * the car and from `log/teljesscan/ftd2xx-proxy.log` - and it is pushed through the same decoders
 * the live path uses. So this is not mock data in the usual sense: it is last Thursday's car,
 * replayed.
 *
 * It exists for two reasons. The layout can be looked at and judged without driving anywhere, and a
 * change to the decoders shows up here immediately rather than at the next trip. The page says in
 * plain words that it is a replay, because a diagnostic screen that cannot be told apart from a
 * live one is worse than no screen.
 */
import * as P from './protocol.js';

const b = (s) => Uint8Array.from(s.trim().split(/\s+/), (x) => parseInt(x, 16));

/** `[identity, live fault page, shadow page, adfg]`, as the modules answered. */
const RECORDED = {
  0x00: {
    ident: '00 10 A0 86 91 43 67 11 02 50 10 10 02 19 20 FB',
    faults: '00 07 A0 00 00 00 A7', shadow: '00 05 A0 00 A5', adfg: '00 07 A0 55 42 20 90',
  },
  0x12: {
    ident: '5A 80 00 00 07 51 95 92 10 0C 00 0F 30 4C 20 02 04 09 08 00 11 16 06',
    kwpDtc: '58 01 27 C3 64', vin: 'KP04220',
  },
  0x1b: {
    ident: '5A 80 00 00 07 51 62 07 10 01 00 14 39 31 20 02 03 05 10 00 06 8F 06',
    // The vendor never asked this module for fault codes -- its report's error column says
    // "no data" -- so the replay has no answer to show and says so. What `18 02 FF FF` gets from a
    // Valvetronic controller is genuinely unknown until somebody sends it.
    kwpDtc: null, vin: '0000000',
  },
  0x29: {
    ident: '5A 80 00 00 06 75 90 45 04 04 00 06 00 06 20 02 04 08 24',
    kwpDtc: '58 04 5E 1F A0 5E 16 20 5E 24 A0 5E 43 A0', vin: 'AY31060KP04220',
  },
  0x44: {
    ident: '44 10 A0 86 90 56 66 03 81 81 07 02 02 04 08 DA',
    faults: '44 05 A0 00 E1', shadow: null, adfg: '44 07 A0 FF FF FF 1C',
    // Mid-blip, from 16:47:21 -- the one frame in the capture that shows 2000 rpm.
    ewsLive: '44 1F A0 42 0C 14 01 55 00 31 66 C0 E5 C1 D0 5F E5 EC C8 9C 5E 57 C8 C9 A4 5B AE EA 4B 00 6C',
  },
  0x57: {
    ident: '57 10 A0 06 75 99 09 04 01 30 60 12 02 02 EE AD',
    faults: '57 14 A0 03 0B 00 AF 09 00 97 04 00 17 00 00 00 00 00 00 C9',
    shadow: null, adfg: '57 07 A0 55 42 20 C7',
  },
  0x5b: {
    ident: '5B 10 A0 86 91 68 82 25 15 32 0D 16 02 55 07 5F',
    faults: '5B 19 A0 02 1C 44 17 54 44 A8 08 11 03 89 1E 42 1E 54 44 A8 08 11 03 89 ED',
    shadow: null, adfg: '5B 07 A0 00 42 20 9E',
  },
  0x80: {
    ident: '80 12 A0 F6 91 12 86 12 06 53 12 14 02 26 23 06 87 06',
    faults: '80 14 A0 01 BE 48 28 00 80 00 00 80 00 00 80 00 00 80 00 EB',
    shadow: null, adfg: '80 07 A0 84 00 00 A3',
    mileage: '80 08 A0 01 32 17 40 4C', ikeVin: '80 0A A0 02 4B 50 04 22 00 15',
  },
  0xa4: {
    ident: 'A4 10 A0 86 91 27 55 10 32 09 00 16 02 08 32 74',
    // Two different true answers. The vendor's software reads `A0 01 06 20` here, because it
    // sends the unlock first; this app reads `A2`, a refusal, because it does not. The
    // refusal is what the replay shows, since it is what the app itself produces.
    faults: 'A4 05 A0 00 01', shadow: 'A4 04 A2 02', adfg: 'A4 07 A0 00 00 00 03',
  },
  0xd0: {
    ident: 'D0 10 A0 06 91 98 25 15 31 30 00 09 02 09 30 6C',
    // The capture never sent 0x9E56 to this module, so the replay has no shadow store to show.
    // That is a limit of the recording, not a statement about the car - the vendor's report
    // says the lighting module's shadow memory is empty.
    faults: 'D0 05 A0 00 75', shadow: null, adfg: 'D0 07 A0 55 55 00 77',
  },
};

/**
 * Turns one recorded fault-store reply into the same shape `session.js` produces.
 *
 * Including the refusal: the airbag module answers `A2` to the shadow read until it is unlocked,
 * and the replay has to show that as locked rather than as empty, or it would be a replay of a
 * different, friendlier car.
 */
function store(hex) {
  if (!hex) return null;
  const frame = b(hex);
  if (!P.isPositive(frame)) return frame[2] === 0xa2 ? { locked: true } : null;
  return P.decodeFaults(frame);
}

/** Runs the recorded replies through the real decoders, module by module. */
export function replay() {
  const out = [];
  for (const mod of P.MODULES) {
    const rec = RECORDED[mod.addr];
    if (!rec) { out.push({ ...mod, present: false, reason: 'nincs rögzítve' }); continue; }

    const result = { ...mod, present: true, ident: b(rec.ident) };
    if (mod.kwp) {
      result.faults = rec.kwpDtc ? P.decodeKwpFaults(b(rec.kwpDtc)) : null;
      result.shadow = null;
      result.vin = rec.vin;
    } else {
      result.faults = store(rec.faults);
      result.shadow = store(rec.shadow);
      result.adfg = b(rec.adfg).slice(3, -1);
      if (rec.mileage) result.mileage = P.decodeMileage(b(rec.mileage));
      if (rec.ikeVin) result.vin = P.decodeIkeVin(b(rec.ikeVin));
      if (rec.ewsLive) result.live = P.decodeEwsLive(b(rec.ewsLive));
    }
    out.push(result);
  }
  return out;
}

/** The trace, so the raw-traffic panel is not empty in a replay either. */
export const TRACE = [
  ['0xA77A', '77 07 77 07 77 07 70'],
  ['0xB318', '77 07 77 07 77 07 70 77 07 77 07 77 07 70'],
  ['0x83F0', '7E 98 00 7E 98 00 7E 98 00 00 FE'],
  ['0x46F1', '80 04 00 84 80 12 A0 F6 91 12 86 12 06 53 12 14 02 26 23 06 87 06'],
  ['0xC731', '80 05 04 01 80 80 14 A0 01 BE 48 28 00 80 00 00 80 00 00 80 00 00 80 00 EB'],
  ['0x8DE3', '80 05 02 01 86 80 08 A0 01 32 17 40 4C'],
  ['0xC358', 'B8 29 F1 04 18 02 FF FF 7E B8 F1 29 0E 58 04 5E 1F A0 5E 16 20 5E 24 A0 5E 43 A0 DC'],
];
