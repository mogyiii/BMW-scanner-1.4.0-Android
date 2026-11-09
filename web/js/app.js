/**
 * The tiles, and what happens when you press things.
 *
 * Nothing in here knows about USB or the protocol; it asks `session.js` to do the talking and draws
 * what comes back. The one opinion it holds is that a reading should never hide its evidence, so
 * every fault keeps its raw bytes on screen.
 */

import { Ftdi } from './ftdi.js';
import * as P from './protocol.js';
import { scan, idleLevel, clearFaults, unlockShadow, findUnknown } from './session.js';
import { t, tn, lang, setLang, applyStatic, LANGUAGES } from './i18n.js';

const $ = (id) => document.getElementById(id);
const state = { ftdi: null, stop: false, busy: false, results: new Map() };

/** Thousands separators follow the chosen language, not the browser's. */
const fmt = (n) => n.toLocaleString(lang === 'hu' ? 'hu-HU' : 'en-GB');

/* ------------------------------------------------------------------ tiles */

function tileFor(mod) {
  // Every tile is a button once a cable is attached, including the ones that have never answered:
  // tapping one reads that module alone. Six lighting states is six taps of five seconds, not six
  // full scans of a minute, and the vendor's own software has had per-module reads all along.
  const tappable = !!state.ftdi && !state.busy && !mod.busy;
  const el = document.createElement(mod.present || tappable ? 'button' : 'div');
  el.className = 'tile';
  if (mod.busy) el.classList.add('busy');
  else if (!mod.present) el.classList.add('off');
  else if ((mod.faults && mod.faults.count > 0) || (mod.shadow && mod.shadow.count > 0)) {
    el.classList.add('warn');
  }
  else if (mod.present && !mod.faults) el.classList.add('warn');
  else el.classList.add('ok');

  // Three states, not two. A store that did not answer is `null`; one that answered zero is
  // `{count: 0}`; one that refused until it is unlocked is `{locked: true}`. Collapsing any of
  // these into "no faults" is the one wrong answer a fault reader can give, and the first on-car
  // run of this app gave it.
  const shadowCount = mod.shadow && !mod.shadow.locked ? mod.shadow.count : 0;
  const locked = !!(mod.shadow && mod.shadow.locked);
  const count = mod.faults ? mod.faults.count : null;
  const state_ = mod.busy ? t('tile.busy')
    : !mod.present ? (mod.reason || '—')
    : count === null ? t('tile.unreadable')
    : count === 0 && shadowCount === 0 ? t(locked ? 'tile.shadowlocked' : 'tile.clean')
    : count === 0 ? tn('tile.shadowfaults', shadowCount)
    : shadowCount === 0 ? tn('tile.faults', count)
    : t('tile.both', { n: count, m: shadowCount });

  el.innerHTML = `
    <svg class="ic" aria-hidden="true"><use href="#ic-${mod.icon}"/></svg>
    <div class="name">${mod.name}</div>
    <div class="label">${t('mod.' + mod.icon)}</div>
    <div class="state">${state_}</div>`;

  if (mod.present) {
    el.classList.add('clickable');
    el.addEventListener('click', () => showDetail(mod));
  } else if (tappable) {
    el.classList.add('clickable');
    el.addEventListener('click', () => readOne(mod));
  }
  return el;
}

/**
 * Reads one module and leaves the rest of the page alone.
 *
 * The trace is *not* cleared, so repeated reads of the same module accumulate in one log — which
 * is exactly what an experiment wants: six lighting states in one file, in order.
 */
async function readOne(mod) {
  if (!state.ftdi || state.busy) return;
  state.busy = true;
  state.results.set(mod.addr, { ...mod, busy: true });
  draw();
  setStatus(t('status.readingone', { name: mod.name }));
  try {
    const [result] = await scan(state.ftdi, { onTrace: trace, only: [mod.addr] });
    if (result) state.results.set(mod.addr, result);
    setStatus(t('status.readone', { name: mod.name }));
  } catch (e) {
    state.results.delete(mod.addr);
    setStatus(t('status.aborted', { msg: e.message }));
  } finally {
    state.busy = false;
    draw();
  }
}

