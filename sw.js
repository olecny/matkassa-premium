// Matkassa service worker: precache the app shell, cache offer images.
// Offer data itself is stored by the app in IndexedDB, so offers work offline too.
// Cache names are per app: Matkassa Premium lives on the same GitHub Pages origin and its caches must survive
// this worker's cleanup, so only delete caches with this app's own prefix.
const PREFIX = 'matkassa-v';
const VERSION = PREFIX + '7';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/tjek.js',
  'js/categories.js',
  'js/spending.js',
  'js/profile.js',
  'js/extra-offers.js',
  'js/settings.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
const IMG_CACHE = 'matkassa-img';
const IMG_MAX = 400;
const NET_TIMEOUT_MS = 3000;
const SLOW_WINDOW_MS = 30000; // after a slow/failed shell request, serve the shell from cache for this long
let slowUntil = 0;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell: network first so updates show up at once; cache when offline or when the network is too slow
  // (weak signal in the shop), so the app never hangs on a white screen. Once one request has been slow or failed,
  // the rest of that page load (css, js, module imports) comes straight from the cache instead of waiting 3 s each.
  if (url.origin === self.location.origin) {
    const degraded = Date.now() < slowUntil;
    let stored = Promise.resolve();
    const net = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) {
        const copy = res.clone(); // clone before the page starts reading the body
        stored = caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    });
    net.catch(() => { slowUntil = Date.now() + SLOW_WINDOW_MS; });
    e.waitUntil(net.then(() => stored).catch(() => null)); // keep the worker alive until the cache is refreshed
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const cached = (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await c.match('index.html') : undefined);
        if (!cached) return net.catch(() => Response.error());
        if (degraded) return cached; // still refreshed in the background via waitUntil above
        const started = Date.now();
        const slow = new Promise((resolve) => setTimeout(() => { slowUntil = Date.now() + SLOW_WINDOW_MS; resolve(cached); }, NET_TIMEOUT_MS));
        const fresh = net.then((res) => { if (Date.now() - started < NET_TIMEOUT_MS) slowUntil = 0; return res; }, () => cached);
        return Promise.race([fresh, slow]);
      }),
    );
    return;
  }

  // Offer images: cache-first.
  if (url.hostname === 'image-transformer-api.tjek.com') {
    e.respondWith(
      caches.open(IMG_CACHE).then(async (c) => {
        const cached = await c.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); e.waitUntil(trim(IMG_CACHE, IMG_MAX)); }
          return res;
        } catch (err) {
          return Response.error();
        }
      }),
    );
  }
  // Tjek API: network only (the app keeps its own copy in IndexedDB).
});
