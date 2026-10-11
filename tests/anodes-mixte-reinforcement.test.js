'use strict';

// ============================================================
// Tests — Optimisation Mixte : renforcement localisé SACP
// Vérifie que le moteur SACP exploite les zones critiques analysées
// (state.iccp.reinforcementAnalysis) au lieu de redimensionner tout
// le réseau, et que l'application des anodes reste traçable.
// ============================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ENGINE_PATH = path.join(__dirname, '..', 'AnodesOptimizationEngine.js');

function makePipeline(tag, lat0) {
    return {
        id: tag,
        tag: tag,
        projectId: 'PROJ-001',
        type: 'pipeline_enterre',
        included: true,
        coordinates: [
            { lat: lat0, lon: 2.0 },
            { lat: lat0 + 0.01, lon: 2.01 },
            { lat: lat0 + 0.02, lon: 2.02 }
        ],
        dimensions: { diametre_m: 0.3 },
        soilResistivity: 100,
        coatingEfficiency: 0.95,
        currentDensity: 10,
        defectDensity: 0.05,
        agingFactor: 1.2
    };
}

function buildContext(analysis) {
    const saved = [];
    const state = {
        equipments: [
            makePipeline('EMN-11', 33.00),
            makePipeline('EMK-42', 33.10),
            makePipeline('EMK-14', 33.20)
        ],
        systems: [],
        iccp: { current: 0.2345 },
        anodes: { count: 0, totalMass: 0, initialCurrent: 0 }
    };
    if (analysis) state.iccp.reinforcementAnalysis = analysis;

    const ProjectManager = {
        getState: () => state,
        getCurrentProjectId: () => 'PROJ-001',
        getActiveSystem: () => null,
        saveEquipment: (eq) => { saved.push(eq); state.equipments.push(eq); },
        deleteEquipment: (id) => {
            state.equipments = state.equipments.filter((e) => e.id !== id);
        },
        saveCurrentProject: () => {},
        addHistoryEntry: () => {}
    };

    const documentStub = {
        getElementById: () => null,
        addEventListener: () => {},
        dispatchEvent: () => true,
        createElement: () => ({ style: {}, addEventListener: () => {} }),
        querySelector: () => null
    };

    const windowStub = {};
    const sandbox = {
        window: windowStub,
        document: documentStub,
        ProjectManager,
        UI: { showToast: () => {} },
        console: { log: () => {}, warn: () => {}, error: () => {} },
        CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
        Math, Date, Number, String, Array, Object, JSON, isNaN, isFinite,
        parseFloat, parseInt, Infinity, NaN
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    const code = fs.readFileSync(ENGINE_PATH, 'utf8');
    vm.runInContext(code, sandbox, { filename: ENGINE_PATH });

    return { engine: windowStub.AnodesOptimizationEngine, state, saved };
}

const REINFORCEMENT_ANALYSIS = {
    totalAdditionalCurrent: 0.90,
    totalAnodesRequired: 87,
    iccpBaseCurrent: 0.2345,
    analyzedAt: '2026-10-04T00:00:00.000Z',
    zones: [
        { zoneId: 'z1', zoneName: 'Courant insuffisant - EMN-11', location: 'EMN-11',
          problemType: 'insufficient_current', criticality: 'medium',
          additionalCurrent: 0.35, anodesCount: 34 },
        { zoneId: 'z2', zoneName: 'Courant insuffisant - EMK-42', location: 'EMK-42',
          problemType: 'insufficient_current', criticality: 'medium',
          additionalCurrent: 0.55, anodesCount: 53 }
    ]
};

test('mode mixte avec zones analysées : SACP localisé sur les pipelines critiques', async () => {
    const { engine } = buildContext(REINFORCEMENT_ANALYSIS);
    const results = await engine.runForProject('PROJ-001', { mode: 'mixte' });

    assert.equal(results.mode, 'mixte_reinforcement');
    assert.ok(results.reinforcementAnalysis, 'analyse de renforcement conservée');
    assert.equal(results.pipelineResults.length, 2);
    // ⚠️ Cross-realm (sandbox vm) : les tableaux créés dans le contexte vm
    // ont un [[Prototype]] différent → on copie dans un tableau du realm
    // des tests avant l'assertion profonde.
    const ids = [...results.pipelineResults].map((r) => r.pipelineId).sort();
    assert.deepEqual(ids, ['EMK-42', 'EMN-11']);
    assert.ok(Math.abs(results.totalCurrentA - 0.90) < 1e-6);
    assert.ok(!ids.includes('EMK-14'));
});

test('mode mixte SANS zones analysées : aucun dimensionnement SACP (0 anode)', async () => {
    const { engine } = buildContext(null);
    const results = await engine.runForProject('PROJ-001', { mode: 'mixte' });

    // ⚠️ Invariant : en type CP mixte, aucune anode hors zone critique.
    assert.equal(results.mode, 'mixte_no_zones');
    assert.equal(results.totalAnodes, 0);
    // Longueurs plutôt que deepEqual : « [] » vm-realm ≠ « [] » test-realm.
    assert.equal(results.allAnodes.length, 0);
    assert.equal(results.pipelineResults.length, 0);
});

test('mode mixte : application refusée si une anode n\'est rattachée à aucune zone', async () => {
    const { engine, saved } = buildContext(REINFORCEMENT_ANALYSIS);
    const results = await engine.runForProject('PROJ-001', { mode: 'mixte' });
    // Simulation d'un résultat contaminant : une anode sans zoneId
    results.allAnodes = [{ id: 'ANODE-ORPHELINE', lat: 33, lon: 2, I_output_A: 0.01, mass_kg: 10 }];

    engine._applyAnodesProject(results);

    assert.equal(saved.length, 0, 'aucune anode ne doit être créée');
});

test('mode anodes standard (hors mixte) : comportement inchangé', async () => {
    const { engine } = buildContext(REINFORCEMENT_ANALYSIS);
    const results = await engine.runForProject('PROJ-001', {});

    assert.equal(results.mode, 'anodes');
    assert.equal(results.pipelineResults.length, 3);
});

test('application des anodes en renforcement : traçabilité zone + synchro SACP', async () => {
    const { engine, state, saved } = buildContext(REINFORCEMENT_ANALYSIS);
    const results = await engine.runForProject('PROJ-001', { mode: 'mixte' });

    engine._applyAnodesProject(results);

    assert.ok(saved.length > 0, 'des anodes ont été enregistrées');
    const reinforced = saved.filter((eq) => eq.reinforcement === true);
    assert.equal(reinforced.length, saved.length);
    assert.ok(reinforced.every((eq) => eq.zoneId && eq.pipelineId));
    assert.ok(reinforced.some((eq) => eq.zoneId === 'z1'));
    assert.ok(reinforced.some((eq) => eq.zoneId === 'z2'));
    assert.equal(state.anodes.count, saved.length);
    assert.ok(state.anodes.totalMass > 0);
    assert.ok(state.iccp.reinforcementApplied);
    assert.equal(state.iccp.reinforcementApplied.count, saved.length);
});
