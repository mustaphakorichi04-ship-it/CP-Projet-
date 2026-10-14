// ============================================================
// phase3-shared-geometry.test.js
// Validation Phase 3 (audit MAJEUR-4) : cache de géométries
// partagées (getSharedGeometry) + protection dans clearScene.
//
// Objectif : PROUVER que
//  (a) deux appels avec la même clé retournent LA MÊME instance
//      (mutualisation -> moins de mémoire GPU) ;
//  (b) une géométrie partagée est marquée userData._shared ;
//  (c) clearScene NE dispose PAS une géométrie partagée (sinon les
//      meshes suivants pointeraient vers une géométrie détruite) ;
//  (d) une géométrie NON partagée EST bien disposée (pas de fuite).
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ---- Mock minimal de THREE.BufferGeometry ----
class FakeGeometry {
    constructor(tag) { this.tag = tag; this.disposed = false; this.userData = {}; }
    dispose() { this.disposed = true; }
}

// ---- Réplique de getSharedGeometry + clearScene (Phase 3) ----
function makeHarness() {
    const _geometryCache = new Map();
    function getSharedGeometry(key, factory) {
        if (_geometryCache.has(key)) return _geometryCache.get(key);
        const geo = factory();
        if (geo) {
            geo.userData = geo.userData || {};
            geo.userData._shared = true;
            _geometryCache.set(key, geo);
        }
        return geo;
    }

    // Traverse simplifiée : liste de nodes { geometry }
    function clearScene(nodes) {
        nodes.forEach(node => {
            if (node.geometry) {
                if (!node.geometry.userData || !node.geometry.userData._shared) {
                    node.geometry.dispose();
                }
            }
        });
    }

    return { getSharedGeometry, clearScene, cache: _geometryCache };
}

test('PHASE-3 [MAJEUR-4] même clé -> instance mutualisée (pas de doublon GPU)', () => {
    const h = makeHarness();
    const g1 = h.getSharedGeometry('box_rectifier_1_1_1', () => new FakeGeometry('a'));
    const g2 = h.getSharedGeometry('box_rectifier_1_1_1', () => new FakeGeometry('b'));
    assert.strictEqual(g1, g2, 'deux appels même clé -> même instance');
    assert.strictEqual(h.cache.size, 1, 'une seule entrée de cache');

    // Clé différente -> instance distincte
    const g3 = h.getSharedGeometry('box_rectifier_2_1_1', () => new FakeGeometry('c'));
    assert.notStrictEqual(g1, g3, 'clé différente -> instance distincte');
    assert.strictEqual(h.cache.size, 2);
});

test('PHASE-3 [MAJEUR-4] géométrie partagée marquée _shared', () => {
    const h = makeHarness();
    const g = h.getSharedGeometry('sphere_weld', () => new FakeGeometry('w'));
    assert.strictEqual(g.userData._shared, true, 'géométrie du cache marquée _shared');
});

test('PHASE-3 [MAJEUR-4] clearScene NE dispose PAS la géométrie partagée', () => {
    const h = makeHarness();
    const shared = h.getSharedGeometry('box_rectifier_1_1_1', () => new FakeGeometry('s'));

    // Deux meshes partagent la géométrie
    const mesh1 = { geometry: shared };
    const mesh2 = { geometry: shared };
    h.clearScene([mesh1, mesh2]);

    assert.strictEqual(shared.disposed, false,
        'géométrie partagée survit à clearScene (réutilisable par les meshes suivants)');
});

test('PHASE-3 [MAJEUR-4] géométrie propre (non partagée) EST disposée', () => {
    const h = makeHarness();
    const own = new FakeGeometry('own'); // userData._shared non défini
    const node = { geometry: own };
    h.clearScene([node]);
    assert.strictEqual(own.disposed, true,
        'géométrie non partagée est libérée -> pas de fuite mémoire');
});

test('PHASE-3 [MAJEUR-4] cycle complet : créer -> clearScene -> recréer (pas de dispose)', () => {
    const h = makeHarness();
    // 1er chargement de projet
    const load1 = h.getSharedGeometry('box_rectifier_1_1_1', () => new FakeGeometry('load1'));
    // clearScene (navigation / rechargement)
    h.clearScene([{ geometry: load1 }]);
    assert.strictEqual(load1.disposed, false, 'géométrie partagée pas disposée au 1er clearScene');

    // 2e chargement : on réutilise la MÊME géométrie vivante
    const load2 = h.getSharedGeometry('box_rectifier_1_1_1', () => new FakeGeometry('load2'));
    assert.strictEqual(load1, load2, 'même géométrie réutilisée entre chargements');
    assert.strictEqual(load2.disposed, false, 'géométrie toujours valide pour le rendu');
});