/**
 * The last tile in the grid: go looking for modules this software has no tile for.
 *
 * It lived in a collapsed `<details>` under the grid and would have gone unnoticed. Dashed, like
 * an absent module, because an absent module is exactly what it is hunting for.
 */
/** How many addresses the sweep would visit: the vendor's list, less the ones we have tiles for. */
function unknownCount() {
  const known = new Set(P.MODULES.map((m) => m.addr));
  return P.PROBE_ADDRESSES.filter((a) => !known.has(a)).length;
}

function huntTile() {
  const el = document.createElement('button');
  el.className = 'tile hunt';
  el.disabled = !state.ftdi || state.busy;
  el.innerHTML = `
    <svg class="ic" aria-hidden="true"><use href="#ic-hunt"/></svg>
    <div class="name">${t('tile.hunt.name')}</div>
    <div class="label">${t('tile.hunt.label')}</div>
    <div class="state">${t('tile.hunt.state', { n: unknownCount() })}</div>`;
  el.addEventListener('click', hunt);
  return el;
}

function draw() {
  const grid = $('grid');
  grid.textContent = '';
  for (const mod of P.MODULES) {
    grid.appendChild(tileFor(state.results.get(mod.addr) || { ...mod, present: false, reason: '' }));
  }
  grid.appendChild(huntTile());
  drawVitals();
}

/** Redraws everything that carries words in it after the language changes. */
function relabel() {
  applyStatic();
  draw();
  if ($('detail').open) $('detail').close();
}

/**
 * Fills the header from what the car said, and from nothing else.
 *
 * The page used to announce "316i · N42" because that is what this particular car is - typed in,
 * true, and worth nothing: a diagnostic tool that states facts it did not measure is indistinguishable
 * from one that measures them wrongly. Every figure here comes off the wire during the scan, and
 * before the scan the row is empty rather than hopeful.
 */
function drawVitals() {
  const results = [...state.results.values()].filter((r) => r.present && !r.busy);
  const vin = results.map((r) => r.vin).filter(Boolean).sort((a, b) => b.length - a.length)[0];
  const km = results.map((r) => r.mileage).find((m) => m);
  const live = results.map((r) => r.live).find(Boolean);
  const dl = $('vitals');
  dl.textContent = '';

  const add = (term, value) => {
    if (!value) return;
    const wrap = document.createElement('div');
    wrap.className = 'vital';
    wrap.innerHTML = `<dt>${term}</dt><dd>${value}</dd>`;
    dl.appendChild(wrap);
  };
  add(t('vital.vin'), vin);
  add(t('vital.km'), km ? `${fmt(km)} km` : '');
  add(t('vital.rpm'), live ? t('vital.rpm.value', { n: fmt(live.rpm) }) : '');
  add(t('vital.modules'), results.length ? `${results.length} / ${P.MODULES.length}` : '');

  if (results.length) {
    const kwp = results.filter((r) => r.kwp).length;
    $('subtitle').textContent =
      t('app.subtitle.done', { ds2: results.length - kwp, kwp });
  }
}

const codeOf = (e) => (e.wide
  ? e.code.toString(16).toUpperCase().padStart(4, '0')
  : e.code.toString(16).toUpperCase().padStart(2, '0'));
const paramOf = (e) => (e.param === null ? '??' : e.param.toString(16).toUpperCase().padStart(2, '0'));

/**
 * Renders one fault store into `body`, heading and all.
 *
 * `missing` is what to say when the store returned nothing. For the shadow memory that is ordinary
 * — only three modules on this car have one — but for the live memory it is a failed read, and the
 * two must not share a wording.
 */
