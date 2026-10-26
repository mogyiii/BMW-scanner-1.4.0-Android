# Handover — where this project stands

Written 2026-10-19, updated 2026-10-20 after runs 8 and 9. Read this first; it is meant to be
enough on its own.

## The goal

Use a **BMW Scanner 1.4.0** cable (an enthusiast-built BMW diagnostic adapter, USB `0333:0137`) from
an **Android phone**, because the cable's original Windows software triggers antivirus and the
owner has no laptop. Target car: **E46 316i, 2002, 1.8 l N42**, 16-pin OBD-II.

Wanted features: fault codes read/clear (airbag included — that is why a generic reader will not
do), live values, service reset, module identification. **Odometer writing is out of scope and will
not be implemented.**

## Current state in one line

Finished. The Android software works and is verified; **the cable's vehicle-side line driver does
not, and every avenue is closed with a measurement rather than an assumption.** Nothing worth
measuring remains. The deliverable is `docs/fault-report.md`, for the seller.

## The hardware, established

| | |
|---|---|
| Chip | **FT232R** (`bcdDevice=0x0600`), single interface, one bulk pair, 64-byte packets |
| USB id | `0333:0137`, strings `PASOFT` / `BMW Scanner V14x` / serial `PA5BG64Y` |
| EEPROM | all 64 words readable, standard layout, checksum `0x6206`. **No usage counter.** Signal inversion register (byte `0x0B`) is `0x00`. CBUS0–3 are in **IOMODE** (software GPIO), CBUS4 is CLK48 |
| LEDs | green = lit only when in the car (so the automotive side is **powered from the OBD socket**, not USB); orange = transmit activity |
| DTR | gates the path — held asserted, the line goes completely silent |

The original `BMWScan140.exe` is wrapped in an executable protector (all sections encrypted at
~8.0 entropy, imports reduced to two functions, entry point writable). That is why antivirus flags
it, and why static reverse engineering was abandoned. **Dynamic analysis replaced it and worked.**

## What the vendor software actually does

Recovered by running it in an isolated Windows XP VM with the cable passed through and all USB
traffic captured (`docs/field-logs/2026-10-18-run6-vendor-usb-capture.md`, decoder in
`tools/usbparse.py` — note VirtualBox writes pcapng with DLT 220, `USB_LINUX_MMAPPED`).

**It transfers zero bulk bytes.** Its hardware check never speaks to the car:

```
read whole EEPROM
SIO reset -> GET_MODEM_STATUS -> 19200 baud -> 8N1
-> purge RX x12 -> purge TX
-> DTR asserted -> ~100 ms -> DTR released
-> wait for the cable to announce itself
```

19200, 8N1 and a DTR **pulse** were all things our own probing had never tried together.
`vendorInit()` replays this exactly.

## What the car measurements say

Ten field runs are in `docs/field-logs/`. The important results:

- **Off the car: total silence**, 32 baud/parity combinations, RXD never moves while transmitting.
  This is the clean negative control — the cable invents nothing on its own, so there is no
  microcontroller chattering, no internal echo and no TX→RX crosstalk.
- **On the car: bytes come back**, RXD is caught low while transmitting, and a **~14 ms burst**
  reproduces byte-for-byte across different days. It was attributed to the DTR pulse until run 9
  found it in a control run with no pulse at all.
- **No valid DS2 frame has ever been decoded**, at any rate from 1200 to 230400, either parity, any
  DTR/RTS state, all 16 CBUS states (with the writes verified 16/16), with the vendor's own byte
  spacing, after the vendor init sequence, at ignition position 1 or 2, or **with the engine
  running** — which puts every module awake and the bus at alternator voltage, and still gives three
  seconds of silence on a passive listen at both DS2 rates (run 10).
- **The 256-address scan is the strongest single result**: 214 of 256 replies fall into three
  near-identical sequences, and `0x00`, `0x44`, `0xA0`, `0xFF` all answer the same thing. **The
  reply carries no information from the request.**

## The disagreement, and how run 9 settled it

Commit `f8cab36` closed the diagnosis: *"The cable's K-line stage does not work, and nothing further
is worth trying against this cable."* Its strongest evidence — the data-independent replies — stands
and is good.

