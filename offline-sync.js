// ============================================================
// offline-sync.js — CP Engineer Pro
// Gestionnaire Offline-First, File d'attente & Background Sync
// ============================================================

(function (window) {
  'use strict';

  const DB_NAME = 'cp_engineer_offline_db';
  const DB_VERSION = 1;
  const STORE_QUEUE = 'pending_calculations';

  let dbPromise = null;

  // 1. Initialisation IndexedDB pour la file d'attente hors-ligne
  function getDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_QUEUE)) {
            const store = db.createObjectStore(STORE_QUEUE, { keyPath: 'id' });
            store.createIndex('by_status', 'status', { unique: false });
            store.createIndex('by_timestamp', 'timestamp', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  // 2. Gestion de la file d'attente
  const OfflineQueue = {
    async enqueue(endpoint, payload, localEstimate) {
      const db = await getDb();
      const item = {
        id: 'calc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9),
        endpoint: endpoint,
        payload: payload,
        localEstimate: localEstimate,
        status: 'PENDING',
        timestamp: Date.now(),
        retryCount: 0,
      };

      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_QUEUE, 'readwrite');
        tx.objectStore(STORE_QUEUE).add(item);
        tx.oncomplete = () => {
          updateConnectivityBadge();
          // Demande de Background Sync si supporté par le navigateur
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            navigator.serviceWorker.ready.then((reg) => {
              reg.sync.register('sync-cp-calculations').catch(() => {});
            });
          }
          resolve(item);
        };
        tx.onerror = () => reject(tx.error);
      });
    },

    async getPending() {
      const db = await getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_QUEUE, 'readonly');
        const store = tx.objectStore(STORE_QUEUE);
        const index = store.index('by_status');
        const req = index.getAll('PENDING');
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },

    async markSynced(id, serverResult) {
      const db = await getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_QUEUE, 'readwrite');
        const store = tx.objectStore(STORE_QUEUE);
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const item = getReq.result;
          if (item) {
            item.status = 'SYNCED';
            item.serverResult = serverResult;
            item.syncedAt = Date.now();
            store.put(item);
          }
        };
        tx.oncomplete = () => {
          updateConnectivityBadge();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  // 3. Fallback de calcul local pour le terrain (marqué NON CERTIFIÉ)
  function fallbackCalculateLocal(type, inputs) {
    console.warn('[Offline Engine] Exécution en mode local dégradé (non certifié).');
    
    if (type === 'required-current' || type === 'cp') {
      const surface = inputs.surfaceAreaM2 || 100;
      const density = (inputs.currentDensityMaM2 || 5) / 1000;
      const f_c = Math.min(1.0, (inputs.coatingBreakdownInitial || 0.05) + (inputs.coatingBreakdownFinal || 0.1) * (inputs.agingFactor || 1.2));
      const exposedArea = surface * f_c;
      const current = exposedArea * density;
      return {
        exposedArea,
        currentAmperes: current,
        f_c,
        isCertified: false,
        warning: 'CALCUL NON CERTIFIÉ - MODE TERRAIN HORS-LIGNE',
      };
    }

    if (type === 'sacp') {
      const current = inputs.currentRequiredA || 1.0;
      const life = inputs.designLifeYears || 25;
      const totalMass = (current * life * 8760 * 1.2) / (1100 * 0.85);
      return {
        totalMassRequiredKg: totalMass,
        anodeCountRequired: Math.ceil(totalMass / (inputs.anodeUnitMassKg || 20)),
        actualLifeYears: life,
        isCertified: false,
        warning: 'CALCUL NON CERTIFIÉ - EN ATTENTE DE SYNCHRONISATION SERVEUR',
      };
    }

    return {
      isCertified: false,
      warning: 'Calcul différé au retour en ligne.',
    };
  }

  // 4. Moteur de synchronisation au retour réseau
  let isSyncing = false;
  async function replayOfflineQueue() {
    if (isSyncing || !navigator.onLine) return;
    isSyncing = true;

    try {
      const pending = await OfflineQueue.getPending();
      if (pending.length === 0) {
        isSyncing = false;
        return;
      }

      console.log(`[Offline Sync] Synchronisation de ${pending.length} calculs vers l'API...`);

      for (const item of pending) {
        try {
          const res = await fetch(item.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item.payload),
          });

          if (res.ok) {
            const serverResult = await res.json();
            await OfflineQueue.markSynced(item.id, serverResult);
            console.log(`[Offline Sync] Calcul ${item.id} certifié par le serveur avec succès.`);
          }
        } catch (err) {
          console.warn(`[Offline Sync] Échec temporaire pour ${item.id}:`, err);
        }
      }
    } finally {
      isSyncing = false;
      updateConnectivityBadge();
    }
  }

  // 5. Badge visuel de connectivité
  function updateConnectivityBadge() {
    let badge = document.getElementById('connectivityStatusBadge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'connectivityStatusBadge';
      badge.style.cssText = [
        'position: fixed',
        'bottom: 12px',
        'right: 12px',
        'padding: 6px 14px',
        'border-radius: 20px',
        'font-size: 12px',
        'font-weight: bold',
        'z-index: 999999',
        'box-shadow: 0 4px 12px rgba(0,0,0,0.3)',
        'transition: all 0.3s ease',
        'display: flex',
        'align-items: center',
        'gap: 8px',
      ].join(';');
      document.body.appendChild(badge);
    }

    OfflineQueue.getPending().then((pending) => {
      const count = pending.length;
      if (navigator.onLine) {
        if (count > 0) {
          badge.style.background = '#f59e0b';
          badge.style.color = '#000';
          badge.innerHTML = `<span>🔄</span> Synchronisation en cours (${count} en attente)...`;
        } else {
          badge.style.background = '#10b981';
          badge.style.color = '#fff';
          badge.innerHTML = `<span>🟢</span> Connecté — Calculs Certifiés API`;
        }
      } else {
        badge.style.background = '#ef4444';
        badge.style.color = '#fff';
        badge.innerHTML = `<span>📡</span> Hors-ligne (Terrain) — ${count} calcul(s) empilé(s)`;
      }
    });
  }

  // 6. Enregistrement du Service Worker et écouteurs de statut réseau
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        console.log('[PWA] Service Worker actif, scope:', reg.scope);
      }).catch((err) => {
        console.warn('[PWA] Enregistrement Service Worker échoué:', err);
      });
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'TRIGGER_BACKGROUND_SYNC') {
        replayOfflineQueue();
      }
    });
  }

  window.addEventListener('online', () => {
    console.log('[Réseau] Connexion rétablie : déclenchement du replay...');
    updateConnectivityBadge();
    replayOfflineQueue();
  });

  window.addEventListener('offline', () => {
    console.warn('[Réseau] Connexion perdue : passage en mode terrain...');
    updateConnectivityBadge();
  });

  // Exposition globale pour l'UI et les contrôleurs
  window.OfflineSync = {
    enqueue: OfflineQueue.enqueue,
    getPending: OfflineQueue.getPending,
    fallbackCalculateLocal: fallbackCalculateLocal,
    replay: replayOfflineQueue,
    updateBadge: updateConnectivityBadge,
  };

  // Initialisation badge au chargement
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateConnectivityBadge);
  } else {
    updateConnectivityBadge();
  }

})(window);