function renderStore(body, mod, store, heading, missing) {
  const h = document.createElement('p');
  h.className = 'store';
  h.textContent = heading;
  body.appendChild(h);

  if (!store) { h.textContent = `${heading} — ${missing}`; return; }
  if (store.locked) { h.textContent = `${heading} — ${t('store.locked')}`; return; }
  if (store.count === 0) { h.textContent = `${heading} — ${t('store.empty')}`; return; }

  for (const e of store.entries) {
    const div = document.createElement('div');
    div.className = 'fault';
    const text = P.faultText(mod.addr, e.code, lang);
    div.innerHTML = `<code>${codeOf(e)} / ${paramOf(e)}</code>
      ${text ? `<div class="desc">${text}</div>` : ''}
      <div class="raw">${P.hex(e.raw)}</div>`;
    body.appendChild(div);
  }
  if (store.entries.length === 0) {
    const p = document.createElement('p');
    p.textContent = t('store.unreadable', { n: store.count });
    body.appendChild(p);
  }
}

function showDetail(mod) {
  $('d-icon').setAttribute('href', `#ic-${mod.icon}`);
  $('d-name').textContent = `${mod.name} · 0x${mod.addr.toString(16).toUpperCase().padStart(2, '0')}`;
  $('d-label').textContent = t('mod.' + mod.icon) + (mod.kwp ? ' · KWP2000' : ' · DS2');

  const body = $('d-body');
  body.textContent = '';

  const ident = P.decodeIdent(mod);
  const facts = [];
  if (ident) facts.push(`<b>${ident.part}</b> · HW ${ident.hw}`);
  if (mod.vin) facts.push(`${t('vital.vin')} <b>${mod.vin}</b>`);
  if (mod.mileage) facts.push(`<b>${fmt(mod.mileage)} km</b>`);
  if (mod.live) facts.push(t('vital.rpm') + ` <b>${t('vital.rpm.value', { n: fmt(mod.live.rpm) })}</b>`);
  if (mod.service) facts.push(`${t('service.raw')} <b>${mod.service.join(' / ')}</b>`);
  if (facts.length) {
    const p = document.createElement('p');
    p.style.margin = '0 0 4px';
    p.innerHTML = facts.join(' &nbsp;·&nbsp; ');
    body.appendChild(p);
  }

  renderStore(body, mod, mod.faults, t('store.live'), t('store.livemissing'));
  // Only three modules on this car keep a shadow store; the rest refuse the command, and saying so
  // is better than silence - a missing section reads as "we did not look". KWP modules are left
  // out altogether, because a DS2 shadow memory is not a thing they have rather than one they lack.
  if (!mod.kwp) renderStore(body, mod, mod.shadow, t('store.shadow'), t('store.shadowmissing'));

  // The unlock is offered, explained and never taken automatically. The explanation is the point:
  // the owner is being asked to authorise a command this project put on its own do-not-send list,
  // and they can only answer that if they are told what is known and what is not.
  if (mod.shadow && mod.shadow.locked) {
    const box = document.createElement('div');
    box.className = 'unlock';
    box.innerHTML = `
      <p>${t('unlock.why1')}</p>
      <p>${t('unlock.why2')}</p>
      <button class="ghost" id="d-unlock">${t('btn.unlock')}</button>
      <span class="status" id="d-unlockmsg"></span>`;
    body.appendChild(box);
    // Shown even with no cable attached, so the explanation can be read before deciding; the
    // button is simply inert until there is something to send it to.
    $('d-unlock').disabled = !state.ftdi;
    $('d-unlock').onclick = () => doUnlock(mod);
  }

  if (mod.adfg) {
    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = 'ADFG: ' + P.hex(mod.adfg).replace(/ /g, '');
    body.appendChild(p);
  }
  if (mod.ident) {
    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = 'ident: ' + P.hex(mod.ident);
    body.appendChild(p);
  }

  const again = $('d-again');
  again.hidden = !state.ftdi;
  again.onclick = async () => { $('detail').close(); await readOne(mod); };

  const clear = $('d-clear');
  const hasAny = (mod.faults && mod.faults.count > 0) || (mod.shadow && mod.shadow.count > 0);
  clear.hidden = !hasAny || !state.ftdi;   // no cable, nothing to clear - including in a replay
  clear.disabled = false;
  clear.textContent = t('btn.clear');
  clear.onclick = () => doClear(mod);
  $('d-clearmsg').textContent = '';

  $('detail').showModal();
}

