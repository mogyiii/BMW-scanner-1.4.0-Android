# Handover — where this project stands

Written 2026-10-19. Read this first; it is meant to be enough on its own.

## The goal

Use a **BMW Scanner 1.4.0** cable (an enthusiast-built BMW diagnostic adapter, USB `0333:0137`) from
an **Android phone**, because the cable's original Windows software triggers antivirus and the
owner has no laptop. Target car: **E46 316i, 2002, 1.8 l N42**, 16-pin OBD-II.

Wanted features: fault codes read/clear (airbag included — that is why a generic reader will not
do), live values, service reset, module identification. **Odometer writing is out of scope and will
not be implemented.**

## Current state in one line

The Android software is finished and verified. **The cable does not talk to the car, and why is
still not fully settled** — one session called it closed, a later one reopened a specific point.
Two measurements remain, both cheap, both needing the car.

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

Seven field runs are in `docs/field-logs/`. The important results:

- **Off the car: total silence**, 32 baud/parity combinations, RXD never moves while transmitting.
  This is the clean negative control — the cable invents nothing on its own, so there is no
  microcontroller chattering, no internal echo and no TX→RX crosstalk.
- **On the car: bytes come back**, RXD is caught low while transmitting, and the DTR pulse produces
  a **deterministic ~14 ms burst** that reproduces byte-for-byte across different days.
- **No valid DS2 frame has ever been decoded**, at any rate from 1200 to 230400, either parity, any
  DTR/RTS state, all 16 CBUS states (with the writes verified 16/16), with the vendor's own byte
  spacing, or after the vendor init sequence.
- **The 256-address scan is the strongest single result**: 214 of 256 replies fall into three
  near-identical sequences, and `0x00`, `0x44`, `0xA0`, `0xFF` all answer the same thing. **The
  reply carries no information from the request.**

## The disagreement, stated fairly

Commit `f8cab36` closed the diagnosis: *"The cable's K-line stage does not work, and nothing further
is worth trying against this cable."*

Its strongest evidence — the data-independent replies — stands and is good.

But one of its arguments does not hold. It reasoned that because the byte count scales with the
sample rate while the duration stays near 14 ms, the burst must be an analogue event rather than a
message. **Both hypotheses predict exactly that.** A real message read at the wrong rate also has a
fixed physical duration and a byte count proportional to the sampling rate. The sound part is that
none of 16 rates decoded cleanly — but 16 discrete points is not a proof.

Also untested: **the vendor software has never been run with the cable connected to the car.** In
the VM it sat on a desk, where its automotive side is unpowered, so "Hardware faulty" from that run
means little.

Commit `2c61b66` reopened this. Nothing contradicts the conclusion; it is just not yet earned.

## The two measurements that are left

Both need the car, both have buttons in the app, neither needs wifi or a laptop.

**1. RADIO BEACON** — the owner noticed the byte traffic as audible pulsing on an empty **FM**
frequency. That is real radiation from the switching edges, and it answers whether the signal
actually reaches the vehicle's wiring: a few centimetres of cable is a poor antenna, several metres
of harness is a good one. The measurement is a **comparison** — listen with the cable in the OBD
socket, then unplug it from the car mid-run while it keeps transmitting on the phone. Weaker or
gone means the signal propagates through the car and the K-line pin is connected. Unchanged means
nothing reaches the socket. One second on, one second off, twenty times.

**2. BURST CAPTURE** — samples the receive line as **raw levels** after a DTR pulse and measures
the intervals between edges. This is where the two hypotheses genuinely differ: UART data at any
rate puts its edges on a consistent bit grid whose shortest interval is one bit time and whose
others are whole multiples of it; a transient has no common divisor. Self-calibrating, because the
burst's ~14 ms duration is already fixed by eight independent decodes. Both earlier bitbang
attempts ran off the car and without a DTR pulse, so neither had anything to capture.

## The hypothesis that currently fits everything

If the radio test shows the signal does reach the harness, an open connection is ruled out and the
likely remaining fault is **signal levels**. A K-line expects battery-voltage logic. A driver that
only manages 5 V would be invisible to every module while still radiating, still disturbing our own
receive line, and still producing exactly the data-independent reply that was measured.

This is a hypothesis, not a finding. It is written down because it fits all seven runs, not because
it has been demonstrated.

## The software

Finished and verified. 14 unit tests green, runs on the target phone.

```
app/src/main/java/hu/bmwscanner/
  usb/FtdiDevice.kt   raw FTDI driver: control transfers, baud divisors (checked against all 15
                      published libftdi reference values), line settings, latency, modem control,
                      CBUS GPIO, sync bitbang capture, EEPROM and pin reads
  ds2/Ds2.kt          DS2 framing, XOR checksums, resynchronising frame recovery, bus scan
  MainActivity.kt     probe UI and every diagnostic described above
tools/usbparse.py     decoder for VirtualBox USB captures
docs/findings.md      the full evidence trail
docs/field-logs/      seven runs, raw
```

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

1. Take the phone and cable to the car, ignition in position 2.
2. Press **RADIO BEACON**, listen on the FM frequency where the pulsing was heard, unplug from the
   OBD socket mid-run, listen again. Report: weaker, gone, or unchanged.
3. Plug back in, press **BURST CAPTURE**.
4. Both save their logs automatically; pull them with
   `adb shell cat /sdcard/Android/data/hu.bmwscanner/files/<newest>.log` or use SHARE LOG.

If the edges fall on a bit grid, there is a protocol and the project continues. If they do not, the
verdict is the same as `f8cab36` reached — but then it rests on the measurement that actually
discriminates, which is worth having for a warranty claim as much as for the record.

Charge the phone first. OTG drains it and the single port cannot charge while the cable is attached.
