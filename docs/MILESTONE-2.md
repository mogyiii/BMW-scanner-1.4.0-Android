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
