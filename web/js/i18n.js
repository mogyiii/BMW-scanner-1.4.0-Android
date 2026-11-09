/**
 * Hungarian and English, chosen by the reader.
 *
 * The app was written in Hungarian because its first user speaks Hungarian, and the cable it drives
 * is sold worldwide — so the strings live here instead of in the markup. Static text is tagged with
 * `data-i18n` in `index.html` and filled in by `applyStatic`; anything assembled at runtime goes
 * through `t`.
 *
 * The fault descriptions are the one place where the English is not a translation of the Hungarian:
 * both come from the vendor software's own report for this car, so the English is the original and
 * the Hungarian is the translation.
 */

const STRINGS = {
  hu: {
    'app.title': 'BMW diagnosztika',
    'app.subtitle': 'DS2 és KWP2000 — csatlakoztasd a kábelt az olvasáshoz',
    'app.subtitle.scanning': 'Olvasás folyamatban…',
    'app.subtitle.done': '{ds2} modul DS2-n, {kwp} KWP2000-en — a kiolvasott adatokból',

    'mod.zke': 'Karosszéria-elektronika',
    'mod.dme': 'Motorvezérlő',
    'mod.abs': 'ABS / DSC',
    'mod.vtc': 'Valvetronic',
    'mod.ews': 'Indításgátló',
    'mod.lew': 'Kormányszög-érzékelő',
    'mod.ihka': 'Klíma',
    'mod.ike': 'Műszerfal',
    'mod.srs': 'Légzsák',
    'mod.lcm': 'Világításvezérlő',

    'vital.vin': 'alvázszám',
    'vital.km': 'kilométeróra',
    'service.raw': 'szerviz-számlálók (jelentésük még nem igazolt)',
    'vital.rpm': 'fordulatszám',
    'vital.rpm.value': '{n} /perc',
    'vital.modules': 'vezérlőegység',

    'btn.connect': 'Kábel csatlakoztatása',
    'btn.connected': 'Kábel csatlakoztatva',
    'btn.scan': 'Olvasás',
    'btn.stop': 'Leállítás',
    'btn.close': 'Bezár',
    'btn.clear': 'Hibák törlése',
    'btn.clearing': 'Törlés…',
    'btn.unlock': 'Feloldás és olvasás',
    'btn.hunt': 'Ismeretlen modulok keresése',
    'btn.share': 'Napló megosztása',
    'btn.copy': 'Vágólapra',
    'btn.report': 'Beküldöm (GitHub)',

    'status.idle': 'Nincs csatlakoztatva.',
    'status.ready': 'Kész az olvasásra.',
    'status.reading': 'Olvasás…',
    'status.stopped': 'Leállítva.',
    'status.stopping': 'Leállítás a modul végén…',
    'status.nodevice': 'Nem választottál eszközt.',
    'status.failed': 'Nem sikerült: {msg}',
    'status.aborted': 'Megszakadt: {msg}',
    'status.summary': '{found} vezérlőegység válaszolt, {faulty} hibával.',
    'status.summary.unreadable': '  {n} hibamemória nem olvasható.',
    'status.replay': 'Rögzített mérés.',
    'status.saved': 'Letöltve.',
    'status.copied': 'Vágólapra másolva.',
    'status.noclipboard': 'A vágólap nem elérhető — használd a megosztást.',

    'tile.busy': 'olvasás…',
    'tile.clean': 'hibátlan',
    'tile.unreadable': 'nem olvasható',
    'tile.shadowlocked': 'árnyék zárolt',
    'tile.faults': '{n} hiba',
    'tile.faults.one': '1 hiba',
    'tile.shadowfaults': '{n} árnyékhiba',
    'tile.shadowfaults.one': '1 árnyékhiba',
    'tile.both': '{n} + {m} hiba',
    'tile.hunt.name': 'Hiányzó?',
    'tile.hunt.label': 'Más modul keresése',
    'tile.hunt.state': 'további {n} cím',

    'reason.nolink': 'nincs kapcsolat',
    'reason.silent': 'nem válaszolt',
    'reason.notrecorded': 'nincs rögzítve',

    'store.live': 'Hibamemória',
    'store.shadow': 'Árnyékmemória',
    'store.empty': 'nincs tárolt hibakód',
    'store.locked': 'zárolt',
    'store.livemissing': 'nem válaszolt, a tartalma ismeretlen',
    'store.shadowmissing': 'nincs ilyen tároló',
    'store.unreadable': '{n} hiba, de a bejegyzések nem voltak olvashatók.',

    'clear.refused': 'Nem sikerült: {reason}.',
    'clear.readback': 'Törölve. Visszaolvasás…',
    'clear.empty': 'Törölve, a memória üres.',
    'clear.live': 'A vezérlő elfogadta a törlést, de {n} hiba azonnal visszajött — ezek élő hibák, '
      + 'nem csak tárolt bejegyzések.',
    'clear.live.one': 'A vezérlő elfogadta a törlést, de a hiba azonnal visszajött — ez élő hiba, '
      + 'nem csak tárolt bejegyzés.',
    'clear.blind': 'A vezérlő elfogadta a törlést, de a visszaolvasás nem válaszolt — hogy mi '
      + 'maradt benne, arról ez a futás nem mond semmit. Olvasd újra.',
    'clear.conditions': 'a vezérlő elutasította — a körülmények nem megfelelők '
      + '(gyújtás 2-es állásban, motor leállítva)',
    'clear.rejected': 'a vezérlő elutasította (0x{code})',
    'clear.garbled': 'értelmezhetetlen válasz',

    'unlock.why1': 'A vezérlő elutasítja az árnyékmemória olvasását, amíg fel nem oldod. A gyári '
      + 'szoftver ilyenkor két parancsot küld: egy <code>90 FF FF</code>-et, majd egy '
      + '<code>95</code>-öt, ami <b>a modul saját azonosító bájtjait</b> adja vissza — nem új adatot.',
    'unlock.why2': 'Ez feloldásnak néz ki, nem írásnak: a válasz üres nyugta, és a modul '
      + 'azonosítója utána is ugyanaz. <b>Bizonyítva nincs</b>, ezért az app magától soha nem küldi el.',
    'unlock.running': 'Feloldás…',
    'unlock.short': 'az azonosító túl rövid a feloldáshoz',
    'unlock.norefused': 'a vezérlő nem fogadta el a feloldást',
    'unlock.stilllocked': 'a feloldás után is zárolt',

    'hunt.title': 'Ismeretlen modulok',
    'hunt.intro': 'A fenti csempék azok a modulok, amiket ez a szoftver ismer, és amiket ez az autó '
      + 'tartalmaz. Egy másik BMW-ben lehet sebességváltó-, navigációs vagy telefonvezérlő is — '
      + 'azokat az app még nem ismeri. Ez végigkérdezi a többi címet, amit a gyári szoftver is '
      + 'szokott, mindkét protokollon.',
    'hunt.intro2': 'Ha találsz ilyet, egy gombbal beküldheted: a modul azonosító bájtjai pont azok, '
      + 'amik hiányoznak ahhoz, hogy bekerüljön. Lassú, mert minden címhez új kapcsolat kell.',
    'hunt.curiosity': 'nem BMW-cím',
    'hunt.progress': '0x{addr} — {done}/{total}',
    'hunt.progress.found': '0x{addr} — {done}/{total}, eddig {n} találat',
    'hunt.done': '{total} cím végignézve, {n} ismeretlen modul.',
    'hunt.none': 'Nincs olyan modul, amit az alkalmazás ne ismerne — ez az autó csak a fenti '
      + 'címeken válaszol.',

    'raw.summary': 'Nyers forgalom',
    'note.evidence': 'A hibakódok mellett mindig ott a nyers bájtsor. A kiolvasás a gyári szoftver '
      + 'saját kimenetéhez van igazolva, egy 2002-es E46 316i-n — de a <b>szöveges leírás</b> csak '
      + 'azokhoz a kódokhoz van meg, amiket az az autó valóban produkált. Ismeretlen kód mellett '
      + 'nincs leírás: inkább semmi, mint egy hihetően hangzó találgatás.',
    'note.clear': 'A törlés csak a <i>tárolt</i> listát üríti. Ha egy hiba éppen fennáll, a vezérlő '
      + 'elfogadja a törlést, majd a következő olvasásnál ugyanazt a kódot jelenti — az alkalmazás '
      + 'ezért mindig visszaolvas, és megmondja, mi jött vissza.',
    'note.unsupported': 'Ez a böngésző nem tud USB-eszközhöz nyúlni. Androidon vagy asztali gépen '
      + '<b>Chrome</b> vagy <b>Edge</b> kell hozzá. iOS-en a Safari nem támogatja, és natív '
      + 'alkalmazásból sem érhető el — iPhone-on ez sajnos nem fog működni.',
    'note.ignition': 'A K-line nyugalmi szintje csak {pct}% — ez alvó vezérlőegységekre vall. '
      + 'Fordítsd a gyújtást 2-es állásba (vagy indítsd be), különben nincs mi válaszoljon.',
    'note.demo': '<b>Bemutató mód.</b> Ezek egy 2026-11-05-i mérés rögzített válaszai, ugyanazokon '
      + 'a dekódolókon átvezetve — <b>nincs kábel csatlakoztatva, és ez nem élő olvasás.</b> '
      + '<a href="./">Vissza az éles módhoz</a>.',

    'log.title': 'BMW diagnosztika',
    'log.present': 'jelen van',
    'log.live': 'hibamemória',
    'log.shadow': 'árnyékmemória',
    'log.nostore': 'nincs ilyen tároló',
    'log.unanswered': 'NEM VÁLASZOLT',
    'log.locked': 'ZÁROLT',
    'log.raw': '--- nyers forgalom ---',
    'log.km': 'kilométeróra',
  },

  en: {
    'app.title': 'BMW diagnostics',
    'app.subtitle': 'DS2 and KWP2000 — connect the cable to read',
    'app.subtitle.scanning': 'Reading…',
    'app.subtitle.done': '{ds2} modules on DS2, {kwp} on KWP2000 — from the car itself',

    'mod.zke': 'Body electronics',
    'mod.dme': 'Engine',
    'mod.abs': 'ABS / DSC',
    'mod.vtc': 'Valvetronic',
    'mod.ews': 'Immobiliser',
    'mod.lew': 'Steering angle',
    'mod.ihka': 'Climate',
    'mod.ike': 'Instrument cluster',
    'mod.srs': 'Airbag',
    'mod.lcm': 'Lighting',

    'vital.vin': 'chassis number',
    'vital.km': 'odometer',
    'service.raw': 'service counters (meaning not yet confirmed)',
    'vital.rpm': 'engine speed',
    'vital.rpm.value': '{n} rpm',
    'vital.modules': 'modules',

    'btn.connect': 'Connect the cable',
    'btn.connected': 'Cable connected',
    'btn.scan': 'Read',
    'btn.stop': 'Stop',
    'btn.close': 'Close',
    'btn.clear': 'Clear faults',
    'btn.clearing': 'Clearing…',
    'btn.unlock': 'Unlock and read',
    'btn.hunt': 'Look for unknown modules',
    'btn.share': 'Share the log',
    'btn.copy': 'Copy',
    'btn.report': 'Report it (GitHub)',

    'status.idle': 'Not connected.',
    'status.ready': 'Ready to read.',
    'status.reading': 'Reading…',
    'status.stopped': 'Stopped.',
    'status.stopping': 'Stopping after this module…',
    'status.nodevice': 'No device chosen.',
    'status.failed': 'Failed: {msg}',
    'status.aborted': 'Interrupted: {msg}',
    'status.summary': '{found} modules answered, {faulty} with faults.',
    'status.summary.unreadable': '  {n} fault memories could not be read.',
    'status.replay': 'Recorded session.',
    'status.saved': 'Downloaded.',
    'status.copied': 'Copied to the clipboard.',
    'status.noclipboard': 'The clipboard is not available — use share instead.',

    'tile.busy': 'reading…',
    'tile.clean': 'no faults',
    'tile.unreadable': 'unreadable',
    'tile.shadowlocked': 'shadow locked',
    'tile.faults': '{n} faults',
    'tile.faults.one': '1 fault',
    'tile.shadowfaults': '{n} shadow faults',
    'tile.shadowfaults.one': '1 shadow fault',
    'tile.both': '{n} + {m} faults',
    'tile.hunt.name': 'Missing?',
    'tile.hunt.label': 'Look for other modules',
    'tile.hunt.state': '{n} more addresses',

    'reason.nolink': 'no link',
    'reason.silent': 'no answer',
    'reason.notrecorded': 'not recorded',

    'store.live': 'Fault memory',
    'store.shadow': 'Shadow memory',
    'store.empty': 'no stored faults',
    'store.locked': 'locked',
    'store.livemissing': 'no answer, contents unknown',
    'store.shadowmissing': 'no such store',
    'store.unreadable': '{n} faults, but the entries could not be read.',

    'clear.refused': 'Failed: {reason}.',
    'clear.readback': 'Cleared. Reading back…',
    'clear.empty': 'Cleared, the memory is empty.',
    'clear.live': 'The module accepted the clear, but {n} faults came straight back — these are '
      + 'live faults, not just stored entries.',
    'clear.live.one': 'The module accepted the clear, but the fault came straight back — it is a '
      + 'live fault, not just a stored entry.',
    'clear.blind': 'The module accepted the clear, but the read-back got no answer — this run says '
      + 'nothing about what is left in there. Read it again.',
    'clear.conditions': 'the module refused — conditions not correct '
      + '(ignition in position 2, engine off)',
    'clear.rejected': 'the module refused (0x{code})',
    'clear.garbled': 'unintelligible reply',

    'unlock.why1': 'The module refuses to serve its shadow memory until it is unlocked. The vendor '
      + 'software sends two commands first: <code>90 FF FF</code>, then <code>95</code> carrying '
      + '<b>the module’s own identity bytes</b> — not new data.',
    'unlock.why2': 'That looks like an unlock rather than a write: the reply is a bare '
      + 'acknowledgement, and the module’s identity is unchanged afterwards. <b>It is not '
      + 'proven</b>, so this app never sends it on its own.',
    'unlock.running': 'Unlocking…',
    'unlock.short': 'the identity is too short to build the unlock',
    'unlock.norefused': 'the module did not accept the unlock',
    'unlock.stilllocked': 'still locked after the unlock',

    'hunt.title': 'Unknown modules',
    'hunt.intro': 'The tiles above are the modules this software knows and this car has. Another '
      + 'BMW may also have a gearbox, navigation or telephone controller, which this app does not '
      + 'know yet. This sweeps the other addresses the vendor software probes, on both protocols.',
    'hunt.intro2': 'If you find one, you can report it with a button: a module’s identity '
      + 'bytes are exactly what is missing to add it. It is slow, because every address needs its '
      + 'own connection.',
    'hunt.curiosity': 'not a BMW address',
    'hunt.progress': '0x{addr} — {done}/{total}',
    'hunt.progress.found': '0x{addr} — {done}/{total}, {n} found so far',
    'hunt.done': '{total} addresses swept, {n} unknown modules.',
    'hunt.none': 'No module this app does not already know — this car only answers at the '
      + 'addresses above.',

    'raw.summary': 'Raw traffic',
    'note.evidence': 'Every fault keeps its raw bytes on screen. The reading is verified against '
      + 'the vendor software’s own output, on a 2002 E46 316i — but the <b>descriptions</b> exist '
      + 'only for the codes that car actually produced. An unknown code gets no description: '
      + 'better nothing than a plausible-sounding guess.',
    'note.clear': 'Clearing empties the <i>stored</i> list only. If a fault is currently present, '
      + 'the module accepts the clear and then reports the same code on the next read — which is '
      + 'why this app always reads back and tells you what returned.',
    'note.unsupported': 'This browser cannot reach a USB device. On Android or a desktop you need '
      + '<b>Chrome</b> or <b>Edge</b>. Safari does not implement WebUSB and Apple does not allow '
      + 'it from native apps either, so an iPhone cannot drive this cable by any route.',
    'note.ignition': 'The K-line idles at only {pct}% high, which means the modules are asleep. '
      + 'Turn the ignition to position 2 (or start the engine), or there is nothing to answer.',
    'note.demo': '<b>Demonstration mode.</b> These are recorded replies from a session on '
      + '2026-11-05, run through the same decoders — <b>no cable is connected and this is not a '
      + 'live reading.</b> <a href="./">Back to live mode</a>.',

    'log.title': 'BMW diagnostics',
    'log.present': 'present',
    'log.live': 'fault memory',
    'log.shadow': 'shadow memory',
    'log.nostore': 'no such store',
    'log.unanswered': 'NO ANSWER',
    'log.locked': 'LOCKED',
    'log.raw': '--- raw traffic ---',
    'log.km': 'odometer',
  },
};

