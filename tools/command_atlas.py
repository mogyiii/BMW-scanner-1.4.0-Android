"""Builds the command atlas from a ftd2xx-proxy.log: who was asked what, and what came back.

`decode_proxy.py` prints the conversation in order, which is right for reading one session but
useless for the question this script answers: across a four-megabyte capture of somebody clicking
through every menu, *which command goes to which module, and what does the module make of it*.

The answer comes from the echo. A single-wire K-line lets the cable hear itself, so every reply
opens with our own request in the module's native framing - DS2 `[addr][len][service...][xor]` or
KWP `[format][target][source][service...][sum]`. That echo is the Rosetta stone: it translates the
vendor's opaque 16-bit command numbers into the standard service they stand for, with no guessing.

Usage:  python command_atlas.py <log> [--cmd 0xNNNN] [--addr 0xNN]
"""
import re
import sys
from collections import Counter, defaultdict

KEY_STEP = 0x4B
ANNOUNCE_LEN = 27

# Commands whose name we have already established, so the atlas reads as a diff rather than a wall.
KNOWN = {
    0xA77A: "sign-on",
    0xB318: "open link",
    0x83F0: "K-line timing",
    0x46F1: "DS2 identify",
    0xC731: "DS2 fault memory",
    0x06F3: "KWP identification",
    0x0DE7: "KWP VIN",
    0xC358: "KWP read DTCs",
    0xC751: "WRITE (do not send)",
}


def parse(path):
    for raw in open(path, encoding="latin-1"):
        m = re.search(r"\s(TX|RX)\[\d+\.\.\]\s+([0-9A-F ]+)", raw)
        if m:
            kind = m.group(1).lower()
            for b in m.group(2).split():
                yield kind, int(b, 16)
            continue
        if re.search(r"FT_ClrDtr|FT_OpenEx", raw):
            yield "reset", 0


def ds2_frame(data):
    """Returns the service bytes of a DS2 frame at the head of `data`, or None."""
    if len(data) < 4:
        return None
    n = data[1]
    if n < 4 or n > len(data):
        return None
    frame = data[:n]
    x = 0
    for b in frame:
        x ^= b
    return (frame[0], frame[2:-1]) if x == 0 else None


def kwp_frame(data):
    """Returns (target, service bytes) of a KWP frame at the head of `data`, or None."""
    if len(data) < 5 or (data[0] & 0xC0) != 0x80:
        return None
    n = (data[0] & 0x3F) + 4
    if n > len(data):
        return None
    frame = data[:n]
    return (frame[1], frame[3:-1]) if (sum(frame[:-1]) & 0xFF) == frame[-1] else None


def main():
    path = sys.argv[1]
    only_cmd = None
    only_addr = None
    if "--cmd" in sys.argv:
        only_cmd = int(sys.argv[sys.argv.index("--cmd") + 1], 16)
    if "--addr" in sys.argv:
        only_addr = int(sys.argv[sys.argv.index("--addr") + 1], 16)

    key = None
    frame = []
    want = 0
    rxcount = 0
    rx = []
    pending = None            # the last command sent, waiting for its reply

    # command -> address -> count, and command -> the service bytes seen echoed back
    seen = defaultdict(Counter)
    service = {}
    answers = defaultdict(list)

    def settle():
        """Attributes the bytes just received to the command that was waiting for them."""
        nonlocal rx
        if pending is not None and rx:
            cmd, addr, payload = pending
            echo = ds2_frame(rx)
            kind = "DS2"
            if echo is None:
                echo = kwp_frame(rx)
                kind = "KWP"
            if echo is None:
                # Keep it anyway. A reply we cannot frame is exactly the one worth reading by eye,
                # and discarding it is how the KWP side of this capture stayed invisible.
                answers[(cmd, addr)].append(("?", None, (), list(rx)))
            else:
                tgt, svc = echo
                service.setdefault((cmd, kind), svc)
                answers[(cmd, addr)].append((kind, tgt, svc, list(rx)))
        rx = []

    for kind, val in parse(path):
        if kind == "reset":
            settle()
            key, frame, rxcount, pending = None, [], 0, None
            continue
        if kind == "rx":
            if rxcount < ANNOUNCE_LEN:
                if rxcount == 0:
                    key = val
                rxcount += 1
                continue
            rx.append(val)
            continue

        settle()
        if key is None:
            continue
        plain = val ^ key
        key = (key + KEY_STEP) & 0xFF
        if not frame:
            want = plain + 2
            if want < 5 or want > 255:
                frame = []
                continue
        frame.append(plain)
        if len(frame) == want:
            if (sum(frame[:-1]) & 0xFF) == frame[-1]:
                cmd, addr = (frame[1] << 8) | frame[2], frame[3]
                seen[cmd][addr] += 1
                pending = (cmd, addr, tuple(frame[4:-1]))
            frame = []
    settle()

    if only_cmd is not None or only_addr is not None:
        for (cmd, addr), rows in sorted(answers.items()):
            if only_cmd is not None and cmd != only_cmd:
                continue
            if only_addr is not None and addr != only_addr:
                continue
            print("0x%04X -> 0x%02X   (%d replies)" % (cmd, addr, len(rows)))
            for kind, tgt, svc, raw in rows[:6]:
                print("   %s echo %s | reply %s" % (
                    kind, " ".join("%02X" % b for b in svc),
                    " ".join("%02X" % b for b in raw[:48])))
            print()
        return

    print("%-8s %-5s %-22s %-11s %s" % ("command", "n", "addresses", "service", "name"))
    print("-" * 100)
    for cmd in sorted(seen, key=lambda c: -sum(seen[c].values())):
        addrs = " ".join("%02X" % a for a in sorted(seen[cmd]))
        svc = ""
        for k in ("DS2", "KWP"):
            if (cmd, k) in service:
                svc = k + " " + " ".join("%02X" % b for b in service[(cmd, k)])
                break
        print("0x%04X   %-5d %-22s %-11s %s" % (
            cmd, sum(seen[cmd].values()), addrs[:22], svc[:11], KNOWN.get(cmd, "")))


if __name__ == "__main__":
    main()
