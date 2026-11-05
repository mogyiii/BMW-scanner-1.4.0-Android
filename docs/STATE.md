# Where this project stands — 2026-11-05

> # 🎉 The browser version read the car — 2026-11-05
>
> `log/teljesscan/Diagnosztikai napló.txt` is its own shared trace, from an Android phone at the car:
> Chrome 156, WebUSB, **eight modules read and every code matching the vendor's report**.
>
> ```
> 0x12  DME   VIN KP04220      27C3/64
> 0x57  LWS   0B/AF  09/97  04/17
> 0x5B  IHKA  1C/44  1E/42
> 0x80  IKE   BE/48
> 0x00 ZKE · 0x44 EWS · 0xA4 SRS · 0xD0 LCM   no faults
> 0x56  ABS   no answer
> ```
>
> No Android build, no adb, no laptop — a web page. The three different DS2 entry sizes all decoded
> correctly on the first attempt at the car.
>
> **It also found a real defect of its own.** The lighting module is listed with no faults while the
> raw trace shows its fault read never happened at all: the code collapsed "the store did not answer"
> and "the store answered zero" into the same count of zero, so a failed read displayed as a clean
> module. The two are now kept apart everywhere — tile, detail, log and the read-back after a clear,
> which previously could have said "the memory is empty" on the strength of a read that returned
> nothing.
>
> And `0x56` answering nothing is the capture's verdict confirmed on the car: the ABS is at `0x29`.

> # 🎉 All nine modules — 2026-11-05
>
> The owner borrowed a laptop and clicked through every read menu of the vendor software with the
> logging proxy attached: 4.1 MB, 1525 frames, 57 distinct commands, plus the vendor's own decoded
> report for the same car in the same session. `tools/command_atlas.py` turns that into a table of
> which command goes to which module and what service it stands for, read out of the K-line echo
> rather than guessed.
>
> **The ABS is at `0x29` and speaks KWP2000.** It was never at `0x56`. `0x56` was never an address
> at all — it is the letter `V`, the sign-on command's parameter, which I read out of a command
> tally as though it were a module and then spent weeks failing to get an answer from. `18 02 FF FF`
> goes to exactly two addresses in the whole capture, `0x12` and `0x29`, and `0x29` answers
> `58 04 5E1F A0 · 5E16 20 · 5E24 A0 · 5E43 A0` — the four faults the vendor prints for the ABS.
>
> **Shadow memory: `0x9E56`, DS2 service `14`,** paged exactly like `0xC731`. This is the vendor
> report's second error column, and this car has something in it — the SRS reads `no errors /
> 1 error`, a side-airbag fault that a live-memory-only scan calls a clean module.
>
> **Clearing: `0x1BCF` (DS2 `05`) and `0x41AC` (KWP `14 FF FF`).** Both are implemented, and both
> outcomes are in the capture to check against.
>
> `web/js/protocol.test.mjs` runs the decoders over bytes taken verbatim from that capture and
> checks them against what the vendor printed for the same bytes: 23 cases, all nine modules, all
> passing.

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

**It works.** All nine modules the vendor's own software finds, read from a phone or a browser,
across both protocols the car uses, including the shadow memories. The codes match the vendor's
output byte for byte, and `web/js/protocol.test.mjs` keeps them matching.

---

## Settled, with evidence

| | how we know |
|---|---|
| The protocol | Recovered from the vendor executable, then recorded off the wire through `tools/ftd2xx-proxy` while the genuine software did a complete scan |
| Our sequence is right | `tools/ds2-probe-win` sent the same frames through the genuine driver and the cluster answered |
| The readings are right | 23 decoder cases in `web/js/protocol.test.mjs`, each one real captured bytes checked against the text the vendor printed for those same bytes |

### The control set — this car, 2026-11-05

The vendor's report for the session that produced the big capture. Anything the app reads can be
checked against this.

| addr | module | protocol | faults |
|---|---|---|---|
| `0x00` | ZKE, body | DS2 | none / shadow none |
| `0x12` | DME, engine | KWP | `27C3/64` oil status sensor |
| `0x1B` | VTC1, Valvetronic | KWP | **never asked** — the vendor's report says "no data" |
| `0x29` | ABS / DSC | KWP | `5E1F/A0`, `5E16/20`, `5E24/A0`, `5E43/A0` |
| `0x44` | EWS, immobiliser | DS2 | none |
| `0x57` | LEW, steering angle | DS2 | `0B/AF`, `09/97`, `04/17` — **cleared, stayed cleared** |
| `0x5B` | IHKA, climate | DS2 | `1C/44`, `1E/42` |
| `0x80` | IKE, cluster | DS2 | `BE/48` — **cleared, stayed cleared** |
| `0xA4` | SRS, airbag | DS2 | none / **shadow `06/20`** side airbag, front right |
| `0xD0` | LCM, lighting | DS2 | none / shadow none |

The owner recalled the clear taking three codes out of the ABS. It did not: the ABS refused the
command outright, and the three that went were the steering angle sensor's. Worth recording because
the capture settles it and memory does not.

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

**The engine controller and the ABS are not DS2 modules.** `0x46F1` returns nothing but the echo,
for us and for the vendor alike. They speak KWP2000, framed `[B8][target][source][len][data][xor]`
— and the checksum is an **XOR**, not the additive sum ISO 14230 specifies. Checked across the whole
capture: `B8^29^F1^02^1A^86 = FE`, which is the byte on the wire. Before that was measured, KWP
replies were located by searching for a `0x58` byte and hoping, which happened to work on the engine
controller and would have mis-split anything carrying `0x58` in its data.

### The full command map

From `tools/command_atlas.py`, which reads each command's meaning out of the echo rather than
guessing. Only what is in scope is listed; the capture holds another forty-odd commands, mostly the
`23` memory reads behind the vendor's binary dumps.

```
DS2   0x46F1  00        identify            0x71A0  0E        assembly release (ADFG)
      0xC731  04 page   fault memory        0x9E56  14 page   shadow fault memory
      0x1BCF  05        clear faults

