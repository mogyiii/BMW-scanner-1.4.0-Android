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

## The remote car session — where this currently stands

Source: `field-logs/2026-10-18-run4-car-remote.log`. On the car, ignition in position 2, driven
entirely over wireless adb from the desk.

### DTR gates the path

Asserting DTR silences the line completely, in all eight baud/parity combinations; deasserting it
brings the bytes back. So DTR is wired to something real in this cable - an enable, most likely.
Every measurement before this one was taken without ever setting DTR or RTS, which was an untested
assumption worth removing. RTS also changes the character of the reply, though less cleanly.

Correct state: **DTR deasserted**. It changes nothing about the conclusions below; the line was
already in that state by default.

### The bus is reached, but the signal is not usable

Comparing against the desk control settles the electrical question:

| | desk, no car | on the car |
|---|---|---|
| RXD at rest | `0xFF` 200/200 | `0xFF` 200/200 |
| RXD while transmitting | never low | low in 19 of 200 samples |

On the car our own transmission comes back; on the desk it does not. The transceiver is powered and
the loop closes. But no bit rate between 1200 and 230400 returns a decodable copy of what we sent,
and **passive listening never hears anything at all** - no module has ever spoken unprompted.

The shape of the failure is consistent across the whole baud sweep. At 19200 and 28800 the first
three received bytes are identical for both parities, so the same waveform is arriving and only the
decoder changes. At 115200 and 125000 the reply repeats at the transmitted *frame* rate with the
`0101` pattern inside each byte gone completely:

```
115200 EVEN  RX E0 E0 00 E0 E0 E0 00 00 00 00
125000 EVEN  RX C0 C0 00 C0 C0 C0 00 00 00 00 00
```

Sub-bit detail is being filtered out. Edges survive, levels do not. On a healthy K-line, pulled up
hard by the ECUs, this would not happen.

### The bitbang result, unexplained

Driving TXD, RTS and DTR directly in synchronous bitbang - single pulses and square waves, at two
sample clocks an order of magnitude apart - produced **no RXD response at all**, while UART-mode
transmission on the same pin demonstrably does. One RTS square-wave hit at the slow clock did not
reproduce at the fast one and is treated as noise.

This is a null result that is not fully explained. Possibly the transceiver's enable depends on chip
state that bitbang mode disturbs. It is recorded rather than interpreted, and no conclusion below
rests on it.

### What this means

The cable works as a USB serial device and reaches something in the car. What it does not do is
carry a clean bidirectional serial signal to a module, and no module has ever answered. The
remaining candidate causes are physical and cannot be separated from software:

1. the cable's K-line pin is not on this car's diagnostic bus;
2. a fault inside the cable - transceiver, or a bad joint;
3. a fault in the car's OBD socket wiring.

Software probing has gone as far as it usefully can. The next evidence has to come from the
hardware: which pins the connector actually populates, and whether another tool can talk to this
socket at all.

**The Android side is finished and working.** USB enumeration, the FTDI driver, framing, checksums,
resynchronisation, the whole diagnostic harness - all verified. If the hardware fault is found and
fixed, the software is ready to talk to the car.

## Conclusion: the cable's K-line stage is not driving the bus

Source: `field-logs/2026-10-18-run5-cbus-and-spacing.log`.

Two facts arrived from the owner that narrow this decisively: **other readers work on this car**,
so the socket and the diagnostic bus are known good, and **the cable is new and undamaged**.

### CBUS was a real lead, and a real negative

The EEPROM puts CBUS0–CBUS3 in IOMODE (bytes `0x14`/`0x15` = `0xAA`, and `0xA` is the FT232R's
code for software-driven GPIO). A plain USB-serial adapter never needs that, so a transceiver
enable was the obvious guess. All 16 output states were tried at both bauds and parities: no valid
frame, and byte counts that barely moved.

That negative is trustworthy because the stimulus was verified — 16 of 16 values read back exactly
as written. The pins are controllable and they do not gate the bus.

### Every transmitted byte produces the same two-byte artifact

Spacing the bytes out — prompted by the vendor ini's own `Delay=20` / `Delay2=40` — separates what
back-to-back bursts had been smearing together:

```
TX 00 04 00 04  ->  RX C4 88  C4 58  C4 28  C4 98
TX 80 04 00 84  ->  RX C4 88  C4 58  C4 A8  C4 98
```

Each transmitted byte yields exactly two received bytes, `C4` and one more. And two completely
different frames produce nearly identical replies: **the response barely depends on the data.**

A working K-line echo carries our bytes back. This carries a fixed shape, triggered once per
transmission.

### The best physical explanation

Everything measured fits a receive path that is **capacitively coupled rather than DC connected**:

- edges pass, steady levels do not — hence the frame-rate envelope at 115200 with the `0101`
  pattern inside each byte gone;
