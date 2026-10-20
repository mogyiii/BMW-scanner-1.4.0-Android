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

The Android software is finished and verified. **The cable's K-line stage does not work, and as of
run 9 that rests on a measurement that actually discriminates** — the ~14 ms burst is a transient,
not a message. One measurement remains, and it concerns the nature of the fault rather than whether
there is one.

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

Nine field runs are in `docs/field-logs/`. The important results:

- **Off the car: total silence**, 32 baud/parity combinations, RXD never moves while transmitting.
  This is the clean negative control — the cable invents nothing on its own, so there is no
  microcontroller chattering, no internal echo and no TX→RX crosstalk.
- **On the car: bytes come back**, RXD is caught low while transmitting, and a **~14 ms burst**
  reproduces byte-for-byte across different days. It was attributed to the DTR pulse until run 9
  found it in a control run with no pulse at all.
- **No valid DS2 frame has ever been decoded**, at any rate from 1200 to 230400, either parity, any
  DTR/RTS state, all 16 CBUS states (with the writes verified 16/16), with the vendor's own byte
  spacing, or after the vendor init sequence.
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

## The measurement that is left

Needs the car, has a button in the app, needs no wifi or laptop.

**RADIO BEACON** — the owner hears the byte traffic as audible pulsing on an empty **FM** frequency,
both originally and during the run-9 sessions. An earlier version of this document claimed FM could
not show the effect; that was wrong, and is retracted. What radiates is the switching edge, not the
4.8 kHz fundamental, and its nanosecond rise time reaches VHF; on an empty frequency there is no
carrier for the FM demodulator to capture, so its limiter amplifies the impulse noise instead of
rejecting it. Run 8's beacon was void only because of the purge bug, not the band.

The pulsing is real radiation, and it answers whether the signal reaches the vehicle's wiring: a few
centimetres of cable is a poor antenna, several metres of harness is a good one.

The measurement has to control for one thing. **The phone streams USB while it transmits, and USB
radiates**, so pulsing that follows the write loop could be the cable driving the harness or could
be bus traffic to the cable. Unplugging mid-run is the crude control — it changes the antenna, but
it also removes power from the cable's automotive side, so a difference has two causes.

Run 9 gave a clean one. DTR asserted silences the line completely (0 of 11 520 samples, ten windows)
while the chip goes on shifting the same bytes at the same rate. So the beacon now runs two parts:

- **Part A, gate toggles, USB constant.** One second driving, one second with DTR asserted. Pulsing
  here can only be the cable's drive onto the harness.
- **Part B, write toggles.** The original one-on, one-off. Pulsing in B but not in A would mean what
  has been heard all along is the phone's own USB, not the car.

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

One thing, and it needs ears rather than software.

1. Phone and cable in the car, ignition in position 2, car radio on the empty **FM** frequency where
   the pulsing has been heard before.
2. Press **RADIO BEACON** and listen to the two parts separately; the app announces each in the log.
3. Report **part A**: does the pulsing follow the one-second gate pattern, or is the noise steady
   through it? Pulsing means the signal reaches the harness — an open connection is ruled out and
   the remaining fault is signal levels, a driver that radiates but cannot reach battery-voltage
   logic. Steady noise means nothing is getting onto the bus and what we hear is the phone's USB.
4. Report **part B** the same way, as the cross-check.
5. The log saves itself; pull it with
   `adb shell cat /sdcard/Android/data/hu.bmwscanner/files/<newest>.log` or use SHARE LOG.

Nothing in the protocol approach depends on the answer any more. The burst capture is finished — see
run 9 — and the verdict on the cable stands either way. This is for the warranty claim and for the
record.

Charge the phone first. OTG drains it and the single port cannot charge while the cable is attached.