/**
 * Clears a module and then reads it back.
 *
 * The read-back is the point. A positive acknowledgement means the module accepted the command, not
 * that the car is now fault-free: on this car the engine controller accepts the clear and reports
 * the same oil-sensor fault immediately afterwards, because the fault is present rather than merely
 * remembered. Reporting "cleared" off the acknowledgement alone would be a lie the user only
 * discovers on the next scan.
 */
/** Sends the unlock the owner just authorised, and shows whatever came back. */
async function doUnlock(mod) {
  const btn = $('d-unlock');
  const msg = $('d-unlockmsg');
  btn.disabled = true;
  msg.textContent = t('unlock.running');
  try {
    const result = await unlockShadow(state.ftdi, mod, trace);
    if (!result.ok) {
      msg.textContent = t('clear.refused', { reason: result.reason });
      btn.disabled = false;
      return;
    }
    const updated = { ...mod, shadow: result.shadow };
    state.results.set(mod.addr, updated);
    draw();
    $('detail').close();
    showDetail(updated);
  } catch (e) {
    msg.textContent = t('status.aborted', { msg: e.message });
    btn.disabled = false;
  }
}

async function doClear(mod) {
  const btn = $('d-clear');
  const msg = $('d-clearmsg');
  btn.disabled = true;
  btn.textContent = t('btn.clearing');
  msg.textContent = '';
  try {
    const result = await clearFaults(state.ftdi, mod, trace);
    if (!result.ok) {
      msg.textContent = t('clear.refused', { reason: result.reason });
      btn.disabled = false;
      btn.textContent = t('btn.clear');
      return;
    }
    msg.textContent = t('clear.readback');
    const fresh = await scan(state.ftdi, { onTrace: trace, only: [mod.addr] });
    if (fresh[0]) {
      state.results.set(mod.addr, fresh[0]);
      draw();
      $('detail').close();
      showDetail(fresh[0]);
      // If the read-back itself failed we know only that the clear was accepted, and saying "the
      // memory is empty" off the back of an unanswered read would be the worst sentence here.
      if (!fresh[0].faults) {
        $('d-clearmsg').textContent = t('clear.blind');
        return;
      }
      const left = fresh[0].faults.count + (fresh[0].shadow ? fresh[0].shadow.count : 0);
      $('d-clearmsg').textContent = left === 0
        ? t('clear.empty') : tn('clear.live', left);
    }
  } catch (e) {
    msg.textContent = t('status.aborted', { msg: e.message });
    btn.disabled = false;
    btn.textContent = t('btn.clear');
  }
}

/* ------------------------------------------------------------------ trace */

