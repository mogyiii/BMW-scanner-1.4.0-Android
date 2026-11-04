/**
 * The tiles, and what happens when you press things.
 *
 * Nothing in here knows about USB or the protocol; it asks `session.js` to do the talking and draws
 * what comes back. The one opinion it holds is that a reading should never hide its evidence, so
 * every fault keeps its raw bytes on screen.
 */

import { Ftdi } from './ftdi.js';
import * as P from './protocol.js';
import { scan, idleLevel } from './session.js';

const $ = (id) => document.getElementById(id);
const state = { ftdi: null, stop: false, results: new Map() };

/* ------------------------------------------------------------------ tiles */

function tileFor(mod) {
  const el = document.createElement(mod.present ? 'button' : 'div');
  el.className = 'tile';
  if (mod.busy) el.classList.add('busy');
  else if (!mod.present) el.classList.add('off');
  else if (mod.faults && mod.faults.count > 0) el.classList.add('warn');
  else el.classList.add('ok');

  const state_ = mod.busy ? 'olvasás…'
    : !mod.present ? (mod.reason || '—')
    : mod.faults.count === 0 ? 'hibátlan'
    : mod.faults.count === 1 ? '1 hiba' : `${mod.faults.count} hiba`;

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

function showDetail(mod) {
  $('d-icon').textContent = mod.icon;
  $('d-name').textContent = `${mod.name} · 0x${mod.addr.toString(16).toUpperCase().padStart(2, '0')}`;
  $('d-label').textContent = mod.label;

  const body = $('d-body');
  body.textContent = '';

  if (mod.vin) {
    const p = document.createElement('p');
    p.innerHTML = `<b>VIN:</b> ${mod.vin}`;
    body.appendChild(p);
  }

  if (!mod.faults || mod.faults.count === 0) {
    const p = document.createElement('p');
    p.textContent = 'Nincs tárolt hibakód.';
    body.appendChild(p);
  } else {
    for (const e of mod.faults.entries) {
      const div = document.createElement('div');
      div.className = 'fault';
      const code = e.wide
        ? e.code.toString(16).toUpperCase().padStart(4, '0')
        : e.code.toString(16).toUpperCase().padStart(2, '0');
      const param = e.param === null ? '??' : e.param.toString(16).toUpperCase().padStart(2, '0');
      div.innerHTML = `<code>${code} / ${param}</code>
        <div class="raw">${P.hex(e.raw)}</div>`;
      body.appendChild(div);
    }
    if (mod.faults.entries.length === 0) {
      const p = document.createElement('p');
      p.textContent = `${mod.faults.count} hiba, de a bejegyzések nem voltak olvashatók.`;
      body.appendChild(p);
    }
  }

  if (mod.ident) {
    const p = document.createElement('p');
    p.className = 'raw';
    p.style.color = 'var(--dim)';
    p.style.fontSize = '.75rem';
    p.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
    p.style.wordBreak = 'break-all';
    p.textContent = 'azonosító: ' + P.hex(mod.ident);
    body.appendChild(p);
  }

  $('detail').showModal();
}

/* ------------------------------------------------------------------ trace */

function trace(label, bytes) {
  const el = $('trace');
  el.textContent += `${label.padEnd(8)} ${bytes.length ? P.hex(bytes) : '—'}\n`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(text) { $('status').textContent = text; }

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
draw();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
}
