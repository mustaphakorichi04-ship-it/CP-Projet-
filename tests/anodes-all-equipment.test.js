'use strict';

// ============================================================
// Tests — Optimisation Anodes (type CP « anodes ») v1.1.0
// ------------------------------------------------------------
// Vérifie que le dimensionnement couvre TOUS les équipements
// protégés du projet (pipelines ET structures : tanks,
// réservoirs, fourreaux…), que les positions sont produites
// pour la carte du module Cartographie, et que le mode mixte
// reste strictement inchangé (régression).
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

// Réservoir / tank : UNE position GPS + dimensions (couronne périphérique)
function makeTank(tag, lat, lon, d, h) {
    return {
        id: tag,
        tag: tag,
        projectId: 'PROJ-001',
        type: 'tank',
        included: true,
        coordinates: [{ lat: lat, lon: lon }],
        dimensions: { diametre_m: d, hauteur_m: h },
        soilResistivity: 100,
        coatingEfficiency: 0.95,
        currentDensity: 10,
        defectDensity: 0.05,
        agingFactor: 1.2
    };
}

// Fourreau / casing : polyline ≥2 points (placement linéaire)
function makeCasing(tag) {
    return {
        id: tag,
        tag: tag,
        projectId: 'PROJ-001',
        type: 'well_casing',
        included: true,
        coordinates: [
            { lat: 34.00, lon: 3.00 },
            { lat: 34.01, lon: 3.01 }
        ],
        dimensions: { diametre_m: 0.245, longueur_m: 1500 },
        soilResistivity: 100,
        coatingEfficiency: 0.95,
        currentDensity: 10,
        defectDensity: 0.05,
        agingFactor: 1.2
    };
}

