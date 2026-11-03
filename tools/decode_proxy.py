"""Reconstructs the conversation from a ftd2xx-proxy.log.

The proxy logs raw bytes in both directions and decodes nothing, deliberately: it is a measuring
instrument and should not have opinions. This turns that recording into the exchange it represents.

Outgoing frames are descrambled with the rolling key, which starts at the first byte of the cable's
announcement and advances 0x4B per transmitted byte. A frame is
`[length][command hi][command lo][parameter][payload...][additive checksum]`, with the length byte
counting everything but itself and the checksum, so a frame is `plain[0] + 2` bytes long.

Replies are printed as they arrived. They are not descrambled, because what rule applies to them is
not settled - run 39 found the parameter echoed back XORed with 0xC9 and could not determine whether
that was a rolling key or a constant.

Usage:  python decode_proxy.py <log> [--full]
"""
import re
import sys
from collections import Counter

KEY_STEP = 0x4B
ANNOUNCE_LEN = 27


def parse(path):
    """Yields ('tx'|'rx'|'line', payload) in order."""
    events = []
    for raw in open(path, encoding="latin-1"):
        line = raw.rstrip("\n")
        m = re.search(r"\s(TX|RX)\[\d+\.\.\]\s+([0-9A-F ]+)", line)
        if m:
            kind = m.group(1).lower()
            for b in m.group(2).split():
                events.append((kind, int(b, 16)))
            continue
        m = re.search(r"(FT_SetBaudRate\(\d+\)|FT_SetDataCharacteristics\([^)]*\)|"
                      r"FT_SetDtr|FT_ClrDtr|FT_Purge\(mask=\d+\)|FT_Close|FT_OpenEx[^-]*)", line)
        if m:
            events.append(("line", m.group(1).strip()))
    return events


def main():
    path = sys.argv[1]
    full = "--full" in sys.argv
    events = parse(path)

    key = None
    frame = []
    want = 0
    pending_rx = []
    rxcount = 0
    commands = Counter()
    exchanges = []

    def flush_rx():
        nonlocal pending_rx
        if pending_rx:
            exchanges.append(("rx", list(pending_rx)))
            pending_rx = []

    for kind, val in events:
        if kind == "line":
            flush_rx()
            exchanges.append(("line", val))
            if val.startswith("FT_ClrDtr"):
                rxcount = 0
            continue

        if kind == "rx":
            # The 27-byte announcement sets the key and is not a reply.
            if rxcount < ANNOUNCE_LEN:
                if rxcount == 0:
                    key = val
                    exchanges.append(("line", "-- announcement begins, key 0x%02X" % key))
                rxcount += 1
                if rxcount == ANNOUNCE_LEN:
                    exchanges.append(("line", "-- announcement complete"))
                continue
            pending_rx.append(val)
            continue

        # tx
        flush_rx()
        if key is None:
            continue
        plain = val ^ key
        key = (key + KEY_STEP) & 0xFF
        if not frame:
            want = plain + 2
            if want < 5 or want > 255:
                exchanges.append(("line", "-- key out of step (first byte 0x%02X)" % plain))
                frame = []
                continue
        frame.append(plain)
        if len(frame) == want:
            ok = (sum(frame[:-1]) & 0xFF) == frame[-1]
            cmd = (frame[1] << 8) | frame[2]
            commands[cmd] += 1
            exchanges.append(("tx", (cmd, frame[3], frame[4:-1], ok)))
            frame = []
    flush_rx()

    print("=" * 78)
    print("commands sent, by frequency")
    print("=" * 78)
    for cmd, n in commands.most_common():
        print("  0x%04X  x%d" % (cmd, n))

    print()
    print("=" * 78)
    print("the exchange" + ("" if full else "  (first 120 entries; --full for all)"))
    print("=" * 78)
    shown = 0
    for kind, val in exchanges:
        if not full and shown > 120:
            print("  ... %d more" % (len(exchanges) - shown))
            break
        shown += 1
        if kind == "line":
            print("  %s" % val)
        elif kind == "tx":
            cmd, par, payload, ok = val
            p = " ".join("%02X" % b for b in payload)
            print("  -> 0x%04X par 0x%02X %s%s" % (cmd, par, ("[" + p + "]") if payload else "",
                                                   "" if ok else "   CHECKSUM BAD"))
        else:
            print("  <- %s" % " ".join("%02X" % b for b in val))


if __name__ == "__main__":
    main()
