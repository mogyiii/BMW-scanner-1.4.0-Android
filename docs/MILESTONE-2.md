# What to build next — written 2026-11-05

Milestone 1 is done: the app reads the car, on both protocols, from a phone, and every reading is
checked against the vendor software's own output. This is the list of what could come after it,
with what is already established for each, what is actually missing, and **how we would know we got
it right** — because on this project that last question has been the difference between progress and
three weeks of confident error.

Ordered by value per unit of work. Nothing here is started.

---

## 1. Fault descriptions — solved 2026-11-09

**374 descriptions ship, across five modules**, up from twelve hand-written ones. `tools/fault_text.py`
reads them out of the vendor binary; a module is included only if its table reproduces, exactly,
every code whose text the vendor printed for the test car.

| module | table | entries |
|---|---|---|
| DME `0x12` | `0x004B3FB8` | 181 |
| ABS `0x29` | `0x004EAC30` | 115 |
| LEW `0x57` | `0x004F7F54` | 15 |
| IHKA `0x5B` | `0x004FE21C` | 23 |
| IKE `0x80` | `0x00510604` | 40 |

Three things had to be worked out, and each one was got wrong first.

**The format.** Each table is a Delphi constant string holding its own index:
`[refcount -1][length:4]`, then `[key:2 BE][code:2 BE][00]` records, then length-prefixed strings.

**Which table.** One per module *variant*, 136 in the image. A module's variant is chosen by its
`DI` field as hex, looked up in a per-module comparison chain between `0x499000` and `0x4A2000`,
giving an index that a switch turns into a table. Verified on three modules independently — A/C
`DI 32` → 12, DME `DI 000F` → 43, ABS `DI 0006` → 19 — each landing on a table already known by
other means to be the right one.

**How a code finds its text, which was the last and hardest piece.** The key is an **exclusive
upper bound**: a fault code selects the first record whose key is strictly greater than it. The
index describes ranges, not individual codes.

Reading the key as `code + 1` is right only where the keys are consecutive. It reproduced the
steering sensor perfectly and failed the ABS on two codes of four, and the engine controller gave
the clearest counter-example: key `0x27C3` exists and holds "Output A/C-compressor control", while
the vendor prints "Failure oil status sensor" for *code* `0x27C3`, which lives under key `0x27C6`.
`key > code` reproduces **all eleven** codes whose text the vendor printed, across five modules and
both protocols.

**One consequence.** Because keys are bounds, a code inside a gap resolves to its range's text
rather than to nothing. That is the vendor's own behaviour, and it is why the raw bytes stay on
screen next to every description.

**Still out: the airbag module**, and its structure is now known even though it is not shipped.

Its line is composed from two lookups joined by `", "`. The location half lives in a table at
`0x00505700` whose **keys repeat** — every key carries exactly three consecutive texts, a German
one, an English one and an empty one — which is why the strict walk used for every other module
stopped at its second record and discarded the table. Key `0x06` holds `Side airbag, front right
door`, which is this car's fault.

The second half, `resistance too low`, sits at key `0x06` of a 234-entry table that exists in 47
copies, one near each module's code. Our fault's parameter is `0x20`, not `0x06`, so a third
lookup stands between the parameter and that key and has not been found. Nearby code computes a
key as `((x & 0x40) >> 6) * 20 + 0xF02` into the same table, so those 234 entries are reached by
several different formulas.

**Not shipped, and the reason is proportion rather than difficulty.** It is one module of ten; the
one fault this car has in it is already described by hand in both languages; and the location
table's convention appears to be `key == code` where every other module uses `key > code`, which
is a difference worth more than one confirming data point before it ships.

**The five shipped tables are not affected.** Checked explicitly: strict and repeat-tolerant walks
return identical records for all five, so nothing was truncated by the stricter rule.

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

## 4. Service interval — the app now reads it, the meaning is yours to confirm

**Shipped as raw numbers, deliberately unlabelled.** `0xA358` → DS2 `02 03` on the cluster returns
three big-endian 16-bit values; on this car `980 / 365 / 3000`. They appear in the cluster's detail
view and in the log as "service counters (meaning not yet confirmed)".

`365` is hard to read as anything but days and `3000` looks like kilometres, but *looks like* is
not a decoding, and this sits next to the word "oil" where a wrong figure gets acted on.

**The experiment, which takes a minute and needs no cable.** Ignition off, press and hold the
odometer reset button in the instrument cluster. The cluster displays its own remaining service
distance and time. Write both down, then compare them with the three numbers the app shows. Two
dashboard figures against three app figures is enough to pin which is which — and if nothing
lines up, we have learnt that cheaply and shown nobody a wrong number.

---

## 5. Lighting module, live — the app now captures the pages

**Shipped into the log, not the screen.** `0x79DE` → DS2 `15 <page>` on `0xD0`, pages 0 to 3,
sixteen bytes each. They go into the shared log as raw bytes under `0x79DE lap N`. Nothing is
decoded, because nothing can be until there are readings taken under known conditions.

**The experiment.** One scan per lighting state, each one shared, with a note of which state it
was:

1. Everything off — the baseline.
2. Sidelights only.
3. Dipped beam.
4. Main beam.
5. Left indicator on (leave it ticking).
6. Brake pedal pressed — needs a second person or something heavy on the pedal.

Each scan takes about a minute. Diffing six readings against the baseline shows which bits move
for which circuit, and that is the whole decode. Ignition in position 2 throughout; the engine
does not need to run.

**Why the order matters.** Change one thing at a time and return to the baseline if anything gets
confusing. The first steering-angle attempt produced data nobody could use because two variables
moved at once and nothing was written down.

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
