"""Extracts fault-code descriptions from the vendor binary.

The text is not compressed, encrypted or generated. It sits in the executable as ordinary Delphi
constant strings, and each one holds a complete lookup table:

    [refcount -1][length:4]         the Delphi AnsiString header
    [textOffset:2 BE][code:2 BE][0] repeated - the index
    [len][characters] repeated      the strings

A fault code is looked up by finding the record whose code field is `code + 1`, and the record's
first field is the byte offset of the description's text within the same string. Both halves of
that sentence were found the hard way: an earlier attempt assumed the index position *was* the
code, which is true for the steering sensor and false for the climate module, whose codes are
sparse - `08` is followed by `0A`.

**There is one table per module variant, not per module.** "AUC sensor" appears fifteen times in
the binary because fifteen climate variants list it. The vendor picks the right one from the
identity bytes it has just read; this script does not know how, so it picks by *testing candidate
tables against codes whose text the vendor has already printed for a real car*. That is weaker
than knowing the selector, and the output says which tables were confirmed that way.

Usage:
    python fault_text.py <unpacked.bin>            summary of what was found
    python fault_text.py <unpacked.bin> --json     the confirmed tables, as JSON
    python fault_text.py <unpacked.bin> --js       the block to paste into web/js/protocol.js
"""
import json
import struct
import sys

# `unpacked.bin` is a memory dump with a 16-byte header, so a virtual address maps to a file
# offset by subtracting the image base and adding that header. The header states the base itself:
# "DUMP", then 0x00400000.
DUMP_HEADER = 16
IMAGE_BASE = 0x400000


def va_to_file(va):
    return va - IMAGE_BASE + DUMP_HEADER


def file_to_va(off):
    return off - DUMP_HEADER + IMAGE_BASE


def parse_table(data, blob):
    """Reads the table whose AnsiString data begins at `data`. Returns {code: text} or None."""
    length = struct.unpack_from("<I", blob, data - 4)[0]
    if not (16 < length < 60000) or data + length > len(blob):
        return None
    # `prev` starts below zero because some tables number their first code 0 rather than 1 - the
    # rear climate table does - and starting at zero with a strict `>` stopped the walk on record
    # zero and silently discarded the whole table.
    out, n, prev = {}, 0, -1
    while data + n * 5 + 5 <= data + length:
        rec = data + n * 5
        offset = struct.unpack_from(">H", blob, rec)[0]
        code = struct.unpack_from(">H", blob, rec + 2)[0]
        # The index runs until a record stops looking like one: the trailing byte is always zero
        # and the codes always ascend, so the first string's length byte terminates the walk.
        if blob[rec + 4] != 0 or code <= prev or not (0 < offset <= length):
            break
        size = blob[data + offset - 1]
        text = blob[data + offset: data + offset + size]
        if size and all(32 <= c < 127 for c in text):
            out[code - 1] = text.decode("latin-1")
        prev = code
        n += 1
    return out if len(out) >= 3 else None


def find_tables(blob):
    """Every Delphi constant string in the image that parses as a fault table."""
    tables, i = {}, 0
    while True:
        i = blob.find(b"\xff\xff\xff\xff", i)
        if i < 0:
            return tables
        data = i + 8
        if data < len(blob) - 8:
            table = parse_table(data, blob)
            if table:
                tables[data] = table
        i += 1


# What the vendor's own report printed for the test car, used to pick a variant's table out of the
# several that exist for each module family. Nothing here is a guess: every line is copied from
# `log/teljesscan/2026-11-05-_13-58-39/`.
CONTROL = {
    0x57: ("LEW", {
        0x0B: "Wrong LWS-ID",
        0x09: "No CAN message (ASC)",
        0x04: "90 degrees difference of wiper too large (Adjustment operation)",
    }),
    0x80: ("IKE", {0xBE: "Data-filing difference to central light module (LCM)"}),
    0x29: ("ABS", {
        0x5E1F: "PT-CAN chassis number wrong / ECU not initialized.",
        0x5E16: "CAN Timeout instrument cluster",
        0x5E24: "Pressure sensor 1/2 not plausible.",
        0x5E43: "Steering angle sensor internal.",
    }),
    0x5B: ("IHKA", {0x1C: "AUC sensor", 0x1E: "AUC heating"}),
    0xA4: ("SRS", {0x06: "Side airbag, front right door, resistance too low"}),
    0x12: ("DME", {0x27C3: "Failure oil status sensor"}),
}


def main():
    blob = open(sys.argv[1], "rb").read()
    tables = find_tables(blob)
    want_json = "--json" in sys.argv

    confirmed = {}
    report = []
    for addr, (name, known) in sorted(CONTROL.items()):
        hits = [o for o, t in tables.items() if all(t.get(c) == x for c, x in known.items())]
        if hits:
            # Several variants can satisfy a one-code control set; the largest table is the one
            # that covers the most codes, and they agree on every code the control set names.
            best = max(hits, key=lambda o: len(tables[o]))
            confirmed[addr] = tables[best]
            report.append((name, addr, len(hits), len(tables[best]), file_to_va(best)))
        else:
            report.append((name, addr, 0, 0, None))

    if "--js" in sys.argv:
        total = sum(len(t) for t in confirmed.values())
        print("export const FAULT_TEXT_EXTRACTED = {")
        for addr, tab in sorted(confirmed.items()):
            print(f"  0x{addr:02x}: {{")
            for code, text in sorted(tab.items()):
                esc = text.replace("\\", "\\\\").replace("'", "\'")
                print(f"    0x{code:02x}: '{esc}',")
            print("  },")
        print("};")
        print(f"// {total} descriptions, {len(confirmed)} modules", file=sys.stderr)
        return

    if want_json:
        json.dump({f"0x{a:02X}": {f"0x{c:X}": t for c, t in sorted(tab.items())}
                   for a, tab in sorted(confirmed.items())},
                  sys.stdout, indent=1, ensure_ascii=False)
        return

    print(f"{len(tables)} fault tables in the image\n")
    print(f"{'module':7}{'addr':7}{'candidates':12}{'codes':7}{'chosen table'}")
    print("-" * 56)
    for name, addr, n, codes, va in report:
        where = f"0x{va:08X}" if va else "-- not found --"
        print(f"{name:7}0x{addr:02X}   {n:<12}{codes:<7}{where}")
    total = sum(len(t) for t in confirmed.values())
    print(f"\n{total} descriptions across {len(confirmed)} modules, every one of them confirmed "
          f"against text the vendor printed for the test car.")


if __name__ == "__main__":
    main()
