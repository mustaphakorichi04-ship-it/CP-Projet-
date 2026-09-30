// ============================================================
// sw.js — CP Engineer Pro PWA Service Worker
// Cache Offline-First & Background Sync (NACE Engineering)
// v9.8 — Network-First pour HTML (dashboard toujours à jour)
// ============================================================

const CACHE_VERSION = 'cp-engineer-v9.8-cache';

// Assets statiques JS/CSS mis en cache (pas les pages HTML !)
const STATIC_ASSETS = [
  './style.css',
  './engine.js',
  './ui.js',
  './app.js',
  './controller.js',
  './cp-controller.js',
  './storage.js',
  './storage-proxy.js',
  './router.js',
  './manifest.json',
  './acCorrosionEngine.js',
  './cableLengthEngine.js',
  './ICCPOptimizationEngine.js'
];

// Pages HTML toujours servies depuis le réseau (Network-First)
const HTML_PAGES = ['/', '/dashboard', '/studio', '/pricing', '/status', '/login', '/auth', '/app', '/workspace'];

// 1. Installation
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      console.log('[SW v9.8] Mise en cache des assets statiques JS/CSS...');
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
          console.log('[SW v9.8] Suppression ancien cache:', key);
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
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
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

// 4. Background Sync : rejouer les calculs au rétablissement du réseau
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-cp-calculations') {
    console.log('[SW] Événement Background Sync reçu: déclenchement de la synchronisation...');
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'TRIGGER_BACKGROUND_SYNC' });
        });
      })
    );
  }
});
