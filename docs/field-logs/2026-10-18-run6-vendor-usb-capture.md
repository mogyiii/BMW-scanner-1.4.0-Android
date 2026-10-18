# The vendor software's own start-up sequence, recovered from USB capture

The decisive measurement. `BMWScan140.exe` was run against the real cable inside an isolated
Windows XP VM (no network, no clipboard, no shared folders, software on a read-only image), with
the cable attached through VirtualBox's USB passthrough and **all USB traffic captured to pcapng**.

The software reported **"Error - Hardware faulty"**.

Capture: 12 128 packets, decoded with `scratchpad/usbparse.py` (DLT_USB_LINUX_MMAPPED).

## What it did

| Request | Count |
|---|---|
| `FTDI_READ_EEPROM` | 122 |
| `FTDI_RESET` | 47 |
| `GET_DESCRIPTOR` | 33 |
| `FTDI_MODEM_CTRL` | 7 |
| `FTDI_BAUD` | 4 |
| `FTDI_LINE` | 3 |
| `FTDI_MODEM_STATUS` | 4 |

**Bulk data transferred: 0 bytes in, 0 bytes out.**

It reads the entire EEPROM word by word (0x00 through 0x3F, the last returning `0x6206` — matching
our own dump exactly), then runs this:

```
FTDI_RESET        val=0x0000   SIO reset
FTDI_MODEM_STATUS              -> reply 01 60
FTDI_BAUD         val=0x809C   -> 19200 baud
FTDI_LINE         val=0x0008   -> 8N1
FTDI_RESET        val=0x0001   purge RX     (x12)
FTDI_RESET        val=0x0002   purge TX
FTDI_MODEM_CTRL   val=0x0101   DTR asserted
      ~100 ms
FTDI_MODEM_CTRL   val=0x0100   DTR released
      ... waits. Nothing arrives. "Hardware faulty".
```

Then it repeats the whole thing ~20 seconds later, and gives up.

## Why this matters

**The vendor's hardware check never touches the car.** It pulses DTR and waits for the *cable* to
announce itself. That is a self-test of the adapter, not a diagnostic session — which is why the
error says "hardware faulty" rather than anything about a vehicle.

Three things in this sequence had never been tried in our own probing:

1. **19200 baud.** Everything here had used 9600 or 10400. The baud hunt covered 19200 but only
   looked for a clean echo of our own bytes, never for an unprompted announcement.
2. **8N1 at that rate**, rather than the 8E1 that DS2 implies.
3. **A DTR *pulse*.** The handshake hunt only ever held DTR in a fixed state, and found that holding
   it asserted silenced the line completely — exactly what you would expect of a reset line held
   permanently in reset. Releasing it is the event that matters, and we never produced that edge.

## Replayed natively: also silent

`vendorInit()` reproduces the sequence exactly, at four bit rates and both parities, listening
after the pulse without transmitting. On the phone, with no hypervisor in the path:

```
19200 NONE  DTR pulse -> (silence)     then ident 0x00 -> (silence)
19200 EVEN  DTR pulse -> (silence)     then ident 0x00 -> (silence)
 9600 NONE  DTR pulse -> (silence)     then ident 0x00 -> (silence)
 9600 EVEN  DTR pulse -> (silence)     then ident 0x00 -> (silence)
10400 NONE  DTR pulse -> (silence)     then ident 0x00 -> (silence)
10400 EVEN  DTR pulse -> (silence)     then ident 0x00 -> (silence)
38400 NONE  DTR pulse -> (silence)     then ident 0x00 -> (silence)
38400 EVEN  DTR pulse -> (silence)     then ident 0x00 -> (silence)
```

That disposes of the virtualization caveat. It does not dispose of the test itself.

## The caveat that actually matters, and it invalidates both runs

**Both the vendor software and this replay were run with the cable disconnected from the car.**

The desk control (`run3`) established that this cable behaves completely differently depending on
whether the car is attached:

| | off the car | on the car |
|---|---|---|
| RXD while transmitting | never leaves high | goes low, data comes back |

The K-line transceiver — and any microcontroller alongside it — is powered from the vehicle, not
from USB. Off the car that circuitry is simply unpowered, so it cannot announce itself no matter
what sequence is sent to it.

Which means **"Hardware faulty" is exactly what a perfectly good cable would report when it is not
plugged into a car.** Both runs fell into the same trap, and neither is evidence about the
hardware's health.

The test that counts is this same sequence with the cable in the OBD socket and the ignition on.
Until that is run, the cable is not diagnosed.
