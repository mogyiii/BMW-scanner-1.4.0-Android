/*
 * Keeps the app usable at the car, where there is no network.
 *
 * WebUSB needs a secure context, so this is served from GitHub Pages rather than opened as a file -
 * which would mean needing a signal in a car park. Caching the handful of files on first load fixes
 * that: afterwards it starts with no network at all.
 */
const CACHE = 'bmw-ds2-v12';
// `demo.js` is deliberately not precached: it is only ever loaded by `?demo=1`, and the car park
// case this cache exists for does not involve a replay.
const FILES = [
  './', './index.html', './manifest.webmanifest',
  './js/app.js', './js/ftdi.js', './js/protocol.js', './js/session.js', './js/i18n.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/*
 * Network first so a fix reaches the car; cache when there is nothing to reach.
 *
 * `cache: 'no-cache'` forces that network request to revalidate with the server instead of being
 * satisfied from the browser's own HTTP cache. Without it "network first" is only first in name:
 * GitHub Pages serves its assets with ten minutes of freshness, so a fix pushed before a trip could
 * still be ten minutes of stale JavaScript when it arrives at the car. Revalidation costs a 304
 * when nothing has changed, and the offline path below is unaffected.
 */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
