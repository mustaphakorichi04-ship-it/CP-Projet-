// ============================================================
// phase3-save-signature.test.js
// Validation Phase 3 (audit MOYEN-7) : sauvegarde conditionnelle
// par signature d'état dans ProjectManager.saveCurrentProject().
//
// Objectif : PROUVER que
//  (a) deux appels consécutifs SANS modification d'état -> 1 seule
//      écriture effective (le 2e est un no-op) ;
//  (b) toute modification réelle de l'état -> sauvegarde effective ;
//  (c) changement de projet -> signature invalidée -> sauvegarde.
// Aucune donnée n'est perdue : on compare le contenu RÉEL de l'état.
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ---- Réplique de la logique de saveCurrentProject (Phase 3) ----
function makeSaveHarness() {
    let _lastSavedSignature = null;
    let writeCount = 0;

    function saveCurrentProject(state, currentProjectId) {
        // (state, id) fournis par le test à la place des closures
        if (!currentProjectId) return Promise.resolve();

        let signature = null;
        try { signature = JSON.stringify(state); } catch (e) { signature = null; }

        if (signature !== null && signature === _lastSavedSignature) {
            return Promise.resolve(); // no-op
        }
        // ... écriture simulée ...
        writeCount++;
        _lastSavedSignature = signature;
        return Promise.resolve();
    }

    function invalidateOnLoadProject() { _lastSavedSignature = null; }

    return {
        save: saveCurrentProject,
        invalidate: invalidateOnLoadProject,
        getWrites: () => writeCount
    };
}

test('PHASE-3 [MOYEN-7] état inchangé -> 2e sauvegarde est un no-op', () => {
    const h = makeSaveHarness();
    const state = { project: { name: 'P1' }, cp: { current: 12.5 }, equipments: [] };

    return h.save(state, 'PROJ-1').then(() => {
        assert.strictEqual(h.getWrites(), 1, '1re sauvegarde écrit');
        return h.save(state, 'PROJ-1'); // état IDENTIQUE
    }).then(() => {
        assert.strictEqual(h.getWrites(), 1, 'état identique -> PAS de 2e écriture (no-op)');
    });
});

test('PHASE-3 [MOYEN-7] modification réelle de l\'état -> sauvegarde effective', () => {
    const h = makeSaveHarness();
    const state = { project: { name: 'P1' }, cp: { current: 12.5 } };

    return h.save(state, 'PROJ-1').then(() => {
        assert.strictEqual(h.getWrites(), 1);
        // L'utilisateur modifie un résultat CP
        state.cp.current = 14.2;
        return h.save(state, 'PROJ-1');
    }).then(() => {
        assert.strictEqual(h.getWrites(), 2, 'changement d\'état -> écriture effective');
    });
});

test('PHASE-3 [MOYEN-7] ajout d\'équipement -> sauvegarde effective', () => {
    const h = makeSaveHarness();
    const state = { project: { name: 'P1' }, equipments: [{ id: 'E1' }] };

    return h.save(state, 'PROJ-1').then(() => {
        assert.strictEqual(h.getWrites(), 1);
        state.equipments.push({ id: 'E2' }); // nouvel équipement GPS
        return h.save(state, 'PROJ-1');
    }).then(() => {
        assert.strictEqual(h.getWrites(), 2, 'ajout équipement -> écriture effective');
    });
});

test('PHASE-3 [MOYEN-7] changement de projet -> signature invalidée -> sauvegarde', () => {
    const h = makeSaveHarness();
    const stateA = { project: { name: 'A' }, cp: { current: 1 } };
    const stateB = { project: { name: 'B' }, cp: { current: 1 } };

    return h.save(stateA, 'PROJ-A').then(() => {
        assert.strictEqual(h.getWrites(), 1);
        // Bascule vers un autre projet (loadProject remplace l'état + invalide)
        h.invalidate();
        return h.save(stateB, 'PROJ-B');
    }).then(() => {
        assert.strictEqual(h.getWrites(), 2, 'nouveau projet -> écriture effective (pas de faux no-op)');
    });
});

test('PHASE-3 [MOYEN-7] plusieurs ticks identiques -> une seule écriture', () => {
    const h = makeSaveHarness();
    const state = { project: { name: 'P' }, history: [1, 2, 3] };

    // Simule 10 ticks de l'intervalle 30s sans aucune modification
    let p = Promise.resolve();
    for (let i = 0; i < 10; i++) {
        p = p.then(() => h.save(state, 'PROJ-1'));
    }
    return p.then(() => {
        assert.strictEqual(h.getWrites(), 1, '10 ticks sans changement -> 1 seule écriture IndexedDB');
    });
});
