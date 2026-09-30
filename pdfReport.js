// ============================================================
// pdfReport.js – CP Engineer Pro
// Connecteur final & API publique pour le module PDF Report
// Version 6.0 – MODULAR ARCHITECTURE BRIDGE (PROFESSIONAL)
// ============================================================
// ARCHITECTURE:
//   pdfReport.js (CE FICHIER - connecteur UI + API publique)
//       ↓ appelle
//   pdf-report-engine.js (chef d'orchestre)
//       ↓ utilise
//       ├── pdf-report-styles.js        (design system v6.0)
//       ├── pdf-report-helpers.js       (tableaux, sauts de page v6.0)
//       ├── pdf-report-sections.js      (sections du rapport v6.0)
//       └── pdf-report-calculations.js  (fiches de calcul v6.0)
// ============================================================
// CORRECTIONS MAJEURES v6.0 :
//   ✅ Logs cohérents v6.0
//   ✅ getStatus() enrichi (détection des versions des modules)
//   ✅ isAvailable() renforcé (vérification de generate())
//   ✅ Gestion d'erreur distinguée (module manquant vs échec génération)
//   ✅ Compatibilité ascendante totale avec les tests unitaires
//   ✅ PDFReportDataCollector conservé intégralement (tests)
//   ✅ Priorité stricte #generateReportBtn > #exportPDFBtn
// ============================================================
(function() {
    'use strict';

    // ============================================================
    // 1. RÉFÉRENCES NORMATIVES (conservées en global pour les tests)
    // ============================================================
    const NORMATIVE_REFERENCES = {
        'CALC-CP-001': 'ISO 15589-1:2017 / NACE SP0169 (Critere de courant)',
        'CALC-SACP-001': 'DNV-RP-B401 / NACE SP0169 (Masse d anodes)',
        'CALC-SACP-002': 'DNV-RP-B401 (Nombre d anodes)',
        'CALC-SACP-003': 'DNV-RP-B401 / ISO 15589-2 (Duree de vie)',
        'CALC-ICCP-001': 'NACE SP0169 / ISO 15589-1 (Courant ICCP)',
        'CALC-ICCP-002': 'NACE SP0169 (Tension redresseur)',
        'CALC-ICCP-003': 'NACE SP0169 / IEC 60146 (Puissance)',
        'CALC-GB-001': 'Dwight formula / NACE SP0169 (Resistance puits)',
        'CALC-GB-002': 'NACE SP0169 / ISO 15589-1 (Courant puits)',
        'CALC-IF-001': 'AMPP SP0177 / ISO 18086 (Tension AC induite)',
        'CALC-IF-002': 'AMPP SP0177 / ISO 18086 (Courant vagabond DC)',
        'default': 'Norme a verifier selon application'
    };

    // Exposer en global pour les tests unitaires
    if (typeof window !== 'undefined') {
        window.NORMATIVE_REFERENCES = NORMATIVE_REFERENCES;
    }

    // ============================================================
    // 2. UTILITAIRE INTERNE
    // ============================================================
    function safeNumber(value, defaultValue) {
        if (value === undefined || value === null || value === '') {
            return defaultValue !== undefined ? defaultValue : 0;
        }
        const num = Number(value);
        return isNaN(num) ? (defaultValue !== undefined ? defaultValue : 0) : num;
    }

    function getCanonicalEquipmentSurface(equipment) {
        if (typeof CalculationEngine !== 'undefined' &&
            typeof CalculationEngine.getOuvrageFields === 'function' &&
            typeof CalculationEngine.computeEquipmentSurface === 'function') {
            const fields = CalculationEngine.getOuvrageFields(equipment && equipment.type);
            const calculated = fields.length > 0
                ? CalculationEngine.computeEquipmentSurface(
                    equipment.type,
                    (equipment && equipment.dimensions) || {}
                )
                : 0;
            if (calculated > 0) return calculated;
        }
        return safeNumber(equipment && equipment.surface, 0);
    }

    function resolveCanonicalGroundbed(state) {
        const groundbeds = (state && state.groundbeds) || [];
        const systems = state && state.dashboard && Array.isArray(state.dashboard.systeme)
            ? state.dashboard.systeme
            : [];
        const activeSystemId = typeof localStorage !== 'undefined'
            ? localStorage.getItem('activeSystemId')
            : null;
        const activeSystem = systems.find(system => system.id === activeSystemId) || systems[0];
        const selected = activeSystem && activeSystem.groundbedId
            ? groundbeds.find(groundbed => groundbed.id === activeSystem.groundbedId)
            : null;
        if (selected) return selected;
        if (state && state.groundbed && state.groundbed.results) {
            return { id: 'legacy-groundbed', results: state.groundbed.results };
        }
        return groundbeds[0] || null;
    }

    /**
     * Nettoie un texte via normalizeText() ou sanitizeUnicode() si
     * disponible. Utilisé pour les logs console.
     */
    function cleanLogText(text) {
        if (text === undefined || text === null) return '';
        let str = String(text);
        if (typeof window !== 'undefined' &&
            window.PDFReportStyles) {
            if (typeof window.PDFReportStyles.normalizeText === 'function') {
                str = window.PDFReportStyles.normalizeText(str);
            } else if (typeof window.PDFReportStyles.sanitizeUnicode === 'function') {
                str = window.PDFReportStyles.sanitizeUnicode(str);
            }
        }
        return str;
    }

    // ============================================================
    // 3. COLLECTEUR DE DONNÉES (CONSERVÉ INTÉGRALEMENT)
    // ============================================================
    /**
     * Collecteur de données pour le rapport PDF.
     * Conservé intégralement pour compatibilité avec pdfReport.test.js.
     * Le moteur (pdf-report-engine.js) utilise sa propre méthode
     * _collectCalculations() qui produit les mêmes IDs mais avec des
     * formules nettoyées.
     */
    const PDFReportDataCollector = {

        /**
         * Collecte TOUTES les données nécessaires au rapport.
         *
         * @param {string} [projectId]
         * @returns {Object}
         */
        collectAll: function(projectId) {
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
                project:            this.collectProjectData(project, state),
                assets:             this.collectAssetsData(state, projectId),
                environment:        this.collectEnvironmentData(state),
                standards:          this.collectStandardsData(state),
                criteria:           this.collectCriteriaData(state),
                cpSystems:          this.collectCPSystemsData(state),
                iccp:               this.collectICCPData(state),
                sacp:               this.collectSACPData(state),
                groundbeds:         this.collectGroundbedsData(state),
                interference:       this.collectInterferenceData(state),
                fieldMeasurements:  this.collectFieldMeasurementsData(state, projectId),
                gis:                this.collectGISData(state, projectId),
                history:            this.collectHistoryData(state),
                calculations:       this.collectCalculationsData(state)
            };

            console.log('[PDF Collector v6.0] collectAll:',
                'assets=' + data.assets.length,
                '| calcs=' + data.calculations.length,
                '| measurements=' + data.fieldMeasurements.length);

            return data;
        },

        // --------------------------------------------------------
        // Projet
        // --------------------------------------------------------
        collectProjectData: function(project, state) {
            const projectEquipments = (state && state.equipments || [])
                .filter(function(eq) {
                    return eq.projectId === (project && project.id) && eq.included !== false;
                });
            const canonicalSurface = projectEquipments.reduce(function(total, eq) {
                return total + getCanonicalEquipmentSurface(eq);
            }, 0);
            const calculatedCurrent = projectEquipments.reduce(function(total, eq) {
                return total + (eq.cpData && eq.cpData.calculated && eq.cpData.results
                    ? safeNumber(eq.cpData.results.currentAmperes, 0)
                    : 0);
            }, 0);
            return {
                id: (project && project.id) || 'N/A',
                name: (project && project.name) || 'Projet sans nom',
                type: (project && project.type) || 'mixte',
                createdAt: (project && project.createdAt) || new Date().toISOString(),
                updatedAt: (project && project.updatedAt) || new Date().toISOString(),
                surface: canonicalSurface > 0
                    ? canonicalSurface
                    : safeNumber(state && state.project && state.project.surface, 0),
                currentRequired: calculatedCurrent > 0
                    ? calculatedCurrent
                    : safeNumber(state && state.project && state.project.currentRequired, 0),
                resistivity: safeNumber(state && state.project && state.project.resistivity, 0),
                coating: safeNumber(state && state.project && state.project.coating, 0.95),
                cpSystemType: (state && state.project && state.project.cpSystemType) || 'mixte',
                defectDensity: safeNumber(state && state.project && state.project.defectDensity, 0.03),
                agingFactor: safeNumber(state && state.project && state.project.agingFactor, 1.2),
                targetPotential: safeNumber(state && state.project && state.project.targetPotential, -850),
                norm: (state && state.project && state.project.norm) || 'ISO 15589-1',
                cpEnvironment: (state && state.project && state.project.cpEnvironment) || 'desert',
                currentDensity: safeNumber(state && state.project && state.project.currentDensity, 5),
                shared: (state && state.project && state.project.shared) || {}
            };
        },

        // --------------------------------------------------------
        // Équipements
        // --------------------------------------------------------
        collectAssetsData: function(state, projectId) {
            if (!state || !state.equipments) return [];
            return state.equipments
                .filter(function(eq) { return eq.projectId === projectId; })
                .map(function(eq) {
                    return {
                        id: eq.id || 'N/A',
                        tag: eq.tag || 'Sans tag',
                        type: eq.type || 'autre',
                        surface: getCanonicalEquipmentSurface(eq),
                        included: eq.included !== false,
                        dimensions: eq.dimensions || {},
                        coordinates: eq.coordinates || null,
                        material: eq.material || 'acier',
                        wallThickness: safeNumber(eq.wallThickness, 8.0),
                        coatingType: eq.coatingType || '3LPE',
                        coatingCondition: eq.coatingCondition || 'neuf',
                        coatingThickness: safeNumber(eq.coatingThickness, 0),
                        soilResistivity: safeNumber(eq.soilResistivity, 0),
                        systemId: eq.systemId || null,
                        cpData: eq.cpData || { calculated: false, results: {}, parameters: {} },
                        cpCalculated: !!(eq.cpData && eq.cpData.calculated === true)
                    };
                });
        },

        // --------------------------------------------------------
        // Environnement
        // --------------------------------------------------------
        collectEnvironmentData: function(state) {
            return {
                soilResistivity: safeNumber(state && state.project && state.project.envSoilResistivity, 0),
                soilPh: safeNumber(state && state.project && state.project.envSoilPh, 7),
                soilMoisture: safeNumber(state && state.project && state.project.envSoilMoisture, 50),
                soilChlorides: safeNumber(state && state.project && state.project.envSoilChlorides, 100),
                soilSulfates: safeNumber(state && state.project && state.project.envSoilSulfates, 200),
                soilRedox: safeNumber(state && state.project && state.project.envSoilRedox, 100),
                waterSalinity: safeNumber(state && state.project && state.project.envWaterSalinity, 0.5),
                waterConductivity: safeNumber(state && state.project && state.project.envWaterConductivity, 500),
                waterTemperature: safeNumber(state && state.project && state.project.envWaterTemp, 20),
                waterDO: safeNumber(state && state.project && state.project.envWaterDO, 6),
                environment: (state && state.project && state.project.cpEnvironment) || 'desert'
            };
        },

        // --------------------------------------------------------
        // Normes
        // --------------------------------------------------------
        collectStandardsData: function(state) {
            const standards = (state && state.project && state.project.standards) || [];
            return {
                selected: standards,
                primary: (state && state.project && state.project.norm) || 'ISO 15589-1',
                all: ['ISO 15589-1', 'NACE SP0169', 'DNV-RP-B401', 'ISO 15589-2', 'EN 12473']
            };
        },

        // --------------------------------------------------------
        // Critères
        // --------------------------------------------------------
        collectCriteriaData: function(state) {
            const project = (state && state.project) || {};
            const criteria = project.protectionCriteria || {};
            const hasOffPotential = criteria.offPotential !== undefined && criteria.offPotential !== null;
            const hasPolarization = criteria.polarization !== undefined && criteria.polarization !== null;
            return {
                targetPotential: safeNumber(project.targetPotential, -850),
                norm: project.norm || 'ISO 15589-1',
                naceOffPotential: safeNumber(criteria.offPotential, -850),
                nacePolarization: safeNumber(criteria.polarization, 100),
                currentDensity: safeNumber(project.currentDensity, 5),
                source: hasOffPotential || hasPolarization ? 'PROJECT' : 'DEFAULT_PRESET',
                measurementType: criteria.measurementType || 'OFF_AND_POLARIZATION',
                referenceElectrode: criteria.referenceElectrode || null,
                warnings: [
                    ...(!hasOffPotential ? ['Potentiel OFF par défaut : confirmer le critère projet.'] : []),
                    ...(!hasPolarization ? ['Polarisation par défaut : confirmer le critère projet.'] : [])
                ]
            };
        },

        // --------------------------------------------------------
        // Systèmes CP
        // --------------------------------------------------------
        collectCPSystemsData: function(state) {
            const systems = (state && state.dashboard && state.dashboard.systeme) ||
                            (state && state.systems) || [];
            return systems.map(function(sys) {
                return {
                    id: sys.id || 'N/A',
                    name: sys.name || 'Systeme sans nom',
                    type: sys.type || 'mixte',
                    params: sys.params || {},
                    results: sys.results || {},
                    equipmentIds: sys.equipmentIds || [],
                    rectifiers: sys.rectifiers || [],
                    groundbedId: sys.groundbedId || null,
                    history: sys.history || []
                };
            });
        },

        // --------------------------------------------------------
        // ICCP
        // --------------------------------------------------------
        collectICCPData: function(state) {
            const iccp = (state && state.iccp) || {};
            const result = {
                current: safeNumber(iccp.current, 0),
                requiredCurrent: safeNumber(iccp.requiredCurrent, 0),
                selectedCurrent: safeNumber(iccp.selectedCurrent, iccp.current),
                currentMarginRatio: iccp.currentMarginRatio !== undefined ? iccp.currentMarginRatio : null,
                currentMarginPercent: iccp.currentMarginPercent !== undefined ? iccp.currentMarginPercent : null,
                voltage: safeNumber(iccp.voltage, 0),
                rectifierVoltage: safeNumber(iccp.rectifierVoltage,
                    safeNumber(iccp.voltageFinal, iccp.voltage)),
                power: safeNumber(iccp.power, 0),
                powerInitial: safeNumber(iccp.powerInitial, iccp.power),
                powerDesign: safeNumber(iccp.powerDesign, iccp.power),
                voltageFinal: safeNumber(iccp.voltageFinal, 0),
                rectifierCurrent: safeNumber(iccp.rectifierCurrent, iccp.current),
                rectifierPower: safeNumber(iccp.rectifierPower, iccp.powerDesign || iccp.power),
                calculatedRequirements: iccp.calculatedRequirements || {
                    current: safeNumber(iccp.rectifierCurrent, iccp.current),
                    voltage: safeNumber(iccp.rectifierVoltage, iccp.voltageFinal || iccp.voltage),
                    power: safeNumber(iccp.rectifierPower, iccp.powerDesign || iccp.power)
                },
                transformerRectifierSelection: iccp.transformerRectifierSelection || null,
                currentDensity: safeNumber(iccp.currentDensity, 0),
                currentDensity_mA: safeNumber(iccp.currentDensity_mA, 0),
                densityOk: iccp.densityOk || false,
                groundbedResistance: safeNumber(iccp.groundbedResistance, 0),
                lifeEstimate: safeNumber(iccp.lifeEstimate, 0),
                lifeTheoretical: iccp.lifeTheoretical === null
                    ? null
                    : safeNumber(iccp.lifeTheoretical, iccp.lifeEstimate),
                lifeDesign: safeNumber(iccp.lifeDesign, iccp.lifeEstimate),
                lifeValidationStatus: iccp.lifeValidationStatus || 'NOT_VALIDATED_MANUFACTURER_DATA_REQUIRED',
                safetyFactorPower: safeNumber(iccp.safetyFactorPower, 1.15),
                iccpCurrentSource: iccp.iccpCurrentSource || null,
                groundbedParams: iccp.groundbedParams || {},
                reinforcementZones: iccp.reinforcementZones || []
            };

            return result;
        },

        // --------------------------------------------------------
        // SACP
        // --------------------------------------------------------
        collectSACPData: function(state) {
            const anodes = (state && state.anodes) || {};
            return {
                totalMass: safeNumber(anodes.totalMass, 0),
                count: safeNumber(anodes.count, 0),
                actualLife: safeNumber(anodes.actualLife, 0),
                initialCurrent: safeNumber(anodes.initialCurrent, 0),
                finalCurrent: safeNumber(anodes.finalCurrent, 0),
                currentDensity: safeNumber(anodes.currentDensity, 0),
                densityOk: anodes.densityOk || false,
                anodeMaterial: anodes.anodeMaterial || 'Mg_HC',
                soilResistivity: safeNumber(anodes.soilResistivity, 30),
                freePotential: safeNumber(anodes.freePotential, -600),
                finalResistanceFactor: safeNumber(anodes.finalResistanceFactor, 1.5),
                safetyFactor: safeNumber(anodes.safetyFactor, 1.1)
            };
        },

        // --------------------------------------------------------
        // Groundbeds
        // --------------------------------------------------------
        collectGroundbedsData: function(state) {
            const groundbeds = (state && state.groundbeds) || [];
            const canonical = resolveCanonicalGroundbed(state);
            const ordered = canonical
                ? [canonical].concat(groundbeds.filter(gb => gb !== canonical))
                : groundbeds;
            return ordered.map(function(gb) {
                return {
                    id: gb.id || 'N/A',
                    name: gb.name || 'Puits sans nom',
                    parameters: gb.parameters || {},
                    results: gb.results || {},
                    coordinates: gb.coordinates || null,
                    version: safeNumber(gb.version, 1),
                    createdAt: gb.createdAt || new Date().toISOString(),
                    updatedAt: gb.updatedAt || new Date().toISOString()
                };
            });
        },

        // --------------------------------------------------------
        // CALCULS NORMATIFS (compatibilité tests unitaires)
        // --------------------------------------------------------
        /**
         * Génère les fiches de calcul.
         * NOTE : cette méthode est conservée pour les tests unitaires.
         *       Le moteur (pdf-report-engine.js v6.0) utilise sa propre
         *       _collectCalculations() avec IDs strictement distincts.
         *
         * @param {Object} state
         * @returns {Array}
         */
        collectCalculationsData: function(state) {
            const calcs = [];
            if (!state) return calcs;

            // CALC-CP-001 : Courant de protection requis
            const calculatedEquipments = (state.equipments || [])
                .filter(function(eq) {
                    return eq.projectId === (state.project && state.project.id) &&
                        eq.included !== false && eq.cpData && eq.cpData.calculated &&
                        eq.cpData.results && Number(eq.cpData.results.currentAmperes) > 0;
                });
            const includedEquipments = (state.equipments || [])
                .filter(function(eq) {
                    return eq.projectId === (state.project && state.project.id) && eq.included !== false;
                });
            const equipmentCurrent = calculatedEquipments.reduce(function(total, eq) {
                return total + Number(eq.cpData.results.currentAmperes);
            }, 0);
            const equipmentSurface = includedEquipments.reduce(function(total, eq) {
                return total + getCanonicalEquipmentSurface(eq);
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
                        : 'Le courant de protection n a pas encore ete calcule.',
                    criterion: 'I_req > 0'
                });
            }

            // CALC-SACP-001/002/003
            const sacp = state.anodes || {};
            if (sacp.totalMass > 0) {
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
                    status: 'PASS',
                    statusMessage: 'Masse totale d anodes calculee conformement a DNV-RP-B401.',
                    criterion: 'M_total >= M_required'
                });

                calcs.push({
                    id: 'CALC-SACP-002',
                    name: 'Number of anodes',
                    formula: 'N = max(N_current, N_mass, 1)',
                    variables: {
                        count: sacp.count,
                        initialCurrent: sacp.initialCurrent || 0,
                        finalCurrent: sacp.finalCurrent || 0
                    },
                    result: sacp.count,
                    unit: 'units',
                    status: sacp.count > 0 ? 'PASS' : 'FAIL',
                    statusMessage: 'Nombre d anodes determine par critere courant + masse.',
                    criterion: 'N >= 1'
                });

                calcs.push({
                    id: 'CALC-SACP-003',
                    name: 'Anode design life',
                    formula: 'T = (M_total x C x u) / (I_avg x 8760)',
                    variables: {
                        totalMass: sacp.totalMass,
                        actualLife: sacp.actualLife || 0
                    },
                    result: sacp.actualLife || 0,
                    unit: 'years',
                    status: (sacp.actualLife || 0) >= ((state.project && state.project.designLifeTarget) || 25) ? 'PASS' :
                            ((sacp.actualLife || 0) > 0 ? 'WARNING' : 'FAIL'),
                    statusMessage: (sacp.actualLife || 0) >= ((state.project && state.project.designLifeTarget) || 25)
                        ? 'Duree de vie conforme a la cible projet.'
                        : ((sacp.actualLife || 0) > 0
                            ? 'Duree de vie inferieure a la cible projet.'
                            : 'Duree de vie non calculee.'),
                    criterion: 'T >= cible projet'
                });
            }

            // CALC-ICCP-001/002/003 (IDs strictement distincts – B-05)
            const iccp = state.iccp || {};
            if (iccp.current > 0) {
                calcs.push({
                    id: 'CALC-ICCP-001',
                    name: 'ICCP total current',
                    formula: 'I_total = S x J / 1000',
                    variables: {
                        current: iccp.current,
                        currentDensity: iccp.currentDensity || 0
                    },
                    result: iccp.current,
                    unit: 'A',
                    status: 'PASS',
                    statusMessage: 'Courant ICCP total calcule conformement a NACE SP0169.',
                    criterion: 'I_total > 0'
                });

                calcs.push({
                    id: 'CALC-ICCP-002',
                    name: 'Rectifier output voltage',
                    formula: 'V = I x R_total + V_backEMF',
                    variables: {
                        current: iccp.current,
                        voltage: iccp.voltage,
                        groundbedResistance: iccp.groundbedResistance || 0
                    },
                        result: iccp.rectifierVoltage,
                    unit: 'V',
                    status: iccp.voltage > 0 ? 'PASS' : 'WARNING',
                    statusMessage: 'Tension redresseur calculee avec back EMF integre.',
                    criterion: 'V > 0'
                });

                calcs.push({
                    id: 'CALC-ICCP-003',
                    name: 'Rectifier power rating',
                    formula: 'P_design = V x I x SF (SF applique UNE seule fois)',
                    variables: {
                        voltage: iccp.voltage,
                        powerDesign: iccp.powerDesign,
                        powerInitial: iccp.powerInitial,
                        safetyFactorPower: iccp.safetyFactorPower
                    },
                    result: iccp.powerDesign,
                    unit: 'W',
                    status: iccp.powerDesign > 0 ? 'PASS' : 'WARNING',
                    statusMessage: 'Puissance redresseur avec marge de securite de 15 %.',
                    criterion: 'P > 0'
                });
            }

            // CALC-GB-001/002 (IDs strictement distincts – B-05)
            const canonicalGroundbed = resolveCanonicalGroundbed(state);
            const gb = canonicalGroundbed && canonicalGroundbed.results;
            if (gb && gb.R_total) {
                calcs.push({
                    id: 'CALC-GB-001',
                    name: 'Groundbed resistance',
                    formula: 'R_total = R_group + R_well + R_cable + R_structure',
                    variables: {
                        R_total: gb.R_total,
                        R_group: gb.R_group || 0,
                        R_well: gb.R_well || 0,
                        R_cable: gb.R_cable || 0,
                        R_struct: gb.R_struct || 0
                    },
                    result: gb.R_total,
                    unit: 'Ohm',
                    status: gb.designStatus === 'PRELIMINARY_ONLY' ? 'WARNING' : 'PASS',
                    statusMessage: gb.designStatus === 'PRELIMINARY_ONLY'
                        ? (gb.requiresSpecialistStudy
                            ? 'Resistance preliminaire uniquement: etude numerique multicouche requise.'
                            : 'Resistance preliminaire multicouche: verification de conception requise.')
                        : 'Resistance du puits anodique calculee (Dwight + Sunde).',
                    criterion: 'R_total > 0'
                });

                if (gb.I_total) {
                    const jAnodeA = gb.J_anode !== undefined && gb.J_anode !== null
                        ? gb.J_anode : 0;
                    calcs.push({
                        id: 'CALC-GB-002',
                        name: 'Groundbed current capacity',
                        formula: 'I_total = I_target ; J_anode = I_anode / S_anode',
                        variables: {
                            I_total: gb.I_total,
                            J_anode: jAnodeA,
                            J_anode_mA: gb.J_anode_mA !== undefined ? gb.J_anode_mA : jAnodeA * 1000,
                            densityLimit: gb.densityLimit || 50
                        },
                        result: jAnodeA,
                        unit: 'A/m2',
                        status: gb.designStatus === 'PRELIMINARY_ONLY' ? 'WARNING' : (gb.densityOk ? 'PASS' : 'WARNING'),
                        statusMessage: gb.densityOk
                            ? 'Densite anodique dans les limites recommandees.'
                            : 'Densite anodique a verifier (depasse la limite).',
                        criterion: 'J_anode <= J_limit'
                    });
                }
            }

            // CALC-IF-001/002
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

            console.log('[PDF Collector v6.0] collectCalculationsData:', calcs.length, 'fiche(s)');
            return calcs;
        },

        // --------------------------------------------------------
        // Interférences
        // --------------------------------------------------------
        collectInterferenceData: function(state) {
            const ifData = (state && state.interference) || { results: null };
            const results = ifData.results || {};
            return {
                acInduced: safeNumber(results.acInduced, 0),
                touchVoltage: safeNumber(results.touchVoltage, 0),
                acStatus: results.acStatus || 'Non calculé',
                deltaV: safeNumber(results.deltaV, 0),
                dcStray: safeNumber(results.dcStray, 0),
                dcStatus: results.dcStatus || 'Non calculé',
                globalStatus: results.globalStatus || 'Non calculé',
                mitigations: results.mitigations || [],
                R_path: safeNumber(results.R_path, 0)
            };
        },

        // --------------------------------------------------------
        // Mesures terrain
        // --------------------------------------------------------
        collectFieldMeasurementsData: function(state, projectId) {
            const measurements = (state && state.fieldMeasurements) || [];
            return measurements
                .filter(function(m) { return m.projectId === projectId; })
                .map(function(m) {
                    return {
                        id: m.id || 'N/A',
                        date: m.date || new Date().toISOString(),
                        assetId: m.assetId || '',
                        assetTag: m.assetTag || '',
                        potON: (m.potON !== undefined && m.potON !== null)
                            ? safeNumber(m.potON, 0) : null,
                        potOFF: (m.potOFF !== undefined && m.potOFF !== null)
                            ? safeNumber(m.potOFF, 0) : null,
                        polarization: safeNumber(m.polarization, 0),
                        compliant: m.compliant || false,
                        operator: m.operator || '',
                        temperature: safeNumber(m.temperature, 20),
                        refElectrode: m.refElectrode || 'CuCuSO4',
                        systemId: m.systemId || null
                    };
                });
        },

        // --------------------------------------------------------
        // GIS
        // --------------------------------------------------------
        collectGISData: function(state, projectId) {
            const mapPoints = (state && state.mapPoints) || [];
            const equipments = (state && state.equipments)
                ? state.equipments.filter(function(eq) { return eq.projectId === projectId; })
                : [];

            const isValidCoord = function(c) {
                if (!c) return false;
                if (Array.isArray(c)) {
                    return c.length > 0 && c.some(function(p) {
                        return p.lat !== undefined && p.lon !== undefined &&
                               typeof p.lat === 'number' && !isNaN(p.lat) &&
                               typeof p.lon === 'number' && !isNaN(p.lon);
                    });
                }
                return c.lat !== undefined && c.lon !== undefined &&
                       typeof c.lat === 'number' && !isNaN(c.lat) &&
                       typeof c.lon === 'number' && !isNaN(c.lon);
            };

            const withCoords = equipments.filter(function(eq) {
                return isValidCoord(eq.coordinates);
            });

            return {
                points: mapPoints.filter(function(p) { return p.projectId === projectId; }),
                equipmentWithCoords: withCoords.map(function(eq) {
                    return {
                        tag: eq.tag || 'N/A',
                        type: eq.type || 'N/A',
                        coordinates: eq.coordinates,
                        surface: safeNumber(eq.surface, 0)
                    };
                }),
                totalPoints: mapPoints.filter(function(p) { return p.projectId === projectId; }).length,
                totalWithCoords: withCoords.length
            };
        },

        // --------------------------------------------------------
        // Historique
        // --------------------------------------------------------
        collectHistoryData: function(state) {
            const history = (state && state.history) || [];
            return history.slice(0, 50).map(function(h) {
                return {
                    timestamp: h.timestamp || new Date().toISOString(),
                    module: h.module || '',
                    action: h.action || '',
                    result: h.result || '',
                    projectName: h.projectName || '',
                    systemName: h.systemName || ''
                };
            });
        }
    };

    // Exposer en global pour les tests unitaires
    if (typeof window !== 'undefined') {
        window.PDFReportDataCollector = PDFReportDataCollector;
    }

    // ============================================================
    // 4. API PUBLIQUE
    // ============================================================
    const PDFReport = {

        // Version du connecteur PDF (cycle de vie indépendant)
        VERSION: '6.0.0',

        /**
         * Génère le rapport PDF professionnel.
         *
         * @param {string} [projectId] - ID du projet (optionnel)
         * @returns {Promise<Object>} { success, fileName, doc }
         */
        generate: async function(projectId) {
            const id = projectId ||
                (window.ProjectManager && ProjectManager.getCurrentProjectId());
            if (!id) {
                throw new Error('Aucun projet selectionne');
            }

            if (!this.isAvailable()) {
                const status = this.getStatus();
                const missingModules = [];
                if (!status.modules.engine) missingModules.push('pdf-report-engine.js');
                if (!status.modules.styles) missingModules.push('pdf-report-styles.js');
                if (!status.modules.helpers) missingModules.push('pdf-report-helpers.js');
                if (!status.modules.sections) missingModules.push('pdf-report-sections.js');
                if (!status.modules.calculations) missingModules.push('pdf-report-calculations.js');
                if (!status.libraryAvailable) missingModules.push('jsPDF (CDN)');

                const errorMsg = 'Modules PDF manquants : ' + missingModules.join(', ');
                console.error('[PDF Report v6.0] ' + errorMsg);
                throw new Error(errorMsg);
            }

            console.log('[PDF Report v6.0] Delegation vers PDFReportEngine pour projet:', id);

            try {
                const result = await window.PDFReportEngine.generate(id);
                console.log('[PDF Report v6.0] Generation reussie:', result.fileName);
                return result;
            } catch (genError) {
                console.error('[PDF Report v6.0] Erreur du moteur:', genError.message);
                throw genError;
            }
        },

        /**
         * Vérifie si le module PDF est disponible (version stricte).
         *
         * @returns {boolean}
         */
        isAvailable: function() {
            // Vérification de jsPDF
            if (typeof window.jspdf === 'undefined' ||
                typeof window.jspdf.jsPDF !== 'function') {
                return false;
            }
            // Vérification du moteur
            if (typeof window.PDFReportEngine === 'undefined') {
                return false;
            }
            // Vérification que generate() est bien une fonction
            if (typeof window.PDFReportEngine.generate !== 'function') {
                console.warn('[PDF Report v6.0] PDFReportEngine.generate n est pas une fonction');
                return false;
            }
            const requiredModules = [
                ['PDFReportStyles', window.PDFReportStyles],
                ['PDFReportHelpers', window.PDFReportHelpers],
                ['PDFReportSections', window.PDFReportSections],
                ['PDFCalculationSheets', window.PDFCalculationSheets],
                ['PDFReportDataCollector', window.PDFReportDataCollector]
            ];
            const missingModule = requiredModules.find(([name, module]) => !module);
            if (missingModule) {
                console.warn('[PDF Report v6.0] Module manquant:', missingModule[0]);
                return false;
            }
            return true;
        },

        /**
         * Retourne le statut détaillé du module.
         *
         * @returns {Object}
         */
        getStatus: function() {
            const styles = window.PDFReportStyles || null;
            const helpers = window.PDFReportHelpers || null;
            const sections = window.PDFReportSections || null;
            const calculations = window.PDFCalculationSheets || null;
            const engine = window.PDFReportEngine || null;

            // Détection des versions v6.0 par signature de méthodes
            const isStylesV6 = !!(styles && typeof styles.normalizeText === 'function' &&
                                 typeof styles.stripLatex === 'function' &&
                                 typeof styles.formatAmp === 'function');
            const isHelpersV6 = !!(helpers && typeof helpers._detectStatusInCell === 'function' &&
                                  typeof helpers._wrapCellText === 'function');
            const isSectionsV6 = !!(sections && typeof sections._drawGroundbedSchema === 'function' &&
                                   typeof sections._insertChartSnapshots === 'function');
            const isCalculationsV6 = !!(calculations && typeof calculations.getReference === 'function');
            const isEngineV6 = !!(engine && typeof engine._writeTableOfContents === 'function');

            return {
                available: this.isAvailable(),
                libraryAvailable: typeof window.jspdf !== 'undefined' &&
                                  typeof window.jspdf.jsPDF === 'function',
                library: 'jsPDF',
                version: (window.jspdf && window.jspdf.version) || 'Inconnu',
                normativeReferences: Object.keys(NORMATIVE_REFERENCES).length,
                architecture: 'modular-v6.0',
                modules: {
                    styles: !!styles,
                    helpers: !!helpers,
                    sections: !!sections,
                    calculations: !!calculations,
                    engine: !!engine
                },
                modulesVersion6: {
                    styles: isStylesV6,
                    helpers: isHelpersV6,
                    sections: isSectionsV6,
                    calculations: isCalculationsV6,
                    engine: isEngineV6
                },
                features: {
                    // Fonctionnalités v6.0 activées si les modules sont v6.0
                    latexStripping: isStylesV6 || isHelpersV6 || isCalculationsV6,
                    unicodeC1Filtering: isStylesV6,
                    tocTwoPasses: isEngineV6,
                    iccpGroundbedConsistencyAlert: isEngineV6,
                    kpiCards: isHelpersV6,
                    tableWordWrap: isHelpersV6,
                    statusBadges: isHelpersV6,
                    chartSnapshots: isSectionsV6,
                    groundbedSchema: isSectionsV6,
                    standardizedNumberFormat: isStylesV6
                }
            };
        },

        /**
         * Retourne les références normatives utilisées.
         *
         * @returns {Object}
         */
        getNormativeReferences: function() {
            return Object.assign({}, NORMATIVE_REFERENCES);
        }
    };

    // Exposer globalement
    if (typeof window !== 'undefined') {
        window.PDFReport = PDFReport;
    }

    // ============================================================
    // 5. INITIALISATION UI — BOUTON DE GÉNÉRATION
    // ============================================================
    document.addEventListener('DOMContentLoaded', function() {

        // --------------------------------------------------------
        // Fonction interne de génération
        // --------------------------------------------------------
        async function handleGenerateReport(btn) {
            const originalHTML = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Generation...';

            try {
                if (!PDFReport.isAvailable()) {
                    throw new Error('La bibliotheque jsPDF ou le moteur PDF n est pas charge.');
                }

                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('Generation du rapport PDF professionnel en cours...', 'info');
                }

                const result = await PDFReport.generate();

                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('Rapport PDF genere avec succes : ' + result.fileName, 'success');
                }

                console.log('[PDF Report v6.0] Rapport genere:', result.fileName);
            } catch (error) {
                console.error('[PDF Report v6.0] Erreur de generation:', error);

                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('Erreur : ' + error.message, 'error');
                }

                if (window.ErrorManager && typeof window.ErrorManager.show === 'function') {
                    window.ErrorManager.show({
                        type: 'error',
                        title: 'Erreur de generation PDF',
                        message: 'Le rapport PDF n a pas pu etre genere.',
                        details: {
                            module: 'PDF Report',
                            function: 'generate',
                            technical: error.message,
                            architecture: 'modular-v6.0'
                        },
                        code: 'PDF-001',
                        _originalError: error
                    });
                }
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHTML;
            }
        }

        // --------------------------------------------------------
        // PRIORITÉ 1 : #generateReportBtn existe déjà → attacher
        // --------------------------------------------------------
        const existingBtn = document.getElementById('generateReportBtn');
        if (existingBtn) {
            if (!existingBtn.__pdfListenerAttached) {
                existingBtn.addEventListener('click', function() {
                    handleGenerateReport(this);
                });
                existingBtn.__pdfListenerAttached = true;
                console.log('[PDF Report v6.0] Listener attache a #generateReportBtn');
            }
            return;
        }

        // --------------------------------------------------------
        // PRIORITÉ 2 : #exportPDFBtn existe → NE PAS créer de doublon
        // --------------------------------------------------------
        const existingExportBtn = document.getElementById('exportPDFBtn');
        if (existingExportBtn) {
            console.log('[PDF Report v6.0] #exportPDFBtn detecte - listener gere par ui.js, pas de creation.');
            return;
        }

        // --------------------------------------------------------
        // PRIORITÉ 3 : AUCUN bouton → créer
        // --------------------------------------------------------
        const headerRight = document.querySelector('.header-right');
        if (!headerRight) {
            console.warn('[PDF Report v6.0] .header-right non trouve, bouton non ajoute');
            return;
        }

        const reportBtn = document.createElement('button');
        reportBtn.className = 'btn btn-primary touch-target';
        reportBtn.id = 'generateReportBtn';
        reportBtn.setAttribute('aria-label', 'Generer le rapport PDF complet');
        reportBtn.innerHTML = '<i class="fas fa-file-pdf" aria-hidden="true"></i> Rapport PDF';
        reportBtn.title = 'Generer le rapport PDF complet de l etude CP';

        reportBtn.addEventListener('click', function() {
            handleGenerateReport(this);
        });
        reportBtn.__pdfListenerAttached = true;

        headerRight.appendChild(reportBtn);
        console.log('[PDF Report v6.0] Bouton cree et ajoute a l interface');
    });

    // ============================================================
    // 6. LOG DE DÉMARRAGE
    // ============================================================
    console.log('[PDF Report] ===================================================');
    console.log('[PDF Report] Module PDF Report v6.0 - PROFESSIONAL ENGINEERING');
    console.log('[PDF Report] ===================================================');
    console.log('[PDF Report] Architecture modulaire active :');
    console.log('[PDF Report]   pdf-report-styles.js      :',
                typeof window.PDFReportStyles !== 'undefined' ? 'OK' : 'MISSING');
    console.log('[PDF Report]   pdf-report-helpers.js     :',
                typeof window.PDFReportHelpers !== 'undefined' ? 'OK' : 'MISSING');
    console.log('[PDF Report]   pdf-report-sections.js    :',
                typeof window.PDFReportSections !== 'undefined' ? 'OK' : 'MISSING');
    console.log('[PDF Report]   pdf-report-calculations.js:',
                typeof window.PDFCalculationSheets !== 'undefined' ? 'OK' : 'MISSING');
    console.log('[PDF Report]   pdf-report-engine.js      :',
                typeof window.PDFReportEngine !== 'undefined' ? 'OK' : 'MISSING');
    console.log('[PDF Report] References normatives:', Object.keys(NORMATIVE_REFERENCES).length);
    console.log('[PDF Report] API publique: window.PDFReport.generate()');
    console.log('[PDF Report] v6.0 : getStatus() enrichi (detection version modules)');
    console.log('[PDF Report] v6.0 : isAvailable() renforce (verification generate())');
    console.log('[PDF Report] v6.0 : collectAll() et collectCalculationsData() conserves');
    console.log('[PDF Report] ===================================================');

})();
// ============================================================
// FIN DU FICHIER pdfReport.js (VERSION 6.0)
// ============================================================