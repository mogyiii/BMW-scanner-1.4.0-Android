# BMW DS2 Probe (Android)

An Android app that talks to a **BMW Scanner 1.4.0** cable (USB `0333:0137`) directly over raw USB,
so the cable can be used without its original Windows software.

Current state: **v0.1 — protocol bring-up.** The app opens the cable's FTDI chip, lets you push
arbitrary bytes at the K-line, and scans the DS2 bus for modules that answer. It does not yet decode
fault codes, because the command set has not been confirmed against a real car yet. See
`docs/findings.md` for why that is the honest starting point, and `docs/testing-on-the-car.md` for
the procedure that gets us to v0.2.

## Why not just use the original software

Short version: the cable is fine, the software is not usable here.

- The cable is an FTDI part with a re-flashed EEPROM (`0333:0137` instead of FTDI's `0403:xxxx`).
  That alone explains why no other OBD software recognises it.
- `BMWScan140.exe` is wrapped in an executable protector — all sections encrypted, import table
  reduced to two functions, entry point in writable memory. That is what the antivirus engines are
  reacting to, and it also makes static reverse engineering of the binary pointless.
- Its driver (`FTD2XX.SYS`, 2005) will not install on a current Windows anyway.

So the cable is approached from the USB and DS2 side instead, and the executable is left alone.

## Features in this build

- **Full run** — the one button the field test needs. Finds the cable, dumps descriptors and EEPROM,
  runs the whole configuration sweep, saves the log, and asks nothing it can work out for itself.
  The cable lives in the car, so the first meeting with the phone is also the real test; the app is
  built for that single shot. Keeps the screen awake while it works.
- Enumerates USB devices, highlights the BMW Scanner, requests OTG permission
- Full USB descriptor dump — including whether the chip is single- or dual-channel
- FTDI configuration EEPROM dump
- Configurable baud / parity / channel, 1 ms latency timer
- Per-packet FTDI line-status reporting, so a wrong parity or baud shows up as
  `PARITY-ERROR` / `FRAMING-ERROR` instead of silent garbage
- Optional K-line echo cancellation (the single-wire bus normally feeds transmitted bytes back)
- **Send raw** — bytes go out exactly as typed
- **Send as DS2** — first byte is the ECU address, the rest is the payload; length and XOR checksum
  are filled in automatically
- **Auto-sweep** — walks all 16 combinations of channel × baud × parity × echo, probes candidate
  ECU addresses in each, and reports which configuration actually works. Takes about a minute and
  replaces a pile of manual toggling in the car.
- **Scan bus** — identification request to all 256 addresses, reporting whoever answers
- **Stop** — aborts a running sweep or scan
- Log save / share

## Building

Everything needed is already on this machine; no Android Studio required.

```sh
./gradlew assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`

Toolchain in use: Gradle 8.11.1 (fetched by the wrapper), AGP 8.10.1, Kotlin 2.1.0, JDK 18,
compileSdk 36, targetSdk 36, minSdk 21. The Gradle plugin downloads SDK platform 36 and
build-tools 35 on first run, so no Android Studio or `sdkmanager` is required.

`local.properties` points at `C:\Users\Mate\AppData\Local\Android\Sdk` and is not checked in.

## Installing

```sh
"$LOCALAPPDATA/Android/Sdk/platform-tools/adb" install -r app/build/outputs/apk/debug/app-debug.apk
```

### Keep targetSdk current — it is not cosmetic

The test phone is a Redmi Note 15 Pro+ on Android 16 (API 36). While this project targeted API 33,
**every** install route failed:

- `adb install`, `pm install -i com.android.vending`, `-t`, and
  `--bypass-low-target-sdk-block` all returned
  `INSTALL_FAILED_VERIFICATION_FAILURE: Install not allowed`
- tapping the APK on the phone gave *"built for an older version of Android and does not include
  the latest privacy protections"*, with no override

Raising `compileSdk`/`targetSdk` to 36 fixed both at once — `adb install -r` then reported
`Success`. The verification failure was the low targetSdk, not a HyperOS sideloading restriction,
and no developer-option toggle was needed.

So when the Android version on the test phone moves, move `targetSdk` with it. Two knock-on
requirements that come with targetSdk 34+ and are already handled in the code:

- runtime-registered receivers must declare export state — see `ContextCompat.registerReceiver`
  with `RECEIVER_NOT_EXPORTED` in `MainActivity`
- the app draws edge to edge, so system-bar insets are applied as root padding in
  `applyWindowInsets`

## Layout

```
app/src/main/java/hu/bmwscanner/
  usb/FtdiDevice.kt   raw FTDI vendor-request driver over android.hardware.usb
  ds2/Ds2.kt          DS2 framing, checksums, transport, bus scan
  MainActivity.kt     probe UI
docs/
  findings.md             what the cable and the original software actually are, with evidence
  testing-on-the-car.md   the field procedure for the first session
```

No third-party USB library is used. `usb-serial-for-android` was considered and rejected: the
non-standard vendor id, the possible second channel, and the need for the raw line-status byte all
want explicit control over the FTDI control transfers.

## Scope

Diagnostics: module identification, fault codes, live values, service-interval reset.
Odometer writing is out of scope and will not be implemented.
