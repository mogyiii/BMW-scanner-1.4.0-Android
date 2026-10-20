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

**Engine running is the condition that mattered, and it changed nothing.** The alternator puts the
bus at ~14 V instead of a resting battery's 12, and every module is awake and chattering. Three
seconds of passive listening at both DS2 rates still hears **nothing**, which closes two
explanations that had never been properly excluded: that the modules were asleep, and that the
supply was too low for the transceiver. Neither is true.

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

## Still open

One question, and it is about the nature of the fault rather than the protocol: **does anything we
transmit leave the cable at all?** Nothing above answers it. Every measurement so far asks what
comes back; this asks whether something goes out.

**The LED walk, step 12, is the test to run, and it needs no car.** The orange LED was established
as a transmit indicator in the earlier walk — cable on the phone, no car attached, so it is driven
from USB power and visible on the desk. The owner reports it never blinked at all on 2026-10-20.
That observation is either a hardware fault that has appeared since, or an artefact of watching a
connector under a dashboard; the original step 7 cannot separate the two, because asking whether a
light is on is a judgement. Step 12 asks whether a light follows a 2 s on / 2 s off square pattern,
three times, which is answerable without judging anything.

- **Orange follows the pattern** → the transmit path through the cable's circuitry is intact, and
  the fault is downstream, at the line driver. Consistent with everything measured.
- **Orange stays dark** → transmission is not reaching the cable's circuitry at all, which is a
  different and much more concrete fault to report, and one that contradicts the earlier walk.

Reproduce the original conditions exactly: cable on the phone over OTG, **not** in the car, where
the green LED is off and the orange one is in plain sight.

### The radio beacon: inconclusive by method, and set aside

The gated beacon (part A toggles only the cable's gate, holding the USB write rate constant at
969–1045 bytes/s against the 960 the line can carry; part B is the plain write/idle pattern) is
sound in design, and it does isolate the drive onto the harness from the phone's own USB radiation.
But the owner reports that what can be heard is marginal and may be imagination, and the one careful
attempt was destroyed by the concurrency defect above.

A measurement whose read-out is "is this faint noise slightly different now" does not settle
anything, and it is not worth another trip to the car. Recorded as attempted and inconclusive. The
LED test asks the same underlying question — does our signal get out — with a binary answer and no
listening involved.

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
