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

The cable is good, the car is good, the protocol is understood, and the Android app gets within one
command of working. The vendor's software reads this car perfectly. Ours completes the entire setup
handshake byte-for-byte identically and then fails on the module query.

---

## Settled, with evidence

| | how we know |
|---|---|
| The cable works | The genuine vendor software on a laptop read and cleared this car's faults, 2026-11-03 |
| The car and socket are fine | Same session; ten modules answered |
| The link protocol | Recovered from the vendor executable and verified on the wire |
| The command set | Recorded through `tools/ftd2xx-proxy` while the vendor software worked |
| Our setup sequence is correct | Run 58: sign-on, `0xB318` and `0x83F0` each return `77 07 77 07 77 07 70`, exactly what the vendor gets |

### The protocol

```
DTR pulse
  <- 27-byte announcement, XOR 0, identity "V144Bn9", first byte is the scrambling key
  -> 0xA77A  par 'V'   31 bytes   challenge response
  -> 0xB318  par addr  [01]       open the connection
  -> 0x83F0  par addr  [E5 50 47 66 <Delay2> <Delay>]   K-line timing
  --> line moves to 9600 8E1
  -> 0x46F1  par addr             identify          DS2 service 00
  -> 0xC731  par addr  [page]     fault memory      DS2 service 04
```

Frames are `[len][cmd hi][cmd lo][param][payload][additive checksum]`, `len` counting everything but
itself and the checksum. Every outgoing byte is XORed with a key that starts at the announcement's
first byte and advances `0x4B` per byte, never reset within a session.

Replies are two DS2 frames end to end: our own request echoed by the K-line, then the module's
answer. `[addr][len][0xA0][data][XOR]`, whole frame XORing to zero.

### The control set

`field-logs/2026-11-03-vendor-session-full-scan.log` — the vendor's own output for this car. Ten
modules, VIN `KP04220`, 321,741 km, every fault in plain text including the airbag's
`06/20 - Side airbag, front right door, resistance too low`. **When the app reads those, it works.**

---

## The one thing that does not work

```
0xA77A   -> 77 07 77 07 77 07 70     same as the vendor
0xB318   -> 77 07 77 07 77 07 70     same as the vendor
0x83F0   -> 77 07 77 07 77 07 70     same as the vendor
0x46F1   -> C4 F0 C4 B8 FF           vendor gets: 80 04 00 84 80 12 A0 ...
```

`0xC4`-prefixed bytes are the signature of reading a line at a rate nobody is transmitting on. The
cable is still talking 19200 while we have moved to 9600 — **it did not switch, and for the vendor
it does.**

### Ruled out by measurement

Two of the day's runs were taken without the ignition definitely on — the fifteen-second
switch-placement test and the twenty-second rate matrix. The owner confirmed the rest had the
ignition in position 2 or the engine running. What that costs each conclusion is noted below.

- **Timing of the switch.** Run 55 swept 0 to 150 ms between the write and the switch; all nine gave
  byte-identical results. Ignition was on; this stands.
- **Which side of the reply the switch goes on.** Run 56 tested all three arrangements and its
  ignition state is uncertain — but run 58, which was taken with the engine running, used the
  arrangement it chose and got the vendor's exact `77 07 77 07 77 07 70`. Confirmed independently.
- **"The cable listens at 19200, not 9600".** Run 57, the rate matrix, is one of the two uncertain
  runs. **Not established** — it may have been measuring sleeping modules. Treat as open.
- **The frame bytes and the key.** Our `0x83F0` is `09 83 F0 80 E5 50 47 66 28 14 1A` at key `0xE9`,
  byte-for-byte the vendor's, at the same key.
- **Baud and parity encoding.** 9600 → `0x4138`, 19200 → `0x809C`, both the standard FTDI values;
  parity EVEN is 2, one stop bit is 0.
- **Read windows.** Fixed in run 54; the sign-on reply takes ~306 ms and the window had been 300.
- **Purging.** Now done before every write, as the vendor does.

### The leading suspect, untested

**The vendor writes one byte per `FT_Write` call, with gaps between them. We write whole frames in
one bulk transfer.**

In the proxy log the vendor's eleven-byte `0x83F0` goes out as eleven separate calls spread over
about 30 ms. Ours goes out as one USB transfer and the bytes leave back-to-back at the line rate.

Two reasons to take this seriously. The cable's `bmwscan.ini` carries `Delay=20` and `Delay2=40`
under `[Communication]` — millisecond inter-byte delays — and **`0x83F0`'s payload is those two
numbers**. A device that takes its inter-byte timing as a command parameter is a device that cares
about inter-byte timing. And the microcontroller reads a byte at a time; a frame arriving with no
gaps is the one thing it might not cope with.

Nothing has tested this. It is the first thing to try.

### Other untested differences

- The vendor calls `FT_SetTimeouts(800, 800)` once; we never do.
- The vendor never resets the chip after opening; we call `SIO_RESET` once at open.
- We have never replayed the vendor's exact recorded byte stream verbatim. The steps are extracted
  and ready — see the scratchpad work in run 57 — and that would remove every reconstruction of ours
  from the question at once.

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
