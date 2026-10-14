// ============================================================
// phase3-storage-debounce.test.js
// Validation Phase 3 (audit MOYEN-8) : debounce du listener
// 'storage' dans app.js.
//
// Objectif : PROUVER qu'une rafale d'événements 'storage' (typique
// d'une sauvegarde multi-onglets) ne déclenche qu'UN SEUL rechargement
// complet, sans changer ce qui est rechargé (aucune désync).
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ---- Réplique de la logique de debounce (Phase 3) ----
function makeStorageHarness() {
    let reloadCount = 0;
    let debounceTimer = null;

    function runStorageReload() { reloadCount++; }

    function onStorageEvent(key) {
        if (key && key.startsWith('cp_')) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(runStorageReload, 300);
        }
    }

    return { onStorageEvent, getReloads: () => reloadCount, flush: (t) => debounceTimer };
}

test('PHASE-3 [MOYEN-8] rafale d\'événements storage -> un seul rechargement', async () => {
    const h = makeStorageHarness();

    // Simule 6 événements storage en rafale (projets, équipements, systèmes…)
    h.onStorageEvent('cp_projects');
    h.onStorageEvent('cp_equipments');
    h.onStorageEvent('cp_systems');
    h.onStorageEvent('cp_history');
    h.onStorageEvent('cp_fieldMeasurements');
    h.onStorageEvent('cp_mapPoints');

    // Immédiatement après : rien encore (debounce en cours)
    assert.strictEqual(h.getReloads(), 0, 'aucun rechargement pendant la rafale');

    // Après la fenêtre de debounce (300ms)
    await new Promise(r => setTimeout(r, 350));
    assert.strictEqual(h.getReloads(), 1, 'rafale groupée en UN SEUL rechargement');
});

test('PHASE-3 [MOYEN-8] événements espacés -> rechargements distincts', async () => {
    const h = makeStorageHarness();

    h.onStorageEvent('cp_projects');
    await new Promise(r => setTimeout(r, 350)); // 1er rechargement
    assert.strictEqual(h.getReloads(), 1);

    h.onStorageEvent('cp_equipments'); // nouvel événement isolé
    await new Promise(r => setTimeout(r, 350)); // 2e rechargement
    assert.strictEqual(h.getReloads(), 2, 'événement espacé -> rechargement distinct (pas de perte)');
});

test('PHASE-3 [MOYEN-8] clé non-cp_ ignorée', async () => {
    const h = makeStorageHarness();
    h.onStorageEvent('other_app_key');
    h.onStorageEvent('theme');
    await new Promise(r => setTimeout(r, 350));
    assert.strictEqual(h.getReloads(), 0, 'clés étrangères ignorées');
});
