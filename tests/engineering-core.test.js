'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const CalculationEngine = require('../engine.js');
const ACCorrosionEngine = require('../acCorrosionEngine.js');

test('requiredCurrent preserves mA/m2 to A conversion', () => {
    const result = CalculationEngine.requiredCurrent(100, 5, 0.95, 0.03, 1.2, 'ISO 15589-1');
    assert.ok(Math.abs(result.exposedArea - 0.18) < 1e-12);
    assert.ok(Math.abs(result.currentAmperes - 0.0009) < 1e-12);
    assert.equal(result.units.currentDensity, 'mA/m²');
});

test('equipment surface is recomputed from canonical pipeline dimensions', () => {
    const surface = CalculationEngine.computeEquipmentSurface('pipeline_enterre', {
        diametre_m: 1,
        longueur_m: 1000
    });
    assert.ok(Math.abs(surface - Math.PI * 1000) < 1e-12);
});

test('vertical anode resistance follows Dwight equation', () => {
    const expected = (100 / (2 * Math.PI)) * (Math.log(40) - 1);
    assert.ok(Math.abs(CalculationEngine.anodeResistanceVertical(100, 1, 0.1) - expected) < 1e-12);
});

test('groundbed requires an explicit target current', () => {
    const result = CalculationEngine.designGroundbed({
        rho: 30,
        totalDepth: 200,
        activeDepth: 150,
        anodeCount: 4,
        anodeLength: 1.5,
        anodeDiameter: 75,
        anodeWeight: 25,
        anodeCapacity: 2.5,
        cableLength: 100,
        cableSection: 35,
        agingFactor: 1.2,
        safetyFactor: 1.1,
        targetCurrent: 0
    });
    assert.equal(result.error, true);
});

test('groundbed reports required anode count with safety factor', () => {
    const result = CalculationEngine.designGroundbed({
        rho: 30,
        totalDepth: 200,
        activeDepth: 150,
        anodeCount: 4,
        anodeLength: 1.5,
        anodeDiameter: 75,
        anodeWeight: 25,
        anodeCapacity: 2.5,
        cableLength: 100,
        cableSection: 35,
        agingFactor: 1.2,
        safetyFactor: 1.1,
        targetCurrent: 10,
        desiredLife: 20
    });
    assert.equal(result.error, undefined);
    assert.equal(result.requiredAnodeCount, 5);
    assert.equal(result.lifeOk, false);
});

test('groundbed validates and traces layer thickness', () => {
    const result = CalculationEngine.designGroundbed({
        rho: 100, totalDepth: 150, activeDepth: 150,
        anodeCount: 16, anodeLength: 1.5, anodeDiameter: 75,
        anodeWeight: 25, anodeCapacity: 2.5,
        cableLength: 100, cableSection: 35,
        agingFactor: 1.2, safetyFactor: 1.1,
        targetCurrent: 10, desiredLife: 25,
        layers: [
            { topDepth: 0, bottomDepth: 75, rho: 30 },
            { topDepth: 75, bottomDepth: 150, rho: 90 }
        ]
    });
    assert.equal(result.groundbedModel, 'LAYERED_DEPTH_WEIGHTED_APPROXIMATION');
    assert.equal(result.layerResistivityMethod, 'DEPTH_WEIGHTED_ARITHMETIC_APPROXIMATION');
    assert.equal(result.rho_eff, 60);
});

test('resistive model uses only the circular base for a floating-roof tank', () => {
    const result = CalculationEngine.calculateEquipmentResistances({
        type: 'reservoir_toit',
        material: 'acier',
        coatingType: 'Acier_nu',
        dimensions: { diametre_m: 10, hauteur_m: 12 },
        soilResistivity: 100
    });

    const baseArea = Math.PI * 25;
    assert.ok(Math.abs(result.soilContactArea - baseArea) < 1e-12);
});

test('resistive model uses base plus buried wall for a semi-buried tank', () => {
    const result = CalculationEngine.calculateEquipmentResistances({
        type: 'reservoir_fond',
        material: 'acier',
        coatingType: 'Acier_nu',
        dimensions: { diametre_m: 10, hauteur_m: 12, hauteur_enterree_m: 3 },
        soilResistivity: 100
    });

    const expectedContactArea = Math.PI * 25 + Math.PI * 10 * 3;
    assert.ok(Math.abs(result.soilContactArea - expectedContactArea) < 1e-12);
});

