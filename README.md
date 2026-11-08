# BMW diagnostics, from a phone

Reads a BMW's control modules through a **BMW Scanner 1.4.0** cable (USB `0333:0137`), without the
cable's original Windows software. Fault codes, module identification, odometer and VIN, and
clearing fault memories. In English and Hungarian.

**It works, and it is checked.** Every reading is matched byte for byte against the vendor
software's own output on the same car — and not as a claim in prose: `web/js/protocol.test.mjs`
replays recorded traffic through the decoders and asserts the vendor's published answers.

→ **[Open the web version](https://mogyiii.github.io/BMW-scanner-1.4.0-Android/)** ·
[see it with recorded data, no cable needed](https://mogyiii.github.io/BMW-scanner-1.4.0-Android/?demo=1)

## Which cars

The cable itself covers the DS2-era BMWs — the E36, E38, E39, E46, E53, Z3 and Z4 generations and
their relatives — and the protocol work here is about the cable, not about one car, so it is not
E46-specific.

**What is verified is narrower, and the distinction matters.** Everything below was measured on one
2002 E46 316i, because that is the car available to test on. The protocol, the framing, the
timing, the commands and the decoders are general. The *module list* and the *fault descriptions*
are that car's.

Another BMW will very likely read fine and may also hold modules this app has no tile for — a
gearbox, navigation or telephone controller. There is a button for exactly that: it sweeps the 48
further addresses the vendor software probes, and turns anything that answers into a prefilled
GitHub issue carrying the identity bytes, which are the whole of what is needed to add it. If you
run this on a car that is not an E46, that button is the useful thing to press.

## What it reads on the test car

| addr | module | | protocol |
|---|---|---|---|
| `0x00` | ZKE | body electronics, doors and locking | DS2 |
| `0x12` | DME | engine controller | KWP2000 |
| `0x1B` | VTC1 | Valvetronic | KWP2000 |
| `0x29` | ABS | ABS / DSC | KWP2000 |
| `0x44` | EWS | immobiliser | DS2 |
| `0x57` | LEW | steering angle sensor | DS2 |
| `0x5B` | IHKA | climate control | DS2 |
| `0x80` | IKE | instrument cluster | DS2 |
| `0xA4` | SRS | airbag | DS2 |
| `0xD0` | LCM | lighting control | DS2 |

That is the whole list because it is the whole car: the vendor's own scan of this E46 found these
ten and nothing else. Another car's list will differ.

`0x1B` was missed for a fortnight. It is not in the vendor's fifty-six-address DS2 probe list, only
in its eight-address KWP one, so every sweep walked past it. Its identity reads `7.516.207` /
hardware `10`, which is the vendor's own `VTC1 · SKV20 - VVT Bank 1` row exactly. What it says to a
fault-memory request is still unknown — the vendor never asked it, and its report's error column for
that row reads "no data".

Per module it reads the BMW part number and hardware revision, the live fault memory, the
**shadow** fault memory where the module keeps one, and the assembly-release bytes; the cluster
also gives up the odometer and its stored VIN, and the engine controller and ABS give the VIN over
KWP.

**Engine speed comes from the immobiliser, not the engine controller.** The DME refuses the live
services outright; the EWS has to know whether the engine is turning, so it is told, and `0x5132`
hands over the block that carries it. Resolution is 100 rpm, which is what the immobiliser is
given.

## Two ways to run it

**The browser version is the one to use.** `web/` is a static page driving the cable over WebUSB —
the same code on an Android phone and on a laptop, nothing to install, no Android build, no adb. It
is served from GitHub Pages and caches itself on first load, so it starts with no signal in a car
park. See [`web/README.md`](web/README.md).

It will not work on iOS: Safari has no WebUSB and Apple does not allow arbitrary USB access from
native apps either, so an iPhone cannot drive this cable by any route.

**The Android app** in `app/` came first and still works. It is a diagnostics harness rather than a
product — intent-driven actions, a log pane, no polished UI — and the browser version has overtaken
it. Build with `./gradlew assembleDebug`; the notes on `targetSdk` below are worth reading before
the test phone's Android version moves.

## Scope

**In:** reading, and clearing fault memories.

**Out:** writing anything else. Module coding — comfort closing and the like — was raised, looked at
and dropped: the risk is not symmetric with reading, and the vendor software has backup and restore
buttons that this app does not. Odometer writing was excluded on day one and there is no code here
that could do it. `VendorProtocol.KNOWN_WRITES` marks the write commands found so far so that nobody
sends one by accident.

The oil service reset is out for the same reason and, as it turns out, not by choice: it is DS2
service `0C`, an actuator call, and the instrument cluster on this car refuses it anyway — the
vendor software gets the same refusal.

## Why not just use the original software

Short version: the cable is fine, the software is not usable here.

- The cable is an FTDI part with a re-flashed EEPROM (`0333:0137` instead of FTDI's `0403:xxxx`),
  which alone explains why no other OBD software recognises it.
- `BMWScan140.exe` is wrapped in an executable protector — all sections encrypted, import table
  reduced to two functions, entry point in writable memory. That is what antivirus engines react to,
  and it also makes static reverse engineering of the binary pointless.
- Its driver (`FTD2XX.SYS`, 2005) will not install on a current Windows.

So the cable is approached from the USB side instead. The protocol was recovered by running the
genuine software behind a logging shim (`tools/ftd2xx-proxy`) and reading its traffic.

## How the protocol was established

Every number in this repository is measured. The method, in one line: a single-wire K-line lets the
cable hear itself, so each reply begins with our own request in the module's native framing — which
turns the vendor's opaque 16-bit command numbers into the standard service they stand for, with no
guessing. `tools/command_atlas.py` does that over a capture and prints the result.

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

Outgoing bytes are XORed with a key that starts at the announcement's first byte and advances `0x4B`
per byte, never reset within a session. The connection is rebuilt for every address. Reads stop on
**800 ms of silence** rather than on a clock — replies arrive in several blocks, and a fixed window
credits each answer to the wrong question. That one number cost a fortnight.

## Tools

| | |
|---|---|
| `tools/command_atlas.py` | what each command means, per module, read out of the echo |
| `tools/decode_proxy.py` | a capture replayed as the conversation it represents |
| `tools/ftd2xx-proxy/` | a logging pass-through that sits under the genuine software |
| `tools/ds2-probe-win/` | our exact frames, sent through the genuine driver, to isolate our bugs |

## Documentation

| | |
|---|---|
| [`docs/STATE.md`](docs/STATE.md) | one page: where the project stands, with the control set |
| [`docs/MILESTONE-2.md`](docs/MILESTONE-2.md) | what to build next, and how we would know it worked |
| [`docs/findings.md`](docs/findings.md) | the full record, newest first, including the wrong turns |
| [`docs/testing-on-the-car.md`](docs/testing-on-the-car.md) | the field procedure |

`findings.md` keeps its mistakes on the page on purpose. Several conclusions in this project were
confidently wrong for weeks — the ABS was chased at an address that turned out to be an ASCII letter
read out of the wrong column — and a record that quietly deletes those teaches nothing.

## Building the Android app

```sh
./gradlew assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`. Gradle 8.11.1 (via the wrapper), AGP 8.10.1,
Kotlin 2.1.0, JDK 18, compileSdk/targetSdk 36, minSdk 21. The plugin fetches the SDK platform on
first run, so no Android Studio is required. `local.properties` is not checked in.

### Keep targetSdk current — it is not cosmetic

On the test phone (Android 16, API 36) **every** install route failed while the project targeted
API 33: `adb install`, `pm install -i com.android.vending`, `-t` and `--bypass-low-target-sdk-block`
all returned `INSTALL_FAILED_VERIFICATION_FAILURE`, and tapping the APK gave *"built for an older
version of Android"* with no override. Raising `compileSdk`/`targetSdk` to 36 fixed both at once.
It was the low targetSdk, not a sideloading restriction.

Two knock-on requirements of targetSdk 34+, already handled: runtime-registered receivers declare
their export state (`RECEIVER_NOT_EXPORTED`), and the app draws edge to edge with system-bar insets
applied as root padding.

## Layout

```
web/                     the browser version - this is the one to use
  js/ftdi.js             FT232R over WebUSB
  js/protocol.js         framing, scrambling, commands, decoding
  js/session.js          the measured order of the conversation
  js/app.js              tiles and dialogs; knows nothing about USB
  js/demo.js             recorded replies, for ?demo=1
  js/i18n.js             English and Hungarian
  js/protocol.test.mjs   the decoders against the vendor's own answers
app/                     the Android harness
  .../usb/FtdiDevice.kt  raw FTDI vendor-request driver
  .../ds2/               framing and the vendor command set
docs/                    state, findings, field procedure
tools/                   capture, proxy and analysis
log/                     captures from the car, text only
```

No third-party USB library is used anywhere. The non-standard vendor id and the need for the raw
line-status byte both want explicit control over the FTDI control transfers.