export const LANGUAGES = [['hu', 'Magyar'], ['en', 'English']];

/** Hungarian for Hungarian speakers, English for everyone else, and whatever was chosen after that. */
function initial() {
  const saved = localStorage.getItem('lang');
  if (saved && STRINGS[saved]) return saved;
  return (navigator.language || '').toLowerCase().startsWith('hu') ? 'hu' : 'en';
}

export let lang = initial();

export function setLang(next) {
  if (!STRINGS[next]) return;
  lang = next;
  localStorage.setItem('lang', next);
  document.documentElement.lang = next;
}

/** Looks up a string and substitutes `{name}` placeholders. Missing keys surface, they do not hide. */
export function t(key, vars) {
  let s = STRINGS[lang][key];
  if (s === undefined) s = STRINGS.en[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/**
 * `t`, but picks `<key>.one` when there is exactly one of the thing.
 *
 * English needs it - "1 fault(s)" on a diagnostic screen looks like nobody read the output.
 * Hungarian does not inflect a noun after a number, so both of its keys hold the same words and
 * the call site does not have to know which language it is in.
 */
export function tn(key, n, vars) {
  return t(n === 1 ? `${key}.one` : key, { n, ...vars });
}

/**
 * Fills every `data-i18n` element in the document.
 *
 * `data-i18n-html` marks the ones whose text carries markup - the notes with `<b>` and `<code>` in
 * them. Everything else goes in as text, so a translation can never inject an element.
 */
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (el.hasAttribute('data-i18n-html')) el.innerHTML = t(key);
    else el.textContent = t(key);
  }
  document.documentElement.lang = lang;
  document.title = t('app.title');
}