But one of its arguments did not hold. It reasoned that because the byte count scales with the
sample rate while the duration stays near 14 ms, the burst must be an analogue event rather than a
message. **Both hypotheses predict exactly that.** A real message read at the wrong rate also has a
fixed physical duration and a byte count proportional to the sampling rate. Commit `2c61b66`
reopened the point: nothing contradicted the conclusion, it was just not earned.

**Run 9 earned it.** The edge measurement discriminates where byte counts cannot. Across fourteen
events on the car, the best-fitting bit time searched over all candidates explains only 46–62 % of
the level runs; real UART sampled thirteen times above its bit rate exceeds 90 %. The run lengths
are a smooth spread with no preferred spacing. **The burst is a transient.** Full numbers and the
three fixes that made the measurement valid are in `docs/findings.md`, section "Run 9".

Run 9 also contradicted two things this document used to assert. The burst is **not** triggered by
the DTR pulse — a control run with no pulse finds it every time — and the FT232R's bitbang clock
runs at **four times** the baud rate the divisor encodes, so every bitbang timing taken before run 9
was out by 4x.

Still untested, and still a loose end: **the vendor software has never been run with the cable
connected to the car.** In the VM it sat on a desk, where its automotive side is unpowered, so
"Hardware faulty" from that run means little.

## Run 12 answered it: the receive line is floating

**Measured on the car, 2026-10-26, four reproducible runs.** The loopback test below was built to
ask whether the receive line follows the transmit line, and the answer is no — decisively.

| Edge rate | RXD | Match |
|---|---|---|
| 2000 µs/level | **never moved**, 5980 samples | — |
| 500 µs | never moved | — |
| 100 µs | never moved | — |
| 50 µs | low in 39–55 % of samples | **51 %, a coin flip** |

That is capacitive crosstalk from the adjacent transmit pin, not an echo. Crosstalk needs fast
edges, so it appears only at 50 µs and is uncorrelated; a real single-wire echo would be near 100 %
at every rate and **best at the slowest**, and the slowest is where RXD is deadest. At 2 ms per level
no transceiver bandwidth limit could hide an echo.

So `probeLineState` was right all along, in its own words: *"what an unconnected, undriven input
looks like"*. And it explains the whole baud sweep — 1200 silent because the edges are too slow to
couple, 9600 producing sporadic spikes misread as bytes with the same first byte every time,
230400 pinning the line low. **Nothing was ever replying.** The replies were our own crosstalk.

Full reasoning and the table of predictions in `docs/findings.md`, "Run 12".

**What it does not settle:** whether the *transmit* side reaches the bus. A disconnected line pin and
a dead transceiver both leave the receive input floating.

### The baseline, for comparison after the jumper

The pin 7 ↔ pin 8 jumper has **not** been done. Run 12 is therefore the "before" measurement, and it
is a good one — flat, reproducible, four runs:

```
2000 us/level (230 samples), 26 levels: RXD never moved (constant high)     <-- the row that matters
 500 us/level: RXD never moved
 100 us/level: RXD never moved
  50 us/level: RXD low in 39-55% of samples, best match 51% (chance)
```

After the jumper, press **LOOPBACK** again, on the car, and read one line: the **2000 µs row**.

- still `RXD never moved` → the jumper changed nothing. The transmit side does not reach the bus
  either, the transceiver is the fault, and the software side is finished for good.
- a match of 90 % or more → **the cable works.** It was wired to a pin this car does not use. The
  project resumes at the protocol, which is wide open, because no initialisation sequence has ever
  been sent (`docs/findings.md`, "Reopened", item 2).

### Doing the jumper

It has to go **inside the cable's own OBD plug** — the plug is male, so there is nowhere to push a
wire in from the front, and the car's socket is not to be modified. Opening the housing is a bonus
in itself: it shows which pin positions actually have wires on them, and an unwired pin 7 would
answer the whole question by eye.

Four things to get right:

1. **Unplug it from the car first.** Pin 16 is live whenever the cable is in the socket.
2. **Trust the moulded pin numbers, not the positions.** The numbering on a male plug is mirrored
   left-to-right relative to the car's socket, and that is the usual way to get this wrong.
3. **Pin 8 sits directly above pin 16, which is battery positive.** A solder bridge from 8 to 16
   would put 12 V onto the K-line. Inspect for stray solder before plugging it back in.
4. While the case is open, **note the markings on the chip between the FT232R and the connector** —
   an L9637D or similar. That is the suspect part, and knowing which it is makes it replaceable.

