// ============================================================
// sw.js — CP Engineer Pro PWA Service Worker
// Cache Offline-First & Background Sync (NACE Engineering)
// v9.10 — Network-First pour HTML et invalidation des anciens assets
// ============================================================

const CACHE_VERSION = 'cp-engineer-v9.24-cache';






// Assets statiques JS/CSS mis en cache (pas les pages HTML !)
const STATIC_ASSETS = [
  './style.css?v=20261010-1',
  './engine.js?v=20261009-3',
  './ui.js?v=20261011-1',
  './app.js?v=20261002-2',
  './controller.js?v=20261011-1',
  './cp-controller.js?v=20261009-3',
  './storage.js?v=20261011-2',
  './storage-proxy.js?v=20261011-2',
  './manifest.json',
  './acCorrosionEngine.js',
  './cableLengthEngine.js',
  './ICCPOptimizationEngine.js?v=20261010-1',
  './AnodesOptimizationEngine.js?v=20261010-1'
];

// Pages HTML toujours servies depuis le réseau (Network-First)
const HTML_PAGES = ['/', '/dashboard', '/studio', '/pricing', '/status', '/login', '/auth', '/app', '/workspace'];

// 1. Installation
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      console.log('[SW v9.10] Mise en cache des assets statiques JS/CSS...');
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Assets non critiques non mis en cache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// 2. Activation — purge tous les anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => {
          console.log('[SW v9.10] Suppression ancien cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch — stratégies distinctes
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const pathname = url.pathname;

  // ── Cross-origin (CDN, Google Fonts, extensions navigateur…) : ──
  // Ne JAMAIS intercepter. Un fetch() exécuté depuis le Service Worker
  // est soumis au connect-src de la page (=> blocage CSP pour
  // fonts.googleapis.com), et cache.put() échoue sur les schémas non
  // supportés (ex. chrome-extension://).
  if (url.origin !== self.location.origin) return;

  // ── API : toujours réseau, jamais de cache ──
  if (pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({
            offline: true,
            error: 'OFFLINE_NETWORK_UNAVAILABLE',
            message: 'Mode hors-ligne: le calcul a été placé dans la file d\'attente locale.',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // ── Pages HTML : Network-First (jamais de stale) ──
  const isHtmlPage = HTML_PAGES.includes(pathname) ||
                     event.request.mode === 'navigate' ||
                     event.request.headers.get('accept')?.includes('text/html');
  if (isHtmlPage) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => {
        return caches.match(event.request);
      })
    );
    return;
  }

  // ── Assets statiques JS/CSS : Stale-While-Revalidate ──
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const clone = networkResponse.clone();
          caches.open(CACHE_VERSION)
            .then((cache) => cache.put(event.request, clone))
            .catch(() => {});
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

// 4. Background Sync
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-cp-calculations') {
    console.log('[SW] Background Sync: synchronisation en cours...');
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'TRIGGER_BACKGROUND_SYNC' });
        });
      })
    );
  }
});

