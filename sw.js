// Offline copy of the app itself (not the map tiles or your data, which live in IndexedDB).
const VERSION = '122904d7f1';
const FILES = ["./", "./app.css", "./icons/apple-touch-icon.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable.png", "./index.html", "./js/ai.js", "./js/config.js", "./js/db.js", "./js/edits.js", "./js/food.js", "./js/img.js", "./js/importer.js", "./js/logic.js", "./js/main.js", "./js/nails.js", "./js/net.js", "./js/places.js", "./js/pre.js", "./js/ui.js", "./manifest.webmanifest", "./vendor/anthropic.mjs", "./vendor/images/layers-2x.png", "./vendor/images/layers.png", "./vendor/images/marker-icon-2x.png", "./vendor/images/marker-icon.png", "./vendor/images/marker-shadow.png", "./vendor/leaflet.css", "./vendor/leaflet.js"];
const CACHE = `zhongcao-${VERSION}`;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never stores an old file.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('zhongcao-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  // Only the app's own page gets the cached index.html (with or without ?share=…); other files by exact match.
  if (req.mode === 'navigate') {
    if (url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`) {
      e.respondWith(caches.match('./index.html', { ignoreSearch: true }).then((r) => r || fetch(req)));
    }
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});
