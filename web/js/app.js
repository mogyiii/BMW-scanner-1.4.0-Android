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
  else if (mod.present && !mod.faults) el.classList.add('warn');
  else el.classList.add('ok');

  // Three states, not two. A store that did not answer is `null`; one that answered zero is
  // `{count: 0}`; one that refused until it is unlocked is `{locked: true}`. Collapsing any of
  // these into "no faults" is the one wrong answer a fault reader can give, and the first on-car
  // run of this app gave it.
  const shadowCount = mod.shadow && !mod.shadow.locked ? mod.shadow.count : 0;
  const locked = !!(mod.shadow && mod.shadow.locked);
  const count = mod.faults ? mod.faults.count : null;
  const state_ = mod.busy ? 'olvasás…'
    : !mod.present ? (mod.reason || '—')
    : count === null ? 'nem olvasható'
    : count === 0 && shadowCount === 0 ? (locked ? 'árnyék zárolt' : 'hibátlan')
    : count === 0 ? `${shadowCount} árnyékhiba`
    : shadowCount === 0 ? `${count} hiba`
    : `${count} + ${shadowCount} hiba`;

  el.innerHTML = `
    <svg class="ic" aria-hidden="true"><use href="#ic-${mod.icon}"/></svg>
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
  drawVitals();
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
  const dl = $('vitals');
  dl.textContent = '';

  const add = (term, value) => {
    if (!value) return;
    const wrap = document.createElement('div');
    wrap.className = 'vital';
    wrap.innerHTML = `<dt>${term}</dt><dd>${value}</dd>`;
    dl.appendChild(wrap);
  };
  add('alvázszám', vin);
  add('kilométeróra', km ? `${km.toLocaleString('hu-HU')} km` : '');
  add('vezérlőegység', results.length ? `${results.length} / ${P.MODULES.length}` : '');

  if (results.length) {
    const kwp = results.filter((r) => r.kwp).length;
    $('subtitle').textContent =
      `${results.length - kwp} modul DS2-n, ${kwp} KWP2000-en — a kiolvasott adatokból`;
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
  if (store.locked) { h.textContent = `${heading} — zárolt`; return; }
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
  $('d-icon').setAttribute('href', `#ic-${mod.icon}`);
  $('d-name').textContent = `${mod.name} · 0x${mod.addr.toString(16).toUpperCase().padStart(2, '0')}`;
  $('d-label').textContent = mod.label + (mod.kwp ? ' · KWP2000' : ' · DS2');

  const body = $('d-body');
  body.textContent = '';

  const ident = P.decodeIdent(mod);
  const facts = [];
  if (ident) facts.push(`<b>${ident.part}</b> · HW ${ident.hw}`);
  if (mod.vin) facts.push(`alvázszám <b>${mod.vin}</b>`);
  if (mod.mileage) facts.push(`<b>${mod.mileage.toLocaleString('hu-HU')} km</b>`);
  if (facts.length) {
    const p = document.createElement('p');
    p.style.margin = '0 0 4px';
    p.innerHTML = facts.join(' &nbsp;·&nbsp; ');
    body.appendChild(p);
  }

  renderStore(body, mod, mod.faults, 'Hibamemória', 'nem válaszolt, a tartalma ismeretlen');
  // Only three modules on this car keep a shadow store; the rest refuse the command, and saying so
  // is better than silence - a missing section reads as "we did not look". KWP modules are left
  // out altogether, because a DS2 shadow memory is not a thing they have rather than one they lack.
  if (!mod.kwp) renderStore(body, mod, mod.shadow, 'Árnyékmemória', 'nincs ilyen tároló');

  // The unlock is offered, explained and never taken automatically. The explanation is the point:
  // the owner is being asked to authorise a command this project put on its own do-not-send list,
  // and they can only answer that if they are told what is known and what is not.
  if (mod.shadow && mod.shadow.locked) {
    const box = document.createElement('div');
    box.className = 'unlock';
    box.innerHTML = `
      <p>A vezérlő elutasítja az árnyékmemória olvasását, amíg fel nem oldod. A gyári szoftver
      ilyenkor két parancsot küld: egy <code>90 FF FF</code>-et, majd egy <code>95</code>-öt,
      ami <b>a modul saját azonosító bájtjait</b> adja vissza — nem új adatot.</p>
      <p>Ez feloldásnak néz ki, nem írásnak: a válasz üres nyugta, és a modul azonosítója
      utána is ugyanaz. <b>Bizonyítva nincs</b>, ezért az app magától soha nem küldi el.</p>
      <button class="ghost" id="d-unlock">Feloldás és olvasás</button>
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
    p.textContent = 'azonosító: ' + P.hex(mod.ident);
    body.appendChild(p);
  }

  const clear = $('d-clear');
  const hasAny = (mod.faults && mod.faults.count > 0) || (mod.shadow && mod.shadow.count > 0);
  clear.hidden = !hasAny || !state.ftdi;   // no cable, nothing to clear - including in a replay
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
/** Sends the unlock the owner just authorised, and shows whatever came back. */
async function doUnlock(mod) {
  const btn = $('d-unlock');
  const msg = $('d-unlockmsg');
  btn.disabled = true;
  msg.textContent = 'Feloldás…';
  try {
    const result = await unlockShadow(state.ftdi, mod, trace);
    if (!result.ok) {
      msg.textContent = `Nem sikerült: ${result.reason}.`;
      btn.disabled = false;
      return;
    }
    const updated = { ...mod, shadow: result.shadow };
    state.results.set(mod.addr, updated);
    draw();
    $('detail').close();
    showDetail(updated);
  } catch (e) {
    msg.textContent = `Megszakadt: ${e.message}`;
    btn.disabled = false;
  }
}

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
      $('detail').close();
      showDetail(fresh[0]);
      // If the read-back itself failed we know only that the clear was accepted, and saying "the
      // memory is empty" off the back of an unanswered read would be the worst sentence here.
      if (!fresh[0].faults) {
        $('d-clearmsg').textContent =
          'A vezérlő elfogadta a törlést, de a visszaolvasás nem válaszolt — hogy mi maradt benne, '
          + 'arról ez a futás nem mond semmit. Olvasd újra.';
        return;
      }
      const left = fresh[0].faults.count + (fresh[0].shadow ? fresh[0].shadow.count : 0);
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
    const ident = P.decodeIdent(r);
    if (ident) lines.push(`      BMWTNR ${ident.part}   HW ${ident.hw}`);
    if (r.vin) lines.push(`      VIN ${r.vin}`);
    if (r.mileage) lines.push(`      kilométeróra ${r.mileage} km`);
    if (r.adfg) lines.push(`      ADFG ${P.hex(r.adfg).replace(/ /g, '')}`);
    if (r.ident) lines.push(`      azonosító ${P.hex(r.ident)}`);
    for (const [name, store, missing] of [
      ['hibamemória', r.faults, 'NEM VÁLASZOLT'],
      ['árnyékmemória', r.shadow, 'nincs ilyen tároló'],
    ]) {
      if (!store) { lines.push(`      ${name}: ${missing}`); continue; }
      if (store.locked) { lines.push(`      ${name}: ZÁROLT`); continue; }
      lines.push(`      ${name}: ${store.count}`);
      for (const e of store.entries) {
        const text = P.faultText(r.addr, e.code);
        // Padded to the widest entry this car produces - fourteen bytes - because a short pad ran
        // the description straight into the last byte of a ten-byte entry in the first real log.
        lines.push(`        ${codeOf(e)} / ${paramOf(e)}    ${P.hex(e.raw).padEnd(44)}  ${text}`);
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
    $('hunt').disabled = false;
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
  $('subtitle').textContent = 'Olvasás folyamatban…';
  $('scan').disabled = true;
  $('hunt').disabled = true;
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
    const faulty = found.filter((r) => (r.faults && r.faults.count > 0)
      || (r.shadow && r.shadow.count > 0));
    const unreadable = found.filter((r) => !r.faults);
    setStatus(state.stop
      ? 'Leállítva.'
      : `${found.length} vezérlőegység válaszolt, ${faulty.length} hibával.`
        + (unreadable.length ? `  ${unreadable.length} hibamemória nem olvasható.` : ''));
  } catch (e) {
    setStatus(`Megszakadt: ${e.message}`);
  } finally {
    $('scan').disabled = false;
    $('hunt').disabled = false;
    $('stop').hidden = true;
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
  $('hunt').disabled = true;
  $('stop').hidden = false;
  state.stop = false;

  const line = document.createElement('p');
  line.className = 'status';
  out.appendChild(line);

  try {
    const found = await findUnknown(state.ftdi, {
      onTrace: trace,
      shouldStop: () => state.stop,
      onProgress: ({ done, total, addr, found: n }) => {
        line.textContent = addr === undefined
          ? `${total} cím végignézve, ${n} ismeretlen modul.`
          : `0x${addr.toString(16).toUpperCase().padStart(2, '0')} — ${done}/${total}`
            + (n ? `, eddig ${n} találat` : '');
      },
    });
    state.unknown = found;

    if (!found.length) {
      const p = document.createElement('p');
      p.textContent = 'Nincs olyan modul, amit az alkalmazás ne ismerne. Ez a kilenc van az autóban.';
      out.appendChild(p);
      return;
    }

    for (const f of found) {
      const div = document.createElement('div');
      div.className = 'fault';
      const a = `0x${f.addr.toString(16).toUpperCase().padStart(2, '0')}`;
      div.innerHTML = `<code>${a}</code>
        ${f.id ? `<div class="desc">BMWTNR ${f.id.part} · HW ${f.id.hw}</div>` : ''}
        <div class="raw">${P.hex(f.ident)}</div>`;
      out.appendChild(div);
    }

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.marginTop = '12px';
    bar.innerHTML = '<button class="ghost" id="report">Beküldöm (GitHub)</button>'
      + '<button class="ghost" id="report-copy">Vágólapra</button>'
      + '<span class="status" id="reportmsg"></span>';
    out.appendChild(bar);
    $('report').onclick = () => window.open(issueUrl(found), '_blank', 'noopener');
    $('report-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(issueBody(found));
        $('reportmsg').textContent = 'Vágólapra másolva.';
      } catch (e) { $('reportmsg').textContent = 'A vágólap nem elérhető.'; }
    };
  } catch (e) {
    line.textContent = `Megszakadt: ${e.message}`;
  } finally {
    $('hunt').disabled = false;
    $('stop').hidden = true;
  }
}

function issueBody(found) {
  const lines = ['Az alkalmazás olyan modult talált, amit nem ismer.', ''];
  lines.push('| cím | BMWTNR | HW | azonosító |');
  lines.push('|---|---|---|---|');
  for (const f of found) {
    const a = `0x${f.addr.toString(16).toUpperCase().padStart(2, '0')}`;
    lines.push(`| \`${a}\` | ${f.id ? f.id.part : '—'} | ${f.id ? f.id.hw : '—'} | \`${P.hex(f.ident)}\` |`);
  }
  lines.push('', '**Autó:** (típus, évjárat, motor — ha megosztanád)', '');
  lines.push('<details><summary>Nyers forgalom</summary>', '', '```', buildLog(), '```', '</details>');
  return lines.join(String.fromCharCode(10));
}

