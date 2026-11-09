# What lives outside this repository

Some of the work that produced the findings here could not be committed, and some of it should not
be. This is the inventory, so that nothing load-bearing is sitting in a folder nobody wrote down.

Everything below is on the development machine under `D:\VMs`. Paths are local and will differ
anywhere else; what matters is the list, not the drive letter.

## Accounted for — binaries whose source is in the repository

These are build outputs. They are outside because they are 32-bit Windows binaries that belong next
to the vendor executable inside a VM, not because anything about them is undocumented.

| outside | built from |
|---|---|
| `FTD2XX-PROXY.DLL` | `tools/ftd2xx-proxy/` — the pass-through logger that produced every `ftd2xx-proxy.log` in `log/` |
| `FTD2XX-SHIM.DLL` | `tools/ftd2xx-shim/` — the one that answers *without* a cable attached |
| `ds2probe.exe` | `tools/ds2-probe-win/` |

The shim's own run logs (`ftd2xx-shim-run35.log`, `-run40.log` and two others, about 3 MB) are also
out there. Their useful parts are in the repository under meaningful names —
`docs/field-logs/2026-10-29-run35-vm-full-command-set.log` and `-run40-vm-line-change.log` — which
is the arrangement to keep: the raw file is a scratch artefact, the named per-run copy is the
evidence.

## Deliberately outside

**`FTD2XX-ORIGINAL.DLL`** — FTDI's genuine library, renamed to `ftd2xx_real.dll` so the proxy can
forward to it. Someone else's redistributable; it is not ours to publish.

**`BMWScanXP/`** — the VirtualBox Windows XP machine with the vendor software installed. 2.7 GB of
disk image, so it could not go in a repository regardless, and it contains `BMWScan140.exe`, which
for the same reason as `build/unpacked/` is not redistributed from here. Its configuration is the
part worth keeping, and it is in `HANDOVER.md` under *Environment*: no network, no clipboard, no
shared folders, the software mounted read-only from a `.viso`, and VirtualBox's VISO parser treating
backslashes as escapes so host paths need forward slashes.

**`BMWScanXP.ova`** — a 1 GB export of that machine, made to carry it to the car on a USB stick.
Same reasoning, and nothing in it that the VM above does not have.

**`usbcap-session1.pcap`** — 5.2 MB pcapng of the vendor software's USB traffic, the input to
`tools/usbparse.py`. Left out on purpose rather than by omission: every byte it established is
transcribed in `docs/field-logs/2026-10-18-run6-vendor-usb-capture.md`, including the full request
sequence and the packet counts, and that run's conclusion was **invalidated anyway** — the cable was
off the car, so the "Hardware faulty" it recorded is what a healthy cable reports when unpowered.
Committing 5 MB to preserve a measurement we know to be void is the wrong trade. Both pointers to it
now name the real filename, which they previously did not.

`shared/` is an empty VirtualBox shared folder, `guest-out.txt` is zero bytes, and `bmwsoft.viso` is
the 1 KB mount descriptor. Nothing in any of them.

## The one thing that was genuinely undocumented

The procedure for capturing the vendor software at the car existed only as a note on the USB stick.
It is the procedure that produced the proxy logs, which are the primary evidence for the entire
command set, so it belongs here.

`docs/testing-on-the-car.md` is the *other* procedure — driving our own app from the phone. This one
is for the laptop, the VM and the vendor software.

### Before touching anything: confirm it works without the proxy

Start `BMWScan140.exe` the way it already worked and read one fault code. **If that fails, stop.** Do
not install anything. A working baseline is worth more than a capture, and it is the thing most
easily lost.

### Installing the proxy

Inside the VM, in `C:\BMWScan140`:

1. rename `FTD2XX.DLL` → `ftd2xx_real.dll`
2. copy `FTD2XX-PROXY.DLL` in as `FTD2XX.DLL`

Both must end up in that one folder. If the files get mixed up, size tells them apart:

| size | which |
|---|---|
| 80 KB | FTDI's original |
| 226 KB | the proxy — this one |
| 236 KB | the shim — **not** this one; it fabricates replies with no cable attached |

### What to capture, in this order

1. Car identification.
2. **A fault read from a module that actually has a stored fault.** This is the important one; the
   fault-reading command came out of it.
3. A few seconds of live data, if there is time.

**Do not clear the remaining faults.** They are the control set: if our own app later reads the same
codes back, that is the proof it works.

### The log

```
\\vboxsvr\xfer\ftd2xx-proxy.log
C:\BMWScan140\ftd2xx-proxy.log      (if the shared folder is not set up)
```

That file is the whole point of the trip. Nothing else needs to come back.

No internet is needed at any stage — the car is where traffic gets recorded, and the analysis
happens afterwards.

### If it will not start with the proxy

Rename `ftd2xx_real.dll` back to `FTD2XX.DLL`. That is a proxy bug, not a cable fault, and the
baseline is restored by that one rename.
