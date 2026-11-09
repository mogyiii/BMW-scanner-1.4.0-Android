# BMW Scanner 1.4 over WebUSB

Reads a BMW's control modules through a **BMW Scanner 1.4.0** cable (USB `0333:0137`) from a web
page, without the cable's original Windows software. Fault codes with the vendor's own
descriptions, module identification, odometer, VIN, engine speed, live steering angle, and
clearing fault memories. English, German and Hungarian.

→ **[Open it](https://mogyiii.github.io/bmw-scanner-1.4-webusb/)** ·
[see it with recorded data, no cable needed](https://mogyiii.github.io/bmw-scanner-1.4-webusb/?demo=1)

**Everything in it is measured.** Not one value is guessed, and the claim is testable:
`web/js/protocol.test.mjs` replays bytes captured off the wire through the decoders and asserts
the text the vendor's own software printed for those same bytes.

---

## What it does

| | |
|---|---|
| **Fault codes** | Live memory and the **shadow** memory most tools ignore, with 374 descriptions extracted from the vendor binary across five modules. Every fault keeps its raw bytes on screen. |
| **Clearing** | DS2 and KWP2000, always followed by a read-back — an acknowledgement means *accepted*, not *clean*. |
| **Identification** | Part number, hardware and software version, coding/diagnosis/bus index and build date: the whole of what the vendor's report prints. |
| **The car** | Odometer and VIN from the cluster, VIN from the engine controller and ABS, **engine speed** from the immobiliser. |
| **Live steering** | The one other live value this car offers, with its own readout. |
| **Unknown modules** | A sweep of the addresses this software has no tile for, turning anything that answers into a prefilled GitHub issue. |

Tapping a tile reads that module alone, about five seconds; **Read all** does the lot.

## Which cars

The cable covers the DS2-era BMWs — E36, E38, E39, E46, E53, Z3, Z4 and relatives — and the
protocol work here is about the cable, not one car.

**What is verified is narrower.** Everything was measured on one 2002 E46 316i. The protocol,
framing, timing, commands and decoders are general; the module list and the fault descriptions are
that car's. Another BMW will very likely read fine and may hold modules this app has no tile for,
which is what the **Missing?** tile is for.

### The ten modules on the test car

| addr | module | | protocol |
|---|---|---|---|
| `0x00` | ZKE | body electronics, doors, locking | DS2 |
| `0x12` | DME | engine controller | KWP2000 |
| `0x1B` | VTC1 | Valvetronic | KWP2000 |
| `0x29` | ABS | ABS / DSC | KWP2000 |
| `0x44` | EWS | immobiliser — and it carries the engine speed | DS2 |
| `0x57` | LEW | steering angle sensor | DS2 |
| `0x5B` | IHKA | climate control | DS2 |
| `0x80` | IKE | instrument cluster | DS2 |
| `0xA4` | SRS | airbag | DS2 |
| `0xD0` | LCM | lighting control | DS2 |

`0x1B` was missed for a fortnight: it is not in the vendor's fifty-six-address DS2 probe list, only
in its eight-address KWP one, so every sweep walked past it.

## Scope

**In:** reading, and clearing fault memories. **Out:** writing anything else — a decision, not a
to-do. The risk is not symmetric with reading: a read that goes wrong returns nothing, while a
coding block written wrong can take a module's function with it, and the recovery path is a backup
this app does not implement. `VendorProtocol.KNOWN_WRITES` marks the write commands found so far
so nobody sends one by accident.

## What it does not do

The vendor's PA-Soft software does considerably more than this, and anyone arriving from it should
know where the line falls before plugging anything in.

| | |
|---|---|
| **Coding and programming** | Not implemented, and not planned. Comfort closing, retrofit coding and the rest were considered and dropped: the risk is not symmetric with reading, and PA-Soft has module backup and restore buttons that this does not. |
| **Odometer writing** | Refused on day one. There is no code here that could do it. |
| **EEPROM read and write, module backup/restore** | Not implemented. The vendor software dumps module memory; this reads diagnostic data only. |
| **Service interval reset** | Not implemented. It is an actuator call rather than a read, and on the test car the cluster refuses it even from PA-Soft. |
| **Key and immobiliser programming** | Not implemented. |
| **Most live values** | PA-Soft has live-data screens this does not. Engine speed and steering angle are the two this app reads, because they are the two that proved available on the test car. |
| **Model coverage** | PA-Soft knows the whole DS2 generation. This knows the ten modules of one E46, plus a sweep that finds anything else and asks you to report it. |

**Clearing faults is implemented**, on both protocols, with a read-back afterwards.

## What this cable can and cannot be made to do

Worth stating, because it bounds the whole project.

**We never talk to the car. We talk to the cable's microcontroller**, which talks to the car. A
request is a 16-bit command the microcontroller already knows plus arguments we supply; the service
prefix lives in the cable's firmware and appears nowhere in the executable. `0x4769` with payload
`00 10 20` goes out as DS2 `06 08 00 | 00 10 20`, and those first three bytes are not ours to
choose. Arbitrary K-line frames are impossible, and so is reading anything the vendor never wrote
a command for.

`tools/command_inventory.py` measures the ceiling: **318 commands the software can send, 61 seen
on the wire.** Five are issued under a "Reading live data" label and two of those have never
appeared — they sit behind a condition this car does not satisfy.

## Running it

WebUSB needs a secure context, so the page must come from `https://` or `localhost`. GitHub Pages
is its home; a service worker caches it on first load, so it starts with no signal in a car park.

```sh
cd web && python -m http.server 8000      # then http://localhost:8000
node js/protocol.test.mjs                 # the decoders against the vendor's answers
```

## Tested on

Kept separate from "should work", because the difference is the habit this whole project runs on.

| | tested | notes |
|---|---|---|
| **Android — Chrome 156/157** | **yes, with the cable, on the car** | Every reading in this repository came from here. |
| **Desktop Chrome / Edge** | the interface only | Driven in demo mode during development; never with a cable attached. Expected to work, since WebUSB is the same API. |
| **Windows + cable** | **no** | Needs the device bound to WinUSB with [Zadig](https://zadig.akeo.ie/) first; without a WinUSB-compatible driver Chrome cannot claim it. |
| **macOS + cable** | **no** | Expected to work, and the reasoning is specific: Apple's `AppleUSBFTDI` binds vendor `0x0403`, while this cable reports `0x0333`, so nothing should claim the interface ahead of Chrome. The re-flashed EEPROM that stops other OBD tools recognising it is what should make this easy. A recent Mac wants a USB-A adapter. |
| **Linux + cable** | **no** | Expected to work; likely wants a udev rule for `0333:0137`. |
| **iOS** | **impossible** | Safari has no WebUSB and Apple does not allow it from native apps either. No route exists. |
| **Firefox** | **impossible** | No WebUSB. |

**Hardware:** one cable, a BMW Scanner 1.4.0 reporting `PASOFT / BMW Scanner V14x`, USB
`0333:0137`, serial `PA5BG64Y`. **Car:** one 2002 E46 316i with the N42 engine. Other DS2-era BMWs
are expected to read; none has been tried.

If you run it anywhere not marked "yes", the result either way is worth an issue — "it just
worked" is as useful here as a failure.

## Your first reading

1. **Plug the cable into the OBD socket** and turn the ignition to position 2, or start the
   engine. The modules run on the ignition-switched supply; with the key out there is nothing
   awake to answer, and the app will say so before wasting your time.
2. **Plug the cable into the phone** (USB-OTG adapter) or the computer.
3. **Open the page** and press **Connect the cable**. The browser asks which device to share;
   pick the one named *BMW Scanner V14x*. The permission is remembered.
4. **Press Read all.** It takes about a minute — ten modules, each needing its own connection
   because the link does not survive being reused across addresses.
5. **You now have:** a tile per module with its fault count, the chassis number, odometer and
   engine speed in the header, and per module its BMW part number, hardware and software version
   and both fault stores. Tap a tile for the detail, including every fault's raw bytes.

After that, tapping a single tile re-reads just that module in about five seconds, which is what
you want when watching something change.

**Share the log** at the bottom to get the whole thing as a text file — decoded results and raw
traffic together.

## The Android app

`app/` holds the Android application this project started as. **It is finished, not maintained.**
It was the first thing to read the car and it is kept as that record, and as the reference the
browser version was checked against; the browser version has overtaken it in every respect and
all new work goes there.

It still builds with `./gradlew assembleDebug`. One note worth keeping if anyone revives it: on a
phone running Android 16, **every** install route failed while the project targeted API 33 —
`adb install`, `pm install -i com.android.vending`, `-t` and `--bypass-low-target-sdk-block` all
returned `INSTALL_FAILED_VERIFICATION_FAILURE`. Raising `compileSdk`/`targetSdk` to 36 fixed it. It
was the low targetSdk, not a sideloading restriction.

## Nothing here is a modified copy of anything

A fair question when a project talks this much about somebody else's software, so: **the vendor's
program was never patched, cracked, altered or redistributed, and neither was the cable's
firmware.**

What was actually done is observation. `tools/ftd2xx-proxy` is a DLL written from scratch that
implements the handful of `FT_*` functions the vendor software calls, logs every byte in both
directions, and forwards them to the genuine FTDI driver renamed alongside it. The vendor program
runs completely unmodified and does not know it is there; it is a wiretap, not a patch. Reading
the fault-description tables meant dumping the protected executable from memory to get past its
packer, which is reading, not writing — and that dump is `.gitignore`d, because it is not ours to
hand out.

This repository contains no vendor binary. The only compiled things in it are two small programs
written for this project: the logging proxy and a Windows probe that sends our own frames through
the genuine driver.

The application itself shares no code with the original. It is a new implementation of a protocol
recovered by watching the wire, which is what the rest of this README is about.

## Why not the original software

The cable is fine; the software is not usable here.

- The cable is an FTDI part with a re-flashed EEPROM (`0333:0137` instead of FTDI's `0403:xxxx`),
  which alone explains why no other OBD software recognises it.
- `BMWScan140.exe` is wrapped in an executable protector — sections encrypted, import table reduced
  to two functions, entry point in writable memory. That is what antivirus engines react to.
- Its driver (`FTD2XX.SYS`, 2005) will not install on a current Windows.

So the cable was approached from the USB side, and the protocol recovered by running the genuine
software behind a logging shim and reading its traffic.

## How the protocol was established

The method in one line: a single-wire K-line lets the cable hear itself, so every reply opens with
our own request in the module's native framing — which translates the vendor's opaque 16-bit
command numbers into the standard service they stand for, with no guessing.

```
DTR pulse
  <- 27-byte announcement, XOR 0, identity "V144Bn9", first byte is the scrambling key
  -> 0xA77A   challenge response
  -> 0xB318   open the connection to one address
  -> 0x83F0   K-line timing
  --  that reply is read at 19200, then the line moves to 9600 8E1 and stays there
  -> 0x46F1   identify        DS2 00
  -> 0xC731   fault memory    DS2 04, paged
```

Outgoing bytes are XORed with a key starting at the announcement's first byte and advancing `0x4B`
per byte, never reset within a session. The connection is rebuilt for every address. Reads stop on
**800 ms of silence** rather than on a clock — replies arrive in several blocks, and a fixed window
credits each answer to the wrong question. That one number cost a fortnight.

Fault descriptions come out of the executable's own tables. Each is a Delphi constant string
carrying its own index; a module's table is chosen by its `DI` field, and a code selects the first
entry whose key is **strictly greater** than it, because the keys are bounds rather than codes.
Both rules reproduce every code the vendor printed for the test car.

## Tools

| | |
|---|---|
| `tools/command_atlas.py` | what each command means, per module, read out of the echo |
| `tools/command_inventory.py` | every command the software *can* send, from the executable |
| `tools/fault_text.py` | 374 fault descriptions, out of the vendor binary's own tables |
| `tools/decode_proxy.py` | a capture replayed as the conversation it represents |
| `tools/ftd2xx-proxy/` | a logging pass-through that sits under the genuine software |
| `tools/ds2-probe-win/` | our exact frames through the genuine driver, to isolate our own bugs |

## Documentation

| | |
|---|---|
| [`docs/STATE.md`](docs/STATE.md) | one page: where things stand, the control set, and what has been done to this car |
| [`docs/MILESTONE-2.md`](docs/MILESTONE-2.md) | each follow-on question, what is settled and what is not |
| [`docs/findings.md`](docs/findings.md) | the full record, newest first, including the wrong turns |
| [`docs/testing-on-the-car.md`](docs/testing-on-the-car.md) | the field procedure |

`findings.md` keeps its mistakes on the page deliberately. Several conclusions here were
confidently wrong for weeks — the ABS was chased at an address that turned out to be an ASCII
letter read out of the wrong column — and a record that quietly deletes those teaches nothing.

## Layout

```
web/                     the browser version
  js/ftdi.js             FT232R over WebUSB
  js/protocol.js         framing, scrambling, commands, decoding
  js/session.js          the measured order of the conversation
  js/app.js              tiles and dialogs; knows nothing about USB
  js/i18n.js             English and Hungarian
  js/demo.js             recorded replies, for ?demo=1
  js/protocol.test.mjs   the decoders against the vendor's own answers
app/                     the Android application, finished and unmaintained
docs/  tools/  log/      state and findings, analysis scripts, captures from the car
```

No third-party USB library anywhere. The non-standard vendor id and the need for the raw
line-status byte both want explicit control over the FTDI control transfers.
