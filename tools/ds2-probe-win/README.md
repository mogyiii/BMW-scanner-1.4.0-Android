# ds2probe — the Android sequence, run through the genuine driver

By run 60 everything about the bytes had been ruled out: frames byte-identical to the vendor's at
the same key, pacing from 0 to 15 ms per byte making no difference, a verbatim replay of the
vendor's own recorded stream failing exactly like ours, handshake lines changing nothing, and the
ignition confirmed on by the line-idle check. The vendor software reads this car; the Android app
does not.

The layer never separated is underneath all of that. The Android code drives the FT232R with its own
raw USB control requests; the vendor talks to a driver. This sends the same sequence the app sends,
through that driver.

    works here  -> the sequence is right, and our raw-USB FTDI layer is what differs
    fails here  -> the sequence is wrong, and the vendor does something not yet captured

## Running it

Copy `ds2probe.exe` next to `BMWScan140.exe` inside the VM, cable plugged in, **ignition in position
2 or the engine running**, then from a command prompt:

    cd C:\BMWScan140
    ds2probe.exe

It prints every frame it sends and everything that comes back. If the logging proxy is installed the
same traffic lands in `ftd2xx-proxy.log`, which costs nothing and corroborates.

## Reading the result

The line that matters is the last one. `80 04 00 84 80 12 A0 ...` is the instrument cluster
answering — the request echoed by the K-line, then the module's frame. Anything beginning `C4` is
what the Android app has been getting.

## Building

Docker Desktop running, then:

    docker run --rm -v "<this folder>:/src" bmwshim-build bash -lc \
      "cd /src && i686-w64-mingw32-gcc -O2 -o ds2probe.exe probe.c -lkernel32"
