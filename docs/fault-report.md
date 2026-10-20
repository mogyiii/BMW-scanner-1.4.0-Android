# Fault report — BMW Scanner 1.4.0 diagnostic cable

Prepared 2026-10-20. Supporting evidence: `docs/findings.md` and eleven raw measurement logs in
`docs/field-logs/`.

> **Status: no addressee.** The cable was bought on AliExpress months ago and buyer protection has
> expired, so there is nobody to send this to. It is kept as the written record of what was
> established and what it rests on, and because it is the right thing to hand over if the cable's
> provenance ever matters again.

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

**3. The bus is silent with the engine running.** With the engine running, every control module is
awake and transmitting and the bus sits at alternator voltage. Three seconds of passive listening —
the cable receiving only, transmitting nothing — detects no activity whatsoever, at either DS2 rate.
A correctly connected K-line interface on a running vehicle is not silent. This rules out the two
remaining benign explanations: that the modules were asleep, and that the supply voltage was
insufficient for the transceiver.

## What this leaves

The fault is in the cable's vehicle-side line driver or its connection to the OBD-II K-line pin. A
driver unable to reach the battery-voltage logic levels a K-line requires would be invisible to
every control module while still coupling enough energy into the cable's own receive line to
produce exactly the transient that was measured. That specific mechanism is a hypothesis; the
failure of the vehicle-side stage is not.

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