test('CP criteria require both measured criteria when both are supplied', () => {
    const result = CalculationEngine.validateProtectionCriteria(-900, 50);
    assert.equal(result.offPotentialPass, true);
    assert.equal(result.polarizationPass, false);
    assert.equal(result.globalPass, false);
});

test('missing OFF potential cannot pass validation', () => {
    const result = CalculationEngine.validateProtectionCriteria(null, 150);
    assert.equal(result.offPotentialPass, false);
    assert.equal(result.globalPass, false);
});

test('interference keeps pipe diameter in millimetres at the API boundary', () => {
    const result = CalculationEngine.analyzeInterference({
        acCurrent: 100,
        acFrequency: 50,
        acDistance: 100,
        acParallel: 1000,
        acSoilCond: 0.01,
        pipeDiameter: 610,
        dcDistance: 100,
        dcSoilResistivity: 100,
        victimPotInit: -600,
        victimPotFinal: -850,
        J_AC: 2,
        J_DC: 1
    });
    assert.equal(result.J_AC, 2);
    assert.equal(result.J_DC, 1);
    assert.equal(result.units.J_AC, 'A/m²');
    assert.ok(Number.isFinite(result.acInduced));
});

test('ICCP rectifier power applies safety factor exactly once to required power', () => {
    const rectifier = CalculationEngine.designRectifier(10, 22.424, 1.15, { backEmfVoltage: 2 });
    assert.ok(Math.abs(rectifier.power - 2262.4) < 1e-6, `power should be 2262.4 W, got ${rectifier.power}`);
    assert.ok(Math.abs(rectifier.powerDesign - 2601.76) < 1e-3, `powerDesign should be approximately 2601.76 W, got ${rectifier.powerDesign}`);
});

test('ICCP advanced does not double count cable and structure resistance from groundbed', () => {
    const result = CalculationEngine.designICCPAdvanced({
        rho: 100, N: 4, L: 1.5, d: 0.075, spacing: 10,
        agingFactor: 1.2, cableResistance: 3, structResistance: 4,
        distanceAnodeStruct: 10, anodeType: 'mmo',
        I_total_override: 2, backEmfVoltage: 2, safetyFactorPower: 1.15,
        groundbedResult: {
            R_groundbed_pure: 8,
            R_total: 10,
            R_cable: 1,
            R_struct: 1,
            _includesCable: true,
            _includesStructure: true
        }
    });

    assert.ok(Math.abs(result.groundbedResistance - 10) < 1e-12);
    assert.ok(Math.abs(result.voltageInitial - 22) < 1e-12);
    assert.ok(Math.abs(result.powerInitial - 44) < 1e-12);
    assert.ok(Math.abs(result.powerDesign - 50.6) < 1e-12);
});

test('ICCP advanced detects included legacy cable and structure resistance', () => {
    const result = CalculationEngine.designICCPAdvanced({
        rho: 100, N: 4, L: 1.5, d: 0.075, spacing: 10,
        agingFactor: 1.2, cableResistance: 3, structResistance: 4,
        distanceAnodeStruct: 10, anodeType: 'mmo',
        I_total_override: 2, backEmfVoltage: 2, safetyFactorPower: 1.15,
        groundbedResult: {
            R_groundbed_pure: 8,
            R_total: 10,
            R_cable: 1,
            R_struct: 1
        }
    });

    assert.ok(Math.abs(result.voltageInitial - 22) < 1e-12);
    assert.ok(Math.abs(result.powerDesign - 50.6) < 1e-12);
});

test('ICCP theoretical life is not presented as validated without manufacturer data', () => {
    const result = CalculationEngine.designICCPAdvanced({
        rho: 100, N: 4, L: 1.5, d: 0.075, spacing: 10,
        agingFactor: 1.2, cableResistance: 0, structResistance: 0,
        distanceAnodeStruct: 10, anodeType: 'mmo', I_total_override: 2
    });

    assert.equal(result.lifeTheoretical, null);
    assert.equal(result.lifeDesign, 25);
    assert.equal(result.lifeValidationStatus, 'NOT_VALIDATED_MANUFACTURER_DATA_REQUIRED');
});

