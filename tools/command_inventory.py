"""Lists every command the vendor software can send, not just the ones seen on the wire.

`command_atlas.py` answers "what did the cable actually do", from a capture. This answers the
prior question — "what *can* it be asked to do" — from the executable, with no car and no capture
involved.

The software builds every request the same way: the 16-bit command goes into `ECX`, then a call to
one of two transaction routines. Finding all `MOV ECX, imm` sites whose next `CALL` lands on those
routines enumerates the command set.

What this cannot tell you is what each command *means*. A command carries a service prefix that
lives in the cable's firmware, not in the executable, so the only way to learn a new command's
service is to watch the vendor software use it and read the K-line echo. That is also the reason
none of these should be sent speculatively: `0xC751` sits in the same number space and is on the
project's do-not-send list.

Usage:
    python command_inventory.py <unpacked.bin> [capture.log ...]
"""
import collections
import re
import struct
import subprocess
import sys
import os

DUMP_HEADER = 16
IMAGE_BASE = 0x400000
# The two routines every request passes through, found by following the call after a known command.
TRANSACTION = {0x006CD150, 0x006CD184}
LIVE_LABEL = "Reading live data: "


def file_to_va(off):
    return off - DUMP_HEADER + IMAGE_BASE


def va_to_file(va):
    return va - IMAGE_BASE + DUMP_HEADER


def delphi_string(blob, va):
    off = va_to_file(va)
    if off < 8 or off >= len(blob) or struct.unpack_from("<i", blob, off - 8)[0] != -1:
        return None
    n = struct.unpack_from("<I", blob, off - 4)[0]
    if not (1 < n < 60) or off + n > len(blob):
        return None
    text = blob[off:off + n]
    return text.decode("latin-1") if all(32 <= c < 127 for c in text) else None


def command_sites(blob):
    """Yields (command, file offset) for every `MOV ECX, imm` that feeds a transaction call."""
    for m in re.finditer(rb"\xb9(....)", blob):
        value = struct.unpack("<I", m.group(1))[0]
        if not (0x0100 <= value <= 0xFFFF):
            continue
        window = blob[m.start() + 5: m.start() + 44]
        call = re.search(rb"\xe8(....)", window)
        if not call:
            continue
        target = (file_to_va(m.start() + 5 + call.start()) + 5
                  + struct.unpack("<i", call.group(1))[0])
        if target in TRANSACTION:
            yield value, m.start()


def labelled(blob, off, label, back=300):
    """True when `label` is referenced in the `back` bytes before `off`."""
    for k in range(max(0, off - back), off):
        if blob[k] == 0xBA and delphi_string(blob, struct.unpack_from("<I", blob, k + 1)[0]) == label:
            return True
    return False


def observed(paths):
    """Commands actually seen on the wire, via command_atlas."""
    here = os.path.dirname(os.path.abspath(__file__))
    seen = set()
    for path in paths:
        out = subprocess.run([sys.executable, os.path.join(here, "command_atlas.py"), path],
                             capture_output=True, text=True).stdout
        seen |= {int(x, 16) for x in re.findall(r"^0x([0-9A-F]{4})", out, re.M)}
    return seen


def main():
    blob = open(sys.argv[1], "rb").read()
    sites = list(command_sites(blob))
    commands = collections.Counter(c for c, _ in sites)
    seen = observed(sys.argv[2:]) if len(sys.argv) > 2 else set()

    live = sorted({c for c, off in sites if labelled(blob, off, LIVE_LABEL)})

    print(f"{len(commands)} distinct commands the software can send")
    if seen:
        print(f"{len(seen & set(commands))} of them observed on the wire, "
              f"{len(set(commands) - seen)} never")
    print(f"\n{len(live)} are issued under a \"{LIVE_LABEL.strip()}\" label:")
    for c in live:
        mark = "observed" if c in seen else "NEVER OBSERVED"
        print(f"   0x{c:04X}   {mark}")
    if seen:
        print("\nnever observed, in full:")
        rest = sorted(set(commands) - seen)
        for i in range(0, len(rest), 12):
            print("   " + "  ".join(f"0x{c:04X}" for c in rest[i:i + 12]))


if __name__ == "__main__":
    main()