function issueUrl(found) {
  const title = `Ismeretlen modul: ${found.map(
    (f) => '0x' + f.addr.toString(16).toUpperCase().padStart(2, '0')).join(', ')}`;
  // A long trace can overflow what a browser will put in a URL, so the body is capped and the
  // "Vágólapra" button stays as the route for the whole thing.
  const body = issueBody(found).slice(0, 5000);
  return `https://github.com/${REPO}/issues/new`
    + `?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/* ------------------------------------------------------------------ start */

/**
 * `?demo=1` fills the page with this car's recorded readings instead of talking to a cable.
 *
 * Loaded on demand, so it costs nothing on the normal path. It says what it is on screen: a replay
 * cannot be allowed to look like a reading.
 */
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
  $('unsupported').innerHTML =
    '<b>Bemutató mód.</b> Ezek a 2026-11-05-i mérés rögzített válaszai, ugyanazokon a dekódolókon '
    + 'átvezetve — <b>nincs kábel csatlakoztatva, és ez nem élő olvasás.</b> '
    + '<a href="./" style="color:inherit">Vissza az éles módhoz</a>.';
  setStatus('Rögzített mérés.');
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
    $('hunt').disabled = false;
    $('connect').textContent = 'Kábel csatlakoztatva';
    $('connect').disabled = true;
    setStatus('Kész az olvasásra.');
  }).catch(() => { /* nothing plugged in yet; the button still works */ });
}

$('connect').addEventListener('click', connect);
$('scan').addEventListener('click', run);
$('hunt').addEventListener('click', hunt);
$('stop').addEventListener('click', () => { state.stop = true; setStatus('Leállítás a modul végén…'); });
$('d-close').addEventListener('click', () => $('detail').close());
$('share').addEventListener('click', shareLog);
$('copy').addEventListener('click', copyLog);
draw();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
}
