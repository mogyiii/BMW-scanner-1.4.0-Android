# What to build next — written 2026-11-05

Milestone 1 is done: the app reads the car, on both protocols, from a phone, and every reading is
checked against the vendor software's own output. This is the list of what could come after it,
with what is already established for each, what is actually missing, and **how we would know we got
it right** — because on this project that last question has been the difference between progress and
three weeks of confident error.

Ordered by value per unit of work. Nothing here is started.

---

## 1. Fault descriptions — the format is solved, the variant selector is not

**The table format is fully decoded, and 55 descriptions now ship.** `tools/fault_text.py` reads
them out of the executable.

Each table is an ordinary Delphi constant string holding its own lookup structure:

```
[refcount -1][length:4]            the AnsiString header
[textOffset:2 BE][code:2 BE][00]   repeated - the index
[len][characters]                  repeated - the strings
```

A fault code `c` is the record whose code field is `c + 1`, and that record's first field is the
byte offset of the description's text inside the same string. Addresses resolve as
`file = VA − 0x400000 + 16`, because `unpacked.bin` is a memory dump with a sixteen-byte header
that states the image base itself.

Two things had to be got right and were initially got wrong. The index position is **not** the
code — that is true only for the steering sensor, whose codes happen to be dense; the climate
module jumps from `08` to `0A`. And an early termination rule that stopped the walk when the index
reached the first string killed the steering table outright, because its first record points inside
the index.

**What ships.** The steering sensor (15 codes), the climate module (23) and the instrument
cluster (40) — the tables that reproduce *every* code whose text the vendor printed for the test
car. That takes the app from twelve hand-written descriptions to seventy-eight.

**What does not, and why it matters more than what does.** The binary holds 93 of these tables and
there is one per module *variant*. For the ABS, the best candidate has 115 codes and gets two of
this car's four exactly right — the other two are off by one and by ten, the signature of a
neighbouring variant. Shipping it would have bought two correct descriptions and a hundred
plausible wrong ones. The climate module, the airbag and the engine controller produce no matching
table at all; the climate text is split across a location list and something else, since
"AUC heating" is not in the array that holds "AUC sensor".

**The four unshipped modules are not one problem but three**, which is worth knowing before
anyone picks this up:

| module | situation |
|---|---|
| ABS, DME | Right structure, **wrong variant**, and still open. The DME's "Failure oil status sensor" exists exactly once in the binary, in a table that files it under `0x27C5` where the vendor prints `0x27C3`. The ABS is off by one and by ten on two of four. Small, inconsistent offsets — the signature of a neighbouring variant, not of a decoding error. |
| IHKA | **Fixed.** The parser was starting its code walk at `prev = 0` with a strict `>`, so any table numbering its first code `0` — the rear climate table does — died on record zero and was discarded whole. With `prev = -1` the image yields 136 tables instead of 93, and the climate module's own table is among them. |
| SRS | **The text is composed.** "Side airbag, front right door, resistance too low" does not exist in the binary as a string at all; "Side airbag" does. The vendor assembles that line from parts. |

### The selector, as far as it is mapped

The chain from a table back towards the identity is now traced most of the way, and the shape is
not what "find the selector function" suggested.

**Every table has a getter.** 134 of the 136 sit behind an identical fourteen-byte prologue ending
`MOV EAX, <table>; CALL <common lookup>`. Each getter is called from exactly one place.

**Those call sites are switch cases.** The dispatch is the classic Delphi dense-case form:

```
MOV EDX, [0x6DA4A0]                a global pointer
MOV EDX, [EDX]
MOV EAX, [EDX + EAX*4 + 0x2B8]     this module's variant index
CMP EAX, 0x4E                      bounds check
JA  default
MOV AL,  [EAX + 0x4D3D67]          a byte map, one entry per variant index
JMP      [EAX*4 + 0x4D3DB6]        a jump table, one entry per case
```

So **the variant is a small integer held per module in a global record**, at offset `0x2B8` of
whatever `[0x6DA4A0]` points to, and a switch turns it into a table. Seventeen dispatchers of
exactly this shape exist; the largest maps 79 variant indices onto 22 cases and 20 tables.

**Two gaps remain, and they are different sizes.**

1. *Not every getter is reached this way.* The steering sensor's is called from `0x004F81C7`, and
   the nearest dispatcher of the above shape is 13 KB earlier — so some families use a plain
   if/else chain or another form. Finding those is mechanical.
2. *Nothing yet shows how an identity becomes a variant index.* That is the real remaining
   question, and it is one function: whatever fills `[…+0x2B8]` after a module answers `1A 80`.

