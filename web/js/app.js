/**
 * The tiles, and what happens when you press things.
 *
 * Nothing in here knows about USB or the protocol; it asks `session.js` to do the talking and draws
 * what comes back. The one opinion it holds is that a reading should never hide its evidence, so
 * every fault keeps its raw bytes on screen.
 */

import { Ftdi } from './ftdi.js';
import * as P from './protocol.js';
import { scan, idleLevel, clearFaults } from './session.js';

const $ = (id) => document.getElementById(id);
const state = { ftdi: null, stop: false, results: new Map() };

/* ------------------------------------------------------------------ tiles */

function tileFor(mod) {
  const el = document.createElement(mod.present ? 'button' : 'div');
  el.className = 'tile';
  if (mod.busy) el.classList.add('busy');
  else if (!mod.present) el.classList.add('off');
  else if ((mod.faults && mod.faults.count > 0) || (mod.shadow && mod.shadow.count > 0)) {
    el.classList.add('warn');
  }
  else el.classList.add('ok');

  const shadowCount = mod.shadow ? mod.shadow.count : 0;
  const state_ = mod.busy ? 'olvasás…'
    : !mod.present ? (mod.reason || '—')
    : mod.faults.count === 0 && shadowCount === 0 ? 'hibátlan'
    : mod.faults.count === 0 ? `${shadowCount} árnyékhiba`
    : shadowCount === 0 ? `${mod.faults.count} hiba`
    : `${mod.faults.count} + ${shadowCount} hiba`;

  el.innerHTML = `
    <div class="icon">${mod.icon}</div>
    <div class="name">${mod.name}</div>
    <div class="label">${mod.label}</div>
    <div class="state">${state_}</div>`;

  if (mod.present) {
    el.classList.add('clickable');
    el.addEventListener('click', () => showDetail(mod));
  }
  return el;
}

function draw() {
  const grid = $('grid');
  grid.textContent = '';
  for (const mod of P.MODULES) {
    grid.appendChild(tileFor(state.results.get(mod.addr) || { ...mod, present: false, reason: '' }));
  }
}

const codeOf = (e) => (e.wide
  ? e.code.toString(16).toUpperCase().padStart(4, '0')
  : e.code.toString(16).toUpperCase().padStart(2, '0'));
const paramOf = (e) => (e.param === null ? '??' : e.param.toString(16).toUpperCase().padStart(2, '0'));

/** Renders one fault store into `body`, heading and all. */
function renderStore(body, mod, store, heading) {
  const h = document.createElement('p');
  h.className = 'store';
  h.textContent = heading;
  body.appendChild(h);

  if (!store) { h.textContent = heading + ' — nincs ilyen tároló'; return; }
  if (store.count === 0) { h.textContent = heading + ' — nincs tárolt hibakód'; return; }

  for (const e of store.entries) {
    const div = document.createElement('div');
    div.className = 'fault';
    const text = P.faultText(mod.addr, e.code);
    div.innerHTML = `<code>${codeOf(e)} / ${paramOf(e)}</code>
      ${text ? `<div class="desc">${text}</div>` : ''}
      <div class="raw">${P.hex(e.raw)}</div>`;
    body.appendChild(div);
  }
  if (store.entries.length === 0) {
    const p = document.createElement('p');
    p.textContent = `${store.count} hiba, de a bejegyzések nem voltak olvashatók.`;
    body.appendChild(p);
  }
}

