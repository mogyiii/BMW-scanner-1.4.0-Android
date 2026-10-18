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

**This inference was wrong.** The `MI_00` / `MI_01` composite-interface ids in the INF led me to
expect a dual-channel FT2232-class part, and to suppose that "Channel A" and "Channel B" might be
wired to two different diagnostic lines in the OBD socket. The first field run
(`field-logs/2026-10-18-run1.log`) settled it: the hardware exposes **one** interface with a single
bulk pair, so it is a single-channel FT232BM-class part. The INF simply declares ids the vendor's
driver package could bind, not ids this cable presents. Channel B does not exist and has been
dropped from the sweep.

## What the first field run established

Source: `field-logs/2026-10-18-run1.log`, app v0.2-probe, on the car, 2026-10-18.

**Observed — the cable works over OTG.** The phone enumerates and powers it:

```
device /dev/bus/usb/001/002  VID=0333 PID=0137
  manufacturer=PASOFT  product=BMW Scanner V14x
  serial=PA5BG64Y
  interfaces=1
  iface#0 class=255 endpoints=2
      ep 0x81 IN  bulk maxPacket=64
      ep 0x02 OUT bulk maxPacket=64
```

Vendor-class, one interface, one bulk pair, 64-byte packets — a single-channel FT232BM-class part.

**Observed — the whole 64-word EEPROM reads back cleanly**, in the standard FTDI layout:

```
00: 4000 0333 0137 0000 2D80 0008 0000 0E98
08: 22A6 12C8 AAAA 0006 030E 0050 0041 0053
10: 004F 0046 0054 0322 0042 004D 0057 0020
18: 0053 0063 0061 006E 006E 0065 0072 0020
20: 0056 0031 0034 0078 0312 0050 0041 0035
28: 0042 0047 0036 0034 0059 0000 0000 0000
30: 0000 0000 0000 0000 0000 0000 0000 0000
38: 0000 0000 0000 0000 0000 0000 0000 6206
```

Decoded: word 1 = VID `0x0333`, word 2 = PID `0x0137`, confirming the re-flash. Words 7/8/9 are the
string descriptors (offset, length): `0x0E98` → `"PASOFT"`, `0x22A6` → `"BMW Scanner V14x"`,
`0x12C8` → `"PA5BG64Y"`. Word `0x3F` = `0x6206` is the EEPROM checksum.

Words `0x2D`–`0x3E` are all zero. **There is no usage counter or protection blob hiding in the
EEPROM** — at least not in the 64 words a 93C46 holds, which is all of it.

**Observed — bytes come back, but no DS2 frame parses.** All 8 configurations returned `valid=0`
with 37–42 bytes per 8-address pass (~4.7 bytes per 4-byte request).

**Inference, and the reason for v0.3.** A *clean* echo would have parsed as valid. With echo
cancellation off, an exact echo of our `[addr][04][00][cs]` request is re-read as a response whose
length byte is plausible, whose address matches, and whose checksum is correct by construction — so
`isPresent` would have returned true and the sweep would have reported 8 valid frames per pass. It
reported zero. **Therefore the returned bytes are not a clean echo of what we sent.**

What they *are* cannot be settled from the v0.2 log, because that build recorded only byte counts,
not the bytes. Three explanations remain open:

1. a corrupted echo — wrong line settings mangling our own transmission on the way back;
2. a real module reply arriving on top of, or instead of, the echo;
3. **the cable is not a transparent bridge after all** — a microcontroller answering our
   unrecognised bytes with a short status or error response of its own. Note that the byte count
   barely moves between 9600 and 10400 baud, which is what you would expect if whatever answers
   does not care about the K-line baud rate at all.

v0.3 adds a line-characterisation step that sends fixed patterns (`55 55 55 55`, `AA AA`, `00`,
`FF`) and prints the reply byte for byte. That separates the three cases directly.

## What the second field run established

Source: `field-logs/2026-10-18-run2.log`, app v0.4-probe, on the car with ignition in position 2.

This run printed the actual bytes, and they rule out the ordinary explanations.

**Observed — the first byte of every reply depends on the baud *setting*, not on the data sent.**

```
 9600 EVEN TX 55 55 55 55    RX C4 E0
 9600 EVEN TX AA AA          RX C4 B8 9A AC 81    LINE=0x64
 9600 EVEN TX 00             RX C4 E8
 9600 EVEN TX FF             RX C4 F8 F8
 9600 EVEN TX 80 04 00 84    RX C4 78 78 72       LINE=0x64
10400 EVEN TX 55 55 55 55    RX F4 71 B3 37 F7    LINE=0x64
10400 EVEN TX 00             RX FC 11
10400 NONE TX FF             RX F4 01 FF
```

