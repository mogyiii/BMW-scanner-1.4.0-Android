/**
 * The unknown-module report, and taking the chassis number out of it.
 *
 * These are the two things in the app that had never been run for real. The sweep needs an
 * unfamiliar BMW carrying a module we have no tile for, so the issue button's first test was
 * otherwise going to be somebody's first attempt in a car park — and its one previous bug was
 * exactly of that kind: the whole log went into the query string, percent-encoding tripled it, the
 * URL exceeded what a browser will open, and the button did nothing at all. No error, no tab.
 *
 * Run:  node js/report.test.mjs
 */
import * as R from './report.js';

let failures = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}

const bytes = (s) => Uint8Array.from(s.trim().split(/\s+/), (b) => parseInt(b, 16));

/* -- the issue text ---------------------------------------------------------------------------- */
{
  const found = [
    { addr: 0x33, kwp: false, id: { part: '6911286', hw: '12' }, ident: bytes('A0 F6 91 12 86 12') },
    { addr: 0x6a, kwp: true, id: null, ident: bytes('B8 F1 6A 03 7F 1A 11') },
  ];
  const body = R.issueBody(found, null);

  check('issue: both modules reach the table, with their protocols',
    [body.includes('| `0x33` | DS2 |'), body.includes('| `0x6A` | KWP2000 |')], [true, true]);
  // A module that refused identification is the common case for an address nobody has a tile for.
  check('issue: a module without identification prints a dash, not "undefined"',
    [/undefined|\bnull\b|NaN/.test(body), body.includes('| — | — |')], [false, true]);
  check('issue: identity bytes survive as hex', body.includes('A0 F6 91 12 86 12'), true);
  check('issue: addresses are upper case and two digits',
    [body.includes('0x6A'), body.includes('0x6a')], [true, false]);
  check('issue: without a log, the paste reminder stands in for it',
    [body.includes('<details>'), body.includes('did not fit in the link')], [false, true]);
  check('issue: with a log, it is fenced inside a collapsed block',
    R.issueBody(found, 'TRACE-HERE').includes('<details><summary>Raw traffic</summary>'), true);
  check('issue: the title names every address', R.issueTitle(found),
    'Unknown module: 0x33, 0x6A');
}

/* -- the prefilled link ------------------------------------------------------------------------- */
{
  const found = [
    { addr: 0x33, kwp: false, id: { part: '6911286', hw: '12' }, ident: bytes('A0 F6 91 12 86 12') },
  ];
  const url = R.issueUrl('owner/repo', found);

  check('link: it is a GitHub new-issue URL',
    url.startsWith('https://github.com/owner/repo/issues/new?title='), true);
  check('link: it is under the limit that broke it before', url.length < R.URL_LIMIT, true);
  // The real test of an encoded URL is whether a parser gets the original back out of it.
  check('link: title and body survive a round trip through the URL parser', (() => {
    const u = new URL(url);
    return u.searchParams.get('title') === R.issueTitle(found)
        && u.searchParams.get('body') === R.issueBody(found, null);
  })(), true);
  check('link: the markdown table is percent-encoded rather than breaking the query string',
    [url.includes('|'), url.includes('%7C')], [false, true]);

  // Enough modules to overflow even without the trace: it must degrade, not break.
  const many = Array.from({ length: 200 }, (_, i) => (
    { addr: i, kwp: false, id: { part: '1234567', hw: '01' }, ident: bytes('A0 11 22 33 44 55') }));
  const big = R.issueUrl('owner/repo', many);
  check('link: an overlong report drops the body instead of producing a dead link',
    [big.length < R.URL_LIMIT, big.includes('&body='), big.includes('title=')],
    [true, false, true]);
}

/* -- the chassis number ------------------------------------------------------------------------- */
/*
 * The trace line below is lifted verbatim out of `log/teljesscan/Diagnosztikai napló.txt`. The
 * short chassis number sits in it as ASCII bytes, which is the form a redaction is most likely to
 * miss — and missing it would be worse than not offering the option, because the app would be
 * reporting a removal that did not happen.
 */
{
  const results = [
    { vin: 'AY31060KP04220' },   // the cluster, full
    { vin: 'KP04220' },          // engine controller and ABS, short form
    { vin: '0000000' },          // the Valvetronic, which has none stored
    { vin: null },               // a module that was never asked
  ];
  check('vins: filler is excluded and real ones come longest first',
    R.vinsIn(results), ['AY31060KP04220', 'KP04220']);

  const log = [
    '0x0DE7   B8 12 F1 02 1A 90 D3 B8 F1 12 09 5A 90 4B 50 30 34 32 32 30 B7',
    '      VIN AY31060KP04220',
    '      VIN KP04220',
    '0x1B   A0 30 30 30 30 30 30 30 11',
  ].join('\n');
  const clean = R.redactVins(log, R.vinsIn(results));

  check('redact: no chassis number survives, in text or in hex',
    /AY31060KP04220|KP04220|4B 50 30 34 32 32 30/.test(clean), false);
  check('redact: the hex is masked byte-for-byte, so the frame keeps its length',
    clean.split('\n')[0],
    '0x0DE7   B8 12 F1 02 1A 90 D3 B8 F1 12 09 5A 90 .. .. .. .. .. .. .. B7');
  // Longest-first is what stops the short form surviving as a tail of the long one.
  check('redact: the long form does not leave its head behind',
    clean.includes('AY31060'), false);
  check('redact: the filler frame is left alone',
    clean.includes('A0 30 30 30 30 30 30 30 11'), true);
  check('redact: running it twice changes nothing further',
    R.redactVins(clean, R.vinsIn(results)), clean);
  check('redact: a report with no chassis number in it is untouched',
    R.redactVins('nothing here', R.vinsIn(results)), 'nothing here');
  check('redact: with no chassis numbers found, nothing is replaced',
    R.redactVins(log, R.vinsIn([{ vin: '0000000' }])), log);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
