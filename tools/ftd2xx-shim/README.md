# FTD2XX shim — make the vendor software talk to us instead of to a cable

A drop-in replacement for `FTD2XX.DLL` that pretends the BMW Scanner cable is attached, logs every
call `BMWScan140.exe` makes, and lets us choose what it reads back.

## Why this and not USB emulation

The obvious way to learn the cable's protocol is to capture the vendor software talking to a powered
cable. That needs the PC, the cable and 12 V in the same room, and we do not have that.

Emulating the cable as a USB device would avoid the hardware, but it is the expensive version of the
idea: a virtual USB device means either a kernel driver on the host (which wants test-signing mode
and Secure Boot off) or rebuilding QEMU's FTDI device model.

**One level up is free.** The vendor software does not talk to USB. It talks to `FTD2XX.DLL`, FTDI's
ordinary userspace library, whose 73 exports are listed in
`docs/findings.md`. Windows loads a DLL from the application's own directory before the system one,
so a replacement dropped next to the executable is loaded instead — no driver, no USB, no kernel,
nothing signed.

And it is *better* than a USB capture, because the calls are semantic. `FT_SetBaudRate(19200)` and
`FT_Write(5 bytes)` say what the software meant; a bulk transfer only says what came out.

## What it does

- Reports exactly one device: VID `0x0333`, PID `0x0137`, serial `PA5BG64Y`, description
  `BMW Scanner V14x`, type `FT_DEVICE_232R` — the real values, read off the cable in run 1.
- Serves the **real EEPROM**, all 64 words as dumped in run 2, from `FT_ReadEE` and `FT_EE_Read`.
- Logs every call with its arguments, and every byte of `FT_Write`, to `ftd2xx-shim.log` beside the
  executable.
- Feeds `FT_Read` from `ftd2xx-rx.hex`, re-read whenever the file changes, so a reply can be tried
  without restarting anything.

## The experiment

1. **First run, empty `ftd2xx-rx.hex`.** The log then shows the exact call sequence and every byte
   the software wants to send. That alone is further than the USB capture ever got — it recorded
   zero bulk bytes, which told us the software gave up, but not what it was waiting for.
2. **Then feed it a sign-on.** The start-up pulses DTR and waits for the cable to announce itself.
   The strongest clue is the 2009 session log shipped with the software, which prints
   `HW: V144Bn9` — a string the host cannot have invented, so the announcement almost certainly
   carries it. Put candidates in `ftd2xx-rx.hex` and watch how far the software gets.
3. **Once it proceeds, the log is the protocol.** Every command it sends to the microcontroller,
   in order, with the baud rate and line settings it used.

## Where to run it

In the isolated `BMWScanXP` VirtualBox VM — no network, no clipboard, no shared folders — which is
where the software was run for the run-6 capture. The DLL is built without any C runtime dependency
so that it loads on XP as well as on current Windows.

Running the vendor executable is a deliberate choice, not a casual one: it is packed, antivirus
flags it, and `docs/findings.md` records why static analysis was abandoned. The VM is the reason
that is acceptable.

## Building

Needs the 32-bit MSVC toolchain — the executable is 32-bit Delphi, so the DLL must be too.

```
build.cmd
```

It locates a Visual Studio install, sets up the x86 environment, and produces `FTD2XX.DLL`.
Copy that next to `BMWScan140.exe`, keeping the original somewhere safe.
