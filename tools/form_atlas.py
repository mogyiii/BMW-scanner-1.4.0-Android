"""Lists the vendor software's Delphi form resources and the captions on each one.

A compiled Delphi executable stores every form as a DFM resource, and a DFM keeps its captions as
plain length-prefixed text. Dumping them is an inventory of the vendor's whole feature set: not
which commands exist -- `command_inventory.py` answers that -- but which *fields the software puts
on screen*, with the names its authors gave them.

That is worth more than it sounds. A command tells you a question was asked; a form tells you what
the answer meant. The EWS live-data form names twenty-two fields in the reply to `0x5132`, of which
this project decodes one.

Captions are the vendor's own words, so they are evidence about the vendor's software, not about
any car. Nothing here was read off a vehicle.

Usage:
    python form_atlas.py <unpacked.bin> [pattern]
"""
import re
import sys

MAX_FORM = 0x6000


def forms(blob):
    """Yields (offset, [captions]) for each DFM resource, in file order."""
    starts = [m.start() for m in re.finditer(rb"TPF0", blob)]
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else start + MAX_FORM
        body = blob[start:end]
        captions = []
        for m in re.finditer(rb"\x07Caption\x06(.)", body):
            text = body[m.end():m.end() + body[m.end() - 1]]
            if all(32 <= c < 127 for c in text):
                captions.append(text.decode("latin-1"))
        if captions:
            yield start, captions


def main():
    blob = open(sys.argv[1], "rb").read()
    pattern = re.compile(sys.argv[2]) if len(sys.argv) > 2 else None

    shown = 0
    for offset, captions in forms(blob):
        if pattern and not pattern.search(" | ".join(captions)):
            continue
        shown += 1
        print(f"=== 0x{offset:X}  {captions[0]!r}")
        for caption in captions[1:]:
            print(f"      {caption}")
        print()
    print(f"{shown} forms" + (" matching" if pattern else ""))


if __name__ == "__main__":
    main()
