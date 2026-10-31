# Logging pass-through for FTD2XX.DLL

Records what the **genuine** vendor software says to the **genuine** cable. The sibling tool in
`../ftd2xx-shim` does the opposite — it answers in place of a cable, which is how the protocol was
recovered with no hardware — and cannot see real traffic by construction.

## Installing it, inside the VM

In `C:\BMWScan140`:

1. Rename the driver the installer put there: `FTD2XX.DLL` -> `ftd2xx_real.dll`
2. Copy this build in as `FTD2XX.DLL`

Both files must sit in that folder. The proxy looks for `ftd2xx_real.dll` **beside itself** and
nowhere else — not in System32 — because on a machine with the driver installed system-wide that
search could resolve back to the proxy and recurse.

Sizes, if you need to tell them apart by eye:

| file | bytes |
|---|---|
| genuine FTDI driver | 81,920 |
| the shim (answers instead of a cable) | ~241,000 |
| this proxy | ~231,000 |

## The log

`\vboxsvr\xfer\ftd2xx-proxy.log` when the shared folder is mounted, otherwise next to the
executable.

Empty reads are not logged. The vendor software polls one byte at a time and spins on empty
returns; logging those buried the real traffic in the shim's early logs.

## Why only thirteen functions are implemented

The other sixty exports are **forwarders declared in `ftd2xx.def`** — the Windows loader resolves
them straight to `ftd2xx_real.dll` and no code here runs for them. A calling convention cannot be
mangled on a function that has no implementation, which keeps the part that could get a measurement
wrong down to the dozen calls that actually carry the conversation.

## Building

Docker Desktop running, then:

    docker run --rm -v "<this folder>:/src" bmwshim-build bash -lc \
      "cd /src && i686-w64-mingw32-gcc -O2 -shared -o FTD2XX.DLL ftd2xx_proxy.c ftd2xx.def \
       -Wl,--enable-stdcall-fixup -lkernel32 -luser32"

`ftd2xx.def` is generated from the shim's export list; regenerate it if that list ever changes.
