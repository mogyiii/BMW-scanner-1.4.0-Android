# Where this project stands — 2026-11-03

> # 🎉 It reads the car — both protocols — 2026-11-04
>
> **DS2, seven modules.** Steering angle sensor `0x57` returns three faults, `0B/AF`, `09/97`,
> `04/17`, which is exactly what `BMWScan140` printed for it. Air conditioning `0x5B` returns
> `1C 44` and `1E 42`.
>
> **KWP2000, the engine controller.** `0x12` ignores DS2 — the vendor's own capture shows it getting
> the same nothing — and answers KWP instead:
>
> ```
> 0x0DE7 -> 1A 90        -> 5A 90 4B 50 30 34 32 32 30     VIN  KP04220
> 0xC358 -> 18 02 FF FF  -> 58 01 27 C3 64                 DTC  27C3 / 64
> ```
>
> Both match the control set: the vendor read this car's VIN as `KP04220` and its engine fault as
> `27C3/64 - Failure oil status sensor`.
>
> Eight of the nine modules the vendor found, on both protocols, from the phone. Only `0x56` (ABS)
> is unread, and the working capture has nothing for it — the vendor did not query it in that
> session.

> # ✅ Solved — 2026-11-04
>
> The same sequence, sent through the genuine driver on Windows by `tools/ds2-probe-win`, got the
> instrument cluster to answer:
>
> ```
> -> 0x46F1 query
> rx (22): 80 04 00 84 | 80 12 A0 F6 91 12 86 12 06 53 12 14 02 26 23 06 87 06
> ```
>
> **So the sequence was always right, and the fault was in how the Android side reads.** The same
> log shows it: `0xB318` answers with **fourteen** bytes — two seven-byte sentinels — and `0x83F0`
> with **eleven**, where Android recorded seven for each. Our reads used a fixed window and stopped
> on a clock, so each reply was cut after its first block and the remainder arrived inside the
> *next* read, credited to the next command. Every reply from there was one block out of step.
>
> The project already had `readUntilQuiet`, which stops on silence instead. It was never used on
> this path, and I wrote a second copy of it before noticing — the same mistake as setting a 300 ms
> window without re-reading the log that already recorded a 306 ms reply.

One page, written because the detail is spread over fifty-eight runs and nobody should have to read
them to pick this up. `findings.md` is the full record; this is what it adds up to.

---

## The short version

**It works.** Eight of the nine modules the vendor's own software finds, read from a phone or a
browser, across both protocols the car uses. The codes match the vendor's output byte for byte.

---

## Settled, with evidence

| | how we know |
|---|---|
| The protocol | Recovered from the vendor executable, then recorded off the wire through `tools/ftd2xx-proxy` while the genuine software did a complete scan |
| Our sequence is right | `tools/ds2-probe-win` sent the same frames through the genuine driver and the cluster answered |
| The readings are right | `0x57` returns `0B/AF`, `09/97`, `04/17`; `0x5B` returns `1C 44` and `1E 42`; the DME returns `27C3/64` and VIN `KP04220` — all exactly as `BMWScan140` printed them |

### The protocol

```
DTR pulse
  <- 27-byte announcement, XOR 0, identity "V144Bn9", first byte is the scrambling key
  -> 0xA77A  par 'V'   31 bytes   challenge response
  -> 0xB318  par addr  [01]       open the connection
  -> 0x83F0  par addr  [E5 50 47 66 <Delay2> <Delay>]   K-line timing
  --  its reply is read at 19200, then the line moves to 9600 8E1 and stays there
  -> 0x46F1  par addr             identify        DS2 service 00
  -> 0xC731  par addr  [page]     fault memory    DS2 service 04
```

Frames are `[len][cmd hi][cmd lo][param][payload][additive checksum]`, `len` counting everything but
itself and the checksum. Every outgoing byte is XORed with a key that starts at the announcement's
first byte and advances `0x4B` per byte, never reset within a session. **The connection is rebuilt
for every address** — reusing one works for two or three frames and then rots.

Replies are two frames end to end: our own request echoed by the K-line, then the module's answer.

**The engine controller is not a DS2 module.** `0x46F1` returns nothing but the echo, for us and for
the vendor alike. It speaks KWP2000: `0x06F3` is `1A 80`, `0x0DE7` is `1A 90` (the VIN), `0xC358` is
`18 02 FF FF` (the codes).

### The number that mattered

Reads stop on **800 ms of silence**, not on a clock. Some replies come in more than one block —
`0xB318` sends two seven-byte sentinels, `0x83F0` eleven bytes — and at 200 ms every one came back
cut in half, with the remainder landing in the next read and being credited to the next command.
Everything downstream was one block out of step, and for a fortnight that looked like a hardware
fault.

---

## What is left

- **`0x56` (ABS)** is unread. The working capture holds nothing for it; that session never queried
  it, so its commands are simply not known yet.
- **Clearing faults** needs one more proxy capture of the vendor doing it.
- **Fault descriptions.** The text is in the binary as contiguous short-string arrays with a
  per-module base code — `0x57`'s starts at code `0x04`, so index = code − 4, which yields
  "Wrong LWS-ID" for `0B` and matches the vendor. Mapping all sixty modules is a day's work and
  nothing depends on it.
- **The fault entry layout** is fitted to three modules. Entry size is data length over count with
  trailing padding stripped; code is the first byte, parameter the first non-zero byte after it.
  The raw bytes stay on screen precisely because that rule could be wrong elsewhere.

---

## What is explicitly out of scope

Writing anything. Module coding — comfort closing and the like — was raised, looked at and dropped:
the risk is not symmetric with reading, and the vendor software has backup and restore buttons that
this app does not. Odometer writing was excluded from the start. `VendorProtocol.KNOWN_WRITES` marks
the write commands found so far.

---

## Mistakes worth not repeating

Recorded because they cost weeks, and all of them are the same shape: concluding from an uncontrolled
variable.

- **Run 49** concluded the cable's vehicle side was at fault. The vendor software read the car
  perfectly four days later.
- **Run 35** called `0xB318` the module query on the strength of eighty-four frames, one per address.
  It is connection setup; it repeated because every attempt failed.
- **Run 43** concluded the reply was sixty-one bytes from a length field in a reply recorded on a
  dying battery.
- **Runs 34 and 37** blamed `0x83F0` for a link decay caused by reusing one connection.
- Read windows were chosen without re-reading our own logs, which already contained the arrival time
  that made 300 ms wrong.
- Diagnostics were repeatedly written to print only the expected outcome, so failures carried no
  evidence.

The ignition state was uncontrolled in two of the day's runs, and the modules are asleep without it
— which looks exactly like a protocol fault and is not one. I first wrote that this invalidated most
of an hour's work; the owner corrected me, and it was two short runs. Overstating the damage is its
own kind of imprecision.