**The practical consequence is small and worth stating.** None of this changes what ships today —
the three confirmed modules were matched against the control set, not through the selector. The
selector matters for the ABS and the engine controller, and for making descriptions work on cars
other than this one.

**How we would know it is right.** Unchanged, and now partly used: this car gives twelve codes
across six modules with known text. A selector worth having reproduces all twelve. Two modules
are done that way already.

---

## 2. Engine live values — solved 2026-11-06

**It is on the immobiliser.** `0x5132` → DS2 `6B` on `0x44`, sixth byte, engine speed in hundreds.

Two documents in this repository said engine live values were unavailable, on the strength of the
engine controller refusing `A2` and `22 20 00` and no engine poll loop appearing in any capture.
All of that is true and none of it was the point: **nobody is polling the engine controller.** The
immobiliser has to know whether the engine is turning, so the DME tells it, and the vendor's screen
reads it from there. The owner said from the start that the rpm was in the EWS menu; I spent two
captures searching address `0x12`.

The evidence is a throttle blip the owner performed deliberately so the display would move, caught
at the 1.3-second interval they described:

```
  16:47:12.881   0F   1500
  16:47:15.789   07    700   back to idle
  16:47:21.097   14   2000   the blip
  16:47:22.414   08    800
  16:47:25.021   07    700
```

and the same byte reading `06`/`07` at idle in the previous day's capture, before anyone was looking
for it. Five independent agreements: the menu the owner names, the poll rate they describe, idle
matching the figure they read off the screen, the spike landing where they pressed the pedal, and
the decay afterwards.

**Resolution is 100 rpm and that is the car, not us** — nothing else in the reply moves. It is
enough for "is it running, and roughly how fast", which is what an immobiliser needs to know.

**Shipped.** The scan reads it, the header shows it next to the odometer, and
`protocol.test.mjs` asserts all five frames above.

**What is not done:** polling. The app reads it once per scan, so it is a snapshot rather than a
gauge. A live display is a UI job, not a protocol one — the hard part is finished.

---

## 3. Steering angle, live — measured 2026-11-06

**Settled.** `0xA651` → DS2 `0B 01` on `0x57`, sixty-two readings over a real sweep. The reply body
is `[angle][complement][95][noise]`:

```
   0   FE 82 95 D1     at rest
   8   ED 92 95 D0     237  =  -19
   9   BA C2 95 CF     186  =  -70
  10   73 F5 95 D1     115  = +115   <- continuous: -70 - 71 wraps
  12   0B 8A 95 CF      11  =  +11
  40   FE 82 95 CF     back at rest, byte for byte
```

- **The angle byte wraps** inside a movement well short of full lock, and there is no turn counter
  or coarse field anywhere in the reply. So this command cannot give an absolute angle on its own.
- **The second byte is `(0x80 − b1) mod 256`**, exactly, whenever the wheel is still — and drifts
  while it moves, which is what a redundant channel sampled a moment apart does.
- The third byte is always `0x95`; the fourth jitters within ±2 of `0xD1`, which is noise.
- At rest it reads `FE 82` at the start and `FE 82` again fifty readings later. The sensor is
  exactly repeatable, so nothing here is drift.

**An earlier version of this section was wrong on both counts** — it called the second byte a
complement summing to `0x17F` and read a flag bit out of one sample that summed to `0x15F`. The
sums only looked constant because all four samples came from a two-centimetre nudge. Fitting a
rule to four adjacent points invented a flag that does not exist.

**What is left.** The coarse field, wherever it lives. It is not in `0xA651`, and it is not in
`0x35CF` (DS2 `08 <page>` on `0x57`), whose six pages are each read once and look like calibration
rather than live values. The vendor's own screen shows degrees, so it reads the coarse part
somewhere — a capture of *only* that screen, with the wheel swept lock to lock, would show which
command carries it. Everything else on that screen is now decoded, so the next capture has one
question to answer instead of several.

---

## 4. Service interval

**Why.** The owner asked about the oil service early on, and it is a thing people actually want to
see. Reading it is a read; resetting it is not, and stays out (see below).

**What is established.** `0xA358` → DS2 `02 03` on the cluster:

```
A0 03 00  03 D4  01 6D  0B B8  00 00 01
          = 980  = 365  = 3000
```

Three 16-bit values. `365` is hard to read as anything but days.

**What is missing.** What the other two are, and in what units. **This is a guess and must not ship
as anything else** — the app would be putting a number next to the word "oil" and people act on
that.

**Cost.** An hour, most of it UI.

**How we would know it is right.** The cluster shows the remaining service distance and time itself:
ignition off, hold the odometer button. Two numbers on the dashboard against three in the reply is
enough to pin the mapping, and if it does not line up we have learnt that cheaply and shown nothing.