test('SACP stale partial results are normalized to an invalid empty state', () => {
    const sanitized = CalculationEngine.normalizeSACPResult({
        totalMass: 0,
        count: 4,
        actualLife: 12,
        initialCurrent: 0.2,
        finalCurrent: 0.1,
        currentDensity: 0.5,
        currentDensity_mA: 500
    });

    assert.equal(sanitized.totalMass, 0);
    assert.equal(sanitized.count, 0);
    assert.equal(sanitized.actualLife, 0);
    assert.equal(sanitized.currentDensity, 0);
    assert.equal(sanitized.currentDensity_mA, 0);
});

test('groundbed stale partial results are normalized to an invalid empty state', () => {
    const sanitized = CalculationEngine.normalizeGroundbedResult({
        R_total: 5.2,
        I_total: 0,
        V_rectifier: 0,
        P_rectifier: 0,
        J_anode: 2.5,
        J_anode_mA: 2500,
        densityLimit: 20,
        densityOk: false,
        lifeWithSafety: 8,
        requiredAnodeCount: 5,
        anodeCount: 0,
        totalMass: 0
    });

    assert.equal(sanitized.R_total, 0);
    assert.equal(sanitized.I_total, 0);
    assert.equal(sanitized.J_anode, 0);
    assert.equal(sanitized.J_anode_mA, 0);
    assert.equal(sanitized.lifeWithSafety, 0);
    assert.equal(sanitized.requiredAnodeCount, 0);
    assert.equal(sanitized.anodeCount, 0);
    assert.equal(sanitized.densityOk, false);
});

test('AC ratio keeps zero-over-zero as not applicable', () => {
    const result = ACCorrosionEngine.analyze({});
    assert.equal(result.J_AC, null);
    assert.equal(result.J_DC, null);
    assert.equal(result.touchV, null);
    assert.equal(result.ratio, null);
    assert.equal(result.ratioStatus, 'N/A');
    assert.equal(result.assessmentStatus, 'NOT_ASSESSABLE');
    assert.notEqual(result.riskLevel, 'LOW');
});

test('legacy interference keeps missing AC/DC inputs non-assessable', () => {
    const result = CalculationEngine.analyzeInterference({ pipeDiameter: 610 });
    assert.equal(result.acInduced, null);
    assert.equal(result.touchVoltage, null);
    assert.equal(result.deltaV, null);
    assert.equal(result.dcStray, null);
    assert.equal(result.globalStatus, 'NOT ASSESSABLE');
});

test('calculateCoatingDegradationFactor calculates and caps f_c <= 1', () => {
    const norm = CalculationEngine.calculateCoatingDegradationFactor(0.95, 0.05, 1.2);
    assert.ok(Math.abs(norm.f_c - 0.003) < 1e-12);
    assert.equal(norm.coatingCapApplied, false);

    const capped = CalculationEngine.calculateCoatingDegradationFactor(0.1, 0.9, 2.0);
    assert.equal(capped.f_c, 1.0);
    assert.equal(capped.coatingCapApplied, true);
    assert.equal(capped.f_c_uncapped, 1.62);
});

test('calculateLayeredSoilResistivity computes arithmetic and harmonic bounds', () => {
    const res = CalculationEngine.calculateLayeredSoilResistivity([
        { rho: 30, depth: 10 },
        { rho: 90, depth: 30 }
    ]);
    assert.ok(Math.abs(res.rho_arithmetic - 75) < 1e-12);
    assert.ok(Math.abs(res.rho_harmonic - 60) < 1e-12);
    assert.ok(Math.abs(res.sensitivityRatio - 1.25) < 1e-12);
});

test('designRectifier selects normalized IEC 60146 catalog ratings', () => {
    const tr = CalculationEngine.designRectifier(10, 2, 1.15, { backEmfVoltage: 2 });
    assert.equal(tr.nominalVoltage, 36);
    assert.equal(tr.nominalCurrent, 15);
    assert.equal(tr.nominalPower, 540);
    assert.equal(tr.trSelectionBasis, 'IEC_60146_NORMALIZED_STEPS');
});

