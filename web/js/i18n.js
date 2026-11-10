/**
 * English, German and Hungarian, chosen by the reader.
 *
 * The app was written in Hungarian because its first user speaks Hungarian, and the cable it drives
 * is sold worldwide — so the strings live here instead of in the markup. Static text is tagged with
 * `data-i18n` in `index.html` and filled in by `applyStatic`; anything assembled at runtime goes
 * through `t`.
 *
 * **The fault descriptions are not here and are not translated.** They are extracted from the
 * vendor binary, which carries them in English for the five modules this app ships; the German
 * and Hungarian `note.evidence` strings say so rather than leaving a reader to wonder. Twelve
 * codes do have hand-written Hungarian, and for those the English came from the vendor's own
 * report - so there the English is the original and the Hungarian the translation.
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
    'btn.scan': 'Mindet olvasom',
    'btn.again': 'Csak ezt olvasd újra',
    'btn.stop': 'Leállítás',
    'btn.close': 'Bezár',
    'btn.clear': 'Hibák törlése',
    'btn.clearing': 'Törlés…',
    'btn.unlock': 'Feloldás és olvasás',
    'btn.live': 'Élő kormányszög',
    'btn.hunt': 'Ismeretlen modulok keresése',
    'btn.share': 'Napló megosztása',
    'btn.copy': 'Vágólapra',
    'foot.warn': 'Ezt az alkalmazást a saját felelősségedre használod, mindenféle jótállás nélkül. Egy autó vezérlőegységeivel beszél, és ki tudja üríteni a hibatárolóikat — egy törölt hibatároló viszont olyan nyomokat semmisít meg, amikre a szerelőnek még szüksége lehet. Olyan kocsin használd, amiért te felelsz.',
    'foot.source': 'Forráskód a GitHubon',
    'foot.licence': 'MIT licenc',
    'foot.issue': 'Hibabejelentés',
    'foot.vendor': 'Független projekt. Nem áll kapcsolatban a BMW-vel és a PA-Soft-tal, és nem tartalmazza a gyári szoftver egyetlen darabját sem. A hibaleírások a gyártó szövegei, és nem tartoznak a fenti licenc alá.',
    'consent.title': 'Mielőtt ez elhagyja a kocsit',
    'consent.sub': 'Nyilvános GitHub-bejelentés',
    'consent.lead': 'A GitHub-bejelentések nyilvánosak és azok is maradnak. A keresők indexelik őket, és a későbbi törlés ezt nem vonja vissza.',
    'consent.what': 'Ez megy ki a kocsidról:',
    'consent.item.modules': 'Az ismeretlen modulok: cím, protokoll, cikkszám, hardververzió és azonosító bájtok ({n} db)',
    'consent.item.modules.one': 'Az ismeretlen modul: cím, protokoll, cikkszám, hardververzió és azonosító bájtok',
    'consent.item.vin': 'Az alvázszám',
    'consent.item.km': 'A kilométeróra állása ({km} km)',
    'consent.item.faults': 'Mind a {n} kiolvasott hibakód',
    'consent.item.faults.one': 'A kiolvasott hibakód',
    'consent.item.trace': 'A teljes nyers forgalom ebből a kiolvasásból',
    'consent.novin': 'Az alvázszám maradjon ki',
    'consent.vinnote': 'Az alvázszám azonosítja a kocsidat a forgalmi és az előélet-adatbázisokban. A modul-bejelentésnek semmi szüksége rá. Kihagyva a nyers forgalomból is eltűnik, nem csak a szövegből.',
    'consent.removed': '[alvázszám eltávolítva]',
    'consent.ok': 'Rendben, mehet',
    'consent.cancel': 'Mégsem',
    'status.copied.redacted': 'Vágólapra másolva, alvázszám nélkül',
    'btn.doc': 'Riport letöltése',
    'rep.sub': 'A kocsiból kiolvasott hibatároló-tartalom. A nyers bájtok a teljes naplóban vannak.',
    'rep.protocols': 'protokoll',
    'rep.date': 'kiolvasás ideje',
    'rep.faults': '{n} hibakód',
    'rep.faults.one': '{n} hibakód',
    'rep.nofaults': 'Nincs tárolt hibakód',
    'rep.undescribed': 'nincs leírás ehhez a kódhoz',
    'rep.other': 'A többi modul',
    'rep.clean': 'nincs hibakód',
    'rep.unread': 'a hibatároló nem válaszolt',
    'rep.locked': 'a hibatároló zárolt',
    'rep.footer': 'Készítette a BMW Scanner 1.4 WebUSB alkalmazás. A hibaleírások a gyári szoftver saját tábláiból származnak; ahol nincs leírás, ott ez külön jelezve van, mert a találgatás rosszabb a semminél.',
    'btn.report': 'Beküldöm (GitHub)',

    'status.idle': 'Nincs csatlakoztatva.',
    'status.ready': 'Kész az olvasásra.',
    'status.reading': 'Olvasás…',
    'status.readingone': '{name} olvasása…',
    'status.readone': '{name} kiolvasva.',
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

    'live.title': 'Élő kormányszög',
    'live.intro': 'A szög <b>relatív</b>, nem fok. A bájt átfordul egy olyan '
      + 'mozgáson belül is, ami jóval a teljes elfordulás alatt van, és a válaszban '
      + 'nincs fordulatszámláló — ezért a mozgás, az irány és a visszatérési pont '
      + 'látszik, nem a tényleges szög. A Leállítás gombbal fejezed be.',
    'live.steady': 'a két csatorna egyezik',
    'live.moving': 'mozgás közben — a csatornák eltérnek',
    'live.range': 'tartomány {min} … {max}',
    'live.samples': '{n} mérés',
    'live.lost': 'a modul abbahagyta a választ {n} mérés után',
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
    'btn.scan': 'Read all',
    'btn.again': 'Read this one again',
    'btn.stop': 'Stop',
    'btn.close': 'Close',
    'btn.clear': 'Clear faults',
    'btn.clearing': 'Clearing…',
    'btn.unlock': 'Unlock and read',
    'btn.live': 'Live steering angle',
    'btn.hunt': 'Look for unknown modules',
    'btn.share': 'Share the log',
    'btn.copy': 'Copy',
    'foot.warn': 'Use this at your own risk, with no warranty of any kind. It talks to the control modules of a car and can erase their fault memories — and an erased fault memory destroys evidence a mechanic may still need. Use it on a car you are responsible for.',
    'foot.source': 'Source on GitHub',
    'foot.licence': 'MIT licence',
    'foot.issue': 'Report a problem',
    'foot.vendor': 'An independent project. Not affiliated with BMW or PA-Soft, and it contains no part of the vendor software. The fault descriptions are the vendor’s wording and are not covered by the licence above.',
    'consent.title': 'Before this leaves your car',
    'consent.sub': 'A public GitHub issue',
    'consent.lead': 'GitHub issues are public and stay public. Search engines index them, and deleting one later does not undo that.',
    'consent.what': 'This is what goes out about your car:',
    'consent.item.modules': 'The unknown modules: address, protocol, part number, hardware version and identity bytes ({n} of them)',
    'consent.item.modules.one': 'The unknown module: address, protocol, part number, hardware version and identity bytes',
    'consent.item.vin': 'The chassis number',
    'consent.item.km': 'The odometer reading ({km} km)',
    'consent.item.faults': 'All {n} fault codes read from the car',
    'consent.item.faults.one': 'The fault code read from the car',
    'consent.item.trace': 'The complete raw traffic of this reading',
    'consent.novin': 'Leave the chassis number out',
    'consent.vinnote': 'A chassis number identifies your car in registration and vehicle-history databases. Nothing in a module report needs it. Left out, it goes from the raw traffic too, not just from the readable text.',
    'consent.removed': '[chassis number removed]',
    'consent.ok': 'Send it',
    'consent.cancel': 'Cancel',
    'status.copied.redacted': 'Copied, without the chassis number',
    'btn.doc': 'Download report',
    'rep.sub': 'Fault store contents read out of the car. The raw bytes are in the full log.',
    'rep.protocols': 'protocol',
    'rep.date': 'read at',
    'rep.faults': '{n} stored faults',
    'rep.faults.one': '{n} stored fault',
    'rep.nofaults': 'No stored faults',
    'rep.undescribed': 'no description for this code',
    'rep.other': 'The other modules',
    'rep.clean': 'no faults',
    'rep.unread': 'fault store did not answer',
    'rep.locked': 'fault store locked',
    'rep.footer': 'Produced by the BMW Scanner 1.4 WebUSB app. Fault descriptions come from the vendor software’s own tables; where there is none, this says so, because a plausible guess is worse than nothing.',
    'btn.report': 'Report it (GitHub)',

    'status.idle': 'Not connected.',
    'status.ready': 'Ready to read.',
    'status.reading': 'Reading…',
    'status.readingone': 'Reading {name}…',
    'status.readone': '{name} read.',
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

    'live.title': 'Live steering angle',
    'live.intro': 'The angle is <b>relative</b>, not degrees. The byte wraps inside '
      + 'a movement well short of full lock and the reply carries no turn counter, so '
      + 'what this shows is movement, direction and the point the wheel returns to — '
      + 'not the actual angle. Press Stop to finish.',
    'live.steady': 'both channels agree',
    'live.moving': 'moving — the channels differ',
    'live.range': 'range {min} … {max}',
    'live.samples': '{n} samples',
    'live.lost': 'the module stopped answering after {n} samples',
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
  de: {
    'app.title': 'BMW-Diagnose',
    'app.subtitle': 'DS2 und KWP2000 — Kabel anschließen zum Auslesen',
    'app.subtitle.scanning': 'Wird ausgelesen…',
    'app.subtitle.done': '{ds2} Steuergeräte über DS2, {kwp} über KWP2000 — aus dem Fahrzeug selbst',

    'mod.zke': 'Karosserieelektronik',
    'mod.dme': 'Motorsteuerung',
    'mod.abs': 'ABS / DSC',
    'mod.vtc': 'Valvetronic',
    'mod.ews': 'Wegfahrsperre',
    'mod.lew': 'Lenkwinkelsensor',
    'mod.ihka': 'Klimaanlage',
    'mod.ike': 'Kombiinstrument',
    'mod.srs': 'Airbag',
    'mod.lcm': 'Lichtmodul',

    'vital.vin': 'Fahrgestellnummer',
    'vital.km': 'Kilometerstand',
    'service.raw': 'Servicezähler (Bedeutung noch nicht bestätigt)',
    'vital.rpm': 'Drehzahl',
    'vital.rpm.value': '{n} /min',
    'vital.modules': 'Steuergeräte',

    'btn.connect': 'Kabel verbinden',
    'btn.connected': 'Kabel verbunden',
    'btn.scan': 'Alle auslesen',
    'btn.again': 'Nur dieses erneut auslesen',
    'btn.stop': 'Stopp',
    'btn.close': 'Schließen',
    'btn.clear': 'Fehler löschen',
    'btn.clearing': 'Wird gelöscht…',
    'btn.unlock': 'Freischalten und auslesen',
    'btn.live': 'Lenkwinkel live',
    'btn.hunt': 'Nach unbekannten Steuergeräten suchen',
    'btn.share': 'Protokoll teilen',
    'btn.copy': 'Kopieren',
    'foot.warn': 'Die Nutzung erfolgt auf eigene Gefahr, ohne jede Gewährleistung. Diese Anwendung spricht mit den Steuergeräten eines Fahrzeugs und kann deren Fehlerspeicher löschen — ein gelöschter Fehlerspeicher vernichtet Hinweise, die eine Werkstatt noch braucht. Nur an einem Fahrzeug verwenden, für das Sie verantwortlich sind.',
    'foot.source': 'Quellcode auf GitHub',
    'foot.licence': 'MIT-Lizenz',
    'foot.issue': 'Problem melden',
    'foot.vendor': 'Ein unabhängiges Projekt. Keine Verbindung zu BMW oder PA-Soft, und es enthält keinen Teil der Hersteller-Software. Die Fehlerbeschreibungen stammen vom Hersteller und fallen nicht unter die obige Lizenz.',
    'consent.title': 'Bevor das Ihr Fahrzeug verlässt',
    'consent.sub': 'Ein öffentlicher GitHub-Eintrag',
    'consent.lead': 'GitHub-Einträge sind öffentlich und bleiben es. Suchmaschinen indexieren sie, und späteres Löschen macht das nicht rückgängig.',
    'consent.what': 'Das geht über Ihr Fahrzeug hinaus:',
    'consent.item.modules': 'Die unbekannten Steuergeräte: Adresse, Protokoll, Teilenummer, Hardwarestand und Identifikationsbytes ({n} Stück)',
    'consent.item.modules.one': 'Das unbekannte Steuergerät: Adresse, Protokoll, Teilenummer, Hardwarestand und Identifikationsbytes',
    'consent.item.vin': 'Die Fahrgestellnummer',
    'consent.item.km': 'Der Kilometerstand ({km} km)',
    'consent.item.faults': 'Alle {n} ausgelesenen Fehlercodes',
    'consent.item.faults.one': 'Der ausgelesene Fehlercode',
    'consent.item.trace': 'Die vollständigen Rohdaten dieser Auslesung',
    'consent.novin': 'Fahrgestellnummer weglassen',
    'consent.vinnote': 'Die Fahrgestellnummer identifiziert Ihr Fahrzeug in Zulassungs- und Historiendatenbanken. Für eine Steuergerät-Meldung wird sie nicht benötigt. Weggelassen verschwindet sie auch aus den Rohdaten, nicht nur aus dem Text.',
    'consent.removed': '[Fahrgestellnummer entfernt]',
    'consent.ok': 'Senden',
    'consent.cancel': 'Abbrechen',
    'status.copied.redacted': 'Kopiert, ohne Fahrgestellnummer',
    'btn.doc': 'Bericht herunterladen',
    'rep.sub': 'Aus dem Fahrzeug gelesene Fehlerspeicher-Inhalte. Die Rohdaten stehen im vollständigen Protokoll.',
    'rep.protocols': 'Protokoll',
    'rep.date': 'gelesen am',
    'rep.faults': '{n} gespeicherte Fehler',
    'rep.faults.one': '{n} gespeicherter Fehler',
    'rep.nofaults': 'Keine gespeicherten Fehler',
    'rep.undescribed': 'keine Beschreibung zu diesem Code',
    'rep.other': 'Die übrigen Steuergeräte',
    'rep.clean': 'keine Fehler',
    'rep.unread': 'Fehlerspeicher antwortete nicht',
    'rep.locked': 'Fehlerspeicher gesperrt',
    'rep.footer': 'Erstellt mit der BMW Scanner 1.4 WebUSB-App. Die Fehlerbeschreibungen stammen aus den Tabellen der Hersteller-Software; fehlt eine, wird das ausdrücklich vermerkt — eine plausible Vermutung ist schlechter als nichts.',
    'btn.report': 'Melden (GitHub)',

    'status.idle': 'Nicht verbunden.',
    'status.ready': 'Bereit zum Auslesen.',
    'status.reading': 'Wird ausgelesen…',
    'status.readingone': '{name} wird ausgelesen…',
    'status.readone': '{name} ausgelesen.',
    'status.stopped': 'Angehalten.',
    'status.stopping': 'Stopp nach diesem Steuergerät…',
    'status.nodevice': 'Kein Gerät ausgewählt.',
    'status.failed': 'Fehlgeschlagen: {msg}',
    'status.aborted': 'Abgebrochen: {msg}',
    'status.summary': '{found} Steuergeräte haben geantwortet, {faulty} mit Fehlern.',
    'status.summary.unreadable': '  {n} Fehlerspeicher nicht lesbar.',
    'status.replay': 'Aufgezeichnete Sitzung.',
    'status.saved': 'Heruntergeladen.',
    'status.copied': 'In die Zwischenablage kopiert.',
    'status.noclipboard': 'Zwischenablage nicht verfügbar — bitte Teilen verwenden.',

    'tile.busy': 'wird ausgelesen…',
    'tile.clean': 'keine Fehler',
    'tile.unreadable': 'nicht lesbar',
    'tile.shadowlocked': 'Schatten gesperrt',
    'tile.faults': '{n} Fehler',
    'tile.faults.one': '1 Fehler',
    'tile.shadowfaults': '{n} Schattenfehler',
    'tile.shadowfaults.one': '1 Schattenfehler',
    'tile.both': '{n} + {m} Fehler',
    'tile.hunt.name': 'Fehlt eines?',
    'tile.hunt.label': 'Nach weiteren Steuergeräten suchen',
    'tile.hunt.state': '{n} weitere Adressen',

    'reason.nolink': 'keine Verbindung',
    'reason.silent': 'keine Antwort',
    'reason.notrecorded': 'nicht aufgezeichnet',

    'store.live': 'Fehlerspeicher',
    'store.shadow': 'Schattenspeicher',
    'store.empty': 'keine gespeicherten Fehler',
    'store.locked': 'gesperrt',
    'store.livemissing': 'keine Antwort, Inhalt unbekannt',
    'store.shadowmissing': 'kein solcher Speicher',
    'store.unreadable': '{n} Fehler, die Einträge waren aber nicht lesbar.',

    'clear.refused': 'Fehlgeschlagen: {reason}.',
    'clear.readback': 'Gelöscht. Wird erneut ausgelesen…',
    'clear.empty': 'Gelöscht, der Speicher ist leer.',
    'clear.live': 'Das Steuergerät hat das Löschen angenommen, aber {n} Fehler kamen sofort '
      + 'zurück — das sind aktive Fehler, keine bloß gespeicherten Einträge.',
    'clear.live.one': 'Das Steuergerät hat das Löschen angenommen, aber der Fehler kam sofort '
      + 'zurück — er liegt aktiv an, es ist kein bloß gespeicherter Eintrag.',
    'clear.blind': 'Das Steuergerät hat das Löschen angenommen, doch beim erneuten Auslesen kam '
      + 'keine Antwort — was noch darin steht, sagt dieser Durchlauf nicht. Bitte erneut auslesen.',
    'clear.conditions': 'das Steuergerät hat abgelehnt — Bedingungen nicht erfüllt '
      + '(Zündung in Stellung 2, Motor aus)',
    'clear.rejected': 'das Steuergerät hat abgelehnt (0x{code})',
    'clear.garbled': 'unverständliche Antwort',

    'unlock.why1': 'Das Steuergerät gibt seinen Schattenspeicher erst nach einer Freischaltung '
      + 'heraus. Die Herstellersoftware sendet dafür zwei Befehle: <code>90 FF FF</code>, dann '
      + '<code>95</code> mit <b>den eigenen Identifikationsbytes des Steuergeräts</b> — keine '
      + 'neuen Daten.',
    'unlock.why2': 'Das sieht nach einer Freischaltung aus und nicht nach einem Schreibvorgang: '
      + 'die Antwort ist eine leere Quittung, und die Identifikation bleibt danach unverändert. '
      + '<b>Bewiesen ist es nicht</b>, deshalb sendet diese App es nie von selbst.',
    'unlock.running': 'Wird freigeschaltet…',
    'unlock.short': 'die Identifikation ist zu kurz für die Freischaltung',
    'unlock.norefused': 'das Steuergerät hat die Freischaltung nicht angenommen',
    'unlock.stilllocked': 'auch nach der Freischaltung gesperrt',

    'live.title': 'Lenkwinkel live',
    'live.intro': 'Der Winkel ist <b>relativ</b>, nicht in Grad. Das Byte läuft schon innerhalb '
      + 'einer Bewegung über, die weit vor dem vollen Einschlag endet, und die Antwort enthält '
      + 'keinen Umdrehungszähler — gezeigt werden also Bewegung, Richtung und der Punkt, zu dem '
      + 'das Lenkrad zurückkehrt, nicht der tatsächliche Winkel. Mit Stopp beenden.',
    'live.steady': 'beide Kanäle stimmen überein',
    'live.moving': 'in Bewegung — die Kanäle weichen ab',
    'live.range': 'Bereich {min} … {max}',
    'live.samples': '{n} Messwerte',
    'live.lost': 'das Steuergerät antwortet nicht mehr, nach {n} Messwerten',

    'hunt.title': 'Unbekannte Steuergeräte',
    'hunt.intro': 'Die Kacheln oben sind die Steuergeräte, die diese Software kennt und die '
      + 'dieses Fahrzeug hat. Ein anderer BMW kann zusätzlich ein Getriebe-, Navigations- oder '
      + 'Telefonsteuergerät haben, das die App noch nicht kennt. Hier werden die übrigen '
      + 'Adressen abgefragt, die auch die Herstellersoftware prüft, auf beiden Protokollen.',
    'hunt.intro2': 'Wird eines gefunden, lässt es sich per Knopfdruck melden: die '
      + 'Identifikationsbytes sind genau das, was zum Aufnehmen fehlt. Es dauert, weil jede '
      + 'Adresse eine eigene Verbindung braucht.',
    'hunt.curiosity': 'keine BMW-Adresse',
    'hunt.progress': '0x{addr} — {done}/{total}',
    'hunt.progress.found': '0x{addr} — {done}/{total}, bisher {n} gefunden',
    'hunt.done': '{total} Adressen geprüft, {n} unbekannte Steuergeräte.',
    'hunt.none': 'Kein Steuergerät, das die App nicht schon kennt — dieses Fahrzeug antwortet '
      + 'nur auf den Adressen oben.',

    'raw.summary': 'Rohdaten',
    'note.evidence': 'Zu jedem Fehler stehen die Rohbytes auf dem Bildschirm. Das Auslesen ist '
      + 'gegen die Ausgabe der Herstellersoftware geprüft, an einem E46 316i von 2002 — die '
      + '<b>Beschreibungen</b> gibt es jedoch nur für die Codes, die dieses Fahrzeug '
      + 'tatsächlich erzeugt hat, und <b>nur auf Englisch</b>: die Herstellersoftware führt sie '
      + 'für diese Steuergeräte nicht auf Deutsch. Zu einem unbekannten Code gibt es keine '
      + 'Beschreibung — lieber gar nichts als eine plausibel klingende Vermutung.',
    'note.clear': 'Das Löschen leert nur die <i>gespeicherte</i> Liste. Liegt ein Fehler gerade '
      + 'an, nimmt das Steuergerät das Löschen an und meldet beim nächsten Auslesen denselben '
      + 'Code — deshalb liest diese App immer erneut aus und sagt, was zurückgekommen ist.',
    'note.unsupported': 'Dieser Browser kann nicht auf USB-Geräte zugreifen. Unter Android oder '
      + 'am Rechner werden <b>Chrome</b> oder <b>Edge</b> benötigt. Safari unterstützt WebUSB '
      + 'nicht, und Apple erlaubt den Zugriff auch nativen Apps nicht — auf einem iPhone ist '
      + 'dieses Kabel daher auf keinem Weg nutzbar.',
    'note.ignition': 'Die K-Leitung liegt nur zu {pct}% auf High, die Steuergeräte schlafen also. '
      + 'Zündung in Stellung 2 bringen oder den Motor starten, sonst antwortet nichts.',
    'note.demo': '<b>Demo-Modus.</b> Dies sind aufgezeichnete Antworten einer Sitzung vom '
      + '05.11.2026, durch dieselben Dekoder geschickt — <b>es ist kein Kabel angeschlossen und '
      + 'dies ist kein Live-Auslesen.</b> <a href="./">Zurück zum Live-Modus</a>.',

    'log.title': 'BMW-Diagnose',
    'log.present': 'vorhanden',
    'log.live': 'Fehlerspeicher',
    'log.shadow': 'Schattenspeicher',
    'log.nostore': 'kein solcher Speicher',
    'log.unanswered': 'KEINE ANTWORT',
    'log.locked': 'GESPERRT',
    'log.raw': '--- Rohdaten ---',
    'log.km': 'Kilometerstand',
  },
};

export const LANGUAGES = [['hu', 'Magyar'], ['en', 'English'], ['de', 'Deutsch']];

/** Hungarian for Hungarian speakers, English for everyone else, and whatever was chosen after that. */
function initial() {
  const saved = localStorage.getItem('lang');
  if (saved && STRINGS[saved]) return saved;
  const want = (navigator.language || '').toLowerCase().slice(0, 2);
  return STRINGS[want] ? want : 'en';
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