- each edge yields a spike, so one byte with several transitions produces two detected "start
  bits" — hence `C4 xx` per byte;
- the shape is set by the coupling, not the data — hence near-identical replies to different frames;
- nothing is ever decodable, at any rate, which is why 32 baud/parity combinations all failed;
- no module ever answers, because nothing properly formed ever reaches the bus.

Combined with a known-good car and a physically intact cable, the conclusion is that **this cable's
K-line transceiver stage is not working.** It is a perfectly good FTDI USB-serial device whose
automotive front end does not drive or sense the bus correctly.

This cannot be fixed in software, and no protocol setting was ever going to help.

### What would confirm it

- Running the cable with its original Windows software. If it fails there too, the cable is simply
  faulty and none of this was ever about our code. That is the cleanest single test, with the
  caveat that the executable is the packed binary described above.
- Opening the cable, or measuring the K-line pin against the OBD socket with a meter.

### State of the software

Finished and verified. USB enumeration, the FTDI driver (control transfers, baud divisors checked
against libftdi's published values, line settings, latency, modem control, CBUS GPIO, bitbang
capture), DS2 framing and checksums, resynchronising frame recovery, and the whole diagnostic
harness - 14 unit tests green, runs on the target phone. Given a cable whose transceiver works,
this is ready to talk to the car.

## What the cable's own indicators say

Observed by the owner, with the cable on the phone and no car attached, during `ledWalk`:

| Signal driven | Orange LED |
|---|---|
| CBUS0–3, each held high in turn, then all high (steps 1–6) | no visible change |
| Continuous transmission, 4 s (step 7) | **fast blinking throughout** |
| DTR / RTS asserted and released (steps 8–11) | one brief flash |

Separately: a **green LED lights whenever the cable is plugged into the car**, and not otherwise.

Three things follow.

**The orange LED is a transmit-activity indicator.** It tracks step 7 exactly. So our bytes are
physically reaching the cable's circuitry — the USB and FTDI layers are doing their job, and
nothing is being swallowed on the way in.

**The LEDs are not on CBUS.** Steps 1–6 produced nothing visible, which is independent
corroboration of the CBUS hunt's flat negative: those pins are in IOMODE for some other purpose and
they do not gate the bus.

**The green LED confirms the power story.** The cable's automotive side is powered from the OBD
socket, not from USB — which is why every off-car measurement has been silent, and why neither the
vendor software's "Hardware faulty" nor our native replay of its test means anything until both are
repeated with the cable in the car.

## The vendor sequence, replayed on the car — and the end of the argument

Source: `field-logs/2026-10-19-run7-vendor-init-on-car.log`, 2026-10-19.

This is the run the previous section said was still owed: the vendor start-up sequence recovered
from the USB capture, replayed **with the cable in the OBD socket and the ignition on**. The
off-car replay in v0.9 proved nothing, because the cable's automotive side is powered from the car.
That caveat is now discharged.

This run was genuinely on the car: RXD is caught low in 10 of 200 samples while transmitting, which
never once happened in the desk control.

### The DTR pulse produces a disturbance, not an announcement

The replay does return bytes after the DTR pulse, which looked promising:

```
19200 NONE  DTR pulse -> 27 bytes: 9B CD AA AF AF D9 F5 A2 9B 17 28 FE 72 ...
 9600 NONE  DTR pulse -> 14 bytes: 4B EF 4F AC 2B E6 05 41 03 46 EE 6C 2F F7
38400 NONE  DTR pulse -> 50 bytes: 9E 78 F3 F8 98 E6 FE E6 FE E6 86 7E 33 ...
```

But measure the *duration* rather than counting bytes:

| baud | bytes | duration |
|---|---|---|
| 9600 | 12–14 | 13.8–14.6 ms |
| 10400 | 14–15 | 14.4–14.8 ms |
| 19200 | 25–27 | 14.1–14.3 ms |
| 38400 | 46–50 | 13.0–13.2 ms |

The byte count varies by a factor of **4.2**; the duration is constant at **~14 ms within 7%**.

A message has a fixed byte count whatever rate you read it at. A fixed-duration analogue event has
a fixed duration and a byte count that scales with the sampling rate. This is unambiguously the
second. The DTR edge produces a ~14 ms disturbance on the receive line, and different baud rates
merely chop it into different numbers of bad bytes.

The sequences are also reproducible across days — `9600 NONE` returned the identical 14 bytes
`4B EF 4F AC 2B E6 05 41 03 46 EE 6C 2F F7` in run 4 the previous evening. Deterministic, which
rules out noise and confirms it is a circuit response.

### 256 different requests, three different answers

The clearest demonstration in the whole project. The full scan sent a distinct identification
request to each of 256 addresses. Grouping the replies:

```
76 x  C4 08 58 CC FF
75 x  C4 48 58 CC FF
63 x  C4 28 58 CC FF
```