// ============================================================
// FIX-LIFESPAN (2026-09-26) : Tests de régression durée de vie ICCP
// Vérifie que les anodes DSA (MMO, platinisées) ne génèrent plus
// de durées de vie astronomiques (1,62 milliard d'années).
// ============================================================

test('calculateICCPAnodeLife: MMO anode life is capped at 50y theoretical, 25y design', () => {
    // Reproduit exactement les paramètres de la capture écran utilisateur :
    // 16 anodes MMO, 25 kg (masse structurelle), courant total 0.209 A
    const I_per_anode = 0.209 / 16;  // = 0.0130625 A/anode
    const result = Utils.calculateICCPAnodeLife('mmo', 25, I_per_anode, 0.85);

    assert.ok(!result.error, 'La fonction ne doit pas retourner une erreur');
    assert.equal(result.isDSA, true, 'MMO est un matériau DSA');

    // Durée de vie théorique : plafonnée à 50 ans (limite physique NACE TM0108)
    assert.ok(result.lifeTheoretical <= 50,
        `lifeTheoretical (${result.lifeTheoretical}) doit être ≤ 50 ans (était 1,62 milliard !)`);

    // Durée de vie de conception : plafonnée à 25 ans (NACE SP0169 / API RP 651)
    assert.ok(result.lifeDesign <= 25,
        `lifeDesign (${result.lifeDesign}) doit être ≤ 25 ans`);

    // Vérifier que la masse effective est la masse catalytique (~0.010 kg), pas 25 kg
    assert.ok(result.effectiveMass_kg <= 0.015,
        `La masse effective doit être la masse catalytique (~10 g), pas ${result.effectiveMass_kg * 1000} g`);
});

test('calculateICCPAnodeLife: platinized DSA anode life capped at 50y theoretical', () => {
    const result = Utils.calculateICCPAnodeLife('platinized', 20, 0.5, 0.85);
    assert.equal(result.isDSA, true, 'Platinized est un matériau DSA');
    assert.ok(result.lifeTheoretical <= 50, 'Durée de vie théorique plafonnée à 50 ans');
    assert.ok(result.lifeDesign <= 25, 'Durée de vie de conception plafonnée à 25 ans');
});

test('calculateICCPAnodeLife: graphite (soluble) anode uses real mass — Faraday standard', () => {
    // Pour les anodes solubles (graphite, Si-Cr), la masse réelle est utilisée.
    // À courant élevé, la durée de vie n'est pas astronomique.
    const result = Utils.calculateICCPAnodeLife('graphite', 50, 5, 0.85);
    assert.ok(!result.error, 'graphite ne doit pas retourner une erreur');
    assert.equal(result.isDSA, false, 'graphite n\'est pas un matériau DSA');
    assert.ok(result.effectiveMass_kg === 50, 'La masse réelle (50 kg) doit être utilisée pour les anodes solubles');
    // calcLife = (50 * 0.85) / (5 * 0.250) = 34 ans → lifeDesign = min(34, 25) = 25
    assert.equal(result.lifeDesign, 25, 'lifeDesign = min(calcul_brut, 25) pour graphite à courant modéré');
});

test('designGroundbed exposes lifeDesign field capped at NACE 25 years', () => {
    // Vérification que lifeDesign est maintenant retourné par designGroundbed
    const result = CalculationEngine.designGroundbed({
        rho: 50, totalDepth: 60, activeDepth: 30,
        anodeCount: 6, anodeLength: 1.5, anodeDiameter: 100,
        anodeWeight: 25, anodeCapacity: 2.5,
        cableLength: 0, cableSection: 0,
        agingFactor: 1.2, safetyFactor: 1.1,
        targetCurrent: 0.5, desiredLife: 20
    });

    assert.ok(!result.error, 'designGroundbed ne doit pas retourner une erreur');
    assert.ok(typeof result.lifeDesign === 'number', 'lifeDesign doit être un nombre');
    assert.ok(typeof result.lifeTheoretical === 'number', 'lifeTheoretical doit être un nombre');
    // La durée de vie de conception ne peut pas dépasser 25 ans
    assert.ok(result.lifeDesign <= 25,
        `lifeDesign (${result.lifeDesign}) ne doit pas dépasser 25 ans (plafond NACE)`);
});