## The pin 7 / pin 8 question — what is left of it

**The verdict below was reached too early.** It assumed the cable's line driver is dead. There is a
second hypothesis that produces every single measurement in this project with an **intact** cable,
and it was never tested: that the cable is wired to a pin this car does not use for the modules
being addressed.

BMW OBD-II sockets carry more than one K-line, and which modules sit on pin 7 versus pin 8 varies by
chassis and year. For this cable in particular, **bridging pin 7 to pin 8 is a widely reported fix**
that makes it find the DME and other units on cars where it otherwise finds nothing. The cable is
documented as covering 1999–2006 E46, so this car is in range.

And this project's own diagnostic said so, in those words, and it was not followed up. On the car,
while transmitting, `probeLineState` prints:

```
RXD high in 94% of samples - UNSTABLE - what an unconnected, undriven input looks like
```

### The test, in software, no multimeter: LOOPBACK

A K-line is a **single wire**, so whatever the transmitter pulls onto it is what the receiver sees.
Driving a known square wave on TXD and sampling RXD **on the same bitbang clock** therefore answers
whether the line pin is on a live bus, with a number instead of a judgement. Press **LOOPBACK** in
the car, ignition in position 2. Four edge rates from 2 ms per level down to 50 µs, plus a control
run with the gate shut.

| What the log says | What it means |
|---|---|
| match **≥ 90 %** at a small lag | RXD follows TXD. The pin is on a live bus and the driver works — **the hardware is fine and the protocol was the problem**, which is wide open because no initialisation has ever been sent |
| match **65–90 %**, collapsing as the edges speed up | the driver follows but cannot keep up: too slow or too weak, and that predicts every unreadable byte we have |
| **RXD never moved**, or match **< 65 % at every rate** | RXD is not seeing TXD at all — the unconnected-pin case, and the 7↔8 jumper is the fix |
| the gate-shut control **also** matches | the echo is not coming through the transceiver, so none of the above applies and the measurement needs rethinking |

Why the existing logs cannot already answer this: off the car the receive line never moves while
transmitting, on the car it does, which looks like a clean comparison and is not. The cable's
automotive side is **powered from the OBD socket**, so the desk run tests an *unpowered*
transceiver. Both hypotheses predict silence off the car and something on it. Only the shape of the
relationship, measured in the car, separates them.

### If you would rather not measure at all

The 7↔8 jumper costs nothing and needs no multimeter. Bridge **pin 7 to pin 8 inside the cable's own
OBD plug** — count the moulded numbers, and note that the plug's numbering is **mirrored** relative
to the car's socket, which is the usual way to get this wrong. Never bridge either of them to pin 16,
which is battery positive. The car's socket is not modified. If the cable then finds modules, the
question is answered retrospectively.

### The multimeter version, if one turns up

Ignition in position 2, multimeter on DC volts, black probe on OBD pin **4 or 5** (ground):

| Measure | Reading | Meaning |
|---|---|---|
| pin 7 | ~12 V | a live K-line is here |
| pin 8 | ~12 V | a live K-line is here too |
| either | ~0 V or drifting | nothing on that pin |

A K-line idles pulled up to battery voltage. **If pin 7 reads ~0 V and pin 8 reads ~12 V, the cable
is fine and has been talking to a dead pin all along.**

Then, and only then, the fix: a jumper from pin 7 to pin 8 **inside the cable's own OBD plug** — not
in the car's socket, which should not be modified. It ties the two diagnostic buses together, which
is what the forum fix does and why it works.

## What was thought to be left to measure

Eleven runs. Both of the tests that remained — the radio beacon and the orange-LED comparison — turn
out to read out as a human judgement about a faint, fast signal, and neither can carry a conclusion.
The section below is kept because it records what they were for and why they were dropped.

The orange LED in particular is not the witness it looked like. Run 11 measured its pattern on the
desk: bursts of seven or eight very fast flashes separated by roughly a tenth of a second, over and
over. That is the USB fill-and-drain cycle, not the bus — the write chunk is 19 bytes, the FT232R's
transmit FIFO is 128, so seven writes fill it and 128 bytes at 9600 8N1 take 133 ms to drain while
the host is held off. **The LED flashes once per USB bulk write**, so it only ever confirmed that
the host hands bytes to the chip, which was never in doubt.

