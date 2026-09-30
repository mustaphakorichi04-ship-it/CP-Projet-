// ============================================================
// pdf-report-engine.js – CP Engineer Pro
// Moteur principal de génération de rapport PDF professionnel
// Version 6.4 – GAP-COAT/RESIST/RECT INTÉGRÉS
// ============================================================
// CORRECTIONS v6.3 (INTÉGRATION PATCH) :
//   ✅ INTÉGRATION pdf-report-nomenclature-patch.js v1.0
//      → _generateTechnicalSections() appelle DIRECTEMENT
//        this._sections.generateNomenclature(data, helpers)
//        au lieu du monkey-patching de helpers.addSectionTitle.
//      → Plus de wrapper, plus de try/finally, plus de restauration.
//      → Appel direct = plus simple, plus traçable, plus maintenable.
//
// CORRECTIONS v6.2 (conservées) :
//   ✅ Section 12 GROUNDBED : Anode Diameter en mm (pas en m)
//   ✅ Confirmation _buildPDF() en 2 passes (TOC robuste)
//
// CORRECTIONS v6.1 (conservées) :
//   P0-02 : Unités canoniques (A/m² pour densité anodique)
//   P0-05 : Traçabilité rhoProject / rhoGroundbed / rho_eff
//   P1-01 : Distinction densité CP / densité anodique
//   P1-02 : CALC-ICCP-003 utilise powerDesign
//   P1-04 : CALC-SACP-002 utilise state.anodes.count
//   P1-05 : Comparaison vie à designLifeTarget
// ============================================================
(function() {
    'use strict';

    /**
     * Moteur principal de génération de rapport PDF
     * @namespace PDFReportEngine
     */
    const PDFReportEngine = {

        // Version du moteur PDF (cycle de vie indépendant)
        VERSION: '6.4.0',

        // ========================================================
        // PROPRIÉTÉS INTERNES
        // ========================================================
        _doc: null,
        _styles: null,
        _helpers: null,
        _sections: null,
        _calculations: null,
        _data: null,
        _chapterPages: {},
        _pageWidth: 0,
        _pageHeight: 0,
        _margin: 0,
        _validationWarnings: [],

        _getPrimaryGroundbed: function(data) {
            const groundbeds = (data && data.groundbeds) || [];
            const systems = (data && data.cpSystems) || [];
            const selectedSystem = systems.find(function(system) {
                return system && system.groundbedId;
            });
            const selected = selectedSystem && groundbeds.find(function(groundbed) {
                return groundbed && groundbed.id === selectedSystem.groundbedId;
            });
            return selected || groundbeds[0] || null;
        },

        // ========================================================
        // 1. POINT D'ENTRÉE PRINCIPAL
        // ========================================================
        generate: async function(projectId) {
            console.log('[PDF Engine v6.3] Debut generation pour projet:', projectId);
            let stage = 'initialisation';

            try {
                this._initModules();

                stage = 'collecte des donnees';
                this._data = this._collectData(projectId);
                stage = 'validation des donnees';
                this._validateData(this._data);
                console.log('[PDF Engine v6.3] Donnees collectees et validees');

                stage = 'enrichissement des donnees';
                const enrichedData = await this._enrichWithHeavyCalculations(this._data);
                this._data = enrichedData;

                const jsPDFClass = window.jspdf.jsPDF;
                this._doc = new jsPDFClass('p', 'mm', 'a4');
                this._pageWidth = this._doc.internal.pageSize.getWidth();
                this._pageHeight = this._doc.internal.pageSize.getHeight();
                this._margin = this._styles.layout.margin.left;

                this._helpers = Object.create(window.PDFReportHelpers).init(
                    this._doc,
                    this._styles,
                    this._margin,
                    this._pageWidth,
                    this._pageHeight
                );

                stage = 'construction du PDF';
                await this._buildPDF();
                console.log('[PDF Engine v6.3] PDF construit avec succes');

                const fileName = this._getFileName();
                try {
                    stage = 'sauvegarde du PDF';
                    await this._doc.save(fileName);
                    console.log('[PDF Engine v6.3] Sauvegarde reussie:', fileName);

                    const savedDoc = this._doc;
                    this._cleanup();
                    return { success: true, fileName: fileName, doc: savedDoc };
                } catch (saveError) {
                    if (saveError.message && saveError.message.indexOf('User cancelled') !== -1) {
                        console.log('[PDF Engine v6.3] Sauvegarde annulee par utilisateur.');
                        throw new Error('Sauvegarde annulee');
                    }
                    throw new Error('Erreur de sauvegarde: ' + saveError.message);
                }
            } catch (error) {
                console.error('[PDF Engine v6.3] Erreur:', error);
                const detail = error && error.message ? error.message : String(error);
                throw new Error('PDF Generation Error | Stage: ' + stage + ' | Cause: ' + detail);
            }
        },

        // ========================================================
        // 2. INITIALISATION DES MODULES
        // ========================================================
        _initModules: function() {
            if (!window.PDFReportStyles) throw new Error('PDFReportStyles non charge');
            if (!window.PDFReportHelpers) throw new Error('PDFReportHelpers non charge');
            if (!window.PDFReportSections) throw new Error('PDFReportSections non charge');
            if (!window.PDFCalculationSheets) throw new Error('PDFCalculationSheets non charge');
            if (!window.PDFReportDataCollector) throw new Error('PDFReportDataCollector non charge');

            this._styles = window.PDFReportStyles;
            this._sections = window.PDFReportSections;
            this._calculations = window.PDFCalculationSheets;

            if (typeof this._calculations.setStyles === 'function') {
                this._calculations.setStyles(this._styles);
            }

            // v6.3 : vérification de la disponibilité de generateNomenclature
            if (typeof this._sections.generateNomenclature !== 'function') {
                console.warn('[PDF Engine v6.3] PDFReportSections.generateNomenclature non disponible — la section 9.1 sera omise.');
            } else {
                console.log('[PDF Engine v6.3] ✅ generateNomenclature() détectée (Section 9.1)');
            }

            console.log('[PDF Engine v6.3] Modules initialises');
        },

        // ========================================================
        // 3. COLLECTE DES DONNÉES
        // ========================================================
        _collectData: function(projectId) {
            const collector = window.PDFReportDataCollector;
            if (!collector) {
                throw new Error('PDFReportDataCollector non charge.');
            }
            if (typeof ProjectManager === 'undefined') {
                throw new Error('ProjectManager non disponible.');
            }

            const state = ProjectManager.getState();
            if (!state) {
                throw new Error('Etat du projet indisponible.');
            }

            const project = ProjectManager.getProjectsList().find(function(p) {
                return p.id === projectId;
            }) || null;

            const data = {
                project:            collector.collectProjectData(project, state),
                assets:             collector.collectAssetsData(state, projectId),
                environment:        collector.collectEnvironmentData(state),
                standards:          collector.collectStandardsData(state),
                criteria:           collector.collectCriteriaData(state),
                cpSystems:          collector.collectCPSystemsData(state),
                iccp:               collector.collectICCPData(state),
                sacp:               collector.collectSACPData(state),
                groundbeds:         collector.collectGroundbedsData(state),
                interference:       collector.collectInterferenceData(state),
                fieldMeasurements:  collector.collectFieldMeasurementsData(state, projectId),
                gis:                collector.collectGISData(state, projectId),
                history:            collector.collectHistoryData(state),
                calculations:       []
            };

            try {
                const shared = (state.project && state.project.shared) || {};
                data.designLifeTarget = (state.project && state.project.designLifeTarget !== undefined)
                    ? state.project.designLifeTarget
                    : 25;
                data.groundbedFormationResistivity = (shared.groundbedFormationResistivity !== undefined)
                    ? shared.groundbedFormationResistivity
                    : null;
                data.projectSoilResistivity = (shared.soilResistivity !== undefined)
                    ? shared.soilResistivity
                    : (state.project ? state.project.resistivity : 100);
                data.iccpAnodeConfig = shared.iccpAnodeConfig || null;
            } catch (e) {
                console.warn('[PDF Engine v6.3] Impossible de collecter les champs P0-05/P1-05:', e.message);
                data.designLifeTarget = 25;
                data.groundbedFormationResistivity = null;
                data.projectSoilResistivity = 100;
                data.iccpAnodeConfig = null;
            }

            const iccpData = data.iccp || {};
            iccpData.calculatedRequirements = {
                current: Number(iccpData.rectifierCurrent || iccpData.current || 0),
                voltage: Number(iccpData.rectifierVoltage || iccpData.voltageFinal || iccpData.voltage || 0),
                power: Number(iccpData.rectifierPower || iccpData.powerDesign || iccpData.power || 0)
            };

            data.calculations = this._collectCalculations(state, data);

            console.log('[PDF Engine v6.3] _collectData:',
                'assets=' + data.assets.length,
                '| calculations=' + data.calculations.length,
                '| measurements=' + data.fieldMeasurements.length,
                '| designLifeTarget=' + data.designLifeTarget);

            return data;
        },

        // ========================================================
        // 4. COLLECTE DES CALCULS (IDs distincts – B-05)
        // ========================================================
        _collectCalculations: function(state, reportData) {
            const calcs = [];
            if (!state) return calcs;

            const designLifeTarget = (state.project && state.project.designLifeTarget !== undefined)
                ? state.project.designLifeTarget
                : 25;

            // ===== CALC-CP-001 : Courant de protection requis =====
            const calculatedAssets = (reportData && reportData.assets || [])
                .filter(function(asset) {
                    return asset.included !== false && asset.cpCalculated &&
                        asset.cpData && asset.cpData.results &&
                        Number(asset.cpData.results.currentAmperes) > 0;
                });
            const includedAssets = (reportData && reportData.assets || [])
                .filter(function(asset) { return asset.included !== false; });
            const equipmentCurrent = calculatedAssets.reduce(function(total, asset) {
                return total + Number(asset.cpData.results.currentAmperes);
            }, 0);
            const equipmentSurface = includedAssets.reduce(function(total, asset) {
                return total + Number(asset.surface || 0);
            }, 0);
            const cpCurrent = equipmentCurrent > 0
                ? equipmentCurrent
                : ((state.cp && state.cp.current) || 0);
            const surface = equipmentSurface > 0
                ? equipmentSurface
                : ((state.project && state.project.surface) || 0);
            const coating = (state.project && state.project.coating !== undefined)
                ? state.project.coating : 0.95;
            const DF = (state.project && state.project.defectDensity !== undefined)
                ? state.project.defectDensity : 0.03;
            const k = (state.project && state.project.agingFactor !== undefined)
                ? state.project.agingFactor : 1.2;
            const J = (state.project && state.project.currentDensity) || 5;

            if (surface > 0) {
                calcs.push({
                    id: 'CALC-CP-001',
                    name: 'Protection current requirement',
                    formula: 'I = [S x (1 - eps) x DF x k x J] / 1000',
                    variables: {
                        surface: surface,
                        coating: coating,
                        defectDensity: DF,
                        agingFactor: k,
                        currentDensity: J
                    },
                    result: cpCurrent,
                    unit: 'A',
                    status: cpCurrent > 0 ? 'PASS' : 'WARNING',
                    statusMessage: cpCurrent > 0
                        ? 'Le courant de protection requis est calcule conformement a ISO 15589-1 / NACE SP0169.'
                        : 'Le courant de protection n a pas encore ete calcule. Effectuez le calcul CP dans le module dedie.',
                    criterion: 'I_req > 0'
                });
            }

            // ===== CALC-SACP-001/002/003 : Anodes sacrificielles =====
            const sacp = state.anodes || {};
            const sacpHasResult = sacp.totalMass > 0 || sacp.count > 0 || sacp.actualLife > 0;
            const sacpMassValid = sacp.totalMass > 0 && sacp.count > 0;
            if (sacpHasResult) {
                calcs.push({
                    id: 'CALC-SACP-001',
                    name: 'Total anode mass',
                    formula: 'M_total = (I_req x T x 8760) / (C x u) x SF',
                    variables: {
                        initialCurrent: sacp.initialCurrent || 0,
                        safetyFactor: sacp.safetyFactor || 1.1,
                        totalMass: sacp.totalMass
                    },
                    result: sacp.totalMass,
                    unit: 'kg',
                    status: sacpMassValid ? 'PASS' : 'NOT ASSESSABLE',
                    statusMessage: sacpMassValid
                        ? 'Masse totale d anodes calculee conformement a DNV-RP-B401.'
                        : 'Masse totale SACP incomplete : masse et nombre d anodes installes requis.',
                    criterion: 'M_total >= M_required'
                });

                calcs.push({
                    id: 'CALC-SACP-002',
                    name: 'Number of anodes',
                    formula: 'N = max(N_current, N_mass, 1)',
                    variables: {
                        count: sacp.count || 0,
                        initialCurrent: sacp.initialCurrent || 0,
                        finalCurrent: sacp.finalCurrent || 0
                    },
                    result: sacp.count || 0,
                    unit: 'units',
                    status: (sacp.count > 0) ? 'PASS' : 'FAIL',
                    statusMessage: 'Nombre d anodes determine par le critere de courant et de masse.',
                    criterion: 'N >= 1'
                });

                                const sacpLife = sacp.actualLife || 0;
                // F-01 : Distinguer explicitement DESIGN LIFE PROJET et
                //        CALCULATED COMPONENT LIFE (SACP).
                //        Le designLifeTarget est une exigence projet (25 ans).
                //        Le sacpLife est la duree calculee par la loi de Faraday
                //        pour les anodes sacrificielles, qui PEUT etre differente
                //        (souvent superieure) sans que cela ne constitue une
                //        non-conformite.
                const sacpLifeStatus = (function() {
                    if (!sacpMassValid || sacpLife <= 0) return 'NOT ASSESSABLE';
                    if (sacpLife >= designLifeTarget) return 'PASS';
                    if (sacpLife >= designLifeTarget * 0.8) return 'WARNING';
                    return 'FAIL';
                })();
                const sacpLifeMessage = (function() {
                    if (!sacpMassValid || sacpLife <= 0) {
                        return 'Duree de vie SACP non evaluable : masse et nombre d anodes valides requis.';
                    }
                    if (sacpLife >= designLifeTarget) {
                        return 'Duree de vie SACP calculee = ' + sacpLife.toFixed(1) +
                               ' ans (>= cible projet ' + designLifeTarget +
                               ' ans). La duree theorique peut depasser la cible ' +
                               'sans constituer une non-conformite.';
                    }
                    return 'Duree de vie SACP calculee = ' + sacpLife.toFixed(1) +
                           ' ans < cible projet ' + designLifeTarget +
                           ' ans. Augmenter la masse ou reduire le courant.';
                })();
                calcs.push({
                    id: 'CALC-SACP-003',
                    name: 'Sacrificial anode component life',
                    formula: 'T_component = (M_total x C x u) / (I_avg x 8760)',
                    variables: {
                        totalMass: sacp.totalMass,
                        componentLifeYears: sacpLife,
                        projectDesignLifeTarget: designLifeTarget,
                        componentLifeType: 'CALCULATED_COMPONENT_LIFE'
                    },
                    result: sacpLife,
                    unit: 'years',
                    status: sacpLifeStatus,
                    statusMessage: sacpLifeMessage,
                    criterion: 'T_component >= ' + designLifeTarget +
                               ' ans (cible projet) — voir note tracabilite'
                });
            }

            // ===== CALC-ICCP-001/002/003 : ICCP =====
            const iccp = (reportData && reportData.iccp) || state.iccp || {};
            const hasIccpData = Number(iccp.current) > 0 ||
                Number(iccp.requiredCurrent) > 0 ||
                Number(iccp.selectedCurrent) > 0 ||
                Number(iccp.rectifierVoltage) > 0 ||
                Number(iccp.powerDesign) > 0;
            if (hasIccpData) {
                const jAnodeA = (iccp.currentDensity !== undefined && iccp.currentDensity !== null)
                    ? iccp.currentDensity : 0;
                const jAnodeMA = (iccp.currentDensity_mA !== undefined && iccp.currentDensity_mA !== null)
                    ? iccp.currentDensity_mA : (jAnodeA * 1000);
                const lifeDesign = (iccp.lifeDesign !== undefined && iccp.lifeDesign !== null)
                    ? iccp.lifeDesign : (iccp.lifeEstimate || 0);
                const lifeTheory = iccp.lifeTheoretical || 0;

                                // F-02 : Tracer explicitement la CHAINE DE DIMENSIONNEMENT ICCP.
                //        Le rapport doit demontrer :
                //          I_required (theorique) -> marge -> I_design
                //        et non afficher un courant arbitraire sans justification.
                const iRequiredA = Number(iccp.requiredCurrent) > 0
                    ? Number(iccp.requiredCurrent)
                    : cpCurrent;
                const iDesignA = Number(iccp.selectedCurrent) > 0
                    ? Number(iccp.selectedCurrent)
                    : (iccp.current || 0);
                const marginRatio = (iRequiredA > 0)
                    ? (iDesignA / iRequiredA)
                    : null;
                const marginPercent = (marginRatio !== null)
                    ? ((marginRatio - 1) * 100)
                    : null;

                let iccpCurrentStatus = 'WARNING';
                let iccpCurrentMessage = '';
                if (marginRatio === null || iRequiredA <= 0) {
                    iccpCurrentStatus = 'NOT ASSESSABLE';
                    iccpCurrentMessage = 'Courant CP requis non disponible. ' +
                        'Calculer CALC-CP-001 avant de valider CALC-ICCP-001.';
                } else if (marginRatio < 1.0) {
                    iccpCurrentStatus = 'FAIL';
                    iccpCurrentMessage = 'Courant ICCP design (' + iDesignA.toFixed(3) +
                        ' A) < courant requis (' + iRequiredA.toFixed(3) +
                        ' A). Sous-dimensionnement critique.';
                } else if (marginRatio > 5.0) {
                    iccpCurrentStatus = 'WARNING';
                    iccpCurrentMessage = 'Courant ICCP design (' + iDesignA.toFixed(3) +
                        ' A) > 5x le courant requis (' + iRequiredA.toFixed(3) +
                        ' A). Sur-dimensionnement important — verifier la justification.';
                } else {
                    iccpCurrentStatus = 'PASS';
                    iccpCurrentMessage = 'Courant ICCP design = ' + iDesignA.toFixed(3) +
                        ' A. Marge = ' + marginPercent.toFixed(0) +
                        '% par rapport au courant requis (' + iRequiredA.toFixed(3) +
                        ' A). Densite anodique = ' + jAnodeA.toFixed(3) + ' A/m2.';
                }

                calcs.push({
                    id: 'CALC-ICCP-001',
                    name: 'ICCP total current requirement',
                    formula: 'I_design = I_required x (1 + margin) — voir note tracabilite',
                    variables: {
                        I_required_A: iRequiredA,
                        I_design_A: iDesignA,
                        margin_ratio: marginRatio,
                        margin_percent: marginPercent,
                        currentDensityAnode: jAnodeA,
                        currentDensityAnode_mA: jAnodeMA,
                        lifeDesign: lifeDesign,
                        lifeTheoretical: lifeTheory,
                        projectDesignLifeTarget: designLifeTarget
                    },
                    result: iDesignA,
                    unit: 'A',
                    status: iccpCurrentStatus,
                    statusMessage: iccpCurrentMessage,
                    criterion: 'I_design >= I_required et marge justifiee'
                });

                calcs.push({
                    id: 'CALC-ICCP-002',
                    name: 'Rectifier output voltage — TR selection',
                    formula: 'V = I x R_total + V_backEMF ; V_nominal = palier IEC 60146',
                    variables: {
                        current: iccp.current,
                        voltage: iccp.voltage,
                        voltageFinal: iccp.voltageFinal,
                        rectifierVoltage: iccp.rectifierVoltage || iccp.voltage,
                        groundbedResistance: iccp.groundbedResistance || 0,
                        // GAP-RECT-01 : Paliers normalisés IEC 60146
                        nominalVoltage: (iccp.rectifierSelection && iccp.rectifierSelection.nominalVoltage)
                            ? iccp.rectifierSelection.nominalVoltage
                            : null,
                        nominalCurrent: (iccp.rectifierSelection && iccp.rectifierSelection.nominalCurrent)
                            ? iccp.rectifierSelection.nominalCurrent
                            : null,
                        trSelectionBasis: (iccp.rectifierSelection && iccp.rectifierSelection.trSelectionBasis)
                            ? iccp.rectifierSelection.trSelectionBasis
                            : 'IEC_60146_NORMALIZED_STEPS'
                    },
                    result: iccp.rectifierVoltage || iccp.voltage,
                    unit: 'V',
                    status: (iccp.rectifierVoltage || iccp.voltage) > 0 ? 'PASS' : 'WARNING',
                    statusMessage: (function() {
                        let msg = 'Tension redresseur calculee avec back EMF integre.';
                        if (iccp.rectifierSelection && iccp.rectifierSelection.nominalVoltage) {
                            msg += ' Palier normalise IEC 60146 selectionne : ' +
                                iccp.rectifierSelection.nominalVoltage + ' V.';
                            if (iccp.rectifierSelection.nominalCurrent) {
                                msg += ' Courant nominal TR : ' + iccp.rectifierSelection.nominalCurrent + ' A.';
                            }
                        } else {
                            msg += ' (Effectuer le calcul redresseur pour obtenir la selection TR normalisee)';
                        }
                        return msg;
                    })(),
                    criterion: 'V > 0 ; V_nominal >= V_calcule x SF (IEC 60146)'
                });

                const powerDesign = (iccp.powerDesign !== undefined && iccp.powerDesign !== null)
                    ? iccp.powerDesign
                    : ((iccp.powerInitial !== undefined && iccp.powerInitial !== null)
                        ? iccp.powerInitial
                        : (iccp.power || 0));
                const powerInitialForTrace = (iccp.powerInitial !== undefined && iccp.powerInitial !== null)
                    ? iccp.powerInitial
                    : (iccp.power || 0);
                const safetyFactorPower = iccp.safetyFactorPower || 1.15;

                calcs.push({
                    id: 'CALC-ICCP-003',
                    name: 'Rectifier power rating',
                    formula: 'P_design = V x I x SF (SF applique UNE seule fois)',
                    variables: {
                        voltage: iccp.voltage,
                        powerDesign: powerDesign,
                        powerInitial: powerInitialForTrace,
                        safetyFactorPower: safetyFactorPower,
                        // GAP-RECT-01 : Puissance nominale TR (palier catalogue)
                        nominalPower: (iccp.rectifierSelection && iccp.rectifierSelection.nominalPower)
                            ? iccp.rectifierSelection.nominalPower
                            : null,
                        P_AC_required: (iccp.rectifierSelection && iccp.rectifierSelection.P_AC_required)
                            ? iccp.rectifierSelection.P_AC_required
                            : null
                    },
                    result: powerDesign,
                    unit: 'W',
                    status: powerDesign > 0 ? 'PASS' : 'WARNING',
                    statusMessage: (function() {
                        let msg = 'Puissance redresseur = ' + powerDesign.toFixed(1) +
                            ' W (P_brut = ' + powerInitialForTrace.toFixed(1) +
                            ' W x SF = ' + safetyFactorPower.toFixed(2) + ').';
                        if (iccp.rectifierSelection && iccp.rectifierSelection.nominalPower) {
                            msg += ' Puissance nominale TR catalogue : ' +
                                iccp.rectifierSelection.nominalPower.toFixed(0) + ' W (IEC 60146).';
                        }
                        return msg;
                    })(),
                    criterion: 'P > 0 ; P_nominal >= P_design (IEC 60146)'
                });
            }

            // ===== CALC-GB-001/002 : Groundbed =====
            const canonicalGroundbed = this._getPrimaryGroundbed(reportData);
            const gb = canonicalGroundbed && canonicalGroundbed.results;
            const shared = (state.project && state.project.shared) || {};
            const rhoProject = (gb && gb.rhoProject !== undefined && gb.rhoProject !== null)
                ? gb.rhoProject
                : ((shared.soilResistivity !== undefined) ? shared.soilResistivity : 100);
            const rhoGroundbed = (gb && gb.rhoGroundbed !== undefined && gb.rhoGroundbed !== null)
                ? gb.rhoGroundbed
                : ((shared.groundbedFormationResistivity !== undefined && shared.groundbedFormationResistivity !== null)
                    ? shared.groundbedFormationResistivity
                    : rhoProject);
            const rhoEff = (gb && gb.rho_eff !== undefined && gb.rho_eff !== null)
                ? gb.rho_eff
                : rhoGroundbed;

            if (gb && Number(gb.R_total) > 0) {
                calcs.push({
                    id: 'CALC-GB-001',
                    name: 'Groundbed resistance',
                    formula: 'R_total = R_group + R_well + R_cable + R_structure',
                    variables: {
                        R_total: gb.R_total,
                        R_group: gb.R_group || 0,
                        R_well: gb.R_well || 0,
                        R_cable: gb.R_cable || 0,
                        R_struct: gb.R_struct || 0,
                        rhoProject: rhoProject,
                        rhoGroundbed: rhoGroundbed,
                        rho_eff: rhoEff
                    },
                    result: gb.R_total,
                    unit: 'Ohm',
                                                                                status: gb.designStatus === 'PRELIMINARY_ONLY' ? 'WARNING' : 'PASS',
                                                                                statusMessage: gb.designStatus === 'PRELIMINARY_ONLY'
                                                                                                ? (gb.requiresSpecialistStudy
                                                                                                ? 'Resistance preliminaire uniquement: etude numerique multicouche requise. ' +
                                                                                                    'rho_project = ' + rhoProject + ' Ohm.m, rho_gb = ' + rhoGroundbed + ' Ohm.m.'
                                                                                                : 'Resistance preliminaire multicouche: verification de conception requise. ' +
                                                                                                    'rho_project = ' + rhoProject + ' Ohm.m, rho_gb = ' + rhoGroundbed + ' Ohm.m.')
                                                : 'Resistance du puits anodique calculee (Dwight + Sunde). ' +
                                                    'rho_project = ' + rhoProject + ' Ohm.m, rho_gb = ' + rhoGroundbed + ' Ohm.m.',
                    criterion: 'R_total > 0'
                });

                if (Number(gb.I_total) > 0) {
                    const jAnodeA = (gb.J_anode !== undefined && gb.J_anode !== null)
                        ? gb.J_anode : 0;
                    const jAnodeMA = (gb.J_anode_mA !== undefined && gb.J_anode_mA !== null)
                        ? gb.J_anode_mA : (jAnodeA * 1000);

                    calcs.push({
                        id: 'CALC-GB-002',
                        name: 'Groundbed current capacity',
                        formula: 'I_total = I_target ; J_anode = I_anode / S_anode',
                        variables: {
                            I_total: gb.I_total,
                            J_anode: jAnodeA,
                            J_anode_mA: jAnodeMA,
                            densityLimit: gb.densityLimit || 50
                        },
                        result: jAnodeA,
                        unit: 'A/m2',
                        status: gb.designStatus === 'PRELIMINARY_ONLY' ? 'WARNING' : (gb.densityOk ? 'PASS' : 'WARNING'),
                        statusMessage: gb.densityOk
                            ? 'Densite de courant anodique dans les limites recommandees. ' +
                              'J_anode = ' + jAnodeA.toFixed(3) + ' A/m2 (' + jAnodeMA.toFixed(1) + ' mA/m2).'
                            : 'Densite de courant anodique a verifier (depasse la limite). ' +
                              'J_anode = ' + jAnodeA.toFixed(3) + ' A/m2 > ' + (gb.densityLimit || 50) + ' A/m2.',
                        criterion: 'J_anode <= J_limit'
                    });
                }
            }

                        // ===== CALC-IF-001/002 : Interférences AC/DC =====
            const interference = state.interference && state.interference.results;
            if (interference && interference.globalStatus) {
                if (interference.acInduced !== undefined) {
                    const touchV = interference.touchVoltage || 0;
                    calcs.push({
                        id: 'CALC-IF-001',
                        name: 'AC induced voltage',
                        formula: 'V_AC = I_AC x Z x L_parallel',
                        variables: {
                            acInduced: interference.acInduced,
                            touchVoltage: touchV
                        },
                        result: interference.acInduced,
                        unit: 'V',
                        status: touchV < 15 ? 'PASS' : (touchV < 30 ? 'WARNING' : 'FAIL'),
                        statusMessage: interference.acStatus || 'Analyse interference AC effectuee.',
                        criterion: 'V_touch < 15 V'
                    });
                }

                if (interference.dcStray !== undefined) {
                    const dcStray = interference.dcStray || 0;
                    calcs.push({
                        id: 'CALC-IF-002',
                        name: 'DC stray current',
                        formula: 'I_stray = DeltaV / R_path',
                        variables: {
                            deltaV: interference.deltaV || 0,
                            dcStray: dcStray,
                            R_path: interference.R_path || 0
                        },
                        result: dcStray,
                        unit: 'A',
                        status: dcStray < 0.01 ? 'PASS' : (dcStray < 0.1 ? 'WARNING' : 'FAIL'),
                        statusMessage: interference.dcStatus || 'Analyse courant vagabond DC effectuee.',
                        criterion: 'I_stray < 0.1 A'
                    });
                }
            }

            // ═══════════════════════════════════════════════════════════
            // A-01 : Calculs AC Corrosion (CALC-AC-001 à CALC-AC-005)
            // ------------------------------------------------------------
            // SOURCE : window.ACCorrosionEngine.analyze() — moteur dédié
            // Les données d'entrée proviennent de state.interference.
            // Le moteur est optionnel : si non chargé, les fiches AC
            // ne sont pas produites (aucune régression).
            // ═══════════════════════════════════════════════════════════
            try {
                if (typeof window.ACCorrosionEngine !== 'undefined' &&
                    typeof window.ACCorrosionEngine.analyze === 'function') {

                    // Reconstruction des paramètres d'entrée depuis le state
                    const jacInput = (state.interference && state.interference.results && state.interference.results.J_AC !== undefined)
                        ? state.interference.results.J_AC
                        : 0;
                    const jdcInput = (state.interference && state.interference.results && state.interference.results.J_DC !== undefined)
                        ? state.interference.results.J_DC
                        : 0;
                    const touchInput = (interference && interference.touchVoltage !== undefined)
                        ? interference.touchVoltage
                        : undefined;

                    // Appel du moteur AC
                    const acResult = window.ACCorrosionEngine.analyze({
                        J_AC: jacInput,
                        J_DC: jdcInput,
                        touchV: touchInput,
                        targetPotential: (state.project && state.project.targetPotential !== undefined)
                            ? state.project.targetPotential
                            : -850
                    });

                                        // ---- CALC-AC-001 : Ratio J_AC / J_DC ----
                    // F-05 : gestion explicite du cas 0/0 -> NOT ASSESSABLE.
                    //        Ne JAMAIS convertir 0/0 en 0 (faux conforme)
                    //        ni en FAIL (faux non conforme).
                    var _acRatioStatus;
                    if (acResult.ratioStatus === 'N/A') {
                        _acRatioStatus = 'NOT ASSESSABLE';
                    } else if (acResult.ratioLevel === 'ACCEPTABLE') {
                        _acRatioStatus = 'PASS';
                    } else if (acResult.ratioLevel === 'MODERATE') {
                        _acRatioStatus = 'WARNING';
                    } else if (acResult.ratioLevel === 'HIGH') {
                        _acRatioStatus = 'FAIL';
                    } else {
                        _acRatioStatus = 'NOT ASSESSABLE';
                    }

                    var _acRatioResultDisplay = (acResult.ratio !== null && acResult.ratio !== undefined)
                        ? acResult.ratio
                        : null;

                    var _acRatioMessage;
                    if (acResult.ratioStatus === 'N/A') {
                        _acRatioMessage = 'Ratio J_AC/J_DC non defini (J_AC = 0 et J_DC = 0). ' +
                            'Basis : ' + (acResult.ratioBasis || 'NOT MEASURED') + '. ' +
                            'Aucune conclusion ne peut etre tiree sans mesures valides.';
                    } else {
                        _acRatioMessage = 'Ratio J_AC/J_DC = ' +
                            (acResult.ratio !== null ? acResult.ratio.toFixed(2) : 'N/A') +
                            ' (niveau : ' + acResult.ratioLevel + '). Reference : ' +
                            acResult.references.ratioSection + '.';
                    }

                    calcs.push({
                        id: 'CALC-AC-001',
                        name: 'AC Corrosion Ratio J_AC / J_DC',
                        formula: 'ratio = J_AC / J_DC',
                        variables: {
                            J_AC: acResult.J_AC,
                            J_DC: acResult.J_DC,
                            ratio: _acRatioResultDisplay
                        },
                        result: _acRatioResultDisplay,
                        unit: '-',
                        status: _acRatioStatus,
                        statusMessage: _acRatioMessage,
                        criterion: 'ratio < 5 (EN 15280 §6.3)'
                    });

                    // ---- CALC-AC-002 : Densité AC (classification) ----
                    calcs.push({
                        id: 'CALC-AC-002',
                        name: 'AC Current Density Classification',
                        formula: 'classification = f(J_AC)',
                        variables: {
                            J_AC: acResult.J_AC
                        },
                        result: acResult.J_AC,
                        unit: 'A/m²',
                        status: acResult.assessmentStatus === 'NOT_ASSESSABLE' ? 'NOT ASSESSABLE'
                            : (acResult.jACLevel === 'ACCEPTABLE') ? 'PASS'
                              : (acResult.jACLevel === 'MODERATE') ? 'WARNING'
                              : 'FAIL',
                                                statusMessage: acResult.J_AC === null
                                                        ? 'Densité AC : N/A — DATA REQUIRED.'
                                                        : 'Densité AC = ' + acResult.J_AC.toFixed(3) +
                                                            ' A/m² (niveau : ' + acResult.jACLevel + ').',
                        criterion: 'J_AC < 1 A/m² (acceptable)'
                    });

                    // ---- CALC-AC-003 : Tension de contact IEC 60479-1 ----
                    calcs.push({
                        id: 'CALC-AC-003',
                        name: 'AC Touch Voltage Zone Classification',
                        formula: 'zone = f(V_touch)',
                        variables: {
                            touchV: acResult.touchV
                        },
                        result: acResult.touchV,
                        unit: 'V',
                        status: acResult.assessmentStatus === 'NOT_ASSESSABLE' ? 'NOT ASSESSABLE'
                            : (acResult.touchZone === 'ZONE_1') ? 'PASS'
                              : (acResult.touchZone === 'ZONE_2') ? 'WARNING'
                              : 'FAIL',
                                                statusMessage: acResult.touchV === null
                                                        ? 'Tension de contact : N/A — DATA REQUIRED.'
                                                        : 'Tension de contact = ' + acResult.touchV.toFixed(2) +
                                                            ' V (zone : ' + acResult.touchZone + '). ' +
                                                            'Référence : ' + acResult.references.touchSection + '.',
                        criterion: 'V_touch < 15 V (Zone 1)'
                    });

                    // ---- CALC-AC-004 : Niveau global de risque ----
                    calcs.push({
                        id: 'CALC-AC-004',
                        name: 'AC Corrosion Global Risk Level',
                        formula: 'risk = max(ratio_level, touch_zone, J_AC_level)',
                        variables: {
                            riskLevel: acResult.riskLevel
                        },
                        result: acResult.riskLevel === 'LOW' ? 0
                              : acResult.riskLevel === 'MODERATE' ? 1
                              : acResult.riskLevel === 'HIGH' ? 2 : 3,
                        unit: 'niveau',
                        status: acResult.assessmentStatus === 'NOT_ASSESSABLE' ? 'NOT ASSESSABLE'
                            : (acResult.riskLevel === 'LOW' && acResult.isCompliant) ? 'PASS'
                              : (acResult.riskLevel === 'MODERATE') ? 'WARNING'
                              : 'FAIL',
                        statusMessage: 'Niveau de risque global : ' + acResult.riskLevel +
                                       '. Conformité EN 15280 : ' +
                                       (acResult.assessmentStatus === 'NOT_ASSESSABLE'
                                           ? 'NON EVALUABLE'
                                           : (acResult.isCompliant ? 'OUI' : 'NON')),
                        criterion: 'riskLevel ∈ {LOW, MODERATE}'
                    });

                    // ---- CALC-AC-005 : Recommandations de mitigation ----
                    calcs.push({
                        id: 'CALC-AC-005',
                        name: 'AC Mitigation Recommendations',
                        formula: 'recommendations = f(riskLevel)',
                        variables: {
                            recommendationCount: acResult.recommendations.length
                        },
                        result: acResult.recommendations.length,
                        unit: 'actions',
                        status: acResult.assessmentStatus === 'NOT_ASSESSABLE' ? 'NOT ASSESSABLE'
                            : (acResult.recommendations.length <= 1 &&
                                 acResult.recommendations[0] &&
                                 acResult.recommendations[0].indexOf('Aucune mitigation') === 0)
                              ? 'PASS' : 'WARNING',
                        statusMessage: 'Recommandations : ' +
                                       acResult.recommendations.join(' | '),
                        criterion: 'Aucune mitigation requise'
                    });
                }
            } catch (acErr) {
                console.warn('[PDF Engine v6.3] AC Corrosion collection échouée:', acErr.message);
            }

            // ═══════════════════════════════════════════════════════════
            // A-02 : Calculs MIC / SRB (CALC-MIC-001 à CALC-MIC-003)
            // ------------------------------------------------------------
            // SOURCE : window.MICEngine.analyzeSRB() — moteur dédié
            // Les données d'entrée proviennent de state.project.shared
            // ou state.project (paramètres environnementaux).
            // ═══════════════════════════════════════════════════════════
            try {
                if (typeof window.MICEngine !== 'undefined' &&
                    typeof window.MICEngine.analyzeSRB === 'function') {

                    // Récupération des paramètres depuis le projet
                    const proj = state.project || {};
                    const shared = proj.shared || {};

                    const micInput = {
                        sulfates:      (proj.envSoilSulfates      !== undefined) ? proj.envSoilSulfates      : (shared.sulfates || 0),
                        sulfides:      (proj.envSoilSulfides      !== undefined) ? proj.envSoilSulfides      : (shared.sulfides || 0),
                        redox:         (proj.envSoilRedox         !== undefined) ? proj.envSoilRedox         : 0,
                        ph:            (proj.envSoilPh            !== undefined) ? proj.envSoilPh            : 7,
                        temperature:   (proj.envWaterTemp         !== undefined) ? proj.envWaterTemp         : 20,
                        humidity:      (proj.envSoilMoisture      !== undefined) ? proj.envSoilMoisture      : 50,
                        organicMatter: (proj.envSoilOrganicMatter !== undefined) ? proj.envSoilOrganicMatter : 0,
                        nitrates:      (proj.envSoilNitrates      !== undefined) ? proj.envSoilNitrates      : 0,
                        chlorides:     (proj.envSoilChlorides     !== undefined) ? proj.envSoilChlorides     : 0
                    };

                    const micResult = window.MICEngine.analyzeSRB(micInput);

                    // ---- CALC-MIC-001 : Score SRB ----
                    calcs.push({
                        id: 'CALC-MIC-001',
                        name: 'SRB Activity Score',
                        formula: 'score = Σ (critères pondérés)',
                        variables: {
                            sulfates:      micResult.inputs.sulfates,
                            sulfides:      micResult.inputs.sulfides,
                            redox:         micResult.inputs.redox,
                            ph:            micResult.inputs.ph,
                            temperature:   micResult.inputs.temperature,
                            humidity:      micResult.inputs.humidity,
                            organicMatter: micResult.inputs.organicMatter,
                            nitrates:      micResult.inputs.nitrates,
                            chlorides:     micResult.inputs.chlorides
                        },
                        result: micResult.score,
                        unit: '/100',
                        status: micResult.assessmentStatus === 'NOT_ASSESSABLE' ? 'NOT ASSESSABLE'
                            : (micResult.score <= 25) ? 'PASS'
                              : (micResult.score <= 50) ? 'WARNING'
                              : 'FAIL',
                        statusMessage: 'Score SRB = ' + micResult.score.toFixed(1) +
                                       ' / 100 (niveau : ' + micResult.classification + '). ' +
                                       'Référence : ' + micResult.references.section + '.',
                        criterion: 'score ≤ 25 (LOW)'
                    });

                    // ---- CALC-MIC-002 : Classification MIC ----
                    calcs.push({
                        id: 'CALC-MIC-002',
                        name: 'MIC Classification Level',
                        formula: 'classification = f(score)',
                        variables: {
                            score: micResult.score,
                            classification: micResult.classification
                        },
                        result: micResult.classification === 'LOW' ? 0
                              : micResult.classification === 'MODERATE' ? 1
                              : micResult.classification === 'HIGH' ? 2 : 3,
                        unit: 'niveau',
                        status: (micResult.classification === 'LOW') ? 'PASS'
                              : (micResult.classification === 'MODERATE') ? 'WARNING'
                              : 'FAIL',
                        statusMessage: 'Classification MIC : ' + micResult.classification +
                                       '. Potentiel cible recommandé : ' +
                                       micResult.targetPotential + ' ' + micResult.targetPotentialUnit,
                        criterion: 'classification ∈ {LOW, MODERATE}'
                    });

                    // ---- CALC-MIC-003 : Protocole de surveillance ----
                    calcs.push({
                        id: 'CALC-MIC-003',
                        name: 'MIC Monitoring Protocol',
                        formula: 'protocol = f(classification)',
                        variables: {
                            couponCount:    micResult.monitoring.couponCount,
                            biocide:        micResult.monitoring.biocideRecommended ? 1 : 0,
                            samplingFreq:   micResult.monitoring.samplingFrequency || 'N/A'
                        },
                        result: micResult.monitoring.couponCount,
                        unit: 'coupons',
                        status: 'WARNING',
                        statusMessage: 'Fréquence : ' + micResult.monitoring.samplingFrequency +
                                       ' | Coupons : ' + micResult.monitoring.couponCount +
                                       ' | Biocide : ' + (micResult.monitoring.biocideRecommended ? 'OUI' : 'NON') +
                                       (micResult.monitoring.biocideType ? ' (' + micResult.monitoring.biocideType + ')' : ''),
                        criterion: 'Protocole NACE TM0212 §8'
                    });
                }
            } catch (micErr) {
                console.warn('[PDF Engine v6.3] MIC collection échouée:', micErr.message);
            }

            console.log('[PDF Engine v6.3] _collectCalculations:', calcs.length, 'fiche(s)');
            return calcs;
        },

        // ========================================================
        // 5. VALIDATION DES DONNÉES
        // ========================================================
        _validateData: function(data) {
            if (!data.project) throw new Error('Donnees du projet manquantes');
            if (!data.project.id) throw new Error('ID du projet manquant');

            this._validationWarnings = [];

            if (!data.assets || data.assets.length === 0) {
                this._validationWarnings.push({
                    type: 'NO_ASSETS',
                    message: 'Aucun equipement enregistre.'
                });
            }
            if (!data.calculations || data.calculations.length === 0) {
                this._validationWarnings.push({
                    type: 'NO_CALCULATIONS',
                    message: 'Aucun calcul disponible.'
                });
            }

            (data.calculations || []).forEach(function(calculation) {
                if (calculation.result !== undefined &&
                    calculation.result !== null &&
                    (!Number.isFinite(Number(calculation.result)))) {
                    throw new Error(
                        'Section: calculations | Parameter: ' + (calculation.id || 'unknown') +
                        ' | Cause: result is not a finite number'
                    );
                }
                Object.keys(calculation.variables || {}).forEach(function(parameter) {
                    const value = calculation.variables[parameter];
                    if (typeof value === 'number' && !Number.isFinite(value)) {
                        throw new Error(
                            'Section: calculations | Parameter: ' + parameter +
                            ' | Source: ' + (calculation.id || 'unknown') +
                            ' | Cause: value is not finite'
                        );
                    }
                });
            });

            if (data.iccp && (data.iccp.current > 0 || data.iccp.requiredCurrent > 0) &&
                data.groundbeds && data.groundbeds.length > 0) {

                const primaryGroundbed = this._getPrimaryGroundbed(data);
                const gbCurrent = (primaryGroundbed && primaryGroundbed.results &&
                    primaryGroundbed.results.I_total) || 0;

                if (gbCurrent > 0) {
                    const maxCurrent = Math.max(data.iccp.current, gbCurrent);
                    const ratio = maxCurrent > 0
                        ? Math.abs(data.iccp.current - gbCurrent) / maxCurrent
                        : 0;

                    if (ratio > 0.2) {
                        const warning = {
                            type: 'ICCP_GROUNDBED_MISMATCH',
                            iccpCurrent: data.iccp.current,
                            groundbedCurrent: gbCurrent,
                            ratio: ratio,
                            message: 'Incoherence ICCP vs Groundbed : ' +
                                     data.iccp.current.toFixed(2) + ' A vs ' +
                                     gbCurrent.toFixed(2) + ' A ' +
                                     '(ecart ' + (ratio * 100).toFixed(0) + '%)'
                        };
                        this._validationWarnings.push(warning);
                        console.warn('[PDF Engine v6.3] ' + warning.message);
                    }
                }
            }

            if (data.iccp && data.iccp.voltage > 0 &&
                data.groundbeds && data.groundbeds.length > 0) {

                const primaryGroundbed = this._getPrimaryGroundbed(data);
                const gbVoltage = (primaryGroundbed && primaryGroundbed.results &&
                    primaryGroundbed.results.V_rectifier) || 0;
                if (gbVoltage > 0) {
                    const maxV = Math.max(data.iccp.voltage, gbVoltage);
                    const ratioV = maxV > 0
                        ? Math.abs(data.iccp.voltage - gbVoltage) / maxV
                        : 0;

                    if (ratioV > 0.2) {
                        const warning = {
                            type: 'ICCP_GROUNDBED_VOLTAGE_MISMATCH',
                            iccpVoltage: data.iccp.voltage,
                            groundbedVoltage: gbVoltage,
                            ratio: ratioV,
                            message: 'Ecart de modelisation tension ICCP/Groundbed (V_initial incluant back EMF vs chute ohmique Groundbed) : ' +
                                     data.iccp.voltage.toFixed(1) + ' V vs ' +
                                     gbVoltage.toFixed(1) + ' V. Comparaison non bloquante.'
                        };
                        this._validationWarnings.push(warning);
                        console.warn('[PDF Engine v6.3] ' + warning.message);
                    }
                }
            }

            const sacp = data.sacp || {};
            const hasPartialSacp = (sacp.totalMass > 0 && sacp.count <= 0) ||
                (sacp.count > 0 && sacp.totalMass <= 0) ||
                (sacp.actualLife > 0 && (sacp.totalMass <= 0 || sacp.count <= 0));
            if (hasPartialSacp) {
                this._validationWarnings.push({
                    type: 'SACP_PARTIAL_RESULT',
                    message: 'Résultat SACP partiel : masse, nombre d’anodes et durée de vie doivent provenir du même calcul.'
                });
            }

            const criticalWarnings = this._validationWarnings.filter(function(w) {
                return w.type === 'ICCP_GROUNDBED_MISMATCH' ||
                    w.type === 'SACP_PARTIAL_RESULT';
            });
            if (criticalWarnings.length > 0) {
                throw new Error(
                    'Rapport bloqué : résultats de calcul incohérents. ' +
                    criticalWarnings.map(function(w) { return w.message; }).join(' ')
                );
            }

            if (this._validationWarnings.length > 0 && window.UI &&
                typeof window.UI.showToast === 'function') {
                const mismatchWarnings = this._validationWarnings.filter(function(w) {
                    return w.type.indexOf('MISMATCH') !== -1;
                });
                if (mismatchWarnings.length > 0) {
                    window.UI.showToast(
                        '[ATTENTION] ' + mismatchWarnings.length +
                        ' incoherence(s) detectee(s) entre modules. Voir section 21 du rapport.',
                        'warning'
                    );
                }
            }
        },

        // ========================================================
        // 6. CONSTRUCTION PDF EN 2 PASSES (TOC robuste – B-04)
        // ========================================================
        _buildPDF: async function() {
            this._helpers.y = this._margin;

            // ===== COUVERTURE (ajoute page 1 + réserve page 2 pour TOC) =====
            this._sections.generateCoverPage(this._data, this._helpers);

            // ===== La page courante est maintenant la page 2 (réservée pour TOC) =====
            const tocPageIndex = this._doc.internal.getNumberOfPages();
            console.log('[PDF Engine v6.3] Page TOC reservee: page', tocPageIndex);

            // ===== PASS 1 : génération de toutes les sections =====
            this._chapterPages = {};
            this._generateAllSections();

            // ===== PASS 2 : retour sur la page TOC pour y écrire les numéros =====
            this._writeTableOfContents(tocPageIndex);
            console.log('[PDF Engine v6.3] TOC remplie sur page', tocPageIndex);

            // ===== HEADERS / FOOTERS sur toutes les pages (sauf couverture) =====
            this._addHeadersAndFooters();
            console.log('[PDF Engine v6.3] Headers/Footers appliques');
        },

        // ========================================================
        // 7. ÉCRITURE DIRECTE DE LA TOC (B-04 robuste)
        // ========================================================
        _writeTableOfContents: function(tocPageIndex) {
            const doc = this._doc;
            const styles = this._styles;
            const margin = this._margin;
            const pageWidth = this._pageWidth;

            doc.setPage(tocPageIndex);

            let tocY = margin + styles.layout.headerHeight;

            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.chapterTitle);
            const primaryRgb = this._helpers.hexToRgb(styles.colors.primary);
            doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            try {
                doc.text('TABLE OF CONTENTS', margin, tocY);
            } catch (e) {
                console.warn('[PDF Engine v6.3] Erreur ecriture titre TOC:', e.message);
            }

            tocY += 6;

            doc.setDrawColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            doc.setLineWidth(0.5);
            doc.line(margin, tocY, margin + 60, tocY);
            doc.setLineWidth(0.2);

            tocY += 8;

            const chapters = this._getChaptersWithPages();
            const textDarkRgb = this._helpers.hexToRgb(styles.colors.textDark);
            const textLightRgb = this._helpers.hexToRgb(styles.colors.textLight);
            const dotChar = '.';
            const lineHeight = 6;

            doc.setFont(styles.typography.fontFamily, 'normal');
            doc.setFontSize(styles.typography.sizes.body);

            for (let i = 0; i < chapters.length; i++) {
                const chapter = chapters[i];
                if (!chapter.title || chapter.title === '') {
                    tocY += lineHeight * 0.5;
                    continue;
                }

                const cleanTitle = this._helpers._cleanText(chapter.title);
                if (cleanTitle === '') {
                    tocY += lineHeight * 0.5;
                    continue;
                }

                const pageStr = String(chapter.page);

                let titleWidth = 0;
                let dotWidth = 0;
                let pageWidthNum = 0;
                try {
                    titleWidth = doc.getTextWidth(cleanTitle);
                    dotWidth = doc.getTextWidth(dotChar);
                    pageWidthNum = doc.getTextWidth(pageStr);
                } catch (e) {
                    titleWidth = cleanTitle.length * 2.5;
                    dotWidth = 1.5;
                    pageWidthNum = pageStr.length * 2.5;
                }

                const available = pageWidth - 2 * margin - titleWidth - pageWidthNum - 8;
                const dotCount = dotWidth > 0 ? Math.max(0, Math.floor(available / dotWidth)) : 0;
                let dots = '';
                for (let d = 0; d < dotCount; d++) dots += dotChar;

                doc.setTextColor(textDarkRgb[0], textDarkRgb[1], textDarkRgb[2]);
                try {
                    doc.text(cleanTitle, margin, tocY);
                } catch (e) {
                    console.warn('[PDF Engine v6.3] Erreur ecriture titre:', cleanTitle, e.message);
                }

                if (dots.length > 0) {
                    doc.setTextColor(textLightRgb[0], textLightRgb[1], textLightRgb[2]);
                    try {
                        doc.text(dots, margin + titleWidth + 2, tocY);
                    } catch (e) {}
                }

                doc.setTextColor(textDarkRgb[0], textDarkRgb[1], textDarkRgb[2]);
                try {
                    doc.text(pageStr, pageWidth - margin, tocY, { align: 'right' });
                } catch (e) {}

                tocY += lineHeight;
            }

            doc.setTextColor(26, 26, 26);
            console.log('[PDF Engine v6.3] TOC: ' + chapters.length + ' chapitres ecrits');
        },

        // ========================================================
        // 8. GÉNÉRATION DE TOUTES LES SECTIONS
        // ========================================================
        _generateAllSections: function() {
            const sections = this._sections;
            const helpers = this._helpers;
            const data = this._data;
            const self = this;

            const requiredSections = [
                'generateCoverPage',
                'generateDocumentControl',
                'generateRevisionHistory',
                'generateTableOfContents',
                'generateExecutiveSummary',
                'generateSection1_Scope',
                'generateSection2_Assets',
                'generateSection3_Environment',
                'generateSection4_Standards',
                'generateSection5_Criteria',
                'generateSection23_Annexes',
                'drawHeader',
                'drawFooter'
            ];
            const missing = requiredSections.filter(function(fn) {
                return typeof sections[fn] !== 'function';
            });
            if (missing.length > 0) {
                const msg = 'Fonctions de section manquantes: ' + missing.join(', ');
                console.error('[PDF Engine v6.3] ' + msg);
                throw new Error(msg);
            }

            const startSection = function(title, generator) {
                self._doc.addPage();
                helpers.y = helpers.margin + helpers.styles.layout.headerHeight;
                self._chapterPages[title] = self._doc.internal.getNumberOfPages();
                generator(data, helpers);
            };

            this._doc.addPage();
            helpers.y = helpers.margin + helpers.styles.layout.headerHeight;
            this._chapterPages['DOCUMENT CONTROL'] = this._doc.internal.getNumberOfPages();
            sections.generateDocumentControl(data, helpers);

            this._doc.addPage();
            helpers.y = helpers.margin + helpers.styles.layout.headerHeight;
            this._chapterPages['REVISION HISTORY'] = this._doc.internal.getNumberOfPages();
            sections.generateRevisionHistory(helpers);

            startSection('EXECUTIVE SUMMARY', function(d, h) {
                sections.generateExecutiveSummary(d, h);
            });

            startSection('1. OBJECT OF THE STUDY', function(d, h) {
                sections.generateSection1_Scope(d, h);
            });
            startSection('2. DESCRIPTION OF THE FACILITY', function(d, h) {
                sections.generateSection2_Assets(d, h);
            });
            startSection('3. ENVIRONMENT', function(d, h) {
                sections.generateSection3_Environment(d, h);
            });
            startSection('4. APPLICABLE CODES AND STANDARDS', function(d, h) {
                sections.generateSection4_Standards(d, h);
            });
            startSection('5. CP DESIGN CRITERIA', function(d, h) {
                sections.generateSection5_Criteria(d, h);
            });

            this._generateTechnicalSections();
            this._generateRemainingSections();
            this._generateFinalSections();

            startSection('23. ANNEXES', function(d, h) {
                sections.generateSection23_Annexes(d, h);
            });
        },

        // ========================================================
        // 9. SECTIONS TECHNIQUES (6 à 12)
        //   ⭐ v6.3 : appel direct de generateNomenclature()
        //             (Section 9.1 intégrée, plus de monkey-patching)
        // ========================================================
        _generateTechnicalSections: function() {
            const data = this._data;
            const helpers = this._helpers;
            const styles = this._styles;
            const doc = this._doc;

            // ===== SECTION 6 : INPUT DATA =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['6. INPUT DATA'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('6. INPUT DATA', 1);
            helpers.addSectionTitle('6.1 Geometric Data', 2);

            const geoRows = data.assets
                .filter(function(a) { return a.surface > 0; })
                .map(function(a) {
                    const surfaceFmt = styles.formatSurface
                        ? styles.formatSurface(a.surface)
                        : a.surface.toFixed(1);
                    const diameterFmt = (a.dimensions && a.dimensions.diametre_m)
                        ? styles.formatNumber(a.dimensions.diametre_m * 1000, 0) + ' mm'
                        : '—';
                    const lengthFmt = (a.dimensions && a.dimensions.longueur_m)
                        ? styles.formatNumber(a.dimensions.longueur_m, 1) + ' m'
                        : '—';
                    return [
                        a.tag || 'N/A',
                        surfaceFmt,
                        diameterFmt,
                        lengthFmt
                    ];
                });

            if (geoRows.length > 0) {
                helpers.addTable(['Tag', 'Surface (m2)', 'Diameter', 'Length'], geoRows);
            } else {
                helpers.addText('No geometric data available.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
                helpers.y += 6;
            }

            helpers.addSectionTitle('6.2 Coating Data', 2);
            const coatRows = data.assets
                .filter(function(a) { return a.coatingType && a.surface > 0; })
                .map(function(a) {
                    const thicknessFmt = (a.coatingThickness && a.coatingThickness > 0)
                        ? styles.formatNumber(a.coatingThickness, 1) + ' mm'
                        : '—';
                    return [
                        a.tag || 'N/A',
                        a.coatingType || '—',
                        a.coatingCondition || '—',
                        thicknessFmt
                    ];
                });

            if (coatRows.length > 0) {
                helpers.addTable(['Tag', 'Type', 'Condition', 'Thickness'], coatRows);
            } else {
                helpers.addText('No coating data available.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
            }

            // ===== SECTION 7 : DIAGNOSTIC =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['7. EXISTING CONDITION DIAGNOSTIC'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('7. EXISTING CONDITION DIAGNOSTIC', 1);

            // F-07 : Distinguer explicitement ON / Instant OFF / IR-drop /
            //        Polarization. Ne JAMAIS assimiler ON-OFF a la
            //        polarisation cathodique (NACE SP0169 §6).
            const REF_ELECTRODE_LABEL = 'vs Cu/CuSO4 saturated';

            const measurements = data.fieldMeasurements || [];
            const offPotentialCriterion = Number(data.criteria && data.criteria.naceOffPotential);
            const polarizationCriterion = Number(data.criteria && data.criteria.nacePolarization);
            const offCriterion = Number.isFinite(offPotentialCriterion) ? offPotentialCriterion : -850;
            const polarizationLimit = Number.isFinite(polarizationCriterion) ? polarizationCriterion : 100;
            if (measurements.length > 0) {
                helpers.addSectionTitle('7.1 Field Measurements', 2);
                helpers.y += 2;

                helpers.addText(
                    'Note : ON = potentiel sous protection. Instant OFF = potentiel ' +
                    'mesure < 1 s apres coupure. IR-drop = ON - Instant OFF ' +
                    '(approximation). Polarization = |Instant OFF - Native Potential|. ' +
                    'L\'assimilation ON-OFF a la polarisation est INTERDITE ' +
                    '(NACE SP0169).',
                    helpers.margin, helpers.y,
                    { style: 'italic', color: styles.colors.textLight }
                );
                helpers.y += 6;

                const measRows = measurements.slice(0, 20).map(function(m) {
                    const irDrop = (m.potON !== null && m.potOFF !== null)
                        ? (m.potON - m.potOFF)
                        : null;

                    let naceStatus = 'NOT ASSESSABLE';
                    if (m.potOFF !== null && m.potOFF !== undefined) {
                        if (m.potOFF <= offCriterion) {
                            naceStatus = 'PASS';
                        } else if (m.polarization !== null && m.polarization !== undefined && m.polarization >= polarizationLimit) {
                            naceStatus = 'PASS';
                        } else {
                            naceStatus = 'FAIL';
                        }
                    }

                    return [
                        m.date ? new Date(m.date).toLocaleDateString('fr-FR') : 'N/A',
                        m.assetTag || 'N/A',
                        m.potON !== null ? styles.formatNumber(m.potON, 0) : '—',
                        m.potOFF !== null ? styles.formatNumber(m.potOFF, 0) : '—',
                        irDrop !== null ? styles.formatNumber(irDrop, 0) : '—',
                        (m.polarization !== null && m.polarization !== undefined)
                            ? styles.formatNumber(m.polarization, 0)
                            : '—',
                        styles.formatStatus(naceStatus)
                    ];
                });

                helpers.addTable(
                    ['Date', 'Tag', 'ON (mV)', 'Instant OFF (mV)', 'IR-drop (mV)', 'Polarization (mV)', 'NACE Status'],
                    measRows,
                    { colWidths: [22, 26, 22, 30, 22, 30, 30] }
                );

                const total = measurements.length;
                const pass = measurements.filter(function(m) {
                    return m.potOFF !== null && m.potOFF <= offCriterion;
                }).length;
                const polarPass = measurements.filter(function(m) {
                    return m.polarization !== null && m.polarization !== undefined && m.polarization >= polarizationLimit;
                }).length;

                helpers.y += 4;
                helpers.addText(
                    'NACE Compliance (OFF <= ' + offCriterion + ' mV ' + REF_ELECTRODE_LABEL + ') : ' +
                    pass + '/' + total + ' (' + (total > 0 ? (pass / total * 100).toFixed(0) : 0) + '%)',
                    helpers.margin, helpers.y, { style: 'bold' }
                );
                helpers.y += 4;
                helpers.addText(
                    'NACE Compliance (Polarization >= ' + polarizationLimit + ' mV) : ' +
                    polarPass + '/' + total + ' (' + (total > 0 ? (polarPass / total * 100).toFixed(0) : 0) + '%)',
                    helpers.margin, helpers.y, { style: 'bold' }
                );
                helpers.y += 6;
            } else {
                helpers.addText('No field measurements available.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
                helpers.y += 6;
            }

            // ===== SECTION 8 : TECHNOLOGY =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['8. CP TECHNOLOGY SELECTION'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('8. CP TECHNOLOGY SELECTION', 1);

            const techRows = [
                ['System Type', (data.project.cpSystemType || 'ICCP').toUpperCase()],
                ['SACP Available', data.sacp.count > 0
                    ? 'Yes (' + styles.formatUnitCount(data.sacp.count) + ' anodes)' : 'No'],
                ['ICCP Available', (data.iccp.current > 0 || data.iccp.requiredCurrent > 0)
                    ? 'Yes (' + styles.formatAmp(data.iccp.current || data.iccp.requiredCurrent) + ' A)' : 'No'],
                ['Groundbed Available', data.groundbeds.length > 0
                    ? 'Yes (' + data.groundbeds.length + ' wells)' : 'No']
            ];
            helpers.addTable(['Parameter', 'Value'], techRows);

            // ============================================================
            // ===== SECTION 9 : CALC SHEETS (avec nomenclature v6.3) =====
            // ------------------------------------------------------------
            // v6.3 : appel DIRECT de generateNomenclature()
            //        juste après le titre de section 9.
            //        Plus de monkey-patching de helpers.addSectionTitle.
            // ============================================================
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['9. ENGINEERING CALCULATION SHEETS'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('9. ENGINEERING CALCULATION SHEETS', 1);

            // ⭐ v6.3 : appel direct — Section 9.1 Nomenclature
            if (typeof this._sections.generateNomenclature === 'function') {
                try {
                    helpers.y += 4;
                    this._sections.generateNomenclature(data, helpers);
                    helpers.y += 4;
                    console.log('[PDF Engine v6.3] ✅ Section 9.1 Nomenclature generee (appel direct)');
                } catch (err) {
                    console.warn('[PDF Engine v6.3] Erreur generation nomenclature:', err.message);
                    // Continue sans bloquer le rapport
                }
            } else {
                console.warn('[PDF Engine v6.3] generateNomenclature non disponible — Section 9.1 omise.');
            }

            const calculations = data.calculations || [];
            if (calculations.length > 0) {
                this._calculations.generateRegister(calculations, helpers);
                helpers.y += 6;

                const idOccurrences = {};

                calculations.forEach(function(calc, index) {
                    if (this._calculations.isValidCalculation(calc)) {
                        const baseId = calc.id || 'N/A';
                        idOccurrences[baseId] = (idOccurrences[baseId] || 0) + 1;

                        this._calculations.generateSheet(calc, helpers, {
                            occurrenceIndex: idOccurrences[baseId]
                        });

                        if (index < calculations.length - 1) {
                            helpers.y += 4;
                        }
                    }
                }, this);
            } else {
                helpers.addText('No calculations available.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
            }

            // ===== SECTION 10 : SACP =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['10. SACP DESIGN'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('10. SACP DESIGN', 1);

            const hasValidSacpDesign = data.sacp.count > 0 && data.sacp.totalMass > 0;
            if (hasValidSacpDesign) {
                const sacpRows = [
                    ['Total Anode Mass', styles.formatKg(data.sacp.totalMass) + ' kg'],
                    ['Number of Anodes', styles.formatUnitCount(data.sacp.count)],
                    ['Design Life', styles.formatNumber(data.sacp.actualLife, 1) + ' years'],
                    ['Initial Current', styles.formatAmp(data.sacp.initialCurrent) + ' A'],
                    ['Final Current', styles.formatAmp(data.sacp.finalCurrent) + ' A'],
                    ['Current Density', styles.formatNumber(data.sacp.currentDensity, 3) + ' A/m2'],
                    ['Density Status', data.sacp.densityOk ? '[OK]' : '[WARN]'],
                    ['Material', data.sacp.anodeMaterial || 'N/A'],
                    ['Soil Resistivity', styles.formatOhm(data.sacp.soilResistivity) + ' Ohm.m'],
                    ['Safety Factor', styles.formatNumber(data.sacp.safetyFactor, 2)]
                ];
                helpers.addTable(['Parameter', 'Value'], sacpRows);
            } else {
                helpers.addText('No SACP system configured.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
            }

            // ===== SECTION 11 : ICCP =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['11. ICCP DESIGN'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('11. ICCP DESIGN', 1);

            if (data.iccp.current > 0 || data.iccp.requiredCurrent > 0) {
                const lifeDesign = (data.iccp.lifeDesign !== undefined && data.iccp.lifeDesign !== null)
                    ? data.iccp.lifeDesign : (data.iccp.lifeEstimate || 0);
                const lifeTheory = data.iccp.lifeTheoretical || 0;

                const lifeDisplay = (lifeDesign > 0)
                    ? styles.formatNumber(lifeDesign, 1) + ' years'
                    : '—';

                const jAnodeA = data.iccp.currentDensity || 0;
                const jAnodeMA = data.iccp.currentDensity_mA || (jAnodeA * 1000);
                const jDisplay = (Math.abs(jAnodeA) >= 1)
                    ? styles.formatNumber(jAnodeA, 3) + ' A/m2'
                    : styles.formatNumber(jAnodeMA, 1) + ' mA/m2';

                const powerDesign = (data.iccp.powerDesign !== undefined && data.iccp.powerDesign !== null)
                    ? data.iccp.powerDesign
                    : (data.iccp.power || 0);

                const iccpRows = [
                    ['Total Current', styles.formatAmp(data.iccp.current) + ' A'],
                    ['Initial Voltage', styles.formatVolt(data.iccp.voltage) + ' V'],
                    ['Final Voltage', (data.iccp.voltageFinal > 0
                        ? styles.formatVolt(data.iccp.voltageFinal) + ' V'
                        : '—')],
                    ['Power (design)', styles.formatNumber(powerDesign, 0) + ' W'],
                    ['Groundbed Resistance', styles.formatOhm(data.iccp.groundbedResistance) + ' Ohm'],
                    ['Anode Current Density', jDisplay],
                    ['Density Status', data.iccp.densityOk ? '[OK]' : '[WARN]'],
                    ['Life Estimate (design)', lifeDisplay],
                    ['Life Estimate (theory)', (lifeTheory > 0
                        ? styles.formatNumber(lifeTheory, 1) + ' years'
                        : '—')]
                ];
                helpers.addTable(['Parameter', 'Value'], iccpRows);
            } else {
                helpers.addText('No ICCP system configured.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
            }

            // ===== SECTION 12 : GROUNDBED (avec schéma vectoriel) =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['12. DEEP WELL GROUNDBED'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('12. DEEP WELL GROUNDBED', 1);

            if (data.groundbeds.length > 0) {
                data.groundbeds.forEach(function(gb, index) {
                    helpers.addNewPageIfNeeded(50);
                    helpers.addSectionTitle('12.' + (index + 1) + ' ' + (gb.name || 'Well ' + (index + 1)), 2);

                    const params = gb.parameters || {};
                    const results = gb.results || {};

                    const jAnodeA = results.J_anode || 0;
                    const jAnodeMA = results.J_anode_mA || (jAnodeA * 1000);
                    const jDisplay = (Math.abs(jAnodeA) >= 1)
                        ? styles.formatNumber(jAnodeA, 3) + ' A/m2'
                        : styles.formatNumber(jAnodeMA, 1) + ' mA/m2';

                    const rhoProjectVal = (results.rhoProject !== undefined)
                        ? results.rhoProject : '—';
                    const rhoGroundbedVal = (results.rhoGroundbed !== undefined)
                        ? results.rhoGroundbed : '—';

                    // CORRECTION v6.2 : Diamètre anode en mm
                    const anodeDiameterDisplay = (params.anodeDiameter !== undefined && params.anodeDiameter !== null)
                        ? styles.formatNumber(params.anodeDiameter, 0) + ' mm'
                        : '—';

                    const gbRows = [
                        ['ID', gb.id || 'N/A'],
                        ['Total Depth', styles.formatNumber(params.totalDepth, 0) + ' m'],
                        ['Active Depth', styles.formatNumber(params.activeDepth, 0) + ' m'],
                        ['Number of Anodes', styles.formatUnitCount(params.anodeCount)],
                        ['Anode Length', styles.formatNumber(params.anodeLength, 2) + ' m'],
                        ['Anode Diameter', anodeDiameterDisplay],
                        ['Soil Resistivity (project)', rhoProjectVal + ' Ohm.m'],
                        ['Soil Resistivity (groundbed)', rhoGroundbedVal + ' Ohm.m'],
                        ['Total Resistance', styles.formatOhm(results.R_total) + ' Ohm'],
                        ['Total Current', styles.formatAmp(results.I_total) + ' A'],
                        ['Anode Current Density', jDisplay],
                        ['Voltage', styles.formatVolt(results.V_rectifier) + ' V'],
                        ['Power', styles.formatNumber(results.P_rectifier, 0) + ' W']
                    ];
                    helpers.addTable(['Parameter', 'Value'], gbRows);
                    helpers.y += 4;

                    if (typeof this._sections._drawGroundbedSchema === 'function') {
                        helpers.addNewPageIfNeeded(70);
                        helpers.y = this._sections._drawGroundbedSchema(
                            gb,
                            helpers,
                            helpers.margin,
                            helpers.y,
                            helpers.contentWidth,
                            60
                        );
                    }
                }, this);
            } else {
                helpers.addText('No groundbed configured.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
            }
        },

        // ========================================================
        // 10. SECTIONS 13 à 18
        // ========================================================
        _generateRemainingSections: function() {
            const data = this._data;
            const helpers = this._helpers;
            const styles = this._styles;
            const doc = this._doc;

            // ===== SECTION 13 : RECTIFIER =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['13. RECTIFIER DESIGN'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('13. RECTIFIER / CP STATION', 1);

            if (data.iccp.current > 0) {
                const powerDesign = (data.iccp.powerDesign !== undefined && data.iccp.powerDesign !== null)
                    ? data.iccp.powerDesign
                    : (data.iccp.power || 0);
                const safetyFactorPower = data.iccp.safetyFactorPower || 1.15;
                const calculatedVoltage = data.iccp.rectifierVoltage ||
                    data.iccp.voltageFinal || data.iccp.voltage || 0;

                const rectRows = [
                    ['Calculated Required Current', styles.formatAmp(data.iccp.current) + ' A'],
                    ['Calculated Required Voltage', styles.formatVolt(calculatedVoltage) + ' V'],
                    ['Power (design)', styles.formatNumber(powerDesign, 0) + ' W'],
                    ['Selected Rectifier Rating', 'N/A — DATA REQUIRED'],
                    ['Safety Factor (power)', styles.formatNumber(safetyFactorPower, 2)],
                    ['Calculated Current', styles.formatAmp(data.iccp.current) + ' A'],
                    ['Calculated Voltage', styles.formatVolt(calculatedVoltage) + ' V']
                ];
                helpers.addTable(['Parameter', 'Value'], rectRows);
            } else {
                helpers.addText('No rectifier data available.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
            }

            // ===== SECTION 14 : DC INTERFERENCE =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['14. DC INTERFERENCE'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('14. DC INTERFERENCE', 1);

            const ifData = data.interference;
            if (ifData && ifData.dcStray !== undefined) {
                const dcRows = [
                    ['DeltaV', styles.formatNumber(ifData.deltaV, 1) + ' mV'],
                    ['DC Stray Current', styles.formatNumber(ifData.dcStray, 3) + ' A'],
                    ['DC Status', ifData.dcStatus || '—'],
                    ['Path Resistance', styles.formatOhm(ifData.R_path) + ' Ohm']
                ];
                helpers.addTable(['Parameter', 'Value'], dcRows);
            } else {
                helpers.addText('No DC interference data available.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
            }

            // ===== SECTION 15 : AC INTERFERENCE =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['15. AC INTERFERENCE'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('15. AC INTERFERENCE', 1);

            if (ifData && ifData.acInduced !== undefined) {
                const acStatus = String(ifData.acStatus || '').toLowerCase();
                const globalAcStatus = acStatus.indexOf('action corrective') !== -1 ||
                    acStatus.indexOf('obligatoire') !== -1
                    ? 'ACTION CORRECTIVE OBLIGATOIRE'
                    : (acStatus.indexOf('surveillance') !== -1
                        ? 'SURVEILLANCE NECESSAIRE'
                        : (ifData.globalStatus || 'NON EVALUE'));
                const acRows = [
                    ['AC Induced Voltage', styles.formatNumber(ifData.acInduced, 2) + ' V'],
                    ['Touch Voltage', styles.formatNumber(ifData.touchVoltage, 2) + ' V'],
                    ['AC Status', ifData.acStatus || '—'],
                    ['Global Status', globalAcStatus]
                ];
                helpers.addTable(['Parameter', 'Value'], acRows);

                if (ifData.mitigations && ifData.mitigations.length > 0) {
                    helpers.y += 4;
                    helpers.addText('Recommended mitigations:', helpers.margin, helpers.y, { style: 'bold' });
                    helpers.y += 4;
                    ifData.mitigations.forEach(function(m) {
                        helpers.addText('- ' + m, helpers.margin + 5, helpers.y);
                        helpers.y += 4;
                    });
                }
            } else {
                helpers.addText('No AC interference data available.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
            }

            // ===== SECTION 16 : IMPLEMENTATION =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['16. IMPLEMENTATION'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('16. IMPLEMENTATION PLAN', 1);

            const implRows = [
                ['Total Equipment', data.assets.length],
                ['CP Systems', data.cpSystems.length],
                ['Groundbeds', data.groundbeds.length],
                ['Equipment with GPS', data.gis.totalWithCoords || 0]
            ];
            helpers.addTable(['Parameter', 'Value'], implRows);

            // ===== SECTION 17 : GIS =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['17. GIS / LOCATION'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('17. GIS / LOCATION PLAN', 1);

            if (data.gis.totalWithCoords > 0) {
                const coordRows = data.gis.equipmentWithCoords.slice(0, 20).map(function(eq) {
                    const coord = eq.coordinates;
                    let lat = 'N/A';
                    let lon = 'N/A';
                    if (coord) {
                        if (Array.isArray(coord) && coord.length > 0) {
                            lat = styles.formatNumber(coord[0].lat, 6);
                            lon = styles.formatNumber(coord[0].lon, 6);
                        } else if (coord.lat !== undefined) {
                            lat = styles.formatNumber(coord.lat, 6);
                            lon = styles.formatNumber(coord.lon, 6);
                        }
                    }
                    return [eq.tag || 'N/A', eq.type || 'N/A', lat, lon];
                });
                helpers.addTable(['Tag', 'Type', 'Latitude', 'Longitude'], coordRows);
            } else {
                helpers.addText('No GIS data available.', helpers.margin, helpers.y, {
                    style: 'italic', color: styles.colors.textLight
                });
            }

            if (typeof this._sections._insertChartSnapshots === 'function') {
                helpers.addNewPageIfNeeded(80);
                helpers.y = this._sections._insertChartSnapshots(helpers);
            }

            // ===== SECTION 18 : MONITORING =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['18. MONITORING'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('18. MONITORING EQUIPMENT', 1);

            const systemsWithHistory = data.cpSystems.filter(function(s) {
                return s.history && s.history.length > 0;
            }).length;

            const monRows = [
                ['Field Measurements', data.fieldMeasurements.length],
                ['Systems with History', systemsWithHistory],
                ['Total History', data.history.length]
            ];
            helpers.addTable(['Parameter', 'Value'], monRows);
        },

        // ========================================================
        // 11. SECTIONS 19 à 22
        // ========================================================
        _generateFinalSections: function() {
            const data = this._data;
            const helpers = this._helpers;
            const styles = this._styles;
            const doc = this._doc;

            // ===== SECTION 19 : COMMISSIONING =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['19. COMMISSIONING'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('19. COMMISSIONING', 1);

            const commLines = [
                'Commissioning tests include:',
                '  - Electrical continuity verification (' + data.assets.length + ' equipment)',
                '  - Insulation joint testing',
                '  - Natural potential (OFF) measurement'
            ];

            if (data.iccp.current > 0) {
                commLines.push('  - ICCP system energization (' + styles.formatVolt(data.iccp.voltage) + ' V)');
                commLines.push('  - Current output adjustment (' + styles.formatAmp(data.iccp.current) + ' A)');
            }

            commLines.push('  - ON/OFF potential measurement after stabilization');
            commLines.push('  - Polarization verification (NACE SP0169 criterion)');
            commLines.push('');
            commLines.push('Estimated duration: ' + (data.assets.length > 5 ? '2 days' : '1 day'));

            commLines.forEach(function(line) {
                helpers.addNewPageIfNeeded(6);
                if (line) {
                    helpers.addText(line, helpers.margin, helpers.y);
                    helpers.y += 5;
                } else {
                    helpers.y += 4;
                }
            });
            helpers.y += 6;

            // ===== SECTION 20 : MAINTENANCE =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['20. MAINTENANCE'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('20. MAINTENANCE', 1);

            const maintLines = [
                'Maintenance plan for ' + (data.project.name || 'N/A') + ':',
                '  - Periodic test station inspections',
                '  - ON/OFF potential verification (NACE SP0169)'
            ];

            if (data.iccp.current > 0) {
                maintLines.push('  - Rectifier verification (current, voltage, status)');
                maintLines.push('  - ICCP cable and connection control');
            }
            if (data.sacp.count > 0) {
                maintLines.push('  - Sacrificial anode inspection (consumption, status)');
            }

            maintLines.push('  - Soil resistivity measurement (Wenner 4 points)');
            maintLines.push('  - AC/DC interference verification');
            maintLines.push('');
            maintLines.push('Recommended frequency: ' + (data.iccp.current > 0 ? 'Semi-annual' : 'Annual'));

            maintLines.forEach(function(line) {
                helpers.addNewPageIfNeeded(6);
                if (line) {
                    helpers.addText(line, helpers.margin, helpers.y);
                    helpers.y += 5;
                } else {
                    helpers.y += 4;
                }
            });
            helpers.y += 6;

            // ===== SECTION 21 : VALIDATION & ALERTS =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['21. VALIDATION & ALERTS'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('21. VALIDATION & ALERTS', 1);

            const totalCalc = data.calculations.length;
            const passedCalc = data.calculations.filter(function(c) { return c.status === 'PASS'; }).length;
            const warningCalc = data.calculations.filter(function(c) { return c.status === 'WARNING'; }).length;
            const failedCalc = data.calculations.filter(function(c) { return c.status === 'FAIL'; }).length;
            const notAssessableCalc = data.calculations.filter(function(c) {
                return c.status === 'NOT ASSESSABLE' || c.status === 'N/A' || c.status === 'NC';
            }).length;

            const valRows = [
                ['Total Calculations', totalCalc],
                ['Compliant (PASS)', passedCalc],
                ['Warnings (WARNING)', warningCalc],
                ['Non-compliant (FAIL)', failedCalc],
                ['Non-assessable', notAssessableCalc]
            ];
            helpers.addTable(['Status', 'Count'], valRows);

            const mismatchWarnings = (this._validationWarnings || []).filter(function(w) {
                return w.type && w.type.indexOf('MISMATCH') !== -1;
            });

            if (mismatchWarnings.length > 0) {
                helpers.y += 8;
                helpers.addSectionTitle('21.1 Critical Alerts', 2);
                helpers.y += 2;

                mismatchWarnings.forEach(function(warning) {
                    helpers.addNewPageIfNeeded(30);

                    let title = 'Incoherence detectee';
                    let content = warning.message;

                    if (warning.type === 'ICCP_GROUNDBED_MISMATCH') {
                        title = 'Alerte : Incoherence ICCP vs Groundbed';
                        content = 'Le courant ICCP (' + warning.iccpCurrent.toFixed(2) +
                                  ' A) differe du courant Groundbed (' + warning.groundbedCurrent.toFixed(2) +
                                  ' A), soit un ecart de ' + (warning.ratio * 100).toFixed(0) +
                                  '%. Verifier la coherence des calculs. ' +
                                  'Recommandation : recalculer le Groundbed en utilisant le courant ICCP comme courant cible.';
                    } else if (warning.type === 'ICCP_GROUNDBED_VOLTAGE_MISMATCH') {
                        title = 'Alerte : Incoherence tension ICCP vs Groundbed';
                        content = 'La tension ICCP (' + warning.iccpVoltage.toFixed(1) +
                                  ' V) differe de la tension Groundbed (' + warning.groundbedVoltage.toFixed(1) +
                                  ' V). Verifier la coherence des calculs.';
                    }

                    helpers.y = helpers.addInfoBox(
                        title,
                        content,
                        helpers.margin,
                        helpers.y,
                        helpers.contentWidth,
                        'error'
                    );
                });
            }

            // ===== SECTION 22 : CONCLUSION =====
            doc.addPage();
            helpers.y = helpers.margin + styles.layout.headerHeight;
            this._chapterPages['22. CONCLUSION'] = doc.internal.getNumberOfPages();
            helpers.addSectionTitle('22. ENGINEERING CONCLUSION', 1);

            const conclusion = [];
            const hasCP = data.sacp.count > 0 || data.iccp.current > 0;

            if (hasCP) {
                conclusion.push('[OK] A cathodic protection system is configured for this project.');
            } else {
                conclusion.push('[WARN] No cathodic protection system is configured.');
            }

            if (data.calculations.length > 0) {
                const passRate = passedCalc / data.calculations.length * 100;
                if (passRate >= 80) {
                    conclusion.push('[OK] ' + passRate.toFixed(0) + '% of calculations are compliant.');
                } else if (passRate >= 50) {
                    conclusion.push('[WARN] ' + passRate.toFixed(0) + '% of calculations are compliant. Verification needed.');
                } else {
                    conclusion.push('[FAIL] ' + passRate.toFixed(0) + '% of calculations are compliant. Revision required.');
                }
            }

            if (mismatchWarnings.length > 0) {
                conclusion.push('');
                conclusion.push('[FAIL] ' + mismatchWarnings.length +
                                ' coherence issue(s) detected between modules. See section 21.1.');
            }

            conclusion.push('');
            conclusion.push('Recommendations:');

            let hasRecommendation = false;
            if (mismatchWarnings.length > 0) {
                conclusion.push('  - Resolve coherence issues between ICCP and Groundbed modules');
                hasRecommendation = true;
            }
            if (data.sacp.count > 0 && !data.sacp.densityOk) {
                conclusion.push('  - Increase number of anodes or modify layout');
                hasRecommendation = true;
            }
            if (data.iccp.current > 0 && !data.iccp.densityOk) {
                conclusion.push('  - Increase ICCP anode count or modify layout');
                hasRecommendation = true;
            }
            if (data.groundbeds.length === 0 && data.iccp.current > 0) {
                conclusion.push('  - Configure groundbed for ICCP system');
                hasRecommendation = true;
            }
            if (data.assets.filter(function(a) { return a.surface === 0; }).length > 0) {
                conclusion.push('  - Complete surface data for equipment');
                hasRecommendation = true;
            }
            if (!hasRecommendation) {
                conclusion.push('  - No specific recommendations');
            }

            conclusion.forEach(function(line) {
                helpers.addNewPageIfNeeded(6);
                helpers.addText(line, helpers.margin, helpers.y);
                helpers.y += 5;
            });
        },

        // ========================================================
        // 12. LISTE DES CHAPITRES AVEC PAGES (TOC)
        // ========================================================
        _getChaptersWithPages: function() {
            const self = this;
            const chapterDefs = [
                'DOCUMENT CONTROL',
                'REVISION HISTORY',
                'EXECUTIVE SUMMARY',
                '1. OBJECT OF THE STUDY',
                '2. DESCRIPTION OF THE FACILITY',
                '3. ENVIRONMENT',
                '4. APPLICABLE CODES AND STANDARDS',
                '5. CP DESIGN CRITERIA',
                '6. INPUT DATA',
                '7. EXISTING CONDITION DIAGNOSTIC',
                '8. CP TECHNOLOGY SELECTION',
                '9. ENGINEERING CALCULATION SHEETS',
                '10. SACP DESIGN',
                '11. ICCP DESIGN',
                '12. DEEP WELL GROUNDBED',
                '13. RECTIFIER DESIGN',
                '14. DC INTERFERENCE',
                '15. AC INTERFERENCE',
                '16. IMPLEMENTATION',
                '17. GIS / LOCATION',
                '18. MONITORING',
                '19. COMMISSIONING',
                '20. MAINTENANCE',
                '21. VALIDATION & ALERTS',
                '22. CONCLUSION',
                '23. ANNEXES'
            ];

            return chapterDefs.map(function(title) {
                const page = self._chapterPages[title];
                return {
                    title: title,
                    page: (page !== undefined && page !== null) ? page : '?'
                };
            });
        },

        // ========================================================
        // 13. HEADERS ET FOOTERS SUR TOUTES LES PAGES
        // ========================================================
        _addHeadersAndFooters: function() {
            const doc = this._doc;
            const totalPages = doc.internal.getNumberOfPages();

            for (let i = 1; i <= totalPages; i++) {
                if (i === 1) continue;

                doc.setPage(i);
                this._sections.drawHeader(this._data, this._helpers);
                this._sections.drawFooter(this._data, this._helpers, i, totalPages);
            }
        },

        // ========================================================
        // 14. ENRICHISSEMENT AVEC CALCULS LOURDS
        // ========================================================
        _enrichWithHeavyCalculations: async function(data) {
            try {
                if (window.cpWorker && typeof runCalculation === 'function') {
                    // Structure prête pour extension future
                }
            } catch (err) {
                console.warn('[PDF Engine v6.3] Calculs lourds echoues:', err);
            }
            return data;
        },

        // ========================================================
        // 15. NOM DU FICHIER
        // ========================================================
        _getFileName: function() {
            const rawId = (this._data && this._data.project && this._data.project.id) || 'PROJ';
            const id = this._styles.normalizeId
                ? this._styles.normalizeId(rawId)
                : rawId;
            const date = new Date().toISOString().slice(0, 10);
            return 'Rapport_CP_' + id + '_' + date + '.pdf';
        },

        // ========================================================
        // 16. NETTOYAGE MÉMOIRE
        // ========================================================
        _cleanup: function() {
            this._data = null;
            this._doc = null;
            this._helpers = null;
            this._chapterPages = {};
            this._validationWarnings = [];
            console.log('[PDF Engine v6.3] Nettoyage memoire effectue');
        }
    };

    // ========================================================
    // 17. EXPOSITION GLOBALE
    // ========================================================
    if (typeof window !== 'undefined') {
        window.PDFReportEngine = PDFReportEngine;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PDFReportEngine;
    }

    console.log('[PDF Engine] ===================================================');
    console.log('[PDF Engine] v6.3 Engineering Report Engine charge.');
    console.log('[PDF Engine] ===================================================');
    console.log('[PDF Engine] ✅ v6.3 : generateNomenclature() appelee en direct');
    console.log('[PDF Engine]    - Plus de monkey-patching de helpers.addSectionTitle');
    console.log('[PDF Engine]    - Appel direct depuis _generateTechnicalSections()');
    console.log('[PDF Engine]    - Section 9.1 integree nativement');
    console.log('[PDF Engine] ✅ v6.2 : Anode Diameter en mm (section 12)');
    console.log('[PDF Engine] ✅ _buildPDF() 2 passes (TOC robuste)');
    console.log('[PDF Engine] ✅ P0-02 : Unites canoniques (A/m2 et mA/m2)');
    console.log('[PDF Engine] ✅ P0-05 : Tracabilite rho_project / rho_groundbed');
    console.log('[PDF Engine] ✅ P1-01 : Distinction densite CP / densite anodique');
    console.log('[PDF Engine] ✅ P1-02 : powerDesign dans CALC-ICCP-003');
    console.log('[PDF Engine] ✅ P1-04 : state.anodes.count dans CALC-SACP-002');
    console.log('[PDF Engine] ✅ P1-05 : lifeDesign / lifeTheoretical + designLifeTarget');
    console.log('[PDF Engine] ===================================================');

})();
// ============================================================
// FIN DU FICHIER pdf-report-engine.js (VERSION 6.3)
// ============================================================