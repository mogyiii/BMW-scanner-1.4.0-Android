/*
 * Keeps the app usable at the car, where there is no network.
 *
 * WebUSB needs a secure context, so this is served from GitHub Pages rather than opened as a file -
 * which would mean needing a signal in a car park. Caching the handful of files on first load fixes
 * that: afterwards it starts with no network at all.
 */
const CACHE = 'bmw-ds2-v2';
const FILES = [
  './', './index.html', './manifest.webmanifest',
  './js/app.js', './js/ftdi.js', './js/protocol.js', './js/session.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Network first so a fix reaches the car; cache when there is nothing to reach. */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
