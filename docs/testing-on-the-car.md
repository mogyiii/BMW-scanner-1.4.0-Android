# Field test procedure — first contact with the car

The cable lives in the car, so there is no desk rehearsal: the first time it meets the phone is also
the real test. The app is built around that. **One button does everything.**

The goal of this session is **not** to read fault codes. It is to answer three questions, in order,
and to come home with a log:

1. Does the phone see the cable at all over OTG?
2. Is the cable a plain FTDI serial port onto the K-line?
3. Does any module answer DS2 framing?

## The car in question

E46 316i, 2002, 1.8 l **N42B18** (Valvetronic), 16-pin OBD-II socket under the dash.

Two things worth knowing before interpreting the log:

**The engine ECU may not behave like the rest.** The N42 is a Valvetronic engine from the generation
where BMW was moving the DME towards the KWP2000 family, while the body and chassis modules
(cluster, airbag, ABS, light module, climate, immobiliser) stayed on 9600-baud DS2. Which family
*this* DME answers is an open question rather than something to assert — it is why the sweep tries
10400 baud as well as 9600. If the body modules answer and the DME does not, that is an informative
result, not a failure.

**"Channel A" / "Channel B" is probably not decorative.** The shipped INF declares two interfaces on
this cable. The E46's 16-pin socket carries more than one diagnostic line, and the most economical
explanation for a dual-channel FTDI in a BMW cable is one channel per line. So Channel B is a
first-class thing to test, not a last resort — the sweep covers both automatically.

## Do this

1. **Ignition to position 2** — everything live, engine not running. Most modules do not answer a
   sleeping bus, so an "ignition off" test proves nothing.
2. Cable in the OBD socket, OTG adapter, phone.
3. Open **BMW DS2 Probe**. Android may offer to open it automatically when the cable is plugged in —
   accept, and tick *always* if offered, because that also grants USB permission.
4. Press **▶ FULL RUN**.
5. If it asks for permission, tap OK and **press FULL RUN again**. That is the only interaction.
6. Wait. It takes about a minute and a half. The screen is held awake deliberately.
7. When it prints `FULL RUN COMPLETE`, press **SHARE LOG** and send it over.

That is the whole procedure. FULL RUN finds the cable itself, dumps the USB descriptors and the FTDI
EEPROM, then sweeps every combination of

- channel A and B (however many the chip actually exposes)
- 9600 and 10400 baud
- even and no parity
- echo cancellation on and off

sending identification requests in each, and saves the log at the end whatever happens.

**Stop** aborts a run that is clearly going nowhere; the log is still there.

## Reading the verdict

The run ends in one of four states.

**`No USB device is visible at all`.** The cable is not reaching the phone, and nothing else was
tested. Causes, in likelihood order: the OTG adapter is a charge-only one that does not pull the USB
ID pin low; the cable is not seated; the phone will not power a bus-powered device. Note that this
is the one failure where the car is irrelevant — it would fail on a desk too.

**`WORKING CONFIGURATION FOUND`.** The cable is a transparent FTDI K-line interface and DS2 framing
is right. This is the good case. Set the reported channel / baud / parity / echo in the controls,
press **Connect**, then **Scan bus** for the full 256-address module list. Those addresses are the
real ECU table for this car and they replace the guesses in `Ds2.KnownEcu`.

**`No valid frame anywhere, but bytes did come back`.** The physical layer is alive and the framing
is wrong — which is still good news, because it means the cable *is* a serial bridge. Connect with
the settings the sweep names as best and use **Send raw** to push bytes by hand. Check the log for
`PARITY-ERROR` / `FRAMING-ERROR`: that points at line settings rather than framing.

**`Total silence in every configuration`.** First rule out the boring causes: ignition really in
position 2, cable properly seated. The *Descriptors* section near the top of the log proves the
phone is powering the cable, so read that before concluding anything.

If it is genuinely silent everywhere, that answers the project's central question: the cable is not a
transparent serial bridge and expects initialisation or framing of its own. That moves us to plan
B — capture the USB traffic of the original software in a throwaway VM and reverse engineer the
wrapper from it. A longer route, not a dead end.

## Afterwards — mapping the commands

Only once a configuration is known to work. The command bytes in `Ds2.Command` are **unverified
candidates**; with a known-good address from the scan, use the hex field and **Send as DS2** to try
them one at a time. Type the address followed by the payload:

```
12 00      identification        (this one is well documented)
12 04      candidate: read fault memory
12 0B      candidate: read measurement block
```

Record what comes back for each. A module answering `A0 ...` is a success; `A2` suggests the command
exists but wants parameters.

**Do not try `05` (candidate clear-faults) or any other write command during this mapping.** Firing
blind writes at a protocol we have not mapped yet is not a risk worth taking on a car you drive.

## Getting the log off the phone

**SHARE LOG** puts the whole thing in the share sheet as plain text — mail, chat, whatever. That is
the reliable route.

FULL RUN also writes a file automatically:

```
/sdcard/Android/data/hu.bmwscanner/files/ds2probe-YYYYMMDD-HHMMSS.log
```

but on Android 11+ that directory is awkward to reach from a file manager, so prefer Share.
