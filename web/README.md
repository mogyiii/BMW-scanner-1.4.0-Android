# Browser version

Runs in Chrome or Edge on Android and on the desktop, over WebUSB. One codebase for the phone and
the laptop, and no driver to install on Linux or macOS.

**It will not work on iOS.** Safari does not implement WebUSB and Apple does not permit arbitrary
USB access from native apps either, so an iPhone cannot drive this cable by any route. That is worth
knowing before planning around it.

## Running it

WebUSB needs a secure context, so the page must come from `https://` or `localhost` - opening the
file directly will not do. Either:

- **GitHub Pages**, which is the intended home. A service worker caches everything on first load, so
  it starts with no signal afterwards - which is the normal situation in a car park.
- **Locally**: `python -m http.server 8000` in this folder, then `http://localhost:8000`.

On Windows the device has to be bound to WinUSB (Zadig) before Chrome can claim it, because the FTDI
driver takes it otherwise. Android and macOS need nothing; Linux may need a udev rule.

## Where the protocol lives

| file | |
|---|---|
| `js/ftdi.js` | the FT232R over WebUSB - baud divisors, line settings, the read that stops on silence |
| `js/protocol.js` | framing, scrambling, the command set, fault decoding |
| `js/session.js` | the measured order of the conversation, per module |
| `js/app.js` | tiles and dialogs; knows nothing about USB |

The numbers in those files are measured, not chosen. The 800 ms quiet period in `readUntilQuiet` is
the one that matters most: at 200 ms every reply came back cut in half, and finding that out took
most of a fortnight.
