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

On Windows the device has to be bound to WinUSB (Zadig) first; without a WinUSB-compatible driver
Chrome cannot claim it.

**macOS and Linux are expected to work and have never been tested.** The reasoning for macOS is
that `AppleUSBFTDI` binds vendor `0x0403` and this cable reports `0x0333`, so nothing should claim
the interface ahead of Chrome — the same re-flashed EEPROM that stops other OBD tools recognising
it. Linux will likely want a udev rule. Either result is worth reporting.

## Language

English, German and Hungarian, picked in the header and remembered. New to the app: whichever
of the three the browser asks for, English otherwise.

**The fault descriptions stay English in every language**, and the German and Hungarian notes say
so. They are extracted from the vendor binary, which carries them in English for the five modules
this app ships; translating 374 technical fault descriptions by hand would produce confident
German for faults nobody has verified. The twelve hand-written entries are the exception and do
carry Hungarian.

All strings live in `js/i18n.js`; the markup carries `data-i18n` keys rather than words. The fault
descriptions are the one place where the English is not a translation — both languages come from
the vendor software's own report, so the English is the original.

## Internet, and installing it as an app

**The first load needs a network. Nothing after that does.** WebUSB only runs in a secure context,
so the page has to come from `https://` or `localhost` — it cannot be opened as a file off a USB
stick. Once it has loaded once, the service worker holds `index.html`, the manifest and the five
JavaScript files, and the app starts with no signal at all. That is the normal situation in a car
park and the reason the cache exists.

`demo.js` is deliberately not precached: it is only ever fetched by `?demo=1`, and the offline case
this is built for is not a replay.

**It installs like an app.** The manifest declares `display: standalone`, so Chrome's *Add to Home
screen* (Android) or the install icon in the address bar (desktop) gives it an icon and a window
with no browser chrome. Nothing is installed in the operating-system sense — it is the same cached
page, launched from a shortcut — which also means the install can be deleted without a trace and
updates arrive by themselves.

The cable permission survives this. The browser remembers the device once it has been granted, so a
second visit goes straight to **Connect the cable** without the chooser.

## The report

**Share the log** gives the whole thing: decoded results *and* every raw byte. That file is for us —
protocol arguments get settled by looking at bytes.

**Download report** gives one self-contained HTML page with the findings and no hex: the car's
details, the faults grouped by module with their descriptions, and every clean module collapsed to a
single line so a reader reaches the faults without scrolling past nine clean bills of health. It is
for the owner's records, for showing a mechanic, or for a forum post.

HTML rather than PDF because generating a PDF in the browser means shipping a library this page
would otherwise not need, while a styled HTML file prints to PDF from the browser's own dialog —
which every phone and laptop already has. There is a print stylesheet for exactly that. The file
references nothing external, so it still opens years from now with no network.

It follows the language switch, including the date format. The fault descriptions do not, for the
reason given above: they are the vendor's own English, and where there is none the report says so
rather than leaving a suggestive blank.

## Reading one module

Tapping a tile with a cable attached reads that module alone, about five seconds instead of the
minute a full scan takes — and an already-read module gets the same thing as a button in its
detail view. The trace is not cleared, so repeated reads of one module accumulate in a single log.
That is deliberate: an experiment that varies one thing and reads it six times wants all six
readings in one file, in order.

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
| `js/i18n.js` | every string, in English, German and Hungarian |
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
