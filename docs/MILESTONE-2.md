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

## 2. Steering angle, live

**Why this one and not the others.** It is the only live value in the capture with a *known varying
input*: the wheel was turned while recording. Everything else sat still.

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

**What is missing.** Which angle. One byte of range cannot hold ±720° at any useful resolution, so
either the scale is coarse or there is a second field we have not identified — and the capture
cannot settle it, because nobody wrote down where the wheel was.

**Cost.** Five minutes at the car, then an hour of arithmetic.

**How we would know it is right.** A controlled read: wheel centred, full left, full right, and
centred again. Three known positions against three byte values determines the scale and the sign, and
the return to centre catches drift. The vendor software displays the angle in degrees, so running it
side by side would settle it outright.

---

## 3. Service interval

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

## 4. Confirm the two things built but never run

The unknown-module sweep and the shadow-memory unlock both went in without ever meeting a cable.

- **The sweep** should find nothing on this car. That *is* the result worth having: it confirms the
  nine are the whole list and that the sweep does not invent answers. If it reports a find here,
  something is wrong with it.
- **The unlock** should make the airbag module's `06/20` appear, which the vendor software sees and
  this app currently cannot.

**Cost.** One trip, ten minutes. This is the cheapest item on the list and the only one that
verifies code already shipped.

---

## 5. Lighting module, live

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
| **Engine live values** | Not available by the routes the vendor tried. `0x41AA` (KWP `A2`) answers `7F A2 11` and `0x209C` (KWP `22 20 00`) answers `7F 22 11` — service not supported. The ME9.2 in this car simply does not serve them. The 314 `0xD390` calls in the capture are a flash dump at sequential addresses, not live variables. |
| **Airbag live values** | `0x99C7` → DS2 `0B` returns `FF FF FF FF FF FD FF FF FF FF`, identical on all 23 reads. There is nothing in there. |
| **Oil service reset** | DS2 `0C 12 01` — service `0C` is an actuator call, so a write. Out of scope by the owner's standing decision, and refused by the cluster anyway: it answers `A2`. The vendor software gets the same refusal. |
| **Module coding** | Raised, looked at, dropped. The risk is not symmetric with reading and the vendor software has backup and restore buttons this app does not. |
| **Odometer writing** | Excluded on day one. There is no code here that could. |

---

## Suggested order

1. **The ten-minute trip** (§4). It verifies shipped code and costs nothing.
2. **Steering angle** (§2) on the same trip — three wheel positions, written down.
3. **Fault descriptions** (§1). The largest piece, and the one that changes what the app is worth to
   somebody who is not us. No car needed, so it can happen between trips.
4. **Service interval** (§3), verified against the dashboard or not shipped.
5. **Lighting** (§5), if there is appetite.

---

## If you are at the car with ten minutes

- Scan. The nine should read as before; the airbag tile should say the shadow memory is locked.
- Press the airbag tile, read the explanation, and unlock it if you are willing. Expect `06/20`.
- Press **Missing?**. Expect nothing found, and let it finish.
- Turn the wheel full left, scan, then full right, scan, then centre, scan — and **write down which
  is which**. Without that note the three readings are worth nothing, which is the mistake the first
  capture already made.
- Share the log.