---

## 5. Confirm the things built but never run

The unknown-module sweep, the shadow-memory unlock and the Valvetronic module all went in without
ever meeting a cable.

- **The sweep** should find nothing on this car. That *is* the result worth having: it confirms the
  nine are the whole list and that the sweep does not invent answers. If it reports a find here,
  something is wrong with it.
- **The unlock** should make the airbag module's `06/20` appear, which the vendor software sees and
  this app currently cannot.

- **The Valvetronic controller at `0x1B`** should identify as `7.516.207` / hardware `10`. Its
  fault memory is the genuinely open question: the vendor software never asked it, and its report's
  error column for that row reads "no data". Our app will ask. Whatever comes back — codes, a
  refusal, or silence — is new, and the app now reports all three differently.

**Cost.** One trip, ten minutes. This is the cheapest item on the list and the only one that
verifies code already shipped.

**Where `0x1B` came from.** It was found while adding one unrelated address to the sweep as a joke.
Checking that the addition was worth anything meant comparing the vendor's two probe lists, which
turned up six addresses it only ever asks over KWP — four of which our sweep did not know about,
and one of which is a module on this very car that we had never read. The lesson is not about
Valvetronic: it is that the sweep had been shipped **sending the DS2 identify only**, on a project
whose own engine controller and ABS do not answer that. A tenth module was sitting in a capture we
had already analysed twice.

---

## 6. Lighting module, live

`0x79DE` → DS2 `15 <page>` on `0xD0`, four pages of sixteen bytes with data and a tail of empty
pages. Content unknown; the bytes look like packed per-circuit status.

Unlike the steering sensor there is no varying input in the capture, so this needs the experiment
designed first: one lamp at a time, read, diff. That is a careful hour at the car with the lights on
and the battery watching, and the payoff is smaller than anything above it. Worth doing, not worth
doing first.

---

## Ruled out, with the evidence

Recorded so nobody spends an afternoon rediscovering them.

| | |
|---|---|
| **Airbag live values** | `0x99C7` → DS2 `0B` returns `FF FF FF FF FF FD FF FF FF FF`, identical on all 23 reads. There is nothing in there. |
| **Oil service reset** | DS2 `0C 12 01` — service `0C` is an actuator call, so a write. Out of scope by the owner's standing decision, and refused by the cluster anyway: it answers `A2`. The vendor software gets the same refusal. |
| **Module coding** | Raised, looked at, dropped. The risk is not symmetric with reading and the vendor software has backup and restore buttons this app does not. |
| **Odometer writing** | Excluded on day one. There is no code here that could. |

---

## On capturing more

The owner offered to dump every module's memory rather than the two or three that were done.
**Not needed, and worth saying why rather than just declining:** those `.bin` and `.epb` files are
module EEPROM and flash images, and nothing on this list reads from them. The fault text is in the
executable, the live values are on the wire, and the service interval is a DS2 read. They are also
the one class of artefact kept out of the repository, because a cluster image carries the stored
odometer and the `_wr` files are write images for the one thing this project rules out. More of
them would be effort spent producing something we cannot use and would not publish.

**What is worth capturing is traffic, not memory** — and specifically the two live-data screens in
§2. Fifteen minutes of that is worth more than every module dump combined, because it is the only
way to learn a command the cable knows and we do not.

A note on method, since it has cost this project before: capture *one thing at a time*. The 4.1 MB
recording is excellent and it answered a great deal, but it was everything at once, so "the engine
live screen was open" and "the proxy was attached" turned out not to overlap and nobody could tell
until the file was analysed days later.

---

## Suggested order

1. **The ten-minute trip** (§5). It verifies shipped code and costs nothing.
2. **The live-data capture** (§2), which also delivers §3. Needs the laptop and the engine running.
3. **Fault descriptions** (§1). The largest piece, and the one that changes what the app is worth to
   somebody who is not us. No car needed, so it can happen between trips.
4. **Service interval** (§4), verified against the dashboard or not shipped.
5. **Lighting** (§6), if there is appetite.

---

## If you are at the car with ten minutes

- Scan. The nine should read as before; the airbag tile should say the shadow memory is locked.
- Press the airbag tile, read the explanation, and unlock it if you are willing. Expect `06/20`.
- Check the **VTC1** tile. It is new and has never met a cable; whatever its fault memory says is
  a result nobody has.
- Press **Missing?**. Expect nothing found, and let it finish.
- Leave the steering angle for the laptop trip in §2 — our app does not decode it yet, so turning
  the wheel for this app's benefit gains nothing the vendor software would not give better.
- Share the log.
