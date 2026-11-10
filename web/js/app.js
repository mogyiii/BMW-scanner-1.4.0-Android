/**
 * The tiles, and what happens when you press things.
 *
 * Nothing in here knows about USB or the protocol; it asks `session.js` to do the talking and draws
 * what comes back. The one opinion it holds is that a reading should never hide its evidence, so
 * every fault keeps its raw bytes on screen.
 */

import { Ftdi } from './ftdi.js';
import * as P from './protocol.js';
import { scan, idleLevel, clearFaults, unlockShadow, findUnknown, pollSteering }
  from './session.js';
import { t, tn, lang, setLang, applyStatic, LANGUAGES } from './i18n.js';
import * as R from './report.js';
import { VERSION } from './version.js';

const $ = (id) => document.getElementById(id);
const state = { ftdi: null, stop: false, busy: false, results: new Map() };

/** Thousands separators follow the chosen language, not the browser's. */
const LOCALE = { hu: 'hu-HU', de: 'de-DE', en: 'en-GB' };
const fmt = (n) => n.toLocaleString(LOCALE[lang] || 'en-GB');

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
  // Nothing to export before the first read, and an enabled button that produces an empty file is
  // worse than an absent one.
  $('exports').hidden = ![...state.results.values()].some((r) => r.present);
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
  if (ident) {
    const bits = [`<b>${ident.part}</b>`, `HW ${ident.hw}`];
    if (ident.sw) bits.push(`SW ${ident.sw}`);
    if (ident.ci) bits.push(`CI ${ident.ci}`, `DI ${ident.di}`, `BI ${ident.bi}`);
    if (ident.date) bits.push(ident.date);
    facts.push(bits.join(' · '));
  }
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

  // Only one module answers a live question, so the button lives on that module rather than in a
  // general "live data" screen that would have one entry.
  const live = $('d-live');
  live.hidden = mod.addr !== 0x57 || !state.ftdi;
  live.onclick = () => { $('detail').close(); steeringLive(); };

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
  lines.push(`app version: ${VERSION}`);
  // The cable's own identity, which the page never shows but a bug report wants. It is also the
  // only handle anyone has on whether two cables are the same cable: the FTDI EEPROM is freely
  // rewritable, so the manufacturer and product strings prove nothing, but a serial that turns up
  // on somebody else's cable would say something.
  if (state.ftdi && state.ftdi.device) {
    const d = state.ftdi.device;
    lines.push(`cable: ${d.manufacturerName || '?'} / ${d.productName || '?'}`
      + `  serial ${d.serialNumber || '?'}`
      + `  usb ${d.vendorId.toString(16).padStart(4, '0')}:`
      + `${d.productId.toString(16).padStart(4, '0')}`);
  }
  lines.push(`user agent: ${navigator.userAgent}`);
  lines.push('');
  for (const mod of P.MODULES) {
    const r = state.results.get(mod.addr);
    if (!r) continue;
    const head = `0x${mod.addr.toString(16).toUpperCase().padStart(2, '0')}  ${mod.name}`;
    if (!r.present) { lines.push(`${head}  -  ${r.reason || t('reason.silent')}`); continue; }
    lines.push(`${head}  ${t('log.present')}  (${r.kwp ? 'KWP2000' : 'DS2'})`);
    const ident = P.decodeIdent(r);
    if (ident) lines.push(`      BMWTNR ${ident.part}   HW ${ident.hw}`
      + (ident.sw ? `   SW ${ident.sw}   CI ${ident.ci}   DI ${ident.di}`
          + `   BI ${ident.bi}   ${ident.date}` : ''));
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

/* ------------------------------------------------------------------ report */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * One self-contained HTML page: the findings, without the hex.
 *
 * `buildLog()` exists for us - it carries every raw byte because a decoder argument is settled by
 * looking at bytes. This is for everyone else: the owner keeping a record, a mechanic being shown
 * what came up, a forum post. Those readers do not want 200 lines of trace, and burying eight
 * faults inside it is how a finding gets missed.
 *
 * HTML rather than text or PDF. Text cannot lay out a table, and generating a PDF in the browser
 * means shipping a library this page would otherwise not need - whereas a styled HTML file prints
 * to PDF from the browser's own dialog, which every phone and laptop already has. It stays one
 * file with no external reference, so it still opens years from now with no network.
 *
 * Modules with nothing to report collapse to one line each. A reader scanning this should reach the
 * faults without scrolling past nine clean bills of health.
 */
function buildReport() {
  const all = [...state.results.values()].filter((r) => !r.busy);
  const present = all.filter((r) => r.present);
  const silent = all.filter((r) => !r.present);
  const vin = present.map((r) => r.vin).filter(Boolean).sort((a, b) => b.length - a.length)[0];
  const km = present.map((r) => r.mileage).find((m) => m);
  const kwp = present.filter((r) => r.kwp).length;

  // Counted over both stores, and only over stores that answered. A module whose read failed must
  // not contribute a zero here - the whole point of the three-state handling elsewhere.
  const faulty = [];
  let total = 0;
  for (const r of present) {
    const stores = [[t('log.live'), r.faults], [t('log.shadow'), r.shadow]];
    const found = stores.filter(([, s]) => s && !s.locked && s.count > 0);
    total += found.reduce((n, [, s]) => n + s.count, 0);
    if (found.length) faulty.push([r, found]);
  }

  const rows = [];
  const row = (term, value) => { if (value) rows.push(`<tr><th>${esc(term)}</th><td>${esc(value)}</td></tr>`); };
  row(t('vital.vin'), vin);
  row(t('vital.km'), km ? `${fmt(km)} km` : '');
  row(t('vital.modules'), `${present.length} / ${P.MODULES.length}`);
  row(t('rep.protocols'), present.length ? `${present.length - kwp} × DS2, ${kwp} × KWP2000` : '');
  row(t('rep.date'), new Date().toLocaleString(LOCALE[lang] || 'en-GB'));

  const nameOf = (r) => (P.MODULES.find((m) => m.addr === r.addr) || { name: '?' }).name;
  const addrOf = (r) => `0x${r.addr.toString(16).toUpperCase().padStart(2, '0')}`;

  const parts = [];
  parts.push(`<h2>${esc(total ? tn('rep.faults', total) : t('rep.nofaults'))}</h2>`);

  for (const [r, stores] of faulty) {
    parts.push(`<section class="mod"><h3>${esc(nameOf(r))} <span class="addr">${addrOf(r)}</span></h3>`);
    for (const [label, store] of stores) {
      parts.push(`<p class="store">${esc(label)} — ${store.count}</p><table class="faults">`);
      for (const e of store.entries) {
        const text = P.faultText(r.addr, e.code, lang);
        parts.push(`<tr><td class="code">${codeOf(e)}</td><td class="code">${paramOf(e)}</td>`
          + `<td>${text ? esc(text) : `<span class="unknown">${esc(t('rep.undescribed'))}</span>`}</td></tr>`);
      }
      parts.push('</table>');
    }
    parts.push('</section>');
  }

  // Everything that is fine, or that could not be asked, as compact lines rather than sections.
  const notes = [];
  for (const r of present) {
    if (faulty.some(([f]) => f === r)) continue;
    const unread = !r.faults;
    const locked = r.faults && r.faults.locked;
    notes.push(`<li><b>${esc(nameOf(r))}</b> <span class="addr">${addrOf(r)}</span> — ${esc(
      unread ? t('rep.unread') : locked ? t('rep.locked') : t('rep.clean'))}</li>`);
  }
  for (const r of silent) {
    notes.push(`<li class="off"><b>${esc(nameOf(r))}</b> <span class="addr">${addrOf(r)}</span> — ${esc(
      r.reason || t('reason.silent'))}</li>`);
  }
  if (notes.length) parts.push(`<h2>${esc(t('rep.other'))}</h2><ul class="notes">${notes.join('')}</ul>`);

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t('log.title'))}${vin ? ` — ${esc(vin)}` : ''}</title>
<style>
  :root { color-scheme: light }
  body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0d1b2a;
         background: #fff; max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; color: #0a2d5e }
  h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; padding-bottom: .35rem;
       border-bottom: 2px solid #14529d; color: #0f3f7d }
  h3 { font-size: 1rem; margin: 1.25rem 0 .4rem }
  .sub { color: #566475; margin: 0 0 1.5rem; font-size: .9rem }
  table { border-collapse: collapse; width: 100% }
  .car th { text-align: left; color: #566475; font-weight: 500; width: 11rem; padding: .3rem 0 }
  .car td { padding: .3rem 0 }
  .mod { break-inside: avoid }
  .store { margin: .5rem 0 .3rem; color: #566475; font-size: .88rem }
  .faults td { padding: .35rem .5rem; border-top: 1px solid #d8e2ee; vertical-align: top }
  .faults td:first-child { padding-left: 0 }
  .code { font-family: ui-monospace, Menlo, Consolas, monospace; width: 3.5rem; color: #0f3f7d }
  .unknown { color: #8b97a6; font-style: italic }
  .addr { font-family: ui-monospace, Menlo, Consolas, monospace; color: #8b97a6; font-weight: 400;
          font-size: .85em }
  .notes { list-style: none; padding: 0; margin: 0 }
  .notes li { padding: .3rem 0; border-top: 1px solid #d8e2ee }
  .notes li.off { color: #8b97a6 }
  footer { margin-top: 2.5rem; padding-top: .9rem; border-top: 1px solid #d8e2ee;
           color: #8b97a6; font-size: .8rem }
  footer a { color: #14529d }
  /* Printing is how this becomes a PDF, so the page has to be built for paper as well. */
  @media print { body { max-width: none; padding: 0 } h2 { break-after: avoid } }
</style></head><body>
<h1>${esc(t('log.title'))}</h1>
<p class="sub">${esc(t('rep.sub'))}</p>
<table class="car">${rows.join('')}</table>
${parts.join('\n')}
<footer>${t('rep.footer')} · v${VERSION}</footer>
</body></html>`;
}

async function saveReport() {
  const html = buildReport();
  const name = `bmw-report-${new Date().toISOString().slice(0, 10)}.html`;
  const file = new File([html], name, { type: 'text/html' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: t('log.title') }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  $('savedmsg').textContent = t('status.saved');
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

/**
 * The steering readout: the one live value this car offers besides engine speed.
 *
 * It shows the raw byte and the signed reading side by side, and says plainly that the angle is
 * relative. The byte wraps inside a movement well short of full lock and carries no turn counter,
 * so "157 degrees" would be an invention. What it can honestly show is movement, direction and
 * the point the wheel returns to — which is what the measurement needs.
 */
async function steeringLive() {
  const panel = $('live');
  const out = $('live-body');
  panel.hidden = false;
  out.textContent = '';
  state.stop = false;
  state.busy = true;
  draw();
  $('stop').hidden = false;

  const value = document.createElement('div');
  value.className = 'livevalue';
  const note = document.createElement('p');
  note.className = 'status';
  const trace_ = document.createElement('p');
  trace_.className = 'meta';
  out.append(value, note, trace_);

  let n = 0;
  let min = null;
  let max = null;
  try {
    await pollSteering(state.ftdi, {
      shouldStop: () => state.stop,
      onSample: (s, raw) => {
        n += 1;
        if (!s) { note.textContent = t('live.lost', { n }); return; }
        min = min === null ? s.signed : Math.min(min, s.signed);
        max = max === null ? s.signed : Math.max(max, s.signed);
        value.textContent = `${s.signed > 0 ? '+' : ''}${s.signed}`;
        value.style.color = s.trusted ? 'var(--blue-800)' : 'var(--amber)';
        note.textContent = t(s.trusted ? 'live.steady' : 'live.moving')
          + `   ·   ${t('live.range', { min, max })}   ·   ${t('live.samples', { n })}`;
        trace_.textContent = raw ? P.hex(raw) : '';
      },
    });
  } catch (e) {
    note.textContent = t('status.aborted', { msg: e.message });
  } finally {
    state.busy = false;
    $('stop').hidden = true;
    draw();
  }
}

/* ---------------------------------------------------- modules we do not know */

const REPO = 'mogyiii/bmw-scanner-1.4-webusb';

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
    // Both routes go through the same consent step. The link carries only the table, the copy
    // button carries the whole log, and the dialog says which of those is happening.
    $('report').onclick = async () => {
      if (!await askConsent(found, false)) return;
      window.open(issueUrl(found), '_blank', 'noopener');
    };
    $('report-copy').onclick = async () => {
      const choice = await askConsent(found, true);
      if (!choice) return;
      const body = choice.redactVin
        ? R.redactVins(issueBody(found, true), vinsSeen(), t('consent.removed'))
        : issueBody(found, true);
      try {
        await navigator.clipboard.writeText(body);
        $('reportmsg').textContent = t(choice.redactVin ? 'status.copied.redacted' : 'status.copied');
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

/** The chassis numbers in this reading; the rule and the reasoning live in `report.js`. */
const vinsSeen = () => R.vinsIn([...state.results.values()]);

/**
 * Asks before anything about the car leaves it, and says exactly what "anything" is.
 *
 * A GitHub issue is public and permanent, and the person pressing this button is trying to be
 * helpful about an unknown module — not to publish their odometer. The two buttons send very
 * different amounts, so the list is built from what is actually about to go rather than from a
 * fixed warning, and the chassis number is left out by default because nothing in a module report
 * needs it.
 *
 * Resolves to `null` if the user declines.
 */
function askConsent(found, withTrace) {
  const dlg = $('consent');
  const list = $('consent-list');
  list.textContent = '';
  const add = (text, sensitive) => {
    const li = document.createElement('li');
    li.textContent = text;
    if (sensitive) li.className = 'sensitive';
    list.appendChild(li);
  };

  add(tn('consent.item.modules', found.length));
  const km = [...state.results.values()].find((r) => r.mileage);
  if (withTrace) {
    const faults = [...state.results.values()]
      .reduce((n, r) => n + (r.faults && !r.faults.locked ? r.faults.count : 0), 0);
    if (km) add(t('consent.item.km', { km: fmt(km.mileage) }), true);
    if (faults) add(tn('consent.item.faults', faults), true);
    add(t('consent.item.trace'), true);
  }
  // Only offer the choice when there is a chassis number in what is about to go.
  const hasVin = vinsSeen().length > 0 && withTrace;
  $('consent-vinrow').hidden = !hasVin;
  if (hasVin) add(t('consent.item.vin'), true);

  dlg.showModal();
  return new Promise((resolve) => {
    const done = (value) => {
      $('consent-yes').onclick = null;
      $('consent-no').onclick = null;
      dlg.close();
      resolve(value);
    };
    $('consent-yes').onclick = () => done({ redactVin: hasVin && $('consent-novin').checked });
    $('consent-no').onclick = () => done(null);
    dlg.addEventListener('cancel', () => done(null), { once: true });
  });
}

/** The issue text; `withTrace` decides whether the whole raw log comes along. */
const issueBody = (found, withTrace) => R.issueBody(found, withTrace ? buildLog() : null);
const issueUrl = (found) => R.issueUrl(REPO, found);

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
$('version').textContent = `v${VERSION}`;
$('version').href = `https://github.com/${REPO}/commits/main`;
$('link-src').href = `https://github.com/${REPO}`;
$('link-lic').href = `https://github.com/${REPO}/blob/main/LICENSE`;
$('link-iss').href = `https://github.com/${REPO}/issues`;
$('doc').addEventListener('click', saveReport);
$('share').addEventListener('click', shareLog);
$('copy').addEventListener('click', copyLog);
draw();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
}
