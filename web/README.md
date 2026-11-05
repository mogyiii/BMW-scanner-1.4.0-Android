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

## Seeing it without a cable

`?demo=1` fills the page with this car's readings from 2026-11-05 and runs them through the same
decoders the live path uses. Useful for looking at the layout, and for checking that a change to a
decoder still produces the right answer, without driving anywhere. The page says on screen that it
is a replay — a diagnostic screen that cannot be told apart from a live one is worse than none.

## Where the protocol lives

| file | |
|---|---|
| `js/ftdi.js` | the FT232R over WebUSB - baud divisors, line settings, the read that stops on silence |
| `js/protocol.js` | framing, scrambling, the command set, fault and identity decoding |
| `js/session.js` | the measured order of the conversation, per module |
| `js/app.js` | tiles and dialogs; knows nothing about USB |
| `js/demo.js` | recorded replies for `?demo=1` |
| `js/protocol.test.mjs` | the decoders against the vendor software's own answers |

The numbers in those files are measured, not chosen. The 800 ms quiet period in `readUntilQuiet` is
the one that matters most: at 200 ms every reply came back cut in half, and finding that out took
most of a fortnight.

## Tests

```sh
node js/protocol.test.mjs
```

Every case is a reply lifted verbatim out of a capture, paired with what the vendor's software
printed for those same bytes on the same car. The pairing is the point: a decoder agreeing with its
author proves nothing. The bytes are confirmed twice over, because this app's own trace at the car
and the proxy capture of the vendor's software contain identical replies.

## Changing the pictograms

Each module in `js/protocol.js` names an SVG `<symbol>` id; nothing else in the code knows what a
module looks like. The symbols live in one block at the top of `index.html`:

| symbol | module | |
|---|---|---|
| `ic-zke` | ZKE | body electronics, doors and locking |
| `ic-dme` | DME | engine controller |
| `ic-abs` | ABS | ABS / DSC |
| `ic-ews` | EWS | immobiliser |
| `ic-lew` | LEW | steering angle sensor |
| `ic-ihka` | IHKA | climate control |
| `ic-ike` | IKE | instrument cluster |
| `ic-srs` | SRS | airbag |
| `ic-lcm` | LCM | lighting control |

To replace one, swap the paths inside its `<symbol>` and leave everything else alone. They are
stroked line art on a 24×24 grid with no `fill`, `stroke` or colour of their own — stroke width and
colour are inherited, which is what lets the same icon sit on a blue tile and on a white dialog
header. A filled icon will work too, but will need its own `fill` and will stop following the
theme.