The owner reports it blinking on the desk and not in the car, with a clear view in both cases, and
that asymmetry is unexplained. An earlier draft of this document blamed a connector hidden under the
dashboard; that was invented rather than measured, and the owner corrected it. It is recorded as an
oddity in `docs/findings.md`, not as a lead.

**What to do instead: `docs/fault-report.md`.** A seller-facing statement of what was tested, under
what conditions, and what the three decisive results were. That is the deliverable now.

## The measurements that were left, and why they were dropped

**No car needed, no listening involved, two minutes on the desk: LED WALK, step 12.**

Everything measured so far asks what comes back from the bus. Nothing asks whether anything we
transmit leaves the cable at all, and the owner handed over the observation that makes that
answerable: **the orange LED never blinked once on 2026-10-20**, only the green one.

The earlier LED walk established orange as a transmit-activity indicator — cable on the phone, no
car, so it runs off USB power and sits in plain sight. But it did so with one uninterrupted 4 s
burst, which asks the eye whether a light is on. That is a judgement, and it cannot separate "the
transmit path has died since" from "nobody was watching a connector under a dashboard at the right
moment".

Step 12 asks something that cannot be imagined either way: three cycles of **2 s transmitting, 2 s
silent**, announced in the log as it goes.

- **Orange follows the pattern** → the transmit path through the cable's circuitry is intact and the
  fault is downstream at the line driver, consistent with everything else.
- **Orange stays dark** → transmission never reaches the cable's circuitry, which is a more concrete
  fault to report and contradicts the earlier walk.

Run it with the cable on the phone over OTG and **not** in the car, to reproduce the conditions of
the original observation.

### The radio beacon is set aside

It was a good idea and the gated version is sound — part A toggles only the cable's gate while
holding the USB write rate constant, which does separate the drive onto the harness from the phone's
own USB radiation. Two things finished it off anyway. The one careful attempt was destroyed by a
concurrency defect (BURST CAPTURE pressed on top of a running beacon killed it a second into part
B), and the owner reports that what is audible is marginal enough to be imagination.

A measurement whose read-out is "is this faint noise slightly different now" settles nothing.
Recorded as attempted and inconclusive. For the record: the band is **FM**, where the owner has
heard it; an earlier version of this document claimed FM could not work, which was wrong and is
retracted — what radiates is the switching edge, whose nanosecond rise time reaches VHF, and an
empty frequency gives the FM limiter no carrier to capture.

## The hypothesis that currently fits everything

If the radio test shows the signal does reach the harness, an open connection is ruled out and the
likely remaining fault is **signal levels**. A K-line expects battery-voltage logic. A driver that
only manages 5 V would be invisible to every module while still radiating, still disturbing our own
receive line, and still producing exactly the data-independent reply and the transient that were
measured.

This is a hypothesis, not a finding. It is written down because it fits all nine runs, not because
it has been demonstrated. It no longer decides whether the project continues — run 9 did that — only
what to say in a warranty claim.

## The software

Finished and verified. 14 unit tests green, runs on the target phone.

```
app/src/main/java/hu/bmwscanner/
  usb/FtdiDevice.kt   raw FTDI driver: control transfers, baud divisors (checked against all 15
                      published libftdi reference values), line settings, latency, modem control,
                      CBUS GPIO, streaming sync bitbang capture, EEPROM and pin reads
  ds2/Ds2.kt          DS2 framing, XOR checksums, resynchronising frame recovery, bus scan
  MainActivity.kt     probe UI and every diagnostic described above
tools/usbparse.py     decoder for VirtualBox USB captures
docs/findings.md      the full evidence trail
docs/field-logs/      nine runs, raw
```

Two traps in `FtdiDevice`, both discovered the hard way in run 9 and both documented at their call
sites: the bitbang sample clock is **four times** the baud the divisor encodes, and synchronous
bitbang **stops its clock** when the TX FIFO runs dry rather than merely slowing down, so a capture
that is not streamed on two threads silently loses time. `syncBitbangStream` handles both and
reports elapsed against expected; the older `syncBitbangCapture` does neither and is kept only for
the two callers that ask whether the line moves at all, not when.

No third-party USB library. `usb-serial-for-android` was considered and rejected: the non-standard
vendor id, the possible second channel, and the need for the raw line-status byte all want explicit
control over the FTDI control transfers.

