# Findings — BMW Scanner 1.4.0 cable and its Windows software

Investigation date: 2026-10-18. Everything below is either an observation with the evidence noted,
or an inference explicitly labelled as such.

## The cable

**Observed.** The shipped driver package (`Drivers/FTD2XX.INF`) binds the device as a plain FTDI
part:

```
[FtdiHw]
%USB\VID_0333&PID_0137.DeviceDesc%        = FTD2XX, USB\VID_0333&PID_0137
%USB\VID_0333&PID_0137&MI_00.DeviceDesc%  = FTD2XX, USB\VID_0333&PID_0137&MI_00
%USB\VID_0333&PID_0137&MI_01.DeviceDesc%  = FTD2XX, USB\VID_0333&PID_0137&MI_01

USB\VID_0333&PID_0137.DeviceDesc        = "BMW Scanner"
USB\VID_0333&PID_0137&MI_00.DeviceDesc  = "BMW Scanner Channel A"
USB\VID_0333&PID_0137&MI_01.DeviceDesc  = "BMW Scanner Channel B"
```

| Item | Value |
|---|---|
| Driver | `FTD2XX.SYS` 3.01.02 (2005-12-15), `FTD2XX.DLL` 3.01.06, CompanyName `FTDI Ltd` |
| Driver kind | D2XX **direct** driver, not a virtual COM port |
| USB id | VID `0x0333`, PID `0x0137` — device self-reports `PASOFT` / `BMW Scanner V14x` |
| Hardware string in logs | `HW: V144Bn9` (from `2009-2-26_20-02-54.log`) |

**Inference.** `0x0333` is not FTDI's registered vendor id (`0x0403`), so the cable's FTDI
configuration EEPROM was re-flashed with a custom VID/PID. This is sufficient to explain why no
third-party OBD software recognises the cable: the protocol is not necessarily unusual, but nobody's
probe table contains `0333:0137`.

**Inference, not yet confirmed.** The `MI_00` / `MI_01` composite-interface ids suggest a
dual-channel part (FT2232C-class) rather than a single-channel FT232BM. The app's *Descriptors*
button settles this: `interfaceCount > 1` means dual-channel.

**Open question.** Whether the cable is a "dumb" FTDI + K-line level shifter (so the software writes
DS2 frames straight to the serial port), or contains a microcontroller imposing its own framing.
This is the one question that decides the project, and it is answered empirically — see
`docs/testing-on-the-car.md`.

## The Windows software

Two different builds are present:

| File | SHA-256 | Size |
|---|---|---|
| `D:\Program Files (x86)\BMW Scanner v1.4.0\BMWScan140.exe` | `25b4fddf725d9712ac3edaa12832824a08479cce424977f4448acabccd828919` | 3 006 464 |
| `C:\Users\Mate\Downloads\bmw1.4\BMWScan140.exe` | `2a93d1f0186b387293cfe2f490704f9f6f3354206d8ce6952e800492e5ea7a8b` | 2 979 328 |

(The copy inside `bmw1.4\BMWScan140\` is byte-identical to the second one.)

### It is packed, and that is why antivirus flags it

**Observed**, by parsing the PE headers of both files:

| Evidence | Both files |
|---|---|
| Section count / names | 8 sections, every one renamed to `.bmw` (installed) or `.bmwscan` (download) |
| Section entropy | 8.000, 7.97, 7.95, 7.53, 7.88 — at or near the 8.0 maximum |
| Import table | exactly two functions: `kernel32!GetModuleHandleA`, `user32!MessageBoxA` |
| Entry point | RVA `0x7A4BD6` / `0x795BD6`, inside a **writable** section |
| TLS directory | present |
| Resource directory | encrypted — REA's `inspect_pe_resources` rejects it: *"Resource range is not entirely file-backed in one section"* |
| DOS stub | `This program must be run under Win32` |
| Link timestamp | 1992-06-19 22:22:17 |

**Inference.** The DOS stub text and that specific fake timestamp are Borland's, so the original
application was built in Delphi. On top of it sits an executable protector: it encrypted every
original section in place, renamed them all, replaced the import table with a two-function
unpacking stub, and moved the entry point into writable memory.

**Conclusion on the antivirus hits.** Maximum-entropy sections, a writable entry point, a collapsed
import table and self-modifying startup are exactly the feature set generic AV heuristics score as
malicious. The VirusTotal detections are therefore most plausibly false positives caused by the
protector. This is an explanation, **not** a clean bill of health — it cannot be proven from the
headers alone, and the file is not going to be executed either way.

**Conclusion on reverse engineering.** Static decompilation of this binary is not viable. There is
no code to decompile until the protector unpacks itself in memory, which would require running it
under a debugger and defeating its anti-analysis measures. Recovering the protocol from the
executable has been dropped from the plan; the protocol is approached from the DS2 side instead.

### Other scraps from the package

- `installation method.txt`: *"1, the best choice windows xp system, 2, turn off antivirus software,
  3, copying the software to C disk"* — the vendor's own instructions assume AV will object.
- `bmwscan.ini`: `Delay=20`, `Delay2=40` under `[Communication]`. **Inference:** millisecond-scale
  inter-byte / inter-frame delays on the K-line. Worth mirroring if the first transactions prove
  flaky.
- `2009-2-26_20-02-54.log` shows the output schema the original tool produced, which is a useful
  target for our own feature set:
  `Unit, BMWTNR, HW, SW-FSW, CI, DI, BI/VI, Date, Odometer, VIN, ADFG, Algorithm`.
- The legacy `FTD2XX.SYS` from 2005 is very unlikely to install on Windows 11 anyway — an
  independent reason the Windows route is a dead end on this machine.

## What was decided from all this

1. Do not run and do not try to decompile `BMWScan140.exe`.
2. Talk to the cable's FTDI chip directly over raw USB from Android — no vendor driver involved.
3. Treat the DS2 command set as unknown and discover it on the car, rather than guessing from
   half-remembered tables. See `docs/testing-on-the-car.md`.