function trace(label, bytes) {
  const el = $('trace');
  el.textContent += `${label.padEnd(8)} ${bytes.length ? P.hex(bytes) : '—'}\n`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(text) { $('status').textContent = text; }

/**
 * Builds the log in the form that is actually useful to read later.
 *
 * The Android app wrote files that could be pulled over adb; a browser has no such thing, so the
 * trace has to leave by the share sheet or the clipboard. It carries the decoded results as well as
 * the raw traffic, because a byte dump on its own has repeatedly turned out to be unreadable
 * without knowing which command each reply belonged to.
 */
function buildLog() {
  const lines = [];
  lines.push(`${t('log.title')} - ${new Date().toISOString()}`);
  lines.push(`user agent: ${navigator.userAgent}`);
  lines.push('');
  for (const mod of P.MODULES) {
    const r = state.results.get(mod.addr);
    if (!r) continue;
    const head = `0x${mod.addr.toString(16).toUpperCase().padStart(2, '0')}  ${mod.name}`;
    if (!r.present) { lines.push(`${head}  -  ${r.reason || t('reason.silent')}`); continue; }
    lines.push(`${head}  ${t('log.present')}  (${r.kwp ? 'KWP2000' : 'DS2'})`);
    const ident = P.decodeIdent(r);
    if (ident) lines.push(`      BMWTNR ${ident.part}   HW ${ident.hw}`);
    if (r.vin) lines.push(`      VIN ${r.vin}`);
    if (r.mileage) lines.push(`      ${t('log.km')} ${r.mileage} km`);
    if (r.live) lines.push(`      ${t('vital.rpm')} ${r.live.rpm} rpm`);
    if (r.adfg) lines.push(`      ADFG ${P.hex(r.adfg).replace(/ /g, '')}`);
    if (r.service) lines.push(`      szerviz-számlálók ${r.service.join(' / ')}`);
    if (r.pages) r.pages.forEach((pg, i) =>
      lines.push(`      0x79DE lap ${i}  ${pg ? P.hex(pg) : '—'}`));
    if (r.ident) lines.push(`      ident ${P.hex(r.ident)}`);
    for (const [name, store, missing] of [
      [t('log.live'), r.faults, t('log.unanswered')],
      [t('log.shadow'), r.shadow, t('log.nostore')],
    ]) {
      if (!store) { lines.push(`      ${name}: ${missing}`); continue; }
      if (store.locked) { lines.push(`      ${name}: ${t('log.locked')}`); continue; }
      lines.push(`      ${name}: ${store.count}`);
      for (const e of store.entries) {
        const text = P.faultText(r.addr, e.code, lang);
        // Padded to the widest entry this car produces - fourteen bytes - because a short pad ran
        // the description straight into the last byte of a ten-byte entry in the first real log.
        lines.push(`        ${codeOf(e)} / ${paramOf(e)}    ${P.hex(e.raw).padEnd(44)}  ${text}`);
      }
    }
  }
  lines.push('');
  lines.push(t('log.raw'));
  lines.push($('trace').textContent.trimEnd());
  return lines.join(String.fromCharCode(10));
}

async function shareLog() {
  const text = buildLog();
  const name = `bmw-diag-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.txt`;
  const file = new File([text], name, { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: t('log.title') }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  // No share sheet - fall back to a download, which works everywhere.
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  $('savedmsg').textContent = t('status.saved');
}

async function copyLog() {
  try {
    await navigator.clipboard.writeText(buildLog());
    $('savedmsg').textContent = t('status.copied');
  } catch (e) {
    $('savedmsg').textContent = t('status.noclipboard');
  }
}

/* ------------------------------------------------------------------ actions */

async function connect() {
  try {
    state.ftdi = await Ftdi.request();
    await state.ftdi.configure({ baudRate: 19200, parity: 0, latencyMs: 1 });
    $('scan').disabled = false;
    $('connect').textContent = t('btn.connected');
    $('connect').disabled = true;
    setStatus(t('status.ready'));
    draw();
  } catch (e) {
    setStatus(e.name === 'NotFoundError'
      ? t('status.nodevice') : t('status.failed', { msg: e.message }));
  }
}

async function run() {
  state.stop = false;
  state.results.clear();
  $('trace').textContent = '';
  $('subtitle').textContent = t('app.subtitle.scanning');
  $('scan').disabled = true;
  state.busy = true;
  $('stop').hidden = false;
  draw();

  try {
    const pct = await idleLevel(state.ftdi);
    $('ignhint').hidden = pct >= 90;
    if (pct < 90) {
      $('ignhint').textContent = t('note.ignition', { pct });
    }
    setStatus(t('status.reading'));

    const results = await scan(state.ftdi, {
      onModule: (m) => { state.results.set(m.addr, m); draw(); },
      onTrace: trace,
      shouldStop: () => state.stop,
    });

    const found = results.filter((r) => r.present);
    const faulty = found.filter((r) => (r.faults && r.faults.count > 0)
      || (r.shadow && r.shadow.count > 0));
    const unreadable = found.filter((r) => !r.faults);
    setStatus(state.stop ? t('status.stopped')
      : t('status.summary', { found: found.length, faulty: faulty.length })
        + (unreadable.length ? t('status.summary.unreadable', { n: unreadable.length }) : ''));
  } catch (e) {
    setStatus(t('status.aborted', { msg: e.message }));
  } finally {
    $('scan').disabled = false;
    state.busy = false;
    $('stop').hidden = true;
    draw();
  }
}

/* ---------------------------------------------------- modules we do not know */

const REPO = 'mogyiii/BMW-scanner-1.4.0-Android';

/**
 * Sweeps the addresses this software has no module for, and offers up whatever answers.
 *
 * The point is other people's cars. This E46 has nine modules; another has a gearbox controller, a
 * navigation unit, a telephone. Their identity bytes are the whole of what is needed to add them,
 * so a find is turned straight into a prefilled issue rather than into a feature request the
 * finder has to write themselves.
 */
async function hunt() {
  const panel = $('unknown');
  const out = $('unknown-body');
  panel.hidden = false;
  out.textContent = '';
  $('stop').hidden = false;
  state.stop = false;
  state.busy = true;
  draw();

  const line = document.createElement('p');
  line.className = 'status';
  out.appendChild(line);

  try {
    const found = await findUnknown(state.ftdi, {
      onTrace: trace,
      shouldStop: () => state.stop,
      onProgress: ({ done, total, addr, found: n }) => {
        const a = addr === undefined ? '' : addr.toString(16).toUpperCase().padStart(2, '0');
        line.textContent = addr === undefined
          ? t('hunt.done', { total, n })
          : t(n ? 'hunt.progress.found' : 'hunt.progress', { addr: a, done, total, n });
      },
    });
    state.unknown = found;

    if (!found.length) {
      const p = document.createElement('p');
      p.textContent = t('hunt.none');
      out.appendChild(p);
      return;
    }

    for (const f of found) {
      const div = document.createElement('div');
      div.className = 'fault';
      const a = `0x${f.addr.toString(16).toUpperCase().padStart(2, '0')}`;
      const proto = f.kwp ? 'KWP2000' : 'DS2';
      const note = P.CURIOSITY_ADDRESSES.has(f.addr) ? ` · ${t('hunt.curiosity')}` : '';
      div.innerHTML = `<code>${a}</code> <span class="raw">${proto}${note}</span>
        ${f.id ? `<div class="desc">BMWTNR ${f.id.part} · HW ${f.id.hw}</div>` : ''}
        <div class="raw">${P.hex(f.ident)}</div>`;
      out.appendChild(div);
    }

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.marginTop = '12px';
    bar.innerHTML = `<button class="ghost" id="report">${t('btn.report')}</button>`
      + `<button class="ghost" id="report-copy">${t('btn.copy')}</button>`
      + '<span class="status" id="reportmsg"></span>';
    out.appendChild(bar);
    $('report').onclick = () => window.open(issueUrl(found), '_blank', 'noopener');
    $('report-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(issueBody(found, true));
        $('reportmsg').textContent = t('status.copied');
      } catch (e) { $('reportmsg').textContent = t('status.noclipboard'); }
    };
  } catch (e) {
    line.textContent = t('status.aborted', { msg: e.message });
  } finally {
    state.busy = false;
    $('stop').hidden = true;
    draw();
  }
}

/**
 * The report text. `withTrace` decides whether the whole raw log comes along.
 *
 * It does for the clipboard and it does not for the URL, because a URL cannot carry it. The table
 * is the part that matters anyway: a module's address, protocol and identity bytes are the whole
 * of what is needed to add it.
 */
function issueBody(found, withTrace) {
  const lines = ['This app found a module it does not know about.', ''];
  lines.push('| address | protocol | BMWTNR | HW | identity |');
  lines.push('|---|---|---|---|---|');
  for (const f of found) {
    const a = `0x${f.addr.toString(16).toUpperCase().padStart(2, '0')}`;
    lines.push(`| \`${a}\` | ${f.kwp ? 'KWP2000' : 'DS2'} | ${f.id ? f.id.part : '—'} `
      + `| ${f.id ? f.id.hw : '—'} | \`${P.hex(f.ident)}\` |`);
  }
  lines.push('', '**Car:** (model, year, engine — if you would share it)', '');
  if (withTrace) {
    lines.push('<details><summary>Raw traffic</summary>', '', '```', buildLog(), '```', '</details>');
  } else {
    lines.push('<!-- The raw traffic did not fit in the link. Press the copy button in the app',
               '     and paste it here - it carries every byte this reading was built from. -->');
  }
  return lines.join(String.fromCharCode(10));
}

/**
 * The prefilled issue link, without the trace and short enough to survive.
 *
 * The first version put the whole log in the URL under a 5000-character cap. Percent-encoding
 * roughly triples a hex dump, so the link blew past what a browser will open and the button did
 * nothing at all. The table alone is a few hundred characters; the copy button beside it carries
 * the rest.
 */
function issueUrl(found) {
  const title = `Unknown module: ${found.map(
    (f) => '0x' + f.addr.toString(16).toUpperCase().padStart(2, '0')).join(', ')}`;
  const url = `https://github.com/${REPO}/issues/new`
    + `?title=${encodeURIComponent(title)}&body=${encodeURIComponent(issueBody(found, false))}`;
  // Many modules at once could still overflow; then the title alone goes, and the body is pasted.
  return url.length < 6000 ? url
    : `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}`;
}

/* ------------------------------------------------------------------ start */

/**
 * `?demo=1` fills the page with this car's recorded readings instead of talking to a cable.
 *
 * Loaded on demand, so it costs nothing on the normal path. It says what it is on screen: a replay
 * cannot be allowed to look like a reading.
 */
// The language picker, and the first fill of every translated string on the page.
for (const [code, label] of LANGUAGES) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = label;
  if (code === lang) opt.selected = true;
  $('lang').appendChild(opt);
}
$('lang').addEventListener('change', (e) => { setLang(e.target.value); relabel(); });
applyStatic();

