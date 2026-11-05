# What to build next — written 2026-11-05

Milestone 1 is done: the app reads the car, on both protocols, from a phone, and every reading is
checked against the vendor software's own output. This is the list of what could come after it,
with what is already established for each, what is actually missing, and **how we would know we got
it right** — because on this project that last question has been the difference between progress and
three weeks of confident error.

Ordered by value per unit of work. Nothing here is started.

---

## 1. Fault descriptions for every module

**The problem.** Twelve codes have text. Every other code shows as `5E1F / A0` and a row of bytes,
which is honest but not much use to somebody standing next to their car.

**What is established.** The vendor binary carries the text in plain, uncompressed, length-prefixed
strings packed end to end. `build/unpacked/unpacked.bin`, walk `[length][characters]` repeatedly:

```
0x0F7FB4  [ 0] Terminal 30 defective
          [ 1] Sensor current out of range
          [ 2] 90 degrees difference of wiper too large (Normal operation)
          …
          [10] Wrong LWS-ID
```

For the steering angle sensor the index is **`code − 1`**, and that reproduces all three codes this
car produced, exactly as the vendor printed them. (An earlier note in `findings.md` said the base
was 4. It is 1; the note was fitted to one code and happened to land.)

**What is missing, and it is not what it looks like.** The obvious next step — do the same for the
other modules — fails, and the reason is worth knowing before anyone spends a day on it. The climate
module's array is unmistakably the right one by content:

```
0x0FB2F1  [ 0] Evaporator sensor      [ 1] AUC sensor      [ 2] Brightness
          [ 3] Inner temperature sensor               …    [30] Unknown error location
```

but no single offset maps this car's `1C → AUC sensor` and `1E → AUC heating` onto it, and
"AUC heating" is not in that array at all. The explanation is in the counts: **"AUC sensor" appears
fifteen times in the binary and "AUC heating" twelve.** There is not one table per module. There is
one per *module variant* — the vendor's own report names the variant it picked (`IHKA E46
PU98/PU99`, `LWS5.1B`, `DSC E46,R50,E85`), and it picks it from the identity bytes it has just read.

So the real work is **finding the selector**, not guessing offsets: the function that turns an
identity into a table pointer. The tables themselves are already readable.

**Cost.** A day, maybe two, in the decompiler. No car needed.

**How we would know it is right.** This car gives twelve codes across six modules with known text.
Any selector worth having reproduces all twelve. That is a real test, not a plausibility check — and
it is already written down in `docs/STATE.md`.

---

## 2. Engine live values — and the one capture that would settle several things at once

**Correction.** An earlier draft of this document ruled engine live values out. That was wrong, and
the way it was wrong is worth keeping: two probe commands are genuinely refused — `0x41AA` answers
`7F A2 11` and `0x209C` answers `7F 22 11`, service not supported — and the capture contains no
engine poll loop. From absence plus two refusals I concluded unavailability. The owner watched the
vendor software display 600–700 rpm. It works; the route it works by is simply not in the recording
we have, which covers only the menus that were clicked while the proxy was attached.

**What the capture does establish.** Exactly one thing in it changes between repeated reads, which
is what live data is:

```
command  addr  reads  distinct
0xA651   57    33     17        steering angle
0xC731   5B     6      3        climate fault memory (an occurrence counter inside the entry)
```

Nothing else. There is no engine poll loop in these 1525 frames.

**The constraint worth knowing before planning around it.** The owner's instinct — that an ordinary
ELM327 reads engine data over documented OBD-II PIDs, so this cable should too — is right about the
car and blocked by the cable. Each vendor command carries a **fixed service prefix** and only the
arguments come from us:

```
0x4769 + payload 00 10 20   ->   DS2  06 08 00 | 00 10 20
0xD390 + payload 00 00 00 00 40  ->  KWP  23 | 00 00 00 00 40
0xC731 + payload 01         ->   DS2  04 | 01
```

So a request is not something we compose; it is a command the cable already knows, with our bytes
appended. There is no table in the executable mapping command numbers to services — the known ones
are scattered through it as incidental byte matches and never cluster — so the mapping lives in the
cable's own firmware. **We cannot invent a mode-01 OBD-II request.** We can only use a command that
exists, and the only way to learn one is to watch the vendor software use it.

Brute-forcing command numbers is not an option: `0xC751` sits in the same number space and is on the
do-not-send list, and an unknown number could be anything.

**So: one targeted capture, and it pays for two items at once.** The vendor software, the proxy
attached, and nothing clicked except the live-data screens:

1. Engine running, open the engine live-data screen, leave it for thirty seconds. That reveals the
   command, and the idle rpm on screen gives the value to decode against.
2. Then the steering-angle live screen, turning the wheel **lock to lock** this time, pausing at
   full left, centre and full right.

The second one matters because the vendor's screen shows the angle in degrees while the proxy
records the bytes — so the calibration comes out of the same recording, with no notes to lose.

**Cost.** Fifteen minutes with the laptop and the engine running.

---

## 3. Steering angle, live

**Why this one and not the others.** It is the only live value in the capture with a varying input:
the wheel was moved while recording. Everything else sat still.

**What is established.** `0xA651` → DS2 `0B 01` on `0x57`, 33 readings, 17 distinct. The reply body
is five bytes:

```
A0  FA 85  95 D2
A0  F5 8A  95 D0
A0  E3 9B  95 D1
A0  EF 70  95 CF
```

The first two move together and the rest barely moves. `FA+85`, `F5+8A`, `F8+87` and `FB+84` all sum
to `0x17F`, so **the second byte is the first one's complement** — the redundant-channel encoding a
steering sensor is required to have. `EF+70` sums to `0x15F`, short by exactly `0x20`, so one bit of
that byte is a flag and not part of the number.

**What is missing, and a useful constraint on it.** The owner moved the wheel about **one or two
centimetres at the rim** — enough to prove data was coming back, not enough to calibrate. The first
byte covered `E3`…`FE` over that, a span of 27 counts.

Two centimetres on a rim of roughly 38 cm is in the region of 6°, so the resolution is of the order
of a fifth of a degree per count. That is a rough estimate from a remembered hand movement and
should be treated as one — but it is enough for the conclusion that matters: **one byte at that
resolution covers about ±28°, and the wheel turns far further than that.** There is a coarse field
somewhere we have not identified. The `95` that never moved and the `D2`/`CF` that jittered are the
candidates, and a two-centimetre sample cannot tell them apart.

**Cost.** Folded into the capture in §2; alone, five minutes at the car and an hour of arithmetic.

**How we would know it is right.** Lock to lock, pausing at full left, centre and full right. Three
widely separated positions settle the scale, the sign and whether a coarse field exists, and the
return to centre catches drift. Doing it with the vendor software running means its own display
gives the degrees while the proxy records the bytes — the calibration then comes out of one file,
with nothing to write down and lose.

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
