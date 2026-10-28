# Fault report — BMW Scanner 1.4.0 diagnostic cable

Prepared 2026-10-20. Supporting evidence: `docs/findings.md` and eleven raw measurement logs in
`docs/field-logs/`.

> **Status: WITHDRAWN, 2026-10-28.** This report names the wrong cause. The cable is not faulty.
>
> On 2026-10-28 it completed the vendor's own handshake on the car, first attempt: 27 bytes, XOR
> zero, hardware identity `V144Bn9` — the same string the manufacturer's software prints in its own
> shipped session log. The ~14 ms "burst" this report treats as a transient is that announcement,
> and it was present and correct in every on-car run from 2026-10-19 onward.
>
> See `HANDOVER.md`, run 23, and `docs/findings.md`, run 22. The file is kept unaltered below so the
> reasoning that produced a wrong conclusion stays legible; nothing in it should be acted on.

## The device

| | |
|---|---|
| Product | BMW Scanner 1.4.0 diagnostic cable |
| USB identity | `0333:0137`, strings `PASOFT` / `BMW Scanner V14x`, serial `PA5BG64Y` |
| Interface chip | FTDI FT232R (`bcdDevice = 0x0600`) |
| Vehicle | BMW E46 316i, 2002, 1.8 l N42, 16-pin OBD-II socket, DS2 protocol |

## Summary of the fault

**The cable's USB and interface electronics work correctly. Its vehicle-side line driver does not.**
The cable accepts data from the host, reports transmit activity on its own indicator LED, and
transmits at the configured rate — but nothing it transmits produces a valid response from any
control module, and the only activity ever observed on its receive line is an electrical transient
that carries no data.

## What was tested

The cable was driven from an Android phone over USB OTG, addressing the FT232R directly through its
documented vendor control-request interface. No third-party serial library was used. The
implementation was verified independently of the cable:

- Baud-rate divisor encoding checked against all fifteen published libftdi reference values.
- The complete 64-word configuration EEPROM read back with a valid checksum (`0x6206`).
- CBUS GPIO writes verified by read-back, 16 of 16 states.
- Synchronous bitbang capture verified against a measured sample clock, with transfer timing
  checked against expected duration on every capture so that a stalled clock cannot be mistaken for
  data.
- Transmitted byte counts verified against the theoretical line rate: 5852 bytes per six-second
  window at 9600 8N1, where the line carries 960 per second.

## Conditions under which no valid response was ever obtained

| Variable | Range covered |
|---|---|
| Baud rate | 1200 – 230400, sixteen rates |
| Parity | none and even, at every rate |
| Handshake lines | DTR and RTS, every combination of states |
| CBUS GPIO | all 16 states, writes verified by read-back |
| Inter-byte spacing | including the vendor software's own `Delay=20` / `Delay2=40` values |
| Initialisation | the vendor software's exact start-up sequence, recovered from a USB capture and replayed on the live vehicle |
| Bus addresses | all 256, individually |
| Ignition | position 1, position 2, and **engine running** |
| USB-C plug orientation | both |

## The three decisive results

**1. The response carries no information from the request.** Scanning all 256 bus addresses, 214 of
the replies fall into three near-identical byte sequences. Addresses `0x00`, `0x44`, `0xA0` and
`0xFF` all return the same thing. Every reply begins with the same byte, `0xC4`, regardless of what
was sent — writing `0x00` returns `C4 21`, writing `0xFF` returns `C4 08 F8`, writing
`55 55 55 55` returns `C4 21 A3 83 ED`. A functioning bus cannot behave this way. This is a fixed
artefact of the cable's own circuitry, triggered by transmission.

**2. The apparent reply is an electrical transient, not a message.** The receive line was sampled as
raw voltage levels, on a sample clock measured rather than assumed, across fourteen independent
events. Each lasts 13.6–15.2 ms. Serial data sampled this far above its bit rate places every
signal transition at a whole multiple of one bit period, with nothing in between; the best-fitting
bit period, searched over every candidate, accounts for only 46–62 % of the transitions here. The
transition lengths form a smooth spread with no preferred spacing. This is the signature of a
circuit transient.

**3. ~~The bus is silent with the engine running.~~ RETRACTED — this was never evidence.**

> The original wording claimed that a correctly connected K-line interface on a running vehicle is
> not silent, and used three seconds of silence to rule out sleeping modules and low supply voltage.
> **That reasoning is wrong.** The diagnostic K-line is a request–response line: control modules do
> not broadcast on it, and it is silent by design until a tester addresses one. (The BMW I-bus/K-bus
> does carry continuous traffic, but that is a different physical bus and not the pin this cable
> uses.) Silence while listening passively is the expected behaviour of a perfectly good connection,
> so it says nothing either way. The measurement stands; the inference drawn from it does not.

## What this leaves — and one lead that was never checked

The fault is on the cable's vehicle side, between the FT232R's TXD pin and the car. **Which** part
is not established, and one possibility was never tested at all: **that the cable is wired to a pin
this car does not use for the modules being addressed.**

BMW OBD-II sockets carry more than one K-line, with pin 7 and pin 8 serving different groups of
modules depending on chassis and year. For this cable specifically, bridging **pin 7 to pin 8** is a
widely reported fix that makes it find the DME and other units on cars where it otherwise finds
nothing. That is consistent with what this project measured and never followed up:
`probeLineState` reports the receive line as *"UNSTABLE — what an unconnected, undriven input looks
like"* while transmitting, and the reply pattern is what an unterminated line does when the
transmit pin switches next to it.

So the hypothesis of a dead line driver is **not** the only one left standing. An intact cable
connected to an unused pin would produce the same measurements. The two can be separated without
modifying anything: see `HANDOVER.md`, "The pin 7 / pin 8 question".

## Note on the supplied Windows software

The cable's own software was not used to reach these conclusions, for two reasons. Its executable is
wrapped in a protector — every section encrypted at maximum entropy, imports reduced to two
functions, a writable entry point — which causes antivirus software to flag it, and its bundled
FTDI driver dates from 2005 and does not install on current Windows. It was examined in an isolated
virtual machine with all USB traffic captured, which is how its start-up sequence was recovered and
replayed.

That examination established one relevant fact: **the vendor software's own hardware self-test
transfers zero bytes to the vehicle.** It reads the EEPROM, sets 19200 8N1, purges the buffers,
pulses DTR for about 100 ms, and waits. It therefore cannot and does not verify the vehicle-side
driver, and a pass or fail from it says nothing about the fault described above.

## Request

The cable is not fit for its stated purpose on this vehicle. Replacement or refund is requested. The
complete measurement record, including every raw log, is available on request.