if (new URLSearchParams(location.search).has('demo')) {
  const demo = await import('./demo.js');
  for (const [label, hex] of demo.TRACE) {
    trace(label, Uint8Array.from(hex.split(' '), (h) => parseInt(h, 16)));
  }
  for (const r of demo.replay()) state.results.set(r.addr, r);
  draw();
  $('connect').disabled = true;
  $('scan').disabled = true;
  $('unsupported').hidden = false;
  // Re-keyed rather than written once, so switching language re-renders it like everything else.
  $('unsupported').setAttribute('data-i18n', 'note.demo');
  $('unsupported').setAttribute('data-i18n-html', '');
  $('unsupported').innerHTML = t('note.demo');
  setStatus(t('status.replay'));
} else if (!('usb' in navigator)) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
  setStatus('');
} else {
  Ftdi.reopenKnown().then(async (f) => {
    if (!f) return;
    state.ftdi = f;
    await f.configure({ baudRate: 19200, parity: 0, latencyMs: 1 });
    $('scan').disabled = false;
    $('connect').textContent = t('btn.connected');
    $('connect').disabled = true;
    setStatus(t('status.ready'));
    draw();
  }).catch(() => { /* nothing plugged in yet; the button still works */ });
}

$('connect').addEventListener('click', connect);
$('scan').addEventListener('click', run);
$('stop').addEventListener('click', () => { state.stop = true; setStatus(t('status.stopping')); });
$('d-close').addEventListener('click', () => $('detail').close());
$('share').addEventListener('click', shareLog);
$('copy').addEventListener('click', copyLog);
draw();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
}
