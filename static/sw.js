// Kafilah service worker — offline app shell + installability.
// API calls (/api/*) are never cached; they always hit the network.

const CACHE = 'kafilah-v16';
const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/manifest.webmanifest',
  '/vendor/maplibre-gl.js',
  '/vendor/maplibre-gl.css',
  '/vendor/gsap.min.js',
  '/vendor/Draggable.min.js',
  '/icons/logo.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Never intercept the API or cross-origin map tiles.
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;

  // Big, stable assets (map lib, gsap, icons): cache-first for speed.
  if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
        if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      }))
    );
    return;
  }

  // App shell (html/js/css/manifest): network-first so updates apply on next load;
  // fall back to cache only when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