function buildContext(equipments, analysis) {
    const saved = [];
    const state = {
        equipments: equipments,
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
        querySelector: () => null,
        querySelectorAll: () => []
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
        parseFloat, parseInt, Infinity, NaN, setTimeout, clearTimeout
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

test('pipeline + tank : tous les équipements du projet sont dimensionnés', async () => {
    const { engine } = buildContext([
        makePipeline('EMN-11', 33.00),
        makeTank('TANK-1', 33.05, 2.05, 6, 8)
    ]);
    const results = await engine.runForProject('PROJ-001', {});

    assert.equal(results.mode, 'anodes');
    assert.equal(results.pipelineResults.length, 1, 'les pipelines restent tracés à part');
    assert.equal(results.equipmentResults.length, 1, 'le tank est dimensionné');

    const eq = results.equipmentResults[0];
    assert.equal(eq.equipmentTag, 'TANK-1');
    assert.equal(eq.equipmentType, 'tank');
    assert.equal(eq.isStructure, true);
    assert.equal(eq.placementMode, 'ring');
    assert.ok(eq.nAnodes >= 1, 'au moins une anode pour le tank');
    assert.ok(eq.structureSurfaceM2 > 0, 'surface du tank calculée');
    assert.ok(eq.totalCurrentA > 0, 'courant requis du tank > 0');

    // Totaux = pipelines + structures
    assert.equal(
        results.totalAnodes,
        results.pipelineResults[0].nAnodes + eq.nAnodes
    );
    assert.equal(results.allAnodes.length, results.totalAnodes, 'toutes les positions sont produites');
    assert.ok(results.totalMassKg > 0 && results.totalCurrentA > 0);
    assert.equal(results.skippedEquipment.length, 0);

    // Positions cartographiables (module Cartographie)
    const tankAnodes = results.allAnodes.filter((a) => a.equipmentTag === 'TANK-1');
    assert.equal(tankAnodes.length, eq.nAnodes);
    tankAnodes.forEach((a) => {
        assert.ok(Number.isFinite(a.lat) && Number.isFinite(a.lon));
        assert.ok(Number.isFinite(a.I_output_A) && a.I_output_A > 0);
        assert.ok(Number.isFinite(a.mass_kg) && a.mass_kg > 0);
    });
    assert.ok(results.score >= 0 && results.score <= 1);
});

test('projet sans pipeline : les structures seules sont dimensionnées', async () => {
    const { engine } = buildContext([
        makeTank('TANK-2', 34.0, 3.0, 10, 12)
    ]);
    const results = await engine.runForProject('PROJ-001', {});

    assert.equal(results.mode, 'anodes');
    assert.equal(results.pipelineResults.length, 0);
    assert.equal(results.equipmentResults.length, 1, 'aucune erreur malgré l’absence de pipeline');
    assert.ok(results.totalAnodes > 0);
    assert.equal(results.allAnodes.length, results.totalAnodes);
    assert.ok(results.allAnodes.every((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon)));
});

test('structure linéaire (≥2 points GPS) : placement le long de l’équipement', async () => {
    const { engine } = buildContext([
        makePipeline('EMN-11', 33.00),
        makeCasing('WC-1')
    ]);
    const results = await engine.runForProject('PROJ-001', {});

    assert.equal(results.equipmentResults.length, 1);
    const eq = results.equipmentResults[0];
    assert.equal(eq.equipmentTag, 'WC-1');
    assert.equal(eq.placementMode, 'linear');
    assert.ok(eq.nAnodes >= 1);
    assert.ok(results.totalAnodes > results.pipelineResults[0].nAnodes);
});

test('réservoir sans dimensions : ignoré et tracé dans skippedEquipment', async () => {
    const { engine } = buildContext([
        makePipeline('EMN-11', 33.00),
        {
            id: 'TANK-X', tag: 'TANK-X', projectId: 'PROJ-001', type: 'tank',
            included: true, coordinates: [{ lat: 33.5, lon: 2.5 }]
        }
    ]);
    const results = await engine.runForProject('PROJ-001', {});

    assert.equal(results.equipmentResults.length, 0);
    assert.equal(results.skippedEquipment.length, 1);
    assert.equal(results.skippedEquipment[0].id, 'TANK-X');
    assert.match(results.skippedEquipment[0].reason, /surface/);
    assert.equal(results.pipelineResults.length, 1, 'le pipeline reste dimensionné');
});

test('type CP mixte : les structures ne sont PAS dimensionnées (régression inchangée)', async () => {
    const { engine } = buildContext([
        makePipeline('EMN-11', 33.00),
        makePipeline('EMK-42', 33.10),
        makePipeline('EMK-14', 33.20),
        makeTank('TANK-9', 33.5, 2.5, 8, 10)
    ], REINFORCEMENT_ANALYSIS);
    const results = await engine.runForProject('PROJ-001', { mode: 'mixte' });

    assert.equal(results.mode, 'mixte_reinforcement');
    assert.equal(results.pipelineResults.length, 2, 'seules les pipelines en zones critiques');
    assert.equal(results.equipmentResults.length, 0, 'structures hors mixte');
    assert.equal(results.skippedEquipment.length, 0);
    assert.ok(results.allAnodes.length > 0);
    assert.ok(results.allAnodes.every((a) => !a.equipmentTag), 'aucune anode rattachée à une structure');
});

// ============================================================
// Exigence 2026-10-09 — séparation dimensionnement / répartition :
// « Dimensionner » fournit le nombre (base = courant du module
// Calcul CP) ; « Optimisation Anodes » répartit/positionne CE
// nombre (AMPP/NACE) et ne le recalcule JAMAIS.
// ============================================================
test('nombre dimensionné réparti sans recalcul (Σ N_i = count, couverture totale)', async () => {
    const { engine, state } = buildContext([
        makePipeline('EMN-11', 33.00),
        makePipeline('EMK-42', 33.10),
        makeTank('TANK-1', 33.05, 2.05, 6, 8)
    ]);
    // Dimensionnement préalable simulé (bouton « Dimensionner »)
    state.anodes.count = 7;
    state.anodes.totalMass = 7 * 10;

    const results = await engine.runForProject('PROJ-001', {});

    assert.equal(results.countSource, 'dimensioned', 'source du compte = dimensionnement');
    assert.equal(results.totalAnodes, 7, 'le total est EXACTEMENT le nombre dimensionné');
    assert.equal(results.allAnodes.length, 7, 'une position par anode dimensionnée');

    // Σ n_anodes par équipement = compte dimensionné (aucune anode créée/perdue)
    const sumN = (results.pipelineResults || []).reduce((s, r) => s + r.nAnodes, 0) +
                 (results.equipmentResults || []).reduce((s, r) => s + r.nAnodes, 0);
    assert.equal(sumN, 7);

    // Couverture : chaque ouvrage demandeur reçoit au moins 1 anode
    const perEq = {};
    results.allAnodes.forEach((a) => {
        const k = a.equipmentTag || a.pipelineId;
        perEq[k] = (perEq[k] || 0) + 1;
    });
    assert.ok(Object.keys(perEq).length >= 3, 'pipelines ET structures couverts');
    Object.entries(perEq).forEach(([k, n]) => assert.ok(n >= 1, `${k} ≥ 1 anode`));

    // Positions normalisées : placement uniforme le long de chaque pipeline
    results.pipelineResults.forEach((r) => {
        assert.ok(Math.abs(r.spacingM - r.pipelineLengthM / (r.nAnodes + 1)) < 1e-9,
            'espacement = L/(N+1) (répartition normalisée)');
    });

    // Masse cohérente avec le dimensionnement (10 kg/unité par défaut)
    assert.ok(Math.abs(results.totalMassKg - 70) < 1e-9, 'masse totale = N × masse unitaire');
});

test('répartition : un compte très supérieur au nombre d\'ouvrages reste exact (Σ = count)', async () => {
    const { engine, state } = buildContext([
        makePipeline('EMN-11', 33.00),
        makeTank('TANK-1', 33.05, 2.05, 6, 8)
    ]);
    state.anodes.count = 23;
    const results = await engine.runForProject('PROJ-001', {});
    assert.equal(results.countSource, 'dimensioned');
    assert.equal(results.totalAnodes, 23, 'Σ N_i = 23 exactement (plus forts restes)');
    assert.equal(results.allAnodes.length, 23);
});