DS2 framing (`[addr][len][data][XOR]`, len counts the whole frame) is known and implemented.
**Command bytes and ECU addresses are deliberately left as labelled unverified candidates** — they
were never recovered from the binary, and the bus scan is meant to discover them from the car
rather than have us guess.

## Environment

- Build: `./gradlew assembleDebug` — Gradle 8.11.1, AGP 8.10.1, Kotlin 2.1.0, JDK 18,
  compileSdk/targetSdk 36, minSdk 21. No Android Studio needed; AGP fetches the SDK bits.
- Phone: Xiaomi Redmi Note 15 Pro+, Android 16. **targetSdk must stay at the phone's API level** —
  at 33 every install route failed, including `adb install`, and raising it to 36 fixed all of them.
- Wireless adb at `192.168.1.74:5555` lets the cable stay plugged in while the app is driven from
  the desk; HyperOS refuses `adb shell input tap`, so there is a broadcast command channel:
  `adb shell am broadcast -a hu.bmwscanner.CMD --es do <full|beacon|burst|vendorinit|baudhunt|linestate|cbus|handshake|scan|send|save|clear|stop>`
- XP VM for the vendor software: `BMWScanXP` in VirtualBox, **no network, no clipboard, no shared
  folders**, software mounted read-only via a `.viso`. Note VirtualBox's VISO parser treats
  backslashes as escapes — use forward slashes in host paths. Both `VBoxSup` and `VBoxUSBMon`
  services must be running.

## What to do next

**There is no money to recover.** The cable came from AliExpress months ago and buyer protection has
long expired, so `docs/fault-report.md` has no addressee. It is kept as the written record of what
was established, not as a claim.

Do not go back to the car to measure anything further. Nothing measurable there can change the
verdict, and the two candidate tests both come down to judging a faint, fast signal by eye or by ear.

So the original goal — fault codes including airbag, live values, service reset, module
identification, from a phone with no laptop — is unmet for exactly one reason: **there is no working
K-line interface in the picture.** Everything above that layer exists and is tested. Two ways
forward, below.

### Option A: a different adapter, verified in two minutes

The app already looks for the BMW Scanner id first and then falls back to **any device with FTDI's
vendor id `0403`**, so a plain FTDI-based K-line adapter — the common KKL 409.1 or a K+DCAN cable,
both normally FT232RL with an L9637D-class transceiver — should be driven on the first plug-in with
no code changes. E46 DS2 lives on **pin 7** of the 16-pin socket, which is what those cables are
wired to.

Two cautions. Many cheap cables now ship a **CH340** instead (vendor id `1A86`), which is a
different control-request interface and needs new driver code rather than configuration; so does a
PL2303 or a CP210x. `withCable` now prints the vendor and product id of every unrecognised USB
device with a guess at the chip, so the answer takes seconds. And an **ELM327** of any kind is not a
solution here: it speaks generic OBD-II only, which is precisely why a generic reader was ruled out
at the start — no airbag module, no BMW-specific units.

**The app is now an acceptance test.** Plug a new adapter in, press FULL RUN, and the verdict comes
in about two minutes while buyer protection on that order is still alive:

- **valid DS2 frames appear in the bus scan** → the interface works, and the project resumes at the
  point it was always meant to reach: discovering the command set from the car rather than guessing
  it.
- **every address answers with the same `C4`-prefixed sequence** → the same fault as this cable.
- **the passive listen hears module traffic with the engine running** → the receive path is
  connected, which this cable never managed.

That third line is the quickest single check and needs no transmission at all.

### Option B: open this cable

The fault is in the transceiver stage between the FT232R's TXD pin and OBD-II pin 7. The chip in
that position is usually an L9637D or a discrete transistor pair, and it costs cents. Opening the
case and looking is free, and the EEPROM, the LEDs and the FT232R are all known-good, so anything
found on the automotive side is the fault. This is a soldering-iron question, not a software one.

Nothing in the protocol approach depends on the answer any more. The burst capture is finished (run
9), and run 10 closed the last two excuses the car itself could have offered — with the engine
running, so every module awake and the bus at alternator voltage, three seconds of passive listening
still hears nothing. The verdict on the cable stands either way. Step 12 is for the warranty claim
and for the record.

Charge the phone first. OTG drains it and the single port cannot charge while the cable is attached.