function showDetail(mod) {
  $('d-icon').textContent = mod.icon;
  $('d-name').textContent = `${mod.name} · 0x${mod.addr.toString(16).toUpperCase().padStart(2, '0')}`;
  $('d-label').textContent = mod.label + (mod.kwp ? ' · KWP2000' : ' · DS2');

  const body = $('d-body');
  body.textContent = '';

  if (mod.vin) {
    const p = document.createElement('p');
    p.innerHTML = `<b>VIN:</b> ${mod.vin}`;
    body.appendChild(p);
  }

  renderStore(body, mod, mod.faults, 'Hibamemória');
  // Only three modules on this car keep a shadow store; the rest refuse the command, and saying so
  // is better than silence - a missing section reads as "we did not look".
  renderStore(body, mod, mod.shadow, 'Árnyékmemória');

  if (mod.adfg) {
    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = 'ADFG: ' + P.hex(mod.adfg).replace(/ /g, '');
    body.appendChild(p);
  }
  if (mod.ident) {
    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = 'azonosító: ' + P.hex(mod.ident);
    body.appendChild(p);
  }

  const clear = $('d-clear');
  const hasAny = (mod.faults && mod.faults.count > 0) || (mod.shadow && mod.shadow.count > 0);
  clear.hidden = !hasAny;
  clear.disabled = false;
  clear.textContent = 'Hibák törlése';
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
async function doClear(mod) {
  const btn = $('d-clear');
  const msg = $('d-clearmsg');
  btn.disabled = true;
  btn.textContent = 'Törlés…';
  msg.textContent = '';
  try {
    const result = await clearFaults(state.ftdi, mod, trace);
    if (!result.ok) {
      msg.textContent = `Nem sikerült: ${result.reason}.`;
      btn.disabled = false;
      btn.textContent = 'Hibák törlése';
      return;
    }
    msg.textContent = 'Törölve. Visszaolvasás…';
    const fresh = await scan(state.ftdi, { onTrace: trace, only: [mod.addr] });
    if (fresh[0]) {
      state.results.set(mod.addr, fresh[0]);
      draw();
      const left = (fresh[0].faults ? fresh[0].faults.count : 0)
        + (fresh[0].shadow ? fresh[0].shadow.count : 0);
      $('detail').close();
      showDetail(fresh[0]);
      $('d-clearmsg').textContent = left === 0
        ? 'Törölve, a memória üres.'
        : `A vezérlő elfogadta a törlést, de ${left} hiba azonnal visszajött — ezek élő hibák, `
          + 'nem csak tárolt bejegyzések.';
    }
  } catch (e) {
    msg.textContent = `Megszakadt: ${e.message}`;
    btn.disabled = false;
    btn.textContent = 'Hibák törlése';
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
  lines.push(`BMW E46 diagnosztika - ${new Date().toISOString()}`);
  lines.push(`user agent: ${navigator.userAgent}`);
  lines.push('');
  for (const mod of P.MODULES) {
    const r = state.results.get(mod.addr);
    if (!r) continue;
    const head = `0x${mod.addr.toString(16).toUpperCase().padStart(2, '0')}  ${mod.name}`;
    if (!r.present) { lines.push(`${head}  -  ${r.reason || 'nem válaszolt'}`); continue; }
    lines.push(`${head}  jelen van  (${r.kwp ? 'KWP2000' : 'DS2'})`);
    if (r.vin) lines.push(`      VIN ${r.vin}`);
    if (r.adfg) lines.push(`      ADFG ${P.hex(r.adfg).replace(/ /g, '')}`);
    if (r.ident) lines.push(`      azonosító ${P.hex(r.ident)}`);
    for (const [name, store] of [['hibamemória', r.faults], ['árnyékmemória', r.shadow]]) {
      if (!store) { lines.push(`      ${name}: nincs ilyen tároló`); continue; }
      lines.push(`      ${name}: ${store.count}`);
      for (const e of store.entries) {
        const text = P.faultText(r.addr, e.code);
        lines.push(`        ${codeOf(e)} / ${paramOf(e)}    ${P.hex(e.raw).padEnd(24)}${text}`);
      }
    }
  }
  lines.push('');
  lines.push('--- nyers forgalom ---');
  lines.push($('trace').textContent.trimEnd());
  return lines.join(String.fromCharCode(10));
}

async function shareLog() {
  const text = buildLog();
  const name = `e46-diag-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.txt`;
  const file = new File([text], name, { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Diagnosztikai napló' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  // No share sheet - fall back to a download, which works everywhere.
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  $('savedmsg').textContent = 'Letöltve.';
}

async function copyLog() {
  try {
    await navigator.clipboard.writeText(buildLog());
    $('savedmsg').textContent = 'Vágólapra másolva.';
  } catch (e) {
    $('savedmsg').textContent = 'A vágólap nem elérhető - használd a megosztást.';
  }
}

/* ------------------------------------------------------------------ actions */

async function connect() {
  try {
    state.ftdi = await Ftdi.request();
    await state.ftdi.configure({ baudRate: 19200, parity: 0, latencyMs: 1 });
    $('scan').disabled = false;
    $('connect').textContent = 'Kábel csatlakoztatva';
    $('connect').disabled = true;
    setStatus('Kész az olvasásra.');
  } catch (e) {
    setStatus(e.name === 'NotFoundError' ? 'Nem választottál eszközt.' : `Nem sikerült: ${e.message}`);
  }
}

async function run() {
  state.stop = false;
  state.results.clear();
  $('trace').textContent = '';
  $('vin').textContent = '';
  $('scan').disabled = true;
  $('stop').hidden = false;
  draw();

  try {
    const pct = await idleLevel(state.ftdi);
    $('ignhint').hidden = pct >= 90;
    if (pct < 90) {
      $('ignhint').textContent =
        `A K-line nyugalmi szintje csak ${pct}% — ez alvó vezérlőegységekre vall. ` +
        `Fordítsd a gyújtást 2-es állásba (vagy indítsd be), különben nincs mi válaszoljon.`;
    }
    setStatus('Olvasás…');

    const results = await scan(state.ftdi, {
      onModule: (m) => { state.results.set(m.addr, m); draw(); },
      onTrace: trace,
      shouldStop: () => state.stop,
    });

    const found = results.filter((r) => r.present);
    const faulty = found.filter((r) => r.faults && r.faults.count > 0);
    const vin = results.find((r) => r.vin);
    if (vin) $('vin').textContent = vin.vin;
    setStatus(state.stop
      ? 'Leállítva.'
      : `${found.length} vezérlőegység válaszolt, ${faulty.length} hibával.`);
  } catch (e) {
    setStatus(`Megszakadt: ${e.message}`);
  } finally {
    $('scan').disabled = false;
    $('stop').hidden = true;
  }
}

/* ------------------------------------------------------------------ start */

if (!('usb' in navigator)) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
  setStatus('');
} else {
  Ftdi.reopenKnown().then(async (f) => {
    if (!f) return;
    state.ftdi = f;
    await f.configure({ baudRate: 19200, parity: 0, latencyMs: 1 });
    $('scan').disabled = false;
    $('connect').textContent = 'Kábel csatlakoztatva';
    $('connect').disabled = true;
    setStatus('Kész az olvasásra.');
  }).catch(() => { /* nothing plugged in yet; the button still works */ });
}

$('connect').addEventListener('click', connect);
$('scan').addEventListener('click', run);
$('stop').addEventListener('click', () => { state.stop = true; setStatus('Leállítás a modul végén…'); });
$('d-close').addEventListener('click', () => $('detail').close());
$('share').addEventListener('click', shareLog);
$('copy').addEventListener('click', copyLog);
draw();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
}
