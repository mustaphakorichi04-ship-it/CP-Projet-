// ============================================================
// cp-controller.js – CP Engineer Pro – Façade unifiée CPController
// Module façade. Version applicative : APP_CONFIG.VERSION (engine.js).
// ============================================================
// CORRECTIONS APPLIQUÉES (v9.1) :
//   ✅ INTÉGRATION ui-groundbed-consistency-patch.js v2.1
//      → calculateGroundbed() force désormais gbTargetCurrent
//        selon la priorité ICCP > CP > Surface AVANT le calcul.
//      → Délégation à ProjectManager.resolveTargetCurrent()
//        (qui délègue elle-même à DataResolver.resolvePreferredCurrent()).
//      → Fallback inline si DataResolver non chargé.
//      → Traçabilité de la source (targetCurrentSource) sauvegardée
//        dans le système actif.
//
// CORRECTIONS CONSERVÉES :
//   BUG-01 (v9.0.1) : anodeDiameter passé en mm (pas en m)
//   P0-01 : Traçabilité source courant ICCP
//   P0-02 : Propagation unités canoniques (A/m² et mA/m²)
//   P0-03 : Propagation lifeTheoretical et lifeDesign
//   P0-04 : Propagation R_groundbed_pure, R_well, _includesCable, _includesStructure
//   P0-05 : Distinction rhoProject / rhoGroundbed
//   P1-01 : R_cable avec facteur 2 (aller-retour)
//   P1-02 : state.iccp.power = powerDesign
//   P1-05 : state.iccp.lifeEstimate = lifeDesign
// ============================================================

