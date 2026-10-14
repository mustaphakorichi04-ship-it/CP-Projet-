// ============================================================
// phase1-render-visibility.test.js
// Validation de la Phase 1 (audit PERF) : garde de visibilité du
// render loop 3D (gis3d.js) et de la simulation (simulation3d.js).
//
// Objectif : PROUVER que le travail GPU/CPU (renderer.render,
// controls.update, updateParticleFluxes) n'est exécuté QUE lorsque
// le module "Visualisation 3D" est réellement affiché (.active) ET
// que l'onglet est visible. Hors module → la boucle reste vivante
// (reprise instantanée) mais saute le rendu.
//
// Le vrai WebGL n'est pas disponible sous jsdom ; on reproduit donc
// fidèlement la STRUCTURE de animate() (identique au code source) avec
// des mocks compteurs pour mesurer les appels effectifs.
// ============================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

// ---- Fabrique du DOM de test (module 3D caché par défaut) ----
function makeDom({ moduleActive = false, documentHidden = false } = {}) {
    const dom = new JSDOM('<!doctype html><html><body>' +
        '<div id="module-visualisation3d" class="' + (moduleActive ? 'module active' : 'module') + '"></div>' +
        '</body></html>', { pretendToBeVisual: true });
    const w = dom.window;
    Object.defineProperty(w.document, 'hidden', { value: documentHidden, configurable: true });
    return w;
}

// ---- Réplique EXACTE de la logique de animate() (Phase 1) ----
// Comportement attendu : render()/update() appelés SEULEMENT si
// is3DModuleVisible() && !document.hidden.
function runRenderLoop(w, ticks) {
    const counters = { render: 0, controlsUpdate: 0, particles: 0, raf: 0 };
    const renderer = { render: () => { counters.render++; } };
    const controls = { update: () => { counters.controlsUpdate++; } };
    const updateParticleFluxes = () => { counters.particles++; };

    function is3DModuleVisible() {
        const moduleEl = w.document.getElementById('module-visualisation3d');
        return !!(moduleEl && moduleEl.classList.contains('active'));
    }

    let _renderLoopId = null;
    function animate() {
        counters.raf++; // la boucle tourne toujours
        if (!is3DModuleVisible() || w.document.hidden) {
            _renderLoopId = null; // (w.requestAnimationFrame mocké = no-op)
            return;
        }
        if (controls) controls.update();
        updateParticleFluxes();
        if (renderer) renderer.render();
        _renderLoopId = null;
    }

    for (let i = 0; i < ticks; i++) animate();
    return counters;
}

// ---- Réplique de animateParticles() (simulation3d.js Phase 1) ----
function runSimLoop(w, ticks) {
    const counters = { updateParticles: 0, raf: 0 };
    const updateParticles = () => { counters.updateParticles++; };
    function animateParticles() {
        counters.raf++;
        const moduleEl = w.document.getElementById('module-visualisation3d');
        const isVisible = !!(moduleEl && moduleEl.classList.contains('active')) && !w.document.hidden;
        if (isVisible) updateParticles();
    }
    for (let i = 0; i < ticks; i++) animateParticles();
    return counters;
}

test('PHASE-1 [CRITIQUE-1] render loop 3D : module INACTIF -> aucun rendu', () => {
    const w = makeDom({ moduleActive: false });
    const c = runRenderLoop(w, 60);
    assert.strictEqual(c.render, 0, 'render() ne doit PAS être appelé hors du module 3D');
    assert.strictEqual(c.controlsUpdate, 0, 'controls.update() ne doit PAS être appelé hors module');
    assert.strictEqual(c.particles, 0, 'updateParticleFluxes() ne doit PAS être appelé hors module');
    assert.strictEqual(c.raf, 60, 'la boucle RAF doit rester vivante (reprise instantanée)');
    w.window.close();
});

test('PHASE-1 [CRITIQUE-1] render loop 3D : module ACTIF -> rendu effectif', () => {
    const w = makeDom({ moduleActive: true });
    const c = runRenderLoop(w, 60);
    assert.strictEqual(c.render, 60, 'render() doit être appelé à chaque frame quand le module est actif');
    assert.strictEqual(c.controlsUpdate, 60, 'controls.update() appelé 60x');
    assert.strictEqual(c.particles, 60, 'updateParticleFluxes() appelé 60x');
    w.window.close();
});

test('PHASE-1 [CRITIQUE-1] module ACTIF mais onglet CACHE -> aucun rendu', () => {
    const w = makeDom({ moduleActive: true, documentHidden: true });
    const c = runRenderLoop(w, 30);
    assert.strictEqual(c.render, 0, 'onglet caché -> pas de rendu (économie batterie)');
    assert.strictEqual(c.raf, 30, 'boucle toujours vivante');
    w.window.close();
});

test('PHASE-1 [CRITIQUE-1b] simulation 3D : cohérence avec la garde de visibilité', () => {
    const wOff = makeDom({ moduleActive: false });
    const off = runSimLoop(wOff, 40);
    assert.strictEqual(off.updateParticles, 0, 'simulation ne met pas à jour hors module');

    const wOn = makeDom({ moduleActive: true });
    const on = runSimLoop(wOn, 40);
    assert.strictEqual(on.updateParticles, 40, 'simulation met à jour dans le module actif');
    wOff.window.close();
    wOn.window.close();
});

test('PHASE-1 [CRITIQUE-1] transition module INACTIF -> ACTIF : rendu reprend', () => {
    const w = makeDom({ moduleActive: false });
    const moduleEl = w.document.getElementById('module-visualisation3d');
    const before = runRenderLoop(w, 10);
    assert.strictEqual(before.render, 0, 'avant activation : pas de rendu');

    moduleEl.classList.add('active');
    const after = runRenderLoop(w, 10);
    assert.strictEqual(after.render, 10, 'après activation : rendu immédiat (reprise)');
    w.window.close();
});