Every 9600 reply begins `C4`; every 10400 reply begins `F4` or `FC`. A module's answer would vary
with the request. A constant that tracks our own clock does not come from the car.

**Observed — parity and framing errors throughout.** `LINE=0x64` is bit 2 set (parity error),
`LINE=0x68` is bits 2 and 3 (parity *and* framing). The receiver is not cleanly decoding whatever
is on the wire.

**Observed — the reply tracks our data, bit-shifted.** In the 256-address scan at 10400 NONE the
second byte alternates with the low bit of the address:

```
0x01 -> F4 81      0x02 -> F4 01      0x03 -> F4 81      0x04 -> FC 01
0x05 -> F4 81      0x06 -> F4 01      0x07 -> F4 81      0x08 -> FC 01
```

Bit 7 of the second received byte follows bit 0 of the address we transmitted. The information we
sent is coming back, but sampled at the wrong bit boundaries.

**Observed — not one valid frame in 256 addresses**, in any configuration, with the resynchronising
search that v0.4 added. So this is not a misalignment the parser can recover from; the bytes
themselves are wrong, not merely offset.

**Inference.** We are receiving our own transmission decoded at the wrong bit rate, or something
that is not a UART running at the rate we selected. Three sub-cases remain, and they are
distinguishable without a car:

1. the cable contains a microcontroller that talks at a fixed rate of its own;
2. the receive line is floating and picking up crosstalk from our own transmit line;
3. the transceiver inverts or otherwise mangles the returned signal.

**The test.** v0.5 adds a baud hunt: send `55 55 55 55` at sixteen rates from 1200 to 230400 and
look for one where the bytes come back unchanged. If the cable is a UART at *some* speed, exactly
one rate will produce a clean echo and that is the cable's real bit rate. If nothing is clean
anywhere, the receive path is not carrying a UART signal at all, which points at case 2 or 3 and
makes the hardware itself the next thing to inspect.

This runs on a desk. The car is not involved in any of it.

## The desk control run

Source: `field-logs/2026-10-18-run3-desk-control.log`. Cable on the phone over OTG, **not connected
to the car**, driven remotely over wireless adb.

This is the measurement that should have been taken first. It establishes what the cable does on
its own, which is what the car readings need to be compared against.

**Observed — total silence at all 32 baud/parity combinations.** `55 55 55 55` out, nothing back,
from 1200 to 230400 baud.

**Observed — the chip is an FT232R.** `bcdDevice=0x0600`. Not the FT232BM the INF's vintage
suggested. The baud divisor encoding is the same on both, and it was already verified against
libftdi's published values, so this changes nothing about the maths - but it does make the EEPROM
readable in FT232R terms, where byte `0x0B` is the signal-inversion register. In this cable's
EEPROM that byte is `0x00`: **no inversion is configured.**

**Observed — at rest the pins read `0xFF` in 200 of 200 samples.** While transmitting, bit 0 (TXD)
is caught low in 13% of samples, as expected, and **bit 1 (RXD) never follows**.

**Observed — passive listening hears nothing** at 9600 or 10400 over three seconds each.

### What this eliminates

| Hypothesis | Verdict |
|---|---|
| The cable contains a microcontroller talking at a fixed rate of its own | **Dead.** It would have answered here too. |
| The receive line picks up crosstalk from our own transmit line | **Dead.** Same bytes were transmitted here with RXD never moving. |
| The transceiver inverts the returned signal | **Dead.** The FT232R inversion register is zero. |

So the cable invents nothing. Everything seen at the car came from the car's K-line, and the garbled
bytes are a consequence of our own transmission reaching a real bus and coming back distorted.

### What it does not settle

Steady-high RXD off the car proves less than it looks like: the chip's own pull-up holds an
unconnected input high too. The reading only becomes evidence when compared against the same
measurement taken at the car. The remaining question is whether the K-line pin is attached to a
working bus at all, and the four measurements that answer it - resting level, level while
transmitting, passive listen, and the baud hunt - now all run at the car as part of FULL RUN.

## Still open

Whether the cable is a "dumb" FTDI + K-line level shifter, or contains a microcontroller imposing
its own framing. This is the one question that decides the project. See
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