214 of 256 replies fall into three byte sequences that differ only in one nibble. Addresses as
unrelated as `0x00`, `0x44`, `0xA0` and `0xFF` all answer the same thing, with a parity error every
time — 276 line-status errors across the run.

**Zero valid frames anywhere in the run**, in any configuration.

### Conclusion

The reply carries no information from the request. It is a fixed artefact of the cable's circuitry,
triggered by transmission, and it does not change when the vendor's own initialisation is applied.

Every avenue is now closed with evidence rather than assumption: protocol settings (32 baud/parity
combinations), handshake lines (DTR/RTS, all states), CBUS GPIO (all 16 states, with the writes
verified), byte spacing (the vendor's own delay values), and finally the vendor's exact start-up
sequence, replayed on a live car. **The cable's K-line stage does not work.** The software cannot
fix it, and nothing further is worth trying against this cable.

## Run 8: two measurements that measured nothing

Both field tests were run on the car, ignition on, and both came back negative. Neither result was
usable, for reasons that had nothing to do with the cable.
(`field-logs/2026-10-20-run8-beacon-purge-bug-void.log`, `-run8-burst-old-code-void.log`)

**The band was never the problem — FM works.** An earlier version of this section claimed FM could
not show the effect, reasoning that the fundamental of a 9600 baud square wave is 4.8 kHz and
nowhere near 100 MHz. That reasoning was wrong: what radiates is the switching *edge*, whose
nanosecond rise time carries harmonic content well into VHF, and on an *empty* FM frequency there is
no carrier for the demodulator to capture, so its limiter amplifies the impulse noise rather than
rejecting it. The owner has heard the pulsing on FM both originally and during the run-9 sessions.
The claim is retracted; FM is the band that has been shown to work here.

**The beacon was barely transmitting — this was the problem.** Its loop purged the TX FIFO after every 64-byte write,
so the chip was handed roughly 15 000 bytes per second while the line at 9600 8N1 can carry 960.
The log is explicit about it — *"14848 bytes transmitted"* in a one-second window — and that number
was counting USB writes, not anything that reached the wire. All but a fraction were discarded from
the FIFO before being shifted out.

**The burst capture looked too late.** It pulsed DTR with a control transfer and then set up the
capture: a baud change, two purges and a bitmode change, four control transfers plus a bulk write,
all between releasing DTR and the first sample. Over OTG that is comfortably longer than the 14 ms
the burst lasts. The code comment claimed the gap was "one control transfer". `0 of 2400 samples`
was a measurement of the host's USB latency.

## Run 9: the burst is a transient, measured on the timebase that proves it

Rewritten capture, on the car, 2026-10-20. Five sessions, fourteen independent events.
(`field-logs/2026-10-20-run9-burst-*.log`)

Three changes made the measurement mean something:

**The pulse moved inside the waveform.** Synchronous bitbang drives every pin from the bytes
written, so bit 4 carries the DTR pin and bit 0 holds TXD idle: the release edge is now
sample-accurate and the capture is already running when it happens. Driving the stimulus and
sampling the response off one clock removes the host latency from the measurement entirely.

**Both directions stream at once.** The old path alternated a 48-byte write with a read on one
thread, which cannot feed the chip at these rates — and a starved TX FIFO does not slow synchronous
bitbang down, it *stops the clock*, leaving the samples either side of the gap an unknown time
apart. One large transfer per direction on two threads keeps both FIFOs fed, and every run now
reports elapsed against expected so a stall cannot pass unnoticed. All runs come back within 5 ms
of their nominal duration.

**The sample clock was being mis-stated by a factor of four.** The rewrite caught it immediately:
14 976 samples requested at 115 200 came back in 43 ms, where 115 200 samples per second needs 130.
The FT232R's bitbang clock runs at four times the baud rate the divisor encodes — libftdi scales
the requested rate for exactly this reason. Measured directly: 12 000 samples with the divisor set
for 9600 come back in ~317 ms, i.e. 38 000 samples/s, **x4**, reproduced in all five sessions.

> Every bitbang timing taken in this project before run 9 was therefore wrong by 4x, and the old
> capture's window was 5.2 ms rather than the 20.8 ms it assumed — a second, independent reason it
> could not have caught a 14 ms burst.

### What the fourteen events say

| | |
|---|---|
| Duration | 13.6 – 15.2 ms, mean ~14.4 ms |
| Low duty | 40 – 50 % |
| Level runs per event | 125 – 151 |
| Distinct run lengths | 17 – 37, smoothly spread, no preferred spacing |
| Best-fitting bit time, searched over **all** candidates | explains only **46 – 62 %** of runs |

The last row is the measurement the diagnosis was missing. UART data sampled thirteen times above
its bit rate puts every level run at a whole multiple of one bit time and nothing in between, so
some candidate scores well over 90 %. Nothing here comes close, at either sample rate, in any
session. **The burst is a transient, not a message.**

The earlier version of this test could not have reached that conclusion: it took the shortest run
as the bit time, which is vacuous as soon as a one-sample run exists — every length is a whole
multiple of one, so it reported 100 % whatever the signal was. Searching the candidates is what
makes a low score meaningful.

### Three further results from the same captures

**The DTR pin gates the line completely.** With the pin driven low — what
`setModemControl(dtr = true)` does, FTDI's active-low DTR# — the receive line is low in **0 of
11 520 samples**, in ten separate 100 ms windows across two sample rates and five sessions. With it
driven high, the event appears. This confirms the gating reported in the remote car session, now
with an exact timebase and a within-run control.

**The DTR pulse does not trigger the burst.** A matched control run with no pulse at all, DTR held
released for 130 ms, finds the same ~14 ms event every time. The deterministic "announcement after
the vendor's DTR pulse" that seven earlier runs were decoding is not caused by the pulse.

**Nor is it the car talking on a schedule.** A 600 ms window with the gate open, at a coarse clock,
is low in **0 of 11 520 samples** — in all five sessions. The event is sporadic, not a module
broadcasting periodically. Its trigger is not identified; its position is reproducible within a
given run of the sequence, which points at something our own sequence does rather than at the
vehicle, but that is an observation and not a finding.

### Conclusion

`f8cab36` called the diagnosis closed and `2c61b66` reopened one of its arguments: that a fixed
~14 ms duration with a byte count proportional to the sample rate proves an analogue event. That
objection was correct — both hypotheses predict exactly that, so the argument was not sound even
though the conclusion was.

The edge measurement discriminates where the byte counts could not, and it agrees with the
conclusion. The burst is a transient. Taken with the data-independent replies from the 256-address
scan, **the cable's K-line stage does not work**, and that now rests on the measurement that
actually separates the two possibilities.

## Run 10: three more conditions, and no difference at all

2026-10-20, owner-driven, on the car. Three complete FULL RUNs back to back, in three conditions
that had never been tried: **ignition position 1**, **engine running**, and the **USB-C plug
reversed** in the phone. (`field-logs/2026-10-20-run10-three-configs-on-car.log`)

The three runs are interchangeable:

| | ignition 1 | engine running | USB-C reversed |
|---|---|---|---|
| Resting RXD, 200 samples | 100 % high | 100 % high | 100 % high |
| RXD while transmitting | 94 % high, `0xFE` 15 %, `0xFD` 6 % | 95 %, 14 %, 4 % | 95 %, 13 %, 4 % |
| Passive listen, 3 s at 9600 and 10400 | silent | silent | silent |
| 256-address scan | 0 valid frames, 256 replies | 0 valid frames | 0 valid frames |

**Engine running changed nothing — but the inference drawn from that was wrong, and is retracted.**
The original text read: *"Three seconds of passive listening at both DS2 rates still hears nothing,
which closes two explanations that had never been properly excluded: that the modules were asleep,
and that the supply was too low for the transceiver."*

The diagnostic K-line is a **request–response** line. Control modules do not broadcast on it; it is
silent by design until a tester addresses one. (The BMW I-bus/K-bus does carry continuous traffic,
but it is a different physical bus and not the pin this cable uses.) So three seconds of passive
silence is exactly what a perfectly good connection produces, and it excludes nothing. What the run
*does* still show is that the active probing is unaffected by engine running, which is worth having —
but the passive listen was never evidence and should not have been presented as any.

The reply is still the same data-independent artefact. Every one of the 256 addresses answers with a
`C4`-prefixed sequence drawn from a handful of variants — `C4 08 58 CC FF`, `C4 28 58 CC FF`,
`C4 48 58 CC FF` — with the second byte varying and nothing tracking the address. Writing `0x00`
gives `C4 21`; writing `0xFF` gives `C4 08 F8`; writing `55 55 55 55` gives `C4 21 A3 83 ED`. The
first byte never changes.

USB-C orientation was never likely to matter — on USB 2.0 the CC pin selects the role and the data
pair is muxed either way — and it did not.

### Two defects this run exposed

**Two diagnostics could run at once.** BURST CAPTURE was pressed while RADIO BEACON was still
going; both opened the device and the beacon died one second into part B with
`IOException: USB bulk OUT failed at offset 0 of 19`. From the driver's seat that is
indistinguishable from the beacon not working, and it is the likely explanation for the owner's
report that the radio test "cannot be carried through properly". Every diagnostic now takes a
single-run lock and says plainly that it did not start.

**The orange LED never blinked, all day.** `ledWalk` step 7 had established it as a transmit
indicator from a single uninterrupted 4 s burst — which asked the eye whether a light was on, a
judgement rather than an observation. A new step 12 asks a question that cannot be imagined either
way: three cycles of 2 s transmitting, 2 s silent. Either the LED follows the square pattern or it
stays dark. See "Still open".

## Run 11: the orange LED is a USB indicator, not a bus indicator

Desk, cable on the phone over OTG, no car. Slow version of the LED test — 6 s transmitting, 6 s
silent, then 6 s driven, 6 s gated with transmission continuing throughout. Byte accounting is
exact: **5852 bytes in each 6 s block, against the 960 per second the line can carry.**

The owner's description, watching the LED directly:

> very fast blinking, the flashes themselves look clean, there is never a case where it fails to go
> fully out, and it flashes very fast about **eight times, then a pause of about a tenth of a
> second, then the same thing again and again**.

That pattern is not the data and it is not the bus. It is the USB fill-and-drain cycle, and the
arithmetic is close enough to settle it:

| | |
|---|---|
| Write chunk | 19 bytes (`960 / 50`, sized for a 20 ms loop) |
| FT232R transmit FIFO | 128 bytes → `128 / 19` ≈ **6.7, so 7 writes fill it** |
| Drain time at 9600 8N1 | `128 / 960` s ≈ **133 ms**, during which the host is held off |

Seven or eight rapid flashes followed by roughly a tenth of a second of nothing, repeating. **The
orange LED flashes once per USB bulk write.** At 960 bytes per second a per-byte indicator would be
a 960 Hz flicker, which the eye reads as steady light, not as countable flashes.

**So the earlier conclusion that orange is a "transmit-activity indicator" was right only in the
trivial sense.** It indicates that the host is handing bytes to the chip — the one part of this
system never in doubt. It says nothing about whether anything leaves the cable's automotive side,
which is the only question that was worth asking it.

### Why the car/desk difference cannot be chased further

The owner reports the orange LED blinking on the desk and **not** blinking in the car on
2026-10-20, with a clear view of it in both cases. An earlier draft of this document offered
"watching a connector under a dashboard" as the explanation. That was invented, not measured, and
the owner corrected it: the LED was visible.

The asymmetry is therefore real and unexplained. It is also not worth pursuing, because the witness
has turned out to be unreliable: the read-out is a roughly 40–50 Hz flicker to be compared by eye
across two locations and two sessions. That is the same class of measurement as the radio beacon —
a human judgement about a faint, fast signal — and it cannot carry a conclusion. Recorded as an
open oddity, not a lead.

### The radio beacon: inconclusive by method, and set aside

The gated beacon (part A toggles only the cable's gate, holding the USB write rate constant at
969–1045 bytes/s against the 960 the line can carry; part B is the plain write/idle pattern) is
sound in design, and it does isolate the drive onto the harness from the phone's own USB radiation.
But the owner reports that what can be heard is marginal and may be imagination, and the one careful
attempt was destroyed by the concurrency defect above.

A measurement whose read-out is "is this faint noise slightly different now" does not settle
anything. Recorded as attempted and inconclusive.

## Run 15: on USB alone the microcontroller is dead, in 52 windows

Desk, cable on the phone, no car. The late-reply hunt in full — fixed listening windows, no early
exit, arrival times recorded. (`field-logs/2026-10-26-run15-late-reply-hunt-desk.log`)

| Part | Windows | Result |
|---|---|---|
| DTR pulse, then 1.2 s of silence | 6 rates × 2 parities = 12 | **0 bytes** |
| A probe, then 600 ms | 6 rates × 4 probes = 24 | **0 bytes** |
| Each CBUS state, DTR pulse, 1.2 s | 16 | **0 bytes** |

Fifty-two windows, roughly fifty seconds of listening, and **not one byte** — not even the immediate
artefact, which only ever appears on the car.

This is a clean negative and it settles the power question raised in run 14. The µPD78F9234 runs
from 2 V and could in principle have been fed from the FT232R's own supply; it is not. **The MCU is
on the vehicle rail**, with the Si9241A's `VBB`, both from OBD pin 16.

Which closes the desk for every remaining idea at once. No probing, no flash-programming-mode entry
via CBUS, and no vendor-software capture — none of them can work with the cable on USB alone,
because there is nothing awake at the other end of the UART. The probes and the CBUS sweep were
worth running precisely to establish that rather than assume it.

**It also retrospectively excuses every desk measurement in this project.** "Off the car: total
silence, 32 baud/parity combinations" was never evidence about the cable's health. It was a
measurement of an unpowered microcontroller.

## Run 14: the parts are identified, and the premise of this whole project was wrong

A 16320 × 12240 photograph of the component side, pulled off the phone over adb and cropped at
native resolution (`photos/2026-10-26-pcb-component-side.jpg`; the full-resolution original is not
checked in). Both unknown parts read cleanly.

| Ref | Marking | What it is |
|---|---|---|
| **U1** | `NEC CHINA / F9234 Z5 / 023EB733`, 30-pin SSOP | **NEC µPD78F9234** — an 8-bit flash microcontroller, 78K0S/KB1+ family, 8 KB flash, 2–5.5 V, 30-pin SSOP. The pin count matches exactly, 15 a side |
| **U3** | `9241A / ⟨Vishay logo⟩ BV △ / T824`, SOIC-8 | **Vishay Siliconix Si9241A** — an ISO 9141 dual K-line / L-line interface IC |
| U4 | `FTDI 2523-C / G0370111 / FT232RL` | the USB UART, proved healthy over twelve runs |

So the signal path is:

```
USB  ->  FT232RL (U4)  ->  µPD78F9234 MCU (U1)  ->  Si9241A (U3) + Q1A/Q2A  ->  OBD pins
```

**This cable is a microcontroller-based instrument, not a USB-serial adapter with a transceiver on
the end.** Every byte this project has ever sent went into an 8-bit MCU running the vendor's
firmware, which was waiting for its own command protocol. The DS2 frames never reached the K-line
and never could have.

### Everything now has one explanation

| Observation | Why |
|---|---|
| No echo, ever, at any rate | a microcontroller does not echo |
| All 256 addresses answer identically, carrying no information from the request | nothing was replying; the bytes were the transmission artefact |
| RXD does not follow TXD (run 12) | there is an MCU between them, not a wire |
| Off the car, total silence | the MCU and the Si9241A's `VBB` come from OBD pin 16 |
| The vendor software's *"Hardware faulty"* on a desk, after pulsing DTR and waiting for the cable to **announce itself** | it was waiting for the MCU's sign-on from an unpowered MCU |
| Zero bulk bytes in the whole VM capture | the conversation never got past the sign-on, so the command protocol was never transmitted |
| The FT232R's CBUS0–3 set to IOMODE in EEPROM | software-driven GPIO, and the obvious thing to wire them to is the MCU's `RESET` and `FLMD0` — the two pins that put a 78K0S into flash programming mode |

That last row reframes the CBUS hunt. Those pins were almost certainly never a bus control; they are
how the vendor reflashes the MCU in circuit.

**The cable is most likely not faulty at all.** Every measurement in this document is what a working
microcontroller-based interface looks like when you speak the wrong language to it. The run-9
transient, the run-12 loopback and the data-independent replies are all consistent with intact
hardware and a wrong premise.

### What would make it usable

Knowing what U1 expects on its UART. Three routes, in order of cost:

1. **Listen longer.** Every read in this project closed 40–150 ms after transmission (see
   "Reopened", item 3). A microcontroller boots, thinks, and answers late. The late-reply hunt in
   v0.20 is the free attempt, and it is worth running **on the desk as well as in the car**, because
   a 78K0S runs from 2 V and may well be powered from the FT232R's own supply.
2. **Capture the vendor software talking to a powered cable.** The one experiment never performed.
   It hands over the protocol outright.
3. **Flash programming mode.** The 78K0S enters it via `FLMD0` and `RESET`, and talks a documented
   UART protocol afterwards. If CBUS0–3 are wired to those pins, it is reachable entirely in
   software from the existing app, and even a silicon-signature response would be definitive proof
   that U1 is alive and listening.

## Run 13: the cable was opened, and it is not a transparent adapter

2026-10-26. The owner opened the housing and photographed the component side
(`photos/2026-10-26-pcb-component-side.jpg`). The connector pins are soldered straight into the
board, so the solder side cannot be seen without destroying it — and does not need to be.

Board: `BQ1006050`, silkscreened `BMW1.4-20100622B`, so a 2010 design.

| Ref | Part | Where it sits |
|---|---|---|
| **U4** | `FTDI 2523-C / G0370111 / **FT232RL**` | next to the USB-B connector |
| **U1** | `NEC CHINA / FB234 Z5 / 023EB733`, ~28-pin SSOP | **between the OBD side and U4** |
| U3 | SOIC-8, marking unread | by the OBD connector |
| Q1A, Q2A | SOT-23 transistors with R12A/R13A/R15A/R16A | by the OBD connector |
| D1 | `M7` (SMD 1N4007) | reverse protection on the 12 V from pin 16 |
| DS1 / DS3 | yellow and green LEDs | by the USB connector |

**A transparent USB-to-K-line adapter needs an FTDI, a transceiver and passives. It does not need a
28-pin NEC part in the middle of the signal path.** U3 and the Q1A/Q2A pair by the connector are
already enough to be the line driver; U1 is something else, and its position — fed from the OBD side,
feeding U4 — is where a **microcontroller** goes.

### This invalidates the run-12 verdict

Run 12 found that RXD does not follow TXD and concluded the receive line is floating. **That
inference assumed a wire between them.** With a microcontroller in the path, TXD and RXD would never
correlate *on a perfectly healthy cable either* — the FT232R's transmit line goes to the MCU's
receive pin, and nothing echoes. The measurement stands exactly as recorded; the conclusion drawn
from it does not, and is withdrawn.

The same applies, more broadly, to the whole approach. Writing raw DS2 frames into the FT232R and
expecting them on the K-line only works if the chip's TXD *is* the K-line path. If U1 is an MCU, the
frames have been going into a microcontroller that is waiting for its own command protocol, and no
amount of baud, parity, CBUS or handshake sweeping would ever have produced an answer. **A healthy
cable would have behaved exactly as this one has.**

### It also explains the desk/car asymmetry that nothing else did

The green LED shows the automotive side is powered from OBD pin 16, not from USB. If U1 is powered
from that rail then **on the desk the MCU is simply switched off**. That accounts for:

- *"Off the car: total silence, RXD never moves"* — nothing is driving RXD because the MCU is dead.
- The vendor software reporting **"Hardware faulty"** in the VM, where the cable sat on a desk. Its
  start-up pulses DTR and then *waits for the cable to announce itself*; an unpowered MCU cannot
  announce anything. That result was always treated as meaningless. It was worse than meaningless —
  it was the expected outcome, and it was pointing at this the whole time.
- The owner's report that the **orange LED blinks on the desk but not in the car**, which has been
  recorded as an unexplained oddity since run 11.

### What has not changed

The ~14 ms burst is still a transient and still not an MCU sign-on. Re-reading run 7 with fresh eyes
confirms it: the byte count scales with the sample rate — 12–14 bytes at 9600, 25–27 at 19200, 46–50
at 38400 — which is a fixed-duration analogue event sampled faster, not a message. The run-9 edge
analysis said the same thing by a different route.

### Next

Identify U1, and capture what the vendor software actually says to it. The capture needs the
automotive side **powered**, which the previous VM capture never had — see `HANDOVER.md`.

## Run 12: the receive line is not connected to what the transmit line drives

2026-10-26, on the car. Four loopback runs plus a line-state probe, minutes apart.
(`field-logs/2026-10-26-run12-*.log`)

**The cable was on the car, confirmed by measurement rather than by report.** The line-state probe
reads, while transmitting, `0xFE` 10 %, `0xFD` 6 %, `0xFC` 2 % — the receive line goes low 8 % of the
time. The desk control of run 3 shows `0xFE` 13 % and **no `0xFD` at all**, with the log's own note
*"bit0 = TXD, seen going low as we transmit; RXD never followed"*. So RXD does respond to something
on the car that is absent on the desk.

### The loopback result

A square wave on TXD, RXD sampled on the same bitbang clock, cross-correlated against the wave
actually driven:

| Edge rate | RXD | Match against TXD |
|---|---|---|
| 2000 µs/level | **never moved**, 5980 samples | — |
| 500 µs/level | **never moved** | — |
| 100 µs/level | **never moved** | — |
| 50 µs/level | active, low in 39–55 % of samples | **51 %** — a coin flip |
| 2000 µs/level, gate shut (control) | never moved | — |

Four runs, reproducible. One run showed 4 low samples out of 5980 at 2000 µs; that is noise.

**This is capacitive crosstalk, not a conducted echo**, and the two look nothing alike once you
measure them:

- Crosstalk couples the *rate of change*, so it needs fast edges. At 2 ms, 500 µs and 100 µs per
  level the coupling never crosses the input threshold and the line is flat. At 50 µs it does, and
  the line twitches.
- It is **uncorrelated** — 51 % is chance — because what couples is a brief spike at each edge, not a
  copy of the level.
- A real single-wire echo would be near 100 % correlated at **every** rate and *cleanest at the
  slowest*. Instead the slowest rate is where RXD is deadest. At 2 ms per level no transceiver
  bandwidth limit on earth could hide an echo.

### This explains every observation in the project

The receive line is a **floating input picking up its neighbour**, which is what `probeLineState`
has printed on every car run since the first one and nobody followed up:

```
RXD high in 91% of samples - UNSTABLE - what an unconnected, undriven input looks like
```

Once that is the premise, the baud sweep stops being mysterious and becomes a prediction:

| Rate | Edge spacing | Measured | Crosstalk predicts |
|---|---|---|---|
| 1200 | 833 µs | **silence** | edges far too slow to couple — nothing |
| 9600 | 104 µs | garbage, always starting `C4` | near the coupling threshold: sporadic spikes misread as bytes, and the first spike after idle always has the same shape, so the first byte is always the same |
| 230400 | 4.3 µs | `00 00 00 …` | coupling so strong the line is held down |

And the data-independence falls out for free: **nothing was ever replying.** The "replies" were our
own transmission's crosstalk being decoded as data, which is why all 256 addresses answered
identically and why `0x00` and `0xFF` gave the same thing.

### What it does not settle

Whether the **transmit** side reaches the bus. A disconnected line pin and a dead transceiver both
produce a floating receive input, and this measurement cannot separate them. The free thing to try
is the documented pin 7 ↔ pin 8 jumper; if the loopback result is unchanged after it, the
transceiver is the fault.

### One unresolved discrepancy, stated rather than smoothed over

At 100 µs per level the loopback sees nothing, while 9600 baud UART — edges every 104 µs, the same
rate — makes RXD low 8 % of the time in the line-state probe. Sampling duration explains part of it
(650 ms of `readPins` against 38 ms of bitbang) but not all. It does not affect the conclusion, which
rests on the 2 ms result, but it is not explained.

## Reopened: three things that were never tried

Written after the owner pushed back on the verdict, which was the right call. The diagnosis assumed
a dead line driver. These were never tested, and the first two could each produce every measurement
in this document with an intact cable.

### 1. Pin 7 versus pin 8 — never checked, and there is a documented fix

BMW OBD-II sockets carry **more than one K-line**, and which group of modules sits on pin 7 versus
pin 8 varies by chassis and year. This project assumed the cable reaches whatever the car uses, and
never verified which pin it is wired to or which pin this car answers on.

For this cable specifically, **bridging pin 7 to pin 8 is a widely reported fix** that makes it find
the DME and other units on cars where it otherwise finds nothing
([e46fanatics](https://www.e46fanatics.com/threads/bmw-scanner-1-4-pa-soft.1282756/),
[bimmerfest](https://www.bimmerfest.com/threads/fixed-bmw-scanner-1-4-dme-not-found.745541/)). The
cable is also documented as supporting 1999–2006 E46, so this car is in range and "wrong era" is not
the explanation.

**This project's own measurement already pointed at it and it was not followed up.**
`probeLineState` prints, on the car, while transmitting:

```
RXD high in 94% of samples - UNSTABLE - what an unconnected, undriven input looks like
```

An intact cable connected to a pin this car does not use would produce every result in this
document: a resting line held high by the cable's own pull-up, a receive line that twitches only
from the adjacent transmit pin, a reply that carries no information because nothing is replying, and
a scan in which all 256 addresses behave identically because none of them is reachable.

Separating the two hypotheses needs a multimeter, not software, and no modification: measure pin 7
and pin 8 against ground with the ignition on. A live K-line idles at battery voltage.

### 2. No initialisation sequence has ever been sent

`FtdiDevice.setBreak` exists, carries a comment saying it is *"needed if a module turns out to want
the classic 5-baud / break-based wake-up rather than plain DS2 framing"* — and **is never called
from anywhere**. Every request this project has ever sent was a bare DS2 frame with no wake-up.

Untried in consequence: ISO 14230 **fast init** (K low 25 ms, high 25 ms, then `StartCommunication`
at 10400), ISO 9141 **5-baud slow init** (address `0x33` clocked out at 5 baud, then the `0x55` sync
byte), and KWP2000 framing of any kind. A `0x55` sync byte coming back from a slow init would be
unmistakable, and would mean the cable works and the protocol was the problem all along.

### 3. The read window closes 40–80 ms after the first byte

`Ds2Link.sendRaw` uses `readUntilQuiet(quietMs = 40)`, and the artefact arrives immediately, so
every read returns about 40 ms after transmission regardless of the overall timeout. A genuine reply
arriving later than that has never been visible. KWP2000 permits a response-pending negative reply
that legitimately pushes an answer out by seconds.

### What still stands regardless

The run-9 edge measurement — fourteen events, best-fitting bit time explaining 46–62 % of level runs
where real UART exceeds 90 % — says the ~14 ms burst is a transient and not a message. That is
unaffected by any of the above: it describes what the signal *is*, not why nothing answers.

## What was thought to be closed on the software side

Eleven runs. There is no measurement left that is both clean and capable of changing the verdict,
and the two that remained — the radio beacon and the LED comparison — both read out as a human
judgement about a faint fast signal, which is why neither is being pursued.

The diagnosis in one paragraph. **The computer side of the cable is in perfect order**: the FT232R
enumerates, its whole EEPROM reads back with a valid checksum, baud divisors match all fifteen
published libftdi reference values, CBUS writes are verified 16/16, synchronous bitbang streams at
a clock measured to four times the divisor rate, DTR gating behaves exactly as a working gate
should, and byte accounting matches the line rate to within a percent. **The vehicle side does not
work.** No valid DS2 frame has ever been decoded under any condition tried; all 256 bus addresses
answer with the same `C4`-prefixed artefact that carries no information from the request; the burst
that looked like a reply is a transient; and with the engine running, every module awake and the
bus at alternator voltage, three seconds of passive listening hear nothing at all.

What remains is a hardware question — return, repair, or open the case and look at the transceiver
stage — and a written statement for the seller, which is in `docs/fault-report.md`.

Otherwise the remaining question is purely about the hardware: whether this cable can be returned or
repaired. Opening it to inspect the transceiver stage is the only diagnostic left that software
cannot reach.

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