KWP   0x06F3  1A 80     identification      0xC358  18 02 FF FF   fault memory
      0x0DE7  1A 90     VIN                 0x41AC  14 FF FF      clear faults
```

Two details that cost time elsewhere and are cheap to state: page 0 of a DS2 fault store carries
only the count and page 1 carries every entry, so two reads suffice; and a positive acknowledgement
to a clear means *accepted*, not *now clean* — the engine controller accepts it and reports the same
oil-sensor fault on the very next read, because that fault is live rather than stored.

### The number that mattered

Reads stop on **800 ms of silence**, not on a clock. Some replies come in more than one block —
`0xB318` sends two seven-byte sentinels, `0x83F0` eleven bytes — and at 200 ms every one came back
cut in half, with the remainder landing in the next read and being credited to the next command.
Everything downstream was one block out of step, and for a fortnight that looked like a hardware
fault.

---

## What is left

The candidates are written up properly in [`MILESTONE-2.md`](MILESTONE-2.md) — what is established
for each, what is actually missing, and how we would know we got it right. In brief:

- **The ABS and the shadow memory have not been read by this app yet.** Everything else has: the
  browser version ran at the car (see the banner), but the run predates both of today's additions.
  The control set in the table is what to check them against — four codes from `0x29` and `06/20`
  in the airbag module's shadow store.
- **Fault descriptions** exist only for the codes this car has produced — twelve of them, each one
  the vendor's own text. The rest of the table is in the binary as contiguous short-string arrays
  with a per-module base code (`0x57`'s starts at `0x04`, so index = code − 4, which yields
  "Wrong LWS-ID" for `0B` and matches the vendor). Mapping all sixty modules is a day's work and
  nothing depends on it. An unknown code deliberately gets no description rather than a guess.
- **Live data** is identified but not implemented: `0xA651` (DS2 `0B 01`) on the steering angle
  sensor, `0x99C7` (DS2 `0B`) on the SRS, `0x79DE` (DS2 `15 n`) on the lighting module, `0x413C`
  and `0x49C8` (KWP `22 10 00` / `22 30 00`) on the ABS. The scaling of the values is not known —
  the capture shows the bytes, not what they mean.
- **The fault entry layout** is now checked on five DS2 modules rather than three, including the
  three different entry sizes (3, 10 and 14 bytes). The raw bytes still stay on screen, because the
  rule is fitted rather than derived.

---

## What is explicitly out of scope

Writing anything. Reads and fault clearing are the scope; clearing is in because it was asked for
and because the capture shows both outcomes plainly enough to report honestly.

Module coding — comfort closing and the like — was raised, looked at and dropped: the risk is not
symmetric with reading, and the vendor software has backup and restore buttons that this app does
not. Odometer writing was excluded from the start. `VendorProtocol.KNOWN_WRITES` marks the write
commands found so far.

**The oil service reset is out, and it turns out not to be a choice.** It is `0x3AED`, DS2
`0C 12 01` — service `0C` is an actuator/control call, so a write by any reading. The owner tried it
in the vendor software and got an error; the capture shows why, and it is not a software fault: the
instrument cluster answered `A2` instead of `A0` and refused it. Reading the intervals is a
different command and is harmless — `0xA358`, DS2 `02 03`, which returns
`A0 03 00 03 D4 01 6D 0B B8`, i.e. `0x03D4` = 980, `0x016D` = 365, `0x0BB8` = 3000.

---

## Mistakes worth not repeating

Recorded because they cost weeks, and all of them are the same shape: concluding from an uncontrolled
variable.

- **The ABS was listed at `0x56` for weeks** on the strength of a command tally in which `0x56`
  appeared — as the parameter of the sign-on command, where it is the ASCII letter `V`. A number
  read out of the wrong column, then chased as a module that does not exist. Its real address was
  sitting in the same capture: `18 02 FF FF` goes to two addresses and only two.
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
