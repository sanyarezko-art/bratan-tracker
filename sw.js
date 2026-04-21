// БРАТАН-трекер — static-shell Service Worker.
//
// Scope: caches the static assets (HTML/CSS/JS, the pinned WebTorrent bundle,
// the QR generator) so repeat opens are instant and the page still boots when
// the network is flaky. Does NOT touch WebRTC traffic or tracker signalling —
// those run through WebSocket/RTCPeerConnection which the SW cannot observe.

const VERSION = 'bratan-shell-v2';

// Paths are resolved against the SW's scope (which is the page's base URL,
// so the code works identically on GitHub Pages at /bratan-tracker/ and on
// http://localhost:8000/ during dev).
const STATIC_PATHS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'catalog.json',
];

const EXTERNAL_PINNED = [
  'https://cdn.jsdelivr.net/npm/webtorrent@2.5.1/dist/webtorrent.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const local = STATIC_PATHS.map((p) => new URL(p, self.registration.scope).toString());
    // Don't fail the whole install if one URL is missing (e.g. manifest.json
    // is optional). addAll() is atomic, so we add individually.
    await Promise.all(
      [...local, ...EXTERNAL_PINNED].map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => null),
      ),
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept WebSocket / WebRTC / tracker handshakes.
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  const sameOrigin = url.origin === self.location.origin;
  const isPinnedCDN = EXTERNAL_PINNED.some((u) => u === req.url);

  // For the page shell and pinned CDN: cache-first, revalidate in the
  // background. This is what makes the repeat open instant.
  if (sameOrigin || isPinnedCDN) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('offline', { status: 503 });
    })());
    return;
  }

  // Everything else (catalog hits, signalling, etc.): pass through.
});