(function() {
    'use strict';

    if (typeof ProjectManager === 'undefined') {
        throw new Error('cp-controller.js: ProjectManager n\'est pas défini.');
    }
    if (typeof CalculationEngine === 'undefined') {
        throw new Error('cp-controller.js: CalculationEngine n\'est pas défini.');
    }

    // --- États internes pour les liens ---
    const linkState = {
        current: false,
        surface: false,
        targetPot: false
    };
    const gndLinkState = {
        resistivity: false,
        current: false
    };
    const ifLinkState = {
        current: false,
        potential: false
    };

    // ============================================================
    // FONCTIONS UTILITAIRES LOCALES
    // ============================================================

    function safeNumber(v, d) {
        if (v === undefined || v === null || v === '') return d;
        const n = parseFloat(String(v).trim().replace(',', '.'));
        return isNaN(n) ? d : n;
    }

    // CORRECTION : getFieldValue robuste pour inputs et selects
        // ============================================================
    // getFieldValue — DÉLÉGATION À UI (SSOT)
    // ------------------------------------------------------------
    // ✅ REFACTORING (ROLE.txt §2) :
    //   - Une seule implémentation de référence dans ui.js
    //   - Comportement unifié pour : 0, négatifs, "", null, undefined, NaN
    //   - Fallback inline strictement identique à UI.getFieldValue()
    //     (utilisé UNIQUEMENT si ui.js n'est pas encore chargé)
    // ============================================================
    function getFieldValue(selectId, manualId) {
        // ─── Source de vérité : UI.getFieldValue ───
        if (typeof window !== 'undefined' &&
            window.UI &&
            typeof window.UI.getFieldValue === 'function') {
            return window.UI.getFieldValue(selectId, manualId);
        }

        // ─── Fallback (identique à UI.getFieldValue) ───
        const el = document.getElementById(selectId);
        if (!el) return 0;

        if (el.tagName === 'INPUT') {
            const v = parseFloat(el.value);
            return isNaN(v) ? 0 : v;
        }

        if (el.tagName === 'SELECT') {
            if (el.value === 'manual') {
                const manual = document.getElementById(manualId);
                if (manual && manual.value !== '' && manual.value !== undefined) {
                    const v = parseFloat(String(manual.value).replace(',', '.'));
                    if (!isNaN(v)) return v;  // accepte 0 et négatifs
                }
                return 0;
            }
            const v = parseFloat(el.value);
            return isNaN(v) ? 0 : v;
        }
        return 0;
    }

    /**
     * BUG-CP-005 : constante RHO_CU lue depuis APP_CONFIG
     * (source unique de vérité — engine.js).
     * Fallback 0.0175 si APP_CONFIG n'est pas encore chargé.
     */
    const RHO_CU = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.CABLE_RESISTIVITY)
        ? APP_CONFIG.CABLE_RESISTIVITY.cu
        : 0.0175;

    // ============================================================
    // ⭐ v9.1 : INTÉGRATION ui-groundbed-consistency-patch v2.1
    // ============================================================
    /**
     * Résout le courant cible pour le groundbed selon une priorité
     * en cascade (ICCP > CP > Surface).
     *
     * Délègue à ProjectManager.resolveTargetCurrent() qui elle-même
     * délègue à DataResolver.resolvePreferredCurrent() si disponible.
     *
     * @param {number} J_cp - Densité de courant CP (mA/m²) pour fallback surface
     * @returns {{value: number, source: string, label: string}}
     */
    function resolveGroundbedTargetCurrent(J_cp) {
        try {
            if (typeof ProjectManager !== 'undefined' &&
                typeof ProjectManager.resolveTargetCurrent === 'function') {

                const resolved = ProjectManager.resolveTargetCurrent({
                    currentDensity_mA_m2: safeNumber(J_cp, 0)
                });

                if (resolved && typeof resolved.value === 'number') {
                    return resolved;
                }
            }
        } catch (e) {
            console.warn('[CPController] resolveGroundbedTargetCurrent erreur:', e.message);
        }

        // Fallback inline (si ProjectManager.resolveTargetCurrent absent)
        const state = ProjectManager.getState();
        const selectedIccpSource = document.getElementById('iccpCurrentSource')?.value ||
            (state && state.iccp && state.iccp.iccpCurrentSource) || 'manual';
        const iccpCurrent = selectedIccpSource === 'cp_calculated'
            ? 0
            : ((state && state.iccp && state.iccp.current) || 0);
        const cpCurrent = (state && state.cp && state.cp.current) || 0;

        if (iccpCurrent > 0) {
            return { value: iccpCurrent, source: 'iccp', label: 'ICCP calcule' };
        }
        if (cpCurrent > 0) {
            return { value: cpCurrent, source: 'cp', label: 'CP calcule' };
        }
        return { value: 0, source: 'none', label: 'Aucune source' };
    }

    function syncGroundbedTargetCurrent() {
        const J_cp = getFieldValue('cpCurrentDensitySelect', 'cpCurrentDensityManual');
        const resolved = resolveGroundbedTargetCurrent(J_cp);
        if (resolved.value > 0) {
            applyTargetToField(resolved.value, resolved.source, resolved.label);
        } else if (document.getElementById('iccpCurrentSource')?.value === 'cp_calculated') {
            applyTargetToField(0, 'none', 'Aucune source');
        }
        return resolved;
    }

    /**
     * Force la valeur du champ #gbTargetCurrent dans le DOM et applique
     * un style visuel correspondant à la source.
     *
     * @param {number} value
     * @param {string} source
     * @param {string} sourceLabel
     * @returns {boolean}
     */
    function applyTargetToField(value, source, sourceLabel) {
        const input = document.getElementById('gbTargetCurrent');
        if (!input) return false;

        if (value > 0) {
            input.value = value.toFixed(3);

            if (source === 'iccp' || source === 'cp') {
                input.style.borderColor = 'var(--accent-green)';
                input.style.background = 'rgba(52, 199, 89, 0.08)';
                input.title = 'Courant cible synchronise depuis ' + sourceLabel +
                              ' : ' + value.toFixed(3) + ' A';
            } else if (source === 'surface') {
                input.style.borderColor = 'var(--accent-orange)';
                input.style.background = 'rgba(255, 149, 0, 0.08)';
                input.title = 'Courant cible estime depuis la surface (fallback).';
            } else {
                input.style.borderColor = '';
                input.style.background = '';
            }
        } else {
            input.value = '';
            input.style.borderColor = '';
            input.style.background = '';
        }
        return true;
    }

    // ============================================================
    // MÉTHODES DE CALCUL (délégation à CalculationEngine)
    // ============================================================

    function clearCPDerivedState() {
        const state = ProjectManager.getState();
        if (!state.cp) state.cp = {};
        state.cp.current = 0;
        state.cp.irDrop = 0;
        state.cp.requiredOnPotential = 0;
        if (state.project) state.project.currentRequired = 0;
        ProjectManager.saveCurrentProject();
    }

    function clearICCPDerivedState() {
        const state = ProjectManager.getState();
        if (!state.iccp) state.iccp = {};
        Object.assign(state.iccp, {
            current: 0,
            power: 0,
            powerInitial: 0,
            powerDesign: 0,
            rectifierPower: 0,
            voltage: 0,
            voltageFinal: 0,
            rectifierVoltage: 0,
            currentDensity: 0,
            currentDensity_mA: 0,
            densityOk: false,
            requiredCurrent: 0,
            selectedCurrent: 0,
            currentMarginRatio: null,
            currentMarginPercent: null,
            groundbedResistance: 0,
            lifeEstimate: 0,
            lifeTheoretical: 0,
            lifeDesign: 0,
            lifeDetails: null,
            lifeValidationStatus: 'NOT_VALIDATED_MANUFACTURER_DATA_REQUIRED'
        });
        ProjectManager.saveCurrentProject();
    }

    function calculateCP() {
        try {
            const S = getFieldValue('cpSurface', '');
            const J = getFieldValue('cpCurrentDensitySelect', 'cpCurrentDensityManual');
            const eps = getFieldValue('cpCoatingSelect', 'cpCoatingManual');
            const DF = getFieldValue('defectDensity', 'defectDensityManual');
            const k = getFieldValue('agingFactor', 'agingFactorManual');
            const norm = document.getElementById('cpNorm')?.value || 'ISO 15589-1';

            if (S <= 0) {
                clearCPDerivedState();
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('⚠️ Surface invalide (doit être > 0).', 'warning');
                }
                return;
            }

            const check = CalculationEngine.checkCPParameters(S, J, eps, DF, k);
            if (!check.valid) {
                clearCPDerivedState();
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast(`⚠️ Attention : ${check.warnings.join(' ')}`, 'warning');
                }
                return;
            }

            const result = CalculationEngine.requiredCurrent(S, J, eps, DF, k, norm);

            const rho = getFieldValue('cpResistivitySelect', 'cpResistivityManual');
            const anodeLength = getFieldValue('anodeLengthSelect', 'anodeLengthManual');
            const anodeDiameter = getFieldValue('anodeDiameterSelect', 'anodeDiameterManual');
            let R_anode = 0;
            if (rho > 0 && anodeLength > 0 && anodeDiameter > 0) {
                R_anode = CalculationEngine.anodeResistanceVertical(rho, anodeLength, anodeDiameter);
            }

            const L_cable = getFieldValue('cableLength', 'cableLengthManual');
            const S_cable = getFieldValue('cableSection', 'cableSectionManual');
            let R_cable = 0;
            if (L_cable > 0 && S_cable > 0) {
                const isTotal = document.getElementById('cableLength')?.dataset?.isTotal === 'true' ||
                                ProjectManager.getState()?.shared?.cableLengthIsTotal === true;
                const cablePathFactor = isTotal ? 1 : 2;
                // cablePathFactor : 1 si longueur totale aller-retour (ex: issue du SIG), 2 si aller-simple
                R_cable = cablePathFactor * RHO_CU * L_cable / S_cable;
            }

            const R_struct = getFieldValue('structureResistance', 'structureResistanceManual');
            const R_total = R_anode + R_cable + R_struct;
            const irDropVolts = result.currentAmperes * R_total;
            const targetOffMv = getFieldValue('targetPotential', 'targetPotentialManual') || -850;
            const requiredOnMv = targetOffMv - (irDropVolts * 1000);

            const state = ProjectManager.getState();
            state.cp.current = result.currentAmperes;
            state.cp.irDrop = irDropVolts;
            state.cp.requiredOnPotential = requiredOnMv;
            if (state.project) {
                state.project.currentRequired = result.currentAmperes;
                state.project.surface = S;
                state.project.currentDensity = J;
                state.project.coating = eps;
                state.project.defectDensity = DF;
                state.project.agingFactor = k;
                state.project.norm = norm;
                state.project.targetPotential = targetOffMv;
            }

            if (window.UI && typeof window.UI.displayCPResults === 'function') {
                window.UI.displayCPResults({
                    current: result.currentAmperes,
                    irDrop: irDropVolts,
                    R_total: R_total,
                    exposedArea: result.exposedArea,
                    requiredOnMv: requiredOnMv,
                    norm: norm,
                    R_anode: R_anode,
                    R_cable: R_cable,
                    R_struct: R_struct
                });
            }

            const sysId = document.getElementById('cpSystemSelector')?.value;
            if (sysId) {
                ProjectManager.saveSystemResults(sysId, 'cp', {
                    current: result.currentAmperes,
                    irDrop: irDropVolts,
                    requiredOnPotential: requiredOnMv,
                    surface: S,
                    norm: norm
                });
            }

            ProjectManager.saveCurrentProject();
            ProjectManager.addHistoryEntry('cp', 'Calcul CP', `${result.currentAmperes.toFixed(3)} A, ${norm}`);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`✅ CP calculé : ${result.currentAmperes.toFixed(3)} A (${norm})`, 'success');
            }

            // Notification pour synchronisation groundbed
            document.dispatchEvent(new CustomEvent('calculationCompleted', {
                detail: { type: 'cp', current: result.currentAmperes }
            }));
        } catch (err) {
            console.error('Erreur calculateCP:', err);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`❌ Erreur : ${err.message}`, 'error');
            }
        }
    }

    function calculateAnodes() {
        try {
            const I_req = getFieldValue('anodeCurrentReq', '');
            const life = getFieldValue('anodeLifeSelect', 'anodeLifeManual');
            const materialKey = document.getElementById('anodeMaterialSelect')?.value || 'Mg_HC';
            const u = getFieldValue('anodeUtilizationSelect', 'anodeUtilizationManual');
            const safety = getFieldValue('safetyFactor', 'safetyFactorManual');
            const unitMass = getFieldValue('anodeMassUnitSelect', 'anodeMassUnit');
            const rho = getFieldValue('anodeSoilResistivity', 'anodeSoilResistivityManual');
            const L = getFieldValue('anodeLengthSelect', 'anodeLengthManual');
            const d = getFieldValue('anodeDiameterSelect', 'anodeDiameterManual');
            const anodePot = getFieldValue('anodePotentialSelect', 'anodePotentialManual');
            const finalFactor = getFieldValue('finalResistanceFactor', 'finalResistanceFactorManual');
            const targetProtection = getFieldValue('targetPotential', 'targetPotentialManual') || -850;
            const orientation = document.getElementById('anodeOrientationSelect')?.value || 'vertical';

            const state = ProjectManager.getState();
            const clearInvalidAnodeState = () => {
                Object.assign(state.anodes, {
                    totalMass: 0,
                    count: 0,
                    actualLife: 0,
                    initialCurrent: 0,
                    finalCurrent: 0,
                    currentDensity: 0,
                    currentDensity_mA: 0,
                    densityOk: false,
                    safetyFactor: Number(safety) || 1.1,
                    soilResistivity: Number(rho) || 100,
                    freePotential: Number(targetProtection) || -850,
                    finalResistanceFactor: Number(finalFactor) || 1.5,
                    units: null
                });

                const sysId = document.getElementById('anodesSystemSelector')?.value;
                if (sysId) {
                    ProjectManager.saveSystemResults(sysId, 'anodes', {
                        totalMass: 0,
                        count: 0,
                        actualLife: 0,
                        initialCurrent: 0,
                        finalCurrent: 0,
                        currentDensity: 0,
                        currentDensity_mA: 0,
                        densityOk: false
                    });
                }
                ProjectManager.saveCurrentProject();
            };

            if (I_req <= 0) {
                clearInvalidAnodeState();
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('⚠️ Courant requis invalide.', 'warning');
                }
                return;
            }

            const result = CalculationEngine.designAnodesDNV({
                I_req, life, materialKey, u, safety, unitMass,
                rho, L, d, anodePot, targetProtection, finalFactor,
                orientation
            });

            if (result.error) {
                clearInvalidAnodeState();
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast(`❌ Erreur : ${result.message}`, 'error');
                }
                return;
            }

            state.anodes.totalMass = result.totalMass;
            state.anodes.count = result.count;
            state.anodes.actualLife = result.actualLife;
            state.anodes.initialCurrent = result.initialCurrent;
            state.anodes.finalCurrent = result.finalCurrent;
            state.anodes.currentDensity = result.currentDensity;          // A/m²
            state.anodes.currentDensity_mA = result.currentDensity_mA;    // P0-02
            state.anodes.densityOk = result.densityOk;
            state.anodes.anodeMaterial = materialKey;
            state.anodes.soilResistivity = rho;
            state.anodes.freePotential = targetProtection;
            state.anodes.finalResistanceFactor = finalFactor;
            state.anodes.safetyFactor = safety;
            state.anodes.units = result.units || null;                    // P0-02

            if (window.UI && typeof window.UI.displayAnodeResults === 'function') {
                window.UI.displayAnodeResults(result, life);
            }

            const sysId = document.getElementById('anodesSystemSelector')?.value;
            if (sysId) {
                ProjectManager.saveSystemResults(sysId, 'anodes', {
                    totalMass: result.totalMass,
                    count: result.count,
                    actualLife: result.actualLife,
                    initialCurrent: result.initialCurrent,
                    finalCurrent: result.finalCurrent,
                    currentDensity: result.currentDensity,
                    currentDensity_mA: result.currentDensity_mA,
                    densityOk: result.densityOk
                });
            }

            ProjectManager.saveCurrentProject();
            ProjectManager.addHistoryEntry('anodes', 'Dimensionnement anodes', `${result.count} anodes, ${result.totalMass.toFixed(1)} kg`);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`✅ Anodes dimensionnées : ${result.count} unités, ${result.totalMass.toFixed(1)} kg`, 'success');
            }
        } catch (err) {
            console.error('Erreur calculateAnodes:', err);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`❌ Erreur : ${err.message}`, 'error');
            }
        }
    }

    function calculateICCP() {
        try {
            const S = getFieldValue('iccpSurface', '');
            const J = getFieldValue('iccpCurrentDensitySelect', '');
            const rho = getFieldValue('iccpResistivitySelect', 'iccpResistivityManual');
            const N = getFieldValue('iccpAnodeCount', 'iccpAnodeCountManual');
            const L = getFieldValue('iccpAnodeLength', 'iccpAnodeLengthManual');
            const d = getFieldValue('iccpAnodeDiameter', 'iccpAnodeDiameterManual');
            const spacing = getFieldValue('iccpSpacing', 'iccpSpacingManual') || 10;
            const aging = getFieldValue('iccpAgingFactor', 'iccpAgingFactorManual');
            const distance = getFieldValue('iccpDistance', 'iccpDistanceManual') || 10;
            const anodeType = document.getElementById('iccpAnodeTypeSelect')?.value || 'mmo';

            const L_cable = getFieldValue('cableLength', 'cableLengthManual');
            const S_cable = getFieldValue('cableSection', 'cableSectionManual');
            const R_struct = getFieldValue('structureResistance', 'structureResistanceManual');
            const isTotal = document.getElementById('cableLength')?.dataset?.isTotal === 'true' ||
                            ProjectManager.getState()?.shared?.cableLengthIsTotal === true;
            const cablePathFactor = isTotal ? 1 : 2;
            const R_cable = (L_cable > 0 && S_cable > 0)
                ? (cablePathFactor * RHO_CU * L_cable / S_cable)
                : 0;

            // P0-01 : Identification explicite de la source du courant
            let I_total = 0;
            const source = document.getElementById('iccpCurrentSource')?.value || 'manual';
            let iccpCurrentSource = 'manual';
            let iccpSourceLabel = 'Manuel';

            if (source === 'manual') {
                I_total = getFieldValue('iccpManualCurrent', 'iccpManualCurrentManual') || 0;
                iccpCurrentSource = 'manual';
                iccpSourceLabel = 'Manuel (saisie utilisateur)';
            } else if (source === 'cp_calculated') {
                I_total = ProjectManager.getState().cp.current || 0;
                iccpCurrentSource = 'cp_calculated';
                iccpSourceLabel = 'CP calculé (I_CP)';
            } else if (source === 'equipment_total') {
                I_total = getTotalEquipmentCurrent();
                iccpCurrentSource = 'equipment_total';
                iccpSourceLabel = 'Cumul équipements';
            }

            if (I_total <= 0) {
                clearICCPDerivedState();
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('⚠️ Courant total ICCP invalide. Vérifiez la source.', 'warning');
                }
                return;
            }

            console.log('[CPController] ICCP courant source =', iccpCurrentSource,
                        '| valeur =', I_total.toFixed(3), 'A');

            const stateBeforeICCP = ProjectManager.getState();
            const equipmentRequiredCurrent = getTotalEquipmentCurrent();
            const requiredCurrent = Number(stateBeforeICCP.cp && stateBeforeICCP.cp.current) > 0
                ? Number(stateBeforeICCP.cp.current)
                : (equipmentRequiredCurrent > 0
                    ? equipmentRequiredCurrent
                    : (S > 0 && J > 0 ? (S * J) / 1000 : 0));
            const currentMarginRatio = requiredCurrent > 0 ? I_total / requiredCurrent : null;
            const currentMarginPercent = currentMarginRatio !== null
                ? (currentMarginRatio - 1) * 100
                : null;

            const gbId = document.getElementById('iccpGroundbedSelector')?.value;
            let groundbedResult = null;
            if (gbId) {
                const gb = ProjectManager.getGroundbedById(gbId);
                if (gb && gb.results && gb.results.R_total) {
                    groundbedResult = {
                        R_group: gb.results.R_group || gb.results.R_total,
                        R_total: gb.results.R_total,
                        ...gb.results
                    };
                }
            }

            const iccpAnodeConfig = ProjectManager.getState().project?.shared?.iccpAnodeConfig || {};

            const params = {
                S, J, rho, N, L, d, spacing,
                agingFactor: aging,
                cableResistance: R_cable,
                structResistance: R_struct,
                distanceAnodeStruct: distance,
                anodeType: anodeType,
                totalDepth: 200,
                boreholeDiameter: 300,
                activeDepth: N * L,
                desiredLife: (ProjectManager.getState().project && ProjectManager.getState().project.designLifeTarget) || 25,
                groundbedResult: groundbedResult,
                I_total_override: I_total,
                iccpCurrentSource: iccpCurrentSource,
                massPerAnode: iccpAnodeConfig.massPerAnode_kg,
                utilization: iccpAnodeConfig.utilization,
                designLifeCap: iccpAnodeConfig.designLifeCap_years
            };

            const result = CalculationEngine.designICCPAdvanced(params);

            const state = ProjectManager.getState();
            const calculatedRequirements = {
                current: result.rectifierCurrent,
                voltage: result.rectifierVoltage,
                power: result.rectifierPower,
                currentSource: iccpCurrentSource,
                currentSourceLabel: iccpSourceLabel
            };
            const transformerRectifierSelection = window.TransformerRectifierEngine
                ? window.TransformerRectifierEngine.select(calculatedRequirements)
                : {
                    status: 'SELECTION_ENGINE_UNAVAILABLE',
                    requirements: calculatedRequirements,
                    compatibleCandidates: [],
                    rejectedCandidates: [],
                    selected: null,
                    criteria: [],
                    trace: 'Moteur de selection TR indisponible.'
                };
            state.iccp.calculatedRequirements = calculatedRequirements;
            state.iccp.transformerRectifierSelection = transformerRectifierSelection;
            const activeSystem = ProjectManager.getActiveSystem();
            if (transformerRectifierSelection.selected && activeSystem &&
                typeof ProjectManager.syncSelectedTransformerRectifier === 'function') {
                ProjectManager.syncSelectedTransformerRectifier(
                    activeSystem.id,
                    transformerRectifierSelection,
                    activeSystem.trCoordinates || activeSystem.rectifierCoordinates || null
                );
                if (window.UI && typeof window.UI.renderSystems === 'function') {
                    window.UI.renderSystems();
                }
                if (window.GisIntegration && typeof window.GisIntegration.loadPoints === 'function') {
                    window.GisIntegration.loadPoints(ProjectManager.getCurrentProjectId(), true);
                }
                if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                    window.Gis3D.loadData(ProjectManager.getCurrentProjectId());
                }
            }
            state.iccp.current = result.currentTotal;
            state.iccp.requiredCurrent = requiredCurrent;
            state.iccp.selectedCurrent = I_total;
            state.iccp.currentMarginRatio = currentMarginRatio;
            state.iccp.currentMarginPercent = currentMarginPercent;
            result.requiredCurrent = requiredCurrent;
            result.selectedCurrent = I_total;
            result.currentMarginRatio = currentMarginRatio;
            result.currentMarginPercent = currentMarginPercent;

            // P1-02 : state.iccp.power reçoit powerDesign
            state.iccp.power = result.powerDesign !== undefined
                ? result.powerDesign
                : result.powerInitial;
            state.iccp.powerInitial = result.powerInitial;
            state.iccp.powerDesign = result.powerDesign;
            state.iccp.safetyFactorPower = result.safetyFactorPower;

            // GAP-04 : Puissance AC réseau (pour dimensionnement transformateur)
            // P_AC = P_design / η_rectifier (η ≈ 0.85 par défaut, IEC 60146)
            if (result.rectifierPower && result.rectifierPower > 0) {
                const eta = 0.85;  // rendement typique redresseur industriel
                state.iccp.P_AC_required = result.rectifierPower / eta;
                state.iccp.rectifierEfficiency = eta;
            } else {
                state.iccp.P_AC_required = null;
                state.iccp.rectifierEfficiency = null;
            }

            state.iccp.voltage = result.voltageInitial;
            state.iccp.voltageFinal = result.voltageFinal;
            state.iccp.rectifierCurrent = result.rectifierCurrent;
            state.iccp.rectifierVoltage = result.rectifierVoltage;
            state.iccp.rectifierPower = result.rectifierPower;
            state.iccp.currentDensity = result.currentDensityAnode;
            state.iccp.currentDensity_mA = result.currentDensityAnode_mA;
            state.iccp.densityOk = result.densityOk;
            state.iccp.groundbedResistance = result.groundbedResistance || result.groupResistanceInitial;

            // P1-05 : lifeEstimate reçoit lifeDesign (plafonné)
            state.iccp.lifeEstimate = result.lifeDesign !== undefined
                ? result.lifeDesign
                : (result.lifeEstimate || 0);
            state.iccp.lifeTheoretical = result.lifeTheoretical || 0;
            state.iccp.lifeDesign = result.lifeDesign || 0;
            state.iccp.lifeDetails = result.lifeDetails || null;
            state.iccp.lifeValidationStatus = result.lifeValidationStatus || 'NOT_VALIDATED_MANUFACTURER_DATA_REQUIRED';

            state.iccp.iccpCurrentSource = iccpCurrentSource;
            state.iccp.iccpSourceLabel = iccpSourceLabel;

            state.iccp.calculationVersion = groundbedResult ? (gbId ? (ProjectManager.getGroundbedById(gbId)?.version || null) : null) : null;

            // P0-04 : Propagation des champs groundbed
            if (result.groundbedDetails) {
                state.iccp.R_groundbed_pure = result.groundbedDetails.R_groundbed_pure;
                state.iccp.R_well = result.groundbedDetails.R_well;
                state.iccp._includesCable = result._includesCable;
                state.iccp._includesStructure = result._includesStructure;
                state.iccp.groundbedModel = result.groundbedDetails.groundbedModel;
                state.iccp.groundbedDesignStatus = result.groundbedDetails.designStatus;
                state.iccp.groundbedRequiresSpecialistStudy = result.groundbedDetails.requiresSpecialistStudy;
                state.iccp.groundbedWarning = result.groundbedDetails._warning || null;
            }

            state.iccp.units = result.units || null;

            if (window.UI && typeof window.UI.displayICCPResults === 'function') {
                window.UI.displayICCPResults(result);
            }
            if (window.UI && typeof window.UI.displayRectifierResults === 'function') {
                window.UI.displayRectifierResults({
                    calculatedRequirements,
                    transformerRectifierSelection
                });
            }

            const sysId = document.getElementById('iccpSystemSelector')?.value;
            if (sysId) {
                ProjectManager.saveSystemResults(sysId, 'iccp', {
                    current: result.currentTotal,
                    voltage: result.voltageInitial,
                    rectifierCurrent: result.rectifierCurrent,
                    rectifierVoltage: result.rectifierVoltage,
                    rectifierPower: result.rectifierPower,
                    calculatedRequirements,
                    transformerRectifierSelection,
                    power: result.powerDesign || result.powerInitial,
                    powerDesign: result.powerDesign,
                    powerInitial: result.powerInitial,
                    voltageFinal: result.voltageFinal,
                    currentDensity: result.currentDensityAnode,
                    currentDensity_mA: result.currentDensityAnode_mA,
                    densityOk: result.densityOk,
                    groundbedResistance: result.groundbedResistance || result.groupResistanceInitial,
                    lifeEstimate: result.lifeDesign || result.lifeEstimate || 0,
                    lifeTheoretical: result.lifeTheoretical || 0,
                    lifeDesign: result.lifeDesign || 0,
                    iccpCurrentSource: iccpCurrentSource,
                    iccpSourceLabel: iccpSourceLabel,
                    groundbedModel: state.iccp.groundbedModel,
                    groundbedDesignStatus: state.iccp.groundbedDesignStatus,
                    groundbedRequiresSpecialistStudy: state.iccp.groundbedRequiresSpecialistStudy,
                    groundbedWarning: state.iccp.groundbedWarning,
                    calculationVersion: state.iccp.calculationVersion,
                    // GAP-04 : Puissance AC réseau
                    P_AC_required: state.iccp.P_AC_required || null,
                    rectifierEfficiency: state.iccp.rectifierEfficiency || null
                });
            }

            ProjectManager.saveCurrentProject();
            ProjectManager.addHistoryEntry('iccp', 'Calcul ICCP',
                `${result.currentTotal.toFixed(2)} A, ${result.voltageInitial.toFixed(1)} V (source: ${iccpSourceLabel})`);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(
                    `✅ ICCP calculé : ${result.currentTotal.toFixed(2)} A, ${result.voltageInitial.toFixed(1)} V (source: ${iccpSourceLabel})`,
                    'success'
                );
            }

            // Notification pour synchronisation groundbed + cable sync
            document.dispatchEvent(new CustomEvent('calculationCompleted', {
                detail: { type: 'iccp', current: result.currentTotal }
            }));
        } catch (err) {
            console.error('Erreur calculateICCP:', err);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`❌ Erreur : ${err.message}`, 'error');
            }
        }
    }

    // ============================================================
    // calculateGroundbed — v9.1 (INTÉGRATION ui-groundbed-consistency)
    // ============================================================
    function calculateGroundbed(editId) {
        try {
            // ============================================================
            // P0-05 : Distinction explicite rhoProject / rhoGroundbed
            // ============================================================
            const rhoGroundbed = getFieldValue('gbSoilResistivity', 'gbSoilResistivityManual');

            let rhoProject = 100;
            try {
                const state = ProjectManager.getState();
                if (state && state.project && state.project.shared &&
                    typeof state.project.shared.soilResistivity === 'number') {
                    rhoProject = state.project.shared.soilResistivity;
                } else if (state && state.project &&
                           typeof state.project.resistivity === 'number') {
                    rhoProject = state.project.resistivity;
                }
            } catch (e) {
                console.warn('[CPController] Impossible de récupérer rhoProject:', e);
            }

            // P0-05 : Avertissement si divergence significative
            if (rhoProject > 0 && rhoGroundbed > 0) {
                const ratio = rhoGroundbed / rhoProject;
                if (ratio < 0.5 || ratio > 2.0) {
                    console.warn('[CPController] P0-05 : Divergence résistivité détectée :',
                                 'rhoProject =', rhoProject, 'Ω·m,',
                                 'rhoGroundbed =', rhoGroundbed, 'Ω·m',
                                 '(ratio =', ratio.toFixed(2), ')');
                    console.warn('[CPController] P0-05 : Le groundbed utilise rhoGroundbed =',
                                 rhoGroundbed, 'Ω·m (couche d\'installation des anodes).');
                    console.warn('[CPController] P0-05 : Documenter la justification stratigraphique.');
                }
            }

            const totalDepth = getFieldValue('gbTotalDepth', 'gbTotalDepthManual');
            const diameter = getFieldValue('gbDiameter', 'gbDiameterManual');
            const activeDepth = getFieldValue('gbActiveDepth', 'gbActiveDepthManual');
            const anodeCount = getFieldValue('gbAnodeCount', 'gbAnodeCountManual');
            const anodeLength = getFieldValue('gbAnodeLength', 'gbAnodeLengthManual');
            const anodeDiameter_mm = getFieldValue('gbAnodeDiameter', 'gbAnodeDiameterManual');
            const anodeWeight = getFieldValue('gbAnodeWeight', 'gbAnodeWeightManual');
            const anodeCapacity = getFieldValue('gbAnodeCapacity', 'gbAnodeCapacityManual');
            const desiredLife = getFieldValue('gbAnodeLife', 'gbAnodeLifeManual');
            const cableLength = getFieldValue('gbCableLength', 'gbCableLengthManual');
            const cableSection = getFieldValue('gbCableSection', 'gbCableSectionManual');
            const agingFactor = getFieldValue('gbAgingFactor', 'gbAgingFactorManual');
            const safetyFactor = getFieldValue('gbSafetyFactor', 'gbSafetyFactorManual');

            const layersInput = document.getElementById('gbSoilLayers')?.value;
            let layers = null;
            if (layersInput) {
                const parts = layersInput.split(',').map(s => parseFloat(s.trim())).filter(v => !isNaN(v));
                if (parts.length > 0) {
                    const totalLayersDepth = totalDepth;
                    layers = parts.map((rhoVal) => ({
                        depth: totalLayersDepth / parts.length,
                        rho: rhoVal
                    }));
                }
            }

            // ============================================================
            // ⭐ v9.1 : INTÉGRATION ui-groundbed-consistency-patch v2.1
            // ------------------------------------------------------------
            // AVANT : targetCurrent lu directement dans #gbTargetCurrent.
            // APRÈS :  targetCurrent résolu via priorité ICCP > CP > Surface.
            //
            // Justification :
            //   - Le calcul ICCP produit le courant de conception réel.
            //   - Le calcul CP est un fallback acceptable.
            //   - La surface × densité est le dernier recours.
            //
            // Le champ #gbTargetCurrent est FORCÉ avec la valeur résolue
            // AVANT le calcul pour garantir la cohérence.
            // ============================================================
            const J_cp = getFieldValue('cpCurrentDensitySelect', 'cpCurrentDensityManual');
            const resolved = resolveGroundbedTargetCurrent(J_cp);

            console.log('[CPController] v9.1 : Target current resolved →',
                        resolved.source, '=', resolved.value.toFixed(3), 'A');

            // Forcer le champ DOM avec la valeur résolue
            if (resolved.value > 0) {
                applyTargetToField(resolved.value, resolved.source, resolved.label);
            }

                        // Déterminer la valeur de targetCurrent à utiliser :
            //   - Si une source prioritaire (ICCP/CP/Surface) est disponible → utiliser cette valeur
            //   - Sinon → lire depuis le DOM (comportement original manuel)
            let targetCurrent;
            if (resolved.value > 0 && resolved.source !== 'none') {
                targetCurrent = resolved.value;
            } else {
                targetCurrent = getFieldValue('gbTargetCurrent', '');
            }

            // BUG-CP-004 : lecture du matériau d'anode pour la résolution
            //              de la densité limite (Mg=20, Zn=10, Al=50 A/m²).
            //              Le champ #gbAnodeMaterial est optionnel : s'il est
            //              absent, 'default' sera utilisé (fallback prudent
            //              à ANODE_DENSITY_LIMITS.default = 30 A/m²).
            const gbAnodeMaterialEl = document.getElementById('gbAnodeMaterial');
            const anodeMaterial = gbAnodeMaterialEl
                ? (gbAnodeMaterialEl.value || 'Mg_HC')
                : 'Mg_HC';

            const params = {
                rho: rhoGroundbed,
                totalDepth, activeDepth, anodeCount, anodeLength,
                anodeDiameter: anodeDiameter_mm,
                anodeWeight, anodeCapacity, cableLength, cableSection,
                agingFactor, safetyFactor,
                targetCurrent: targetCurrent || 0,
                desiredLife: desiredLife,
                layers: layers,
                structureResistance: getFieldValue('structureResistance', 'structureResistanceManual'),
                rhoProject: rhoProject,
                rhoGroundbed: rhoGroundbed,
                // BUG-CP-004 : matériau anode transmis à designGroundbed
                //              pour _resolveAnodeDensityLimit()
                anodeMaterial: anodeMaterial
            };

            const result = CalculationEngine.designGroundbed(params);

            if (result && result.error) {
                throw new Error(result.message);
            }

            const state = ProjectManager.getState();
            state.groundbed.results = result;

            // P0-02 : propagation des unités canoniques
            state.groundbed.results.units = result.units || null;

            // P0-05 : traçabilité résistivité
            state.groundbed.results.rhoProject = rhoProject;
            state.groundbed.results.rhoGroundbed = rhoGroundbed;

            // v9.1 : traçabilité de la source du courant cible
            state.groundbed.results.targetCurrentSource = resolved.source;
            state.groundbed.results.targetCurrentLabel = resolved.label;

            if (window.UI && typeof window.UI.displayGroundbedResults === 'function') {
                window.UI.displayGroundbedResults(result, totalDepth, activeDepth, anodeCount, anodeLength);
            }

            const name = document.getElementById('gbName')?.value || 'Puits anodique';
            const projectId = document.getElementById('gbProjectSelect')?.value || ProjectManager.getCurrentProjectId();
            if (editId) {
                ProjectManager.updateGroundbed(editId, {
                    name: name,
                    parameters: params,
                    results: result,
                    coordinates: null
                });
            } else {
                ProjectManager.createGroundbed(name, params, result);
            }

            const sysId = document.getElementById('gbSystemSelector')?.value;
            if (sysId) {
                ProjectManager.saveSystemResults(sysId, 'groundbed', {
                    R_total: result.R_total,
                    R_group: result.R_group,
                    R_well: result.R_well,
                    R_groundbed_pure: result.R_groundbed_pure,
                    R_cable: result.R_cable,
                    R_struct: result.R_struct,
                    I_total: result.I_total,
                    V_rectifier: result.V_rectifier,
                    P_rectifier: result.P_rectifier,
                    J_anode: result.J_anode,
                    J_anode_mA: result.J_anode_mA,
                    densityLimit: result.densityLimit,
                    densityOk: result.densityOk,
                    lifeWithSafety: result.lifeWithSafety,
                    desiredLife: result.desiredLife,
                    requiredAnodeCount: result.requiredAnodeCount,
                    lifeOk: result.lifeOk,
                    totalMass: result.totalMass,
                    anodeCount: result.anodeCount,
                    rhoProject: rhoProject,
                    rhoGroundbed: rhoGroundbed,
                    // v9.1 : source du courant cible
                    targetCurrentSource: resolved.source
                });

                // v9.1 : sauvegarder également dans les params du système
                const sys = ProjectManager.getSystem(sysId);
                if (sys) {
                    const gbParams = ProjectManager.loadSystemParams(sysId, 'groundbed') || {};
                    gbParams.targetCurrent = targetCurrent;
                    gbParams.targetCurrentSource = resolved.source;
                    ProjectManager.saveSystemParams(sysId, 'groundbed', gbParams);
                }
            }

            ProjectManager.saveCurrentProject();
            ProjectManager.addHistoryEntry('groundbed', `Calcul groundbed ${name}`,
                `R=${result.R_total.toFixed(4)} Ω (source: ${resolved.label})`);
            if (window.UI && typeof window.UI.renderGroundbedList === 'function') window.UI.renderGroundbedList();
            if (window.UI && typeof window.UI.populateICCPGroundbedSelectors === 'function') window.UI.populateICCPGroundbedSelectors();
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(
                    `✅ Groundbed calculé : R=${result.R_total.toFixed(4)} Ω, I=${result.I_total.toFixed(2)} A (source: ${resolved.label})`,
                    'success'
                );
            }
        } catch (err) {
            console.error('Erreur calculateGroundbed:', err);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`❌ Erreur : ${err.message}`, 'error');
            }
        }
    }

    function calculateInterference() {
        try {
            const acVoltage = getFieldValue('ifACVoltage', 'ifACVoltageManual');
            const acCurrent = getFieldValue('ifACCurrent', 'ifACCurrentManual');
            const acFrequency = getFieldValue('ifACFrequency', 'ifACFrequencyManual');
            const acDistance = getFieldValue('ifACDistance', 'ifACDistanceManual');
            const acParallel = getFieldValue('ifACParallel', 'ifACParallelManual');
            const acSoilCond = getFieldValue('ifACSoilConductivity', 'ifACSoilConductivityManual');
            // The interference engine expects pipeDiameter in millimetres.
            const pipeDiameter = getFieldValue('ifPipeDiameter', 'ifPipeDiameterManual');
            const pipeLength = getFieldValue('ifPipeLength', 'ifPipeLengthManual');
            const coatingRes = getFieldValue('ifCoatingResistance', 'ifCoatingResistanceManual');
            const dcCurrent = getFieldValue('ifDCCurrent', '');
            const dcPotON = getFieldValue('ifDCPotentialON', '');
            const dcDistance = getFieldValue('ifDCDistance', 'ifDCDistanceManual');
            const dcSeparation = getFieldValue('ifDCSeparation', 'ifDCSeparationManual');
            const dcSoilResistivity = getFieldValue('ifDCSoilResistivity', 'ifDCSoilResistivityManual');
            const victimPotInit = getFieldValue('ifVictimPotInit', 'ifVictimPotInitManual');
            const victimPotFinal = getFieldValue('ifVictimPotFinal', 'ifVictimPotFinalManual');
            const J_AC = getFieldValue('ifJAC', 'ifJACManual');
            const J_DC = getFieldValue('ifJDC', 'ifJDCManual');

            const params = {
                acVoltage, acCurrent, acFrequency, acDistance, acParallel, acSoilCond,
                pipeDiameter, pipeLength, coatingRes,
                dcCurrent, dcPotON, dcDistance, dcSeparation, dcSoilResistivity,
                victimPotInit, victimPotFinal, J_AC, J_DC
            };

            const result = CalculationEngine.analyzeInterference(params);

            const state = ProjectManager.getState();
            state.interference.results = result;
            state.interference.results.J_AC = result.J_AC;
            state.interference.results.J_DC = result.J_DC;

            if (window.UI && typeof window.UI.displayInterferenceResults === 'function') {
                window.UI.displayInterferenceResults(result);
            }

            const sysId = document.getElementById('ifSystemSelector')?.value;
            if (sysId) {
                ProjectManager.saveSystemResults(sysId, 'interference', {
                    acInduced: result.acInduced,
                    touchVoltage: result.touchVoltage,
                    acStatus: result.acStatus,
                    deltaV: result.deltaV,
                    dcStray: result.dcStray,
                    dcStatus: result.dcStatus,
                    globalStatus: result.globalStatus,
                    mitigations: result.mitigations
                });
            }

            ProjectManager.saveCurrentProject();
            ProjectManager.addHistoryEntry('interference', 'Analyse interférences', result.globalStatus);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`✅ Interférences analysées : ${result.globalStatus}`, 'success');
            }
        } catch (err) {
            console.error('Erreur calculateInterference:', err);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`❌ Erreur : ${err.message}`, 'error');
            }
        }
    }

        // ============================================================
    // calculateEquipmentCP — SSOT du calcul CP par équipement
    // ------------------------------------------------------------
    // ROLE.txt §4 : la logique métier du calcul CP par équipement
    // était dupliquée dans ui.js (_calculateEquipmentCPFallback).
    // Elle est désormais centralisée dans la couche métier.
    // ============================================================
    function calculateEquipmentCP(equipId) {
        try {
            const eq = ProjectManager.getState().equipments.find(e => e.id === equipId);
            if (!eq) {
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('Équipement introuvable', 'error');
                }
                return null;
            }

            // ---- 1. Géométrie / surface ----
            const ouvrageFields = typeof CalculationEngine.getOuvrageFields === 'function'
                ? CalculationEngine.getOuvrageFields(eq.type)
                : [];
            const calculatedSurface = ouvrageFields.length > 0 &&
                typeof CalculationEngine.computeEquipmentSurface === 'function'
                ? CalculationEngine.computeEquipmentSurface(eq.type, eq.dimensions || {})
                : 0;
            const S = calculatedSurface > 0
                ? calculatedSurface
                : Utils.safeNumber(eq.surface);
            if (S <= 0) {
                throw new Error('Surface invalide (doit être > 0)');
            }

            // Keep the persisted equipment surface aligned with its dimensions.
            if (calculatedSurface > 0 && Math.abs(Utils.safeNumber(eq.surface) - calculatedSurface) > 1e-9) {
                eq.surface = calculatedSurface;
            }

            // ---- 2. Paramètres CP (SSOT via getFieldValue) ----
            const DF = getFieldValue('defectDensity', 'defectDensityManual');
            const k = getFieldValue('agingFactor', 'agingFactorManual');
            const J = getFieldValue('cpCurrentDensitySelect', 'cpCurrentDensityManual');
            const eps = getFieldValue('cpCoatingSelect', 'cpCoatingManual');
            const norm = ProjectManager.getState().project.norm || 'ISO 15589-1';

            // ---- 3. Courant requis (délégué à engine.js) ----
            const result = CalculationEngine.requiredCurrent(S, J, eps, DF, k, norm);
            const I = result.currentAmperes;
            const exposedArea = result.exposedArea;

            // ---- 4. Résistances ----
            const rho = getFieldValue('cpResistivitySelect', 'cpResistivityManual');
            const anodeLength = getFieldValue('anodeLengthSelect', 'anodeLengthManual');
            const anodeDiameter = getFieldValue('anodeDiameterSelect', 'anodeDiameterManual');
            let R_anode = 0;
            if (rho > 0 && anodeLength > 0 && anodeDiameter > 0) {
                R_anode = CalculationEngine.anodeResistanceVertical(rho, anodeLength, anodeDiameter);
            }

            const L_cable = getFieldValue('cableLength', 'cableLengthManual');
            const S_cable = getFieldValue('cableSection', 'cableSectionManual');
            let R_cable = 0;
            if (L_cable > 0 && S_cable > 0) {
                const isTotal = document.getElementById('cableLength')?.dataset?.isTotal === 'true' ||
                                ProjectManager.getState()?.shared?.cableLengthIsTotal === true;
                const cablePathFactor = isTotal ? 1 : 2;
                R_cable = (cablePathFactor * RHO_CU * L_cable) / S_cable;
            }

            const R_struct = getFieldValue('structureResistance', 'structureResistanceManual');
            const R_total = R_anode + R_cable + R_struct;
            const irDropVolts = I * R_total;
            const targetOffMv = ProjectManager.getState().project.targetPotential || -850;
            const requiredOnMv = targetOffMv - (irDropVolts * 1000);

            // ---- 5. Persistance sur l'équipement ----
            eq.cpData.parameters = {
                S, DF, k, J, eps, rho,
                anodeLength, anodeDiameter,
                L_cable, S_cable, R_struct,
                targetOffMv, norm
            };
            eq.cpData.results = {
                currentAmperes: I,
                exposedArea: exposedArea,
                R_anode: R_anode,
                R_cable: R_cable,
                R_struct: R_struct,
                R_total: R_total,
                irDropVolts: irDropVolts,
                requiredOnMv: requiredOnMv,
                timestamp: new Date().toISOString()
            };
            eq.cpData.calculated = true;
            eq.cpData.lastCalculationDate = new Date().toISOString();

            // ---- 6. Sauvegarde + invalidation caches ----
            ProjectManager.saveEquipment(eq);
            ProjectManager.invalidateSystemCurrentCache();
            ProjectManager.invalidateSurfaceCache();

            const equipmentCurrent = getTotalEquipmentCurrent();
            const projectState = ProjectManager.getState();
            if (!projectState.cp) projectState.cp = {};
            projectState.cp.current = equipmentCurrent;
            if (projectState.project) projectState.project.currentRequired = equipmentCurrent;

            // ---- 7. UI refresh ----
            if (window.UI) {
                if (typeof window.UI.refreshEquipmentListUI === 'function') {
                    window.UI.refreshEquipmentListUI(true);
                }
                if (typeof window.UI.updateDashboard === 'function') {
                    window.UI.updateDashboard();
                }
                if (typeof window.UI.updateAnodeCurrentSource === 'function') {
                    window.UI.updateAnodeCurrentSource();
                }
                if (typeof window.UI.updateICCPCurrentSource === 'function') {
                    window.UI.updateICCPCurrentSource();
                }
                syncGroundbedTargetCurrent();
                if (typeof window.UI.syncSurfaceFromEquipments === 'function') {
                    window.UI.syncSurfaceFromEquipments();
                }
                if (typeof window.UI.showToast === 'function') {
                    window.UI.showToast(
                        'CP calculé pour ' + Utils.escapeHtml(eq.tag) +
                        ' : ' + I.toFixed(3) + ' A (' + Utils.escapeHtml(norm) + ')',
                        'success'
                    );
                }
            }

            ProjectManager.saveCurrentProject();
            ProjectManager.addHistoryEntry('cp', 'Calcul CP ' + eq.tag, I.toFixed(3) + ' A, ' + norm);

            return eq.cpData.results;

        } catch (err) {
            console.error('[CPController] Erreur calculateEquipmentCP:', err);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('Erreur calcul CP équipement : ' + err.message, 'error');
            }
            return null;
        }
    }

    // ============================================================
    // MÉTHODES SPÉCIFIQUES (non déléguées)
    // ============================================================

    function getTotalEquipmentCurrent() {
        let total = 0;
        const state = ProjectManager.getState();
        const projectId = ProjectManager.getCurrentProjectId();
        const equipments = state.equipments.filter(eq => eq.projectId === projectId && eq.included !== false);
        equipments.forEach(eq => {
            if (eq.cpData && eq.cpData.calculated && typeof eq.cpData.results.currentAmperes === 'number') {
                total += eq.cpData.results.currentAmperes;
                return;
            }

            // Fallback ciblé pour conserver les équipements protégés dans le
            // courant ICCP global lorsqu'ils n'ont pas encore été calculés
            // individuellement (notamment le fond d'un réservoir).
            const supportedTypes = [
                'pipeline_enterre', 'pipeline_offshore',
                'reservoir_fond', 'reservoir_toit', 'tank', 'reservoir'
            ];
            if (!supportedTypes.includes(eq.type) ||
                typeof CalculationEngine.calculateEquipmentResistances !== 'function' ||
                typeof CalculationEngine.requiredCurrent !== 'function') return;

            try {
                const resistance = CalculationEngine.calculateEquipmentResistances(
                    eq,
                    Number(eq.soilResistivity) > 0 ? Number(eq.soilResistivity) : undefined
                );
                const area = Number(resistance?.soilContactArea || resistance?.surfaceArea || 0);
                const currentDensity = Number(eq.currentDensity ?? 10);
                if (area <= 0 || currentDensity <= 0) return;
                const result = CalculationEngine.requiredCurrent(
                    area,
                    currentDensity,
                    Number(eq.coatingEfficiency ?? 0.95),
                    Number(eq.defectDensity ?? 0.05),
                    Number(eq.agingFactor ?? 1.2),
                    eq.norm || (eq.type === 'reservoir_fond' || eq.type === 'reservoir_toit'
                        ? 'API RP 651' : 'ISO 15589-1')
                );
                if (result && Number.isFinite(result.currentAmperes) && result.currentAmperes > 0) {
                    total += result.currentAmperes;
                }
            } catch (e) {
                console.warn('[CPController] Courant équipement non calculé:', e.message);
            }
        });
        return total;
    }

    function applyEquipmentTotalToCP() {
        const total = getTotalEquipmentCurrent();
        if (total > 0) {
            const resCurrent = document.getElementById('resCurrent');
            if (resCurrent) resCurrent.innerText = total.toFixed(3);
            ProjectManager.getState().cp.current = total;
            ProjectManager.getState().project.currentRequired = total;
            ProjectManager.saveCurrentProject();
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`Courant cumulé (${total.toFixed(3)} A) appliqué au CP`, 'success');
            }
        } else {
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('Aucun courant cumulé disponible (calculez d\'abord les équipements)', 'warning');
            }
        }
    }

    function syncSurfaceFromEquipments() {
        const total = ProjectManager.getTotalEquipmentSurface();
        const cpSurface = document.getElementById('cpSurface');
        const iccpSurface = document.getElementById('iccpSurface');
        const sumDisplay = document.getElementById('sumSurface');
        if (cpSurface) cpSurface.value = total.toFixed(2);
        if (iccpSurface) iccpSurface.value = total.toFixed(2);
        if (sumDisplay) sumDisplay.innerText = total.toFixed(1);
        ProjectManager.getState().project.surface = total;
        if (window.UI && typeof window.UI.showToast === 'function') {
            window.UI.showToast(`Surface synchronisée : ${total.toFixed(2)} m²`, 'info');
        }
        ProjectManager.saveCurrentProject();
    }

    function updateAnodeCurrentSource() {
        if (window.UI && typeof window.UI.updateAnodeCurrentSource === 'function') {
            window.UI.updateAnodeCurrentSource();
        } else {
            console.debug('[CPController] UI.updateAnodeCurrentSource non disponible');
        }
    }

    function updateICCPCurrentSource() {
        if (window.UI && typeof window.UI.updateICCPCurrentSource === 'function') {
            window.UI.updateICCPCurrentSource();
        } else {
            console.debug('[CPController] UI.updateICCPCurrentSource non disponible');
        }
    }

    function syncGroundbedFromCP() {
        if (window.UI && typeof window.UI.syncGroundbedFromCP === 'function') {
            window.UI.syncGroundbedFromCP();
        } else {
            console.debug('[CPController] UI.syncGroundbedFromCP non disponible');
        }
    }

    function syncInterferenceFromCP() {
        if (window.UI && typeof window.UI.syncInterferenceFromCP === 'function') {
            window.UI.syncInterferenceFromCP();
        } else {
            console.debug('[CPController] UI.syncInterferenceFromCP non disponible');
        }
    }

    function checkConsistency() {
        if (window.UI && typeof window.UI.checkConsistency === 'function') {
            return window.UI.checkConsistency();
        }
        console.debug('[CPController] UI.checkConsistency non disponible');
        return null;
    }

    function validateSystem() {
        if (window.UI && typeof window.UI.validateSystem === 'function') {
            return window.UI.validateSystem();
        }
        console.debug('[CPController] UI.validateSystem non disponible');
        return null;
    }

    function generateValidationReport() {
        const result = validateSystem();
        if (result) {
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`Rapport de validation : ${result.globalPass ? '✅ PASS' : '❌ FAIL'}`, result.globalPass ? 'success' : 'error');
            }
            return result;
        }
        return null;
    }

    async function exportPDF() {
        if (typeof window.PDFReport !== 'undefined' && typeof window.PDFReport.generate === 'function') {
            try {
                let projectId = ProjectManager.getCurrentProjectId();
                const selector = document.getElementById('projectSelector');
                const selectedProjectId = selector && selector.value && selector.value !== '__all__'
                    ? selector.value
                    : null;

                if (!projectId && selectedProjectId && typeof ProjectManager.loadProject === 'function') {
                    await ProjectManager.loadProject(selectedProjectId);
                    projectId = ProjectManager.getCurrentProjectId();
                }

                if (!projectId) {
                    throw new Error('Veuillez sélectionner un projet avant de générer le rapport PDF.');
                }

                await window.PDFReport.generate(projectId);
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('✅ Rapport PDF généré', 'success');
                }
            } catch (err) {
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast(`❌ Erreur PDF : ${err.message}`, 'error');
                }
            }
        } else {
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('⚠️ Module PDF non chargé.', 'warning');
            }
        }
    }

    function exportGlobalReport() {
        if (window.UI && typeof window.UI.exportGlobalReport === 'function') {
            window.UI.exportGlobalReport();
        } else {
            console.debug('[CPController] UI.exportGlobalReport non disponible');
        }
    }

    function exportGroundbedPDF() {
        if (window.UI && typeof window.UI.exportGroundbedPDF === 'function') {
            window.UI.exportGroundbedPDF();
        } else {
            console.debug('[CPController] UI.exportGroundbedPDF non disponible');
        }
    }

    function exportInterferencePDF() {
        if (window.UI && typeof window.UI.exportInterferencePDF === 'function') {
            window.UI.exportInterferencePDF();
        } else {
            console.debug('[CPController] UI.exportInterferencePDF non disponible');
        }
    }

    function updateDashboard() {
        if (window.UI && typeof window.UI.updateDashboard === 'function') {
            window.UI.updateDashboard();
        } else {
            console.debug('[CPController] UI.updateDashboard non disponible');
        }
    }

    function renderSystems() {
        if (window.UI && typeof window.UI.renderSystems === 'function') {
            window.UI.renderSystems();
        } else {
            console.debug('[CPController] UI.renderSystems non disponible');
        }
    }

    function populateAllSystemSelectors() {
        if (window.UI && typeof window.UI.populateAllSystemSelectors === 'function') {
            window.UI.populateAllSystemSelectors();
        } else {
            console.debug('[CPController] UI.populateAllSystemSelectors non disponible');
        }
    }

    function refreshEquipmentList() {
        if (window.UI && typeof window.UI.refreshEquipmentList === 'function') {
            window.UI.refreshEquipmentList();
        } else {
            console.debug('[CPController] UI.refreshEquipmentList non disponible');
        }
    }

    function refreshFieldMeasurementsTable() {
        if (window.UI && typeof window.UI.refreshFieldMeasurementsTable === 'function') {
            window.UI.refreshFieldMeasurementsTable();
        } else {
            console.debug('[CPController] UI.refreshFieldMeasurementsTable non disponible');
        }
    }

    function refreshAssetDropdownForFieldMeas() {
        if (window.UI && typeof window.UI.refreshAssetDropdownForFieldMeas === 'function') {
            window.UI.refreshAssetDropdownForFieldMeas();
        } else {
            console.debug('[CPController] UI.refreshAssetDropdownForFieldMeas non disponible');
        }
    }

    function updateCorrosivity() {
        if (window.UI && typeof window.UI.updateCorrosivity === 'function') {
            window.UI.updateCorrosivity();
        } else {
            console.debug('[CPController] UI.updateCorrosivity non disponible');
        }
    }

    function populateProjectSelector() {
        if (window.UI && typeof window.UI.populateProjectSelector === 'function') {
            window.UI.populateProjectSelector();
        } else {
            console.debug('[CPController] UI.populateProjectSelector non disponible');
        }
    }

    function populateGroundbedProjectSelect() {
        if (window.UI && typeof window.UI.populateGroundbedProjectSelect === 'function') {
            window.UI.populateGroundbedProjectSelect();
        } else {
            console.debug('[CPController] UI.populateGroundbedProjectSelect non disponible');
        }
    }

    function populateInterferenceProjectSelect() {
        if (window.UI && typeof window.UI.populateInterferenceProjectSelect === 'function') {
            window.UI.populateInterferenceProjectSelect();
        } else {
            console.debug('[CPController] UI.populateInterferenceProjectSelect non disponible');
        }
    }

    function populatePipelineSelects() {
        if (window.UI && typeof window.UI.populatePipelineSelects === 'function') {
            window.UI.populatePipelineSelects();
        } else {
            console.debug('[CPController] UI.populatePipelineSelects non disponible');
        }
    }

    function refreshHistoryTable() {
        if (window.UI && typeof window.UI.refreshHistoryTable === 'function') {
            window.UI.refreshHistoryTable();
        } else {
            console.debug('[CPController] UI.refreshHistoryTable non disponible');
        }
    }

    function loadHistory() {
        if (window.UI && typeof window.UI.loadHistory === 'function') {
            window.UI.loadHistory();
        } else {
            console.debug('[CPController] UI.loadHistory non disponible');
        }
    }

    function drawGroundbedVisual(totalDepth, activeDepth, anodeCount, anodeLength, spacing) {
        if (window.UI && typeof window.UI.drawGroundbedVisual === 'function') {
            window.UI.drawGroundbedVisual(totalDepth, activeDepth, anodeCount, anodeLength, spacing);
        } else {
            console.debug('[CPController] UI.drawGroundbedVisual non disponible');
        }
    }

    function updateEquipTypeOptions() {
        if (window.UI && typeof window.UI.updateEquipTypeOptions === 'function') {
            window.UI.updateEquipTypeOptions();
        } else {
            console.debug('[CPController] UI.updateEquipTypeOptions non disponible');
        }
    }

    function updateEquipDimensionsFields() {
        if (window.UI && typeof window.UI.updateEquipDimensionsFields === 'function') {
            window.UI.updateEquipDimensionsFields();
        } else {
            console.debug('[CPController] UI.updateEquipDimensionsFields non disponible');
        }
    }

    function computeEquipSurface() {
        if (window.UI && typeof window.UI.computeEquipSurface === 'function') {
            return window.UI.computeEquipSurface();
        }
        console.debug('[CPController] UI.computeEquipSurface non disponible');
        return 0;
    }

    function updateDimensionsFields() {
        if (window.UI && typeof window.UI.updateDimensionsFields === 'function') {
            window.UI.updateDimensionsFields();
        } else {
            console.debug('[CPController] UI.updateDimensionsFields non disponible');
        }
    }

    function autoFillFromEnvironment() {
        if (window.UI && typeof window.UI.autoFillFromEnvironment === 'function') {
            window.UI.autoFillFromEnvironment();
        } else {
            console.debug('[CPController] UI.autoFillFromEnvironment non disponible');
        }
    }

    function initDashboardCharts() {
        if (window.UI && typeof window.UI.initDashboardCharts === 'function') {
            window.UI.initDashboardCharts();
        } else {
            console.debug('[CPController] UI.initDashboardCharts non disponible');
        }
    }

    function setModulesActivation(type) {
        if (window.UI && typeof window.UI.setModulesActivation === 'function') {
            window.UI.setModulesActivation(type);
        } else {
            console.debug('[CPController] UI.setModulesActivation non disponible');
        }
    }

    function scheduleRenderSystems() {
        if (window.UI && typeof window.UI.renderSystems === 'function') {
            window.UI.renderSystems();
        } else {
            console.debug('[CPController] UI.renderSystems non disponible');
        }
    }

    function updateGroundbedTargetCurrent() {
        if (window.UI && typeof window.UI.updateGroundbedTargetCurrent === 'function') {
            window.UI.updateGroundbedTargetCurrent();
        } else {
            console.debug('[CPController] UI.updateGroundbedTargetCurrent non disponible');
        }
    }

    function generateTestPosts() {
        if (window.UI && typeof window.UI.generateTestPosts === 'function') {
            window.UI.generateTestPosts();
        } else {
            console.debug('[CPController] UI.generateTestPosts non disponible');
        }
    }

    function exportPostsPDF() {
        if (window.UI && typeof window.UI.exportPostsPDF === 'function') {
            window.UI.exportPostsPDF();
        } else {
            console.debug('[CPController] UI.exportPostsPDF non disponible');
        }
    }

    function exportPostsCSV() {
        if (window.UI && typeof window.UI.exportPostsCSV === 'function') {
            window.UI.exportPostsCSV();
        } else {
            console.debug('[CPController] UI.exportPostsCSV non disponible');
        }
    }

    function calculateCableSection() {
        if (window.UI && typeof window.UI.calculateCableSection === 'function') {
            window.UI.calculateCableSection();
        } else {
            console.debug('[CPController] UI.calculateCableSection non disponible');
        }
    }

    function applyCableToICCP() {
        if (window.UI && typeof window.UI.applyCableToICCP === 'function') {
            window.UI.applyCableToICCP();
        } else {
            console.debug('[CPController] UI.applyCableToICCP non disponible');
        }
    }

    function suggestStandards() {
        if (window.UI && typeof window.UI.suggestStandards === 'function') {
            window.UI.suggestStandards();
        } else {
            console.debug('[CPController] UI.suggestStandards non disponible');
        }
    }

    function generateSoilFromResistivity() {
        if (window.UI && typeof window.UI.generateSoilFromResistivity === 'function') {
            window.UI.generateSoilFromResistivity();
        } else {
            console.debug('[CPController] UI.generateSoilFromResistivity non disponible');
        }
    }

    function generateWaterFromEnvironment() {
        if (window.UI && typeof window.UI.generateWaterFromEnvironment === 'function') {
            window.UI.generateWaterFromEnvironment();
        } else {
            console.debug('[CPController] UI.generateWaterFromEnvironment non disponible');
        }
    }

    // ============================================================
    // MÉTHODES GIS (délégation à GisIntegration et Gis3D)
    // ============================================================

    function initMap() {
        if (typeof GisIntegration !== 'undefined' && typeof GisIntegration.init === 'function') {
            GisIntegration.init('mapContainer');
            GisIntegration.loadPoints();
        } else {
            console.debug('[CPController] GisIntegration non disponible');
        }
    }

    function loadMapPoints() {
        if (typeof GisIntegration !== 'undefined' && typeof GisIntegration.loadPoints === 'function') {
            GisIntegration.loadPoints();
        } else {
            console.debug('[CPController] GisIntegration non disponible');
        }
    }

    function addMapPoint(type, name, lat, lon) {
        if (typeof GisIntegration !== 'undefined' && typeof GisIntegration.addPoint === 'function') {
            return GisIntegration.addPoint(type, name, lat, lon);
        }
        console.debug('[CPController] GisIntegration.addPoint non disponible');
        return null;
    }

    function centerMap() {
        if (typeof GisIntegration !== 'undefined' && typeof GisIntegration.getMap === 'function') {
            const map = GisIntegration.getMap();
            if (map) {
                const ref = (typeof CoordSystem !== 'undefined' && CoordSystem.getReference) ? CoordSystem.getReference() : { lat: 30.123456, lon: 8.123456 };
                map.setView([ref.lat, ref.lon], 5);
            }
        } else {
            console.debug('[CPController] GisIntegration non disponible');
        }
    }

    function exportMapData() {
        if (typeof GisIntegration !== 'undefined' && typeof GisIntegration.exportGeoJSON === 'function') {
            const geojson = GisIntegration.exportGeoJSON();
            if (geojson) {
                const blob = new Blob([geojson], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `map_points_${ProjectManager.getCurrentProjectId()}.geojson`;
                a.click();
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('✅ Données cartographiques exportées', 'success');
                }
            } else {
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('⚠️ Aucun point à exporter.', 'warning');
                }
            }
        } else {
            console.debug('[CPController] GisIntegration.exportGeoJSON non disponible');
        }
    }

    // ============================================================
    // ZONES DE RENFORCEMENT
    // ============================================================

    function addReinforcementZone(name, location, problemType, criticality, additionalCurrent) {
        const zones = ProjectManager.getState().iccp.reinforcementZones || [];
        const zone = { id: Utils.generateId(), name, location, problemType, criticality, additionalCurrent };
        zones.push(zone);
        ProjectManager.getState().iccp.reinforcementZones = zones;
        if (window.UI && typeof window.UI.renderReinforcementZones === 'function') {
            window.UI.renderReinforcementZones();
        }
        ProjectManager.saveCurrentProject();
        ProjectManager.addHistoryEntry('iccp', `Ajout zone critique ${name}`, `${additionalCurrent} A`);
        if (window.UI && typeof window.UI.showToast === 'function') {
            window.UI.showToast(`Zone "${name}" ajoutée.`, 'success');
        }
    }

    function analyzeReinforcementNeeds() {
        if (window.UI && typeof window.UI.analyzeReinforcementNeeds === 'function') {
            window.UI.analyzeReinforcementNeeds();
        } else {
            console.debug('[CPController] UI.analyzeReinforcementNeeds non disponible');
        }
    }

    function autoDetectZones() {
        if (window.UI && typeof window.UI.autoDetectZones === 'function') {
            window.UI.autoDetectZones();
        } else {
            console.debug('[CPController] UI.autoDetectZones non disponible');
        }
    }

    function renderReinforcementZones() {
        if (window.UI && typeof window.UI.renderReinforcementZones === 'function') {
            window.UI.renderReinforcementZones();
        } else {
            console.debug('[CPController] UI.renderReinforcementZones non disponible');
        }
    }

    function renderGroundbedList() {
        if (window.UI && typeof window.UI.renderGroundbedList === 'function') {
            window.UI.renderGroundbedList();
        } else {
            console.debug('[CPController] UI.renderGroundbedList non disponible');
        }
    }

    function populateICCPGroundbedSelectors() {
        if (window.UI && typeof window.UI.populateICCPGroundbedSelectors === 'function') {
            window.UI.populateICCPGroundbedSelectors();
        } else {
            console.debug('[CPController] UI.populateICCPGroundbedSelectors non disponible');
        }
    }

    function openGroundbedForm(id) {
        if (window.UI && typeof window.UI.openGroundbedForm === 'function') {
            window.UI.openGroundbedForm(id);
        } else {
            console.debug('[CPController] UI.openGroundbedForm non disponible');
        }
    }

    function populateResistiveParams() {
        if (window.UI && typeof window.UI.populateResistiveParams === 'function') {
            window.UI.populateResistiveParams();
        } else {
            console.debug('[CPController] UI.populateResistiveParams non disponible');
        }
    }

    function applyResistiveModel() {
        if (window.UI && typeof window.UI.applyResistiveModel === 'function') {
            window.UI.applyResistiveModel();
        } else {
            console.debug('[CPController] UI.applyResistiveModel non disponible');
        }
    }

    function syncSharedParams() {
        if (window.UI && typeof window.UI.updateSyncBadges === 'function') {
            window.UI.updateSyncBadges();
        } else {
            console.debug('[CPController] UI.updateSyncBadges non disponible');
        }
    }

    function updateDerivedFields() {
        if (window.UI && typeof window.UI.updateDerivedFields === 'function') {
            window.UI.updateDerivedFields();
        } else {
            console.debug('[CPController] UI.updateDerivedFields non disponible');
        }
    }

    function toggleSharedLock(key) {
        if (window.UI && typeof window.UI.toggleSharedLock === 'function') {
            window.UI.toggleSharedLock(key);
        } else {
            console.debug('[CPController] UI.toggleSharedLock non disponible');
        }
    }

    // ============================================================
    // SYNCHRONISATION GIS/3D AVEC GUARDS ROBUSTES
    // ============================================================

    function syncAllEquipmentToGIS() {
        const projectId = ProjectManager.getCurrentProjectId();
        if (!projectId) {
            console.debug('[CPController] syncAllEquipmentToGIS: Aucun projet actif');
            return;
        }

        if (typeof window.GisIntegration === 'undefined') {
            console.debug('[CPController] GisIntegration non chargé — sync GIS ignorée (normal si module inactif).');
            return;
        }
        if (typeof window.GisIntegration.getMap !== 'function' || !window.GisIntegration.getMap()) {
            console.debug('[CPController] GisIntegration présent mais carte non initialisée — sync GIS ignorée.');
            return;
        }

        const state = ProjectManager.getState();
        const equipments = state.equipments.filter(eq => eq.projectId === projectId);
        equipments.forEach(eq => {
            if (typeof window.GisIntegration.updateEquipmentMarker === 'function') {
                try {
                    window.GisIntegration.updateEquipmentMarker(eq);
                } catch (err) {
                    console.debug('[CPController] Erreur updateEquipmentMarker:', err.message);
                }
            }
        });
        if (window.UI && typeof window.UI.showToast === 'function') {
            window.UI.showToast('✅ Synchronisation GIS terminée.', 'info');
        }
    }

    function syncAllEquipmentTo3D() {
        const projectId = ProjectManager.getCurrentProjectId();
        if (!projectId) {
            console.debug('[CPController] syncAllEquipmentTo3D: Aucun projet actif');
            return;
        }

        if (typeof window.Gis3D === 'undefined') {
            console.debug('[CPController] Gis3D non chargé — sync 3D ignorée (normal si module 3D inactif).');
            return;
        }
        if (typeof window.Gis3D.isReady === 'function' && !window.Gis3D.isReady()) {
            console.debug('[CPController] Gis3D présent mais non prêt — sync 3D différée.');
            if (typeof window.Gis3D.whenReady === 'function') {
                window.Gis3D.whenReady().then(() => {
                    if (typeof window.Gis3D.loadData === 'function') {
                        window.Gis3D.loadData(projectId);
                    }
                }).catch(() => {});
            }
            return;
        }
        if (typeof window.Gis3D.loadData !== 'function') {
            console.debug('[CPController] Gis3D.loadData non disponible — sync 3D ignorée.');
            return;
        }

        try {
            window.Gis3D.loadData(projectId);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('✅ Synchronisation 3D terminée.', 'info');
            }
        } catch (err) {
            console.debug('[CPController] Erreur sync 3D:', err.message);
        }
    }

    function syncEquipmentToGIS(equipment) {
        if (!equipment) {
            console.debug('[CPController] syncEquipmentToGIS: Équipement manquant');
            return;
        }
        if (typeof window.GisIntegration === 'undefined') {
            console.debug('[CPController] GisIntegration non chargé — sync équipement GIS ignorée.');
            return;
        }
        if (typeof window.GisIntegration.updateEquipmentMarker === 'function') {
            try {
                window.GisIntegration.updateEquipmentMarker(equipment);
            } catch (err) {
                console.debug('[CPController] Erreur updateEquipmentMarker:', err.message);
            }
        }
    }

    function syncEquipmentTo3D(equipment) {
        if (!equipment) {
            console.debug('[CPController] syncEquipmentTo3D: Équipement manquant');
            return;
        }
        if (typeof window.Gis3D === 'undefined') {
            console.debug('[CPController] Gis3D non chargé — sync équipement 3D ignorée.');
            return;
        }
        if (typeof window.Gis3D.updateEquipment === 'function') {
            try {
                window.Gis3D.updateEquipment(equipment);
            } catch (err) {
                console.debug('[CPController] Erreur updateEquipment 3D:', err.message);
            }
        }
    }

    // ============================================================
    // VALIDATION GPS (délégation ProjectManager + fallback)
    // ============================================================

    function validateEquipmentCoordinates(coordinates) {
        if (typeof ProjectManager.validateEquipmentCoordinates === 'function') {
            return ProjectManager.validateEquipmentCoordinates(coordinates);
        }
        if (!coordinates) return true;
        if (Array.isArray(coordinates)) {
            if (coordinates.length === 0) return false;
            for (const p of coordinates) {
                if (!p || typeof p !== 'object') return false;
                const lat = p.lat;
                const lon = p.lon;
                if (lat === undefined || lon === undefined) return false;
                if (typeof lat !== 'number' || typeof lon !== 'number') return false;
                if (isNaN(lat) || isNaN(lon)) return false;
                if (lat < -90 || lat > 90) return false;
                if (lon < -180 || lon > 180) return false;
            }
            return true;
        } else if (typeof coordinates === 'object') {
            const lat = coordinates.lat;
            const lon = coordinates.lon;
            if (lat === undefined || lon === undefined) return false;
            if (typeof lat !== 'number' || typeof lon !== 'number') return false;
            if (isNaN(lat) || isNaN(lon)) return false;
            if (lat < -90 || lat > 90) return false;
            if (lon < -180 || lon > 180) return false;
            return true;
        }
        return false;
    }

    function normalizeEquipmentCoordinates(coordinates) {
        if (typeof ProjectManager.normalizeEquipmentCoordinates === 'function') {
            return ProjectManager.normalizeEquipmentCoordinates(coordinates);
        }
        if (!coordinates) return null;
        if (Array.isArray(coordinates)) {
            return coordinates.filter(p => p && typeof p === 'object' && p.lat !== undefined && p.lon !== undefined)
                .map(p => ({
                    lat: parseFloat(p.lat),
                    lon: parseFloat(p.lon),
                    alt: p.alt !== undefined ? parseFloat(p.alt) : null
                }));
        } else if (typeof coordinates === 'object') {
            return {
                lat: parseFloat(coordinates.lat),
                lon: parseFloat(coordinates.lon),
                alt: coordinates.alt !== undefined ? parseFloat(coordinates.alt) : null
            };
        }
        return null;
    }

    // ============================================================
    // PARTIE 2/2 — DÉLÉGATIONS ET EXPOSITION PUBLIQUE
    // ============================================================

    const delegatePM = (method) => (...args) => ProjectManager[method](...args);

    const delegateCable = (method) => (...args) => {
        if (typeof CableLengthEngine === 'undefined') {
            console.warn('[CPController] CableLengthEngine non chargé');
            return null;
        }
        return CableLengthEngine[method](...args);
    };

    const delegateUI = (method) => (...args) => {
        if (window.UI && typeof window.UI[method] === 'function') {
            return window.UI[method](...args);
        }
        console.debug(`[CPController] UI.${method} non disponible`);
        return null;
    };

    // ============================================================
    // CONSTRUCTION DE L'OBJET CPController
    // ============================================================
    const CPController = {
        // --------------------------------------------------------
        // DÉLÉGATION PROJECTMANAGER
        // --------------------------------------------------------
        getState: delegatePM('getState'),
        getCurrentProjectId: delegatePM('getCurrentProjectId'),
        getProjectsList: delegatePM('getProjectsList'),
        getSystems: delegatePM('getSystems'),
        getSystem: delegatePM('getSystem'),
        getActiveSystem: delegatePM('getActiveSystem'),
        getCurrentSystemId: delegatePM('getCurrentSystemId'),
        setCurrentSystemId: delegatePM('setCurrentSystemId'),
        createSystem: delegatePM('createSystem'),
        deleteSystem: delegatePM('deleteSystem'),
        addRectifier: delegatePM('addRectifier'),
        deleteRectifier: delegatePM('deleteRectifier'),
        updateRectifierStatus: delegatePM('updateRectifierStatus'),
        getSystemEquipment: delegatePM('getSystemEquipment'),
        getSystemTotalCurrent: delegatePM('getSystemTotalCurrent'),
        saveSystemParams: delegatePM('saveSystemParams'),
        saveSystemResults: delegatePM('saveSystemResults'),
        loadSystemParams: delegatePM('loadSystemParams'),
        loadSystemResults: delegatePM('loadSystemResults'),
        addHistoryEntry: delegatePM('addHistoryEntry'),
        loadProject: delegatePM('loadProject'),
        saveCurrentProject: delegatePM('saveCurrentProject'),
        createNewProject: delegatePM('createNewProject'),
        deleteCurrentProject: delegatePM('deleteCurrentProject'),
        loadProjectsList: delegatePM('loadProjectsList'),
        getGroundbeds: delegatePM('getGroundbeds'),
        getGroundbedById: delegatePM('getGroundbedById'),
        createGroundbed: delegatePM('createGroundbed'),
        updateGroundbed: delegatePM('updateGroundbed'),
        deleteGroundbed: delegatePM('deleteGroundbed'),
        getSharedParams: delegatePM('getSharedParams'),
        updateSharedParam: delegatePM('updateSharedParam'),
        getTotalEquipmentSurface: delegatePM('getTotalEquipmentSurface'),
        addEquipmentDirect: delegatePM('addEquipmentDirect'),
        saveEquipment: delegatePM('saveEquipment'),
        deleteEquipment: delegatePM('deleteEquipment'),

        // --------------------------------------------------------
        // v9.1 : Délégation nouvelles méthodes ProjectManager
        // --------------------------------------------------------
        resolveTargetCurrent: delegatePM('resolveTargetCurrent'),

        // --------------------------------------------------------
        // VALIDATION GPS
        // --------------------------------------------------------
        validateEquipmentCoordinates: validateEquipmentCoordinates,
        normalizeEquipmentCoordinates: normalizeEquipmentCoordinates,

        // --------------------------------------------------------
        // DÉLÉGATION UI (avec guards — voir helper delegateUI)
        // --------------------------------------------------------
        renderSystems: delegateUI('renderSystems'),
        populateAllSystemSelectors: delegateUI('populateAllSystemSelectors'),
        refreshEquipmentList: delegateUI('refreshEquipmentList'),
        refreshFieldMeasurementsTable: delegateUI('refreshFieldMeasurementsTable'),
        refreshAssetDropdownForFieldMeas: delegateUI('refreshAssetDropdownForFieldMeas'),
        updateCorrosivity: delegateUI('updateCorrosivity'),
        populateProjectSelector: delegateUI('populateProjectSelector'),
        populateGroundbedProjectSelect: delegateUI('populateGroundbedProjectSelect'),
        populateInterferenceProjectSelect: delegateUI('populateInterferenceProjectSelect'),
        populatePipelineSelects: delegateUI('populatePipelineSelects'),
        refreshHistoryTable: delegateUI('refreshHistoryTable'),
        loadHistory: delegateUI('loadHistory'),
        drawGroundbedVisual: delegateUI('drawGroundbedVisual'),
        updateEquipTypeOptions: delegateUI('updateEquipTypeOptions'),
        updateEquipDimensionsFields: delegateUI('updateEquipDimensionsFields'),
        computeEquipSurface: delegateUI('computeEquipSurface'),
        updateDimensionsFields: delegateUI('updateDimensionsFields'),
        autoFillFromEnvironment: delegateUI('autoFillFromEnvironment'),
        initDashboardCharts: delegateUI('initDashboardCharts'),
        setModulesActivation: delegateUI('setModulesActivation'),
        scheduleRenderSystems: delegateUI('renderSystems'),
        updateGroundbedTargetCurrent: delegateUI('updateGroundbedTargetCurrent'),
        generateTestPosts: delegateUI('generateTestPosts'),
        exportPostsPDF: delegateUI('exportPostsPDF'),
        exportPostsCSV: delegateUI('exportPostsCSV'),
        calculateCableSection: delegateUI('calculateCableSection'),
        applyCableToICCP: delegateUI('applyCableToICCP'),
        suggestStandards: delegateUI('suggestStandards'),
        generateSoilFromResistivity: delegateUI('generateSoilFromResistivity'),
        generateWaterFromEnvironment: delegateUI('generateWaterFromEnvironment'),
        renderReinforcementZones: delegateUI('renderReinforcementZones'),
        renderGroundbedList: delegateUI('renderGroundbedList'),
        populateICCPGroundbedSelectors: delegateUI('populateICCPGroundbedSelectors'),
        openGroundbedForm: delegateUI('openGroundbedForm'),
        populateResistiveParams: delegateUI('populateResistiveParams'),
        applyResistiveModel: delegateUI('applyResistiveModel'),
        syncSharedParams: delegateUI('syncSharedParams'),
        validateSystem: delegateUI('validateSystem'),
        updateDerivedFields: delegateUI('updateDerivedFields'),
        toggleSharedLock: delegateUI('toggleSharedLock'),
        updateDashboard: delegateUI('updateDashboard'),
        exportGlobalReport: delegateUI('exportGlobalReport'),
        exportGroundbedPDF: delegateUI('exportGroundbedPDF'),
        exportInterferencePDF: delegateUI('exportInterferencePDF'),

        // --------------------------------------------------------
        // CÂBLES DC (délégation CableLengthEngine)
        // --------------------------------------------------------
        computeCableLengths: delegateCable('computeCableLengths'),
        computeCableLengthsFromProject: delegateCable('computeFromProjectState'),
        calculateCableSectionFromEngine: delegateCable('calculateSection'),
        enrichCableLengths: delegateCable('enrichWithCableLengths'),

        // --------------------------------------------------------
        // MÉTHODES DE CALCUL (définies explicitement)
        // --------------------------------------------------------
        calculateCP: calculateCP,
        calculateAnodes: calculateAnodes,
        calculateICCP: calculateICCP,
        calculateGroundbed: calculateGroundbed,
        calculateInterference: calculateInterference,
        calculateEquipmentCP: calculateEquipmentCP,

        // --------------------------------------------------------
        // AUTRES MÉTHODES
        // --------------------------------------------------------
        getTotalEquipmentCurrent: getTotalEquipmentCurrent,
        applyEquipmentTotalToCP: applyEquipmentTotalToCP,
        syncSurfaceFromEquipments: syncSurfaceFromEquipments,
        updateAnodeCurrentSource: updateAnodeCurrentSource,
        updateICCPCurrentSource: updateICCPCurrentSource,
        syncGroundbedTargetCurrent: syncGroundbedTargetCurrent,
        syncGroundbedFromCP: syncGroundbedFromCP,
        syncInterferenceFromCP: syncInterferenceFromCP,
        checkConsistency: checkConsistency,
        generateValidationReport: generateValidationReport,
        exportPDF: exportPDF,

        // --------------------------------------------------------
        // MÉTHODES GIS
        // --------------------------------------------------------
        initMap: initMap,
        loadMapPoints: loadMapPoints,
        addMapPoint: addMapPoint,
        centerMap: centerMap,
        exportMapData: exportMapData,

        // --------------------------------------------------------
        // ZONES DE RENFORCEMENT
        // --------------------------------------------------------
        addReinforcementZone: addReinforcementZone,
        analyzeReinforcementNeeds: analyzeReinforcementNeeds,
        autoDetectZones: autoDetectZones,

        // --------------------------------------------------------
        // SYNCHRONISATION GIS/3D (avec guards robustes)
        // --------------------------------------------------------
        syncAllEquipmentToGIS: syncAllEquipmentToGIS,
        syncAllEquipmentTo3D: syncAllEquipmentTo3D,
        syncEquipmentToGIS: syncEquipmentToGIS,
        syncEquipmentTo3D: syncEquipmentTo3D,

        // --------------------------------------------------------
        // EXPOSITIONS INTERNES (pour debug)
        // --------------------------------------------------------
        _linkState: linkState,
        _gndLinkState: gndLinkState,
        _ifLinkState: ifLinkState,

        // --------------------------------------------------------
        // CONSTANTES UTILES (exposées pour cohérence)
        // --------------------------------------------------------
        _rhoCu: RHO_CU,

        // --------------------------------------------------------
        // v9.1 : Exposer les helpers pour debug
        // --------------------------------------------------------
        _applyTargetToField: applyTargetToField,
        _resolveGroundbedTargetCurrent: resolveGroundbedTargetCurrent
    };

    // ============================================================
    // EXPOSITION GLOBALE
    // ============================================================
    window.CPController = CPController;
    console.log('[CPController] Façade unifiée initialisée (v9.1 – intégration patches).');
    console.log('[CPController] ✅ v9.1 : calculateGroundbed intègre la résolution ICCP > CP > Surface');
    console.log('[CPController] ✅ v9.1 : délégation resolveTargetCurrent → ProjectManager → DataResolver');
    console.log('[CPController] ✅ v9.1 : traçabilité targetCurrentSource dans state.groundbed.results');

})();

// ============================================================
// FIN DE cp-controller.js (VERSION 9.1 – INTÉGRATION PATCHES)
// ============================================================