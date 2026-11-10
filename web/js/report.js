/**
 * Building the unknown-module report, and taking the chassis number out of it.
 *
 * These live apart from `app.js` because they are the part that had never been exercised. The
 * sweep needs a cable and an unfamiliar car, so the issue button could only ever be tried by
 * someone in a car park with a module we have no tile for - which is to say, never. Pure functions
 * with no DOM in them can be tested from `node` against made-up modules, and `protocol.test.mjs`
 * now does.
 *
 * Nothing here touches the network. `issueUrl` returns a string; whether it is opened is `app.js`'s
 * business, and the consent dialog stands in front of that.
 */
import * as P from './protocol.js';

/**
 * GitHub will not open an arbitrarily long URL, and a browser has its own limit below that.
 *
 * The first version of this put the whole log in the query string under a 5000-character cap.
 * Percent-encoding roughly triples a hex dump, so the link blew past what Chrome would open and
 * the button did nothing at all - no error, no tab, nothing. 6000 is measured against that
 * failure, not chosen: the table alone is a few hundred characters, and the copy button carries
 * the rest.
 */
export const URL_LIMIT = 6000;

const addrOf = (addr) => `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * The issue text. `logText` comes along when there is room for it, which is the clipboard route.
 *
 * English regardless of the interface language: it is going to a repository whose issues are in
 * English, and a maintainer who cannot read the report cannot act on it.
 */
export function issueBody(found, logText) {
  const lines = ['This app found a module it does not know about.', ''];
  lines.push('| address | protocol | BMWTNR | HW | identity |');
  lines.push('|---|---|---|---|---|');
  for (const f of found) {
    lines.push(`| \`${addrOf(f.addr)}\` | ${f.kwp ? 'KWP2000' : 'DS2'} | ${f.id ? f.id.part : '—'} `
      + `| ${f.id ? f.id.hw : '—'} | \`${P.hex(f.ident)}\` |`);
  }
  lines.push('', '**Car:** (model, year, engine — if you would share it)', '');
  if (logText) {
    lines.push('<details><summary>Raw traffic</summary>', '', '```', logText, '```', '</details>');
  } else {
    lines.push('<!-- The raw traffic did not fit in the link. Press the copy button in the app',
               '     and paste it here - it carries every byte this reading was built from. -->');
  }
  return lines.join('\n');
}

export function issueTitle(found) {
  return `Unknown module: ${found.map((f) => addrOf(f.addr)).join(', ')}`;
}

/**
 * The prefilled link, degrading rather than breaking.
 *
 * Many modules at once could still overflow even without the trace, and an over-long URL fails
 * silently. So the body is dropped before the limit is reached and the title goes alone - an issue
 * with a title and no body is recoverable by pasting; a button that does nothing is not.
 */
export function issueUrl(repo, found) {
  const base = `https://github.com/${repo}/issues/new`;
  const title = encodeURIComponent(issueTitle(found));
  const full = `${base}?title=${title}&body=${encodeURIComponent(issueBody(found, null))}`;
  return full.length < URL_LIMIT ? full : `${base}?title=${title}`;
}

/**
 * Every chassis number a reading produced, longest first and filler excluded.
 *
 * A module with none stored answers with filler rather than refusing - the Valvetronic on the test
 * car returns `0000000`. Redacting that identifies nobody, and its hex form is a run of `30` bytes
 * common enough to hit unrelated frames. A chassis number has letters in it; filler does not.
 *
 * Longest first matters: the cluster gives the full seventeen characters and the engine controller
 * and ABS a seven-character short form, and the short one is a tail of the long one. Replacing the
 * short form first would leave the long one's head stranded in the text.
 */
export function vinsIn(results) {
  const set = new Set();
  for (const r of results) if (r.vin && /[A-Z]/.test(r.vin)) set.add(r.vin);
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * Takes the chassis number out of a report, in both of the forms it appears in.
 *
 * The decoded line is the obvious one. The raw trace is not: the cluster's reply carries the VIN as
 * ASCII bytes, so `P.hex` prints it as `4B 50 30 34 32 32 30` and a redaction that only scrubbed
 * the readable line would leave the number in plain sight two screens further down while telling
 * the user it had been removed. That is worse than not offering the option at all.
 *
 * The hex is replaced byte-for-byte with `..` so the trace keeps its length and column alignment.
 * A shortened frame would be a decoding puzzle for whoever reads the issue.
 */
export function redactVins(text, vins, placeholder = '[chassis number removed]') {
  for (const vin of vins) {
    const hex = [...vin].map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    text = text.split(vin).join(placeholder);
    text = text.split(hex.join(' ')).join(hex.map(() => '..').join(' '));
  }
  return text;
}
