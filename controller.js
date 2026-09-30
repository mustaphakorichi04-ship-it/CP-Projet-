// ============================================================
// controller.js – CP Engineer Pro – Gestion d'état et orchestration métier
// Module : orchestrateur d'état (pas de version globale propre)
// Version applicative : définie par APP_CONFIG.VERSION (engine.js).
// ============================================================
// CORRECTIONS v9.1 (INTÉGRATION DES PATCHES) :
//   ✅ storage-patch.js          → cleanEmergencyBackups() intégré
//      (les rechargements IndexedDB étaient déjà dans v9.0)
//   ✅ ui-groundbed-consistency-patch.js v2.1 → resolveTargetCurrent()
//      (délègue à DataResolver.resolvePreferredCurrent())
//   ✅ ui-groundbed-consistency-patch.js v2.1 → migrateGroundedToGroundbed()
//      (petite migration ponctuelle intégrée)
//
// CORRECTIONS v9.0 (conservées) :
//   P0-05 : groundbedFormationResistivity distinct de soilResistivity
//   P1-04 : Préservation de state.anodes.count / currentDensity_mA / units
//   P1-05 : designLifeTarget (25 ans) dans state.project
//   P0-03 : iccpAnodeConfig dans state.project.shared
// ============================================================

const ProjectManager = (function() {
    let state = {
        project: {
            id: null,
            name: 'Projet par défaut',
            surface: 0,
            currentRequired: 0,
            resistivity: 100,
            coating: 0.95,
            standards: [],
            cpSystemType: 'mixte',
            defectDensity: 0.03,
            agingFactor: 1.2,
            targetPotential: -850,
            norm: 'ISO 15589-1',
            envSoilResistivity: 100,
            envSoilPh: 7.5,
            envSoilMoisture: 15,
            envSoilChlorides: 100,
            envSoilSulfates: 200,
            envSoilRedox: 150,
            envWaterSalinity: 0.5,
            envWaterConductivity: 500,
            envWaterTemp: 20,
            envWaterDO: 6,
            cpEnvironment: 'desert',
            currentDensity: 5,
            // ============================================================
            // P1-05 : Durée de vie de conception cible (années)
            // Utilisée pour plafonner lifeDesign dans engine.js.
            // Valeur projet par défaut : 25 ans.
            // ============================================================
            designLifeTarget: 25,
            shared: {
                soilResistivity: 100,
                // ============================================================
                // P0-05 : Résistivité de la couche d'installation des anodes.
                // Distincte de soilResistivity (résistivité projet).
                // Si null → utilise soilResistivity (source de vérité projet).
                // Si une stratigraphie existe, peut être renseignée
                // explicitement dans le module Groundbed.
                // ============================================================
                groundbedFormationResistivity: null,
                protectedSurface: 0,
                designCurrent: 0,
                cableLength: 50,
                cableSection: 16,
                structureResistance: 0.02,
                // ============================================================
                // P0-03 : Configuration anodes ICCP
                // ============================================================
                iccpAnodeConfig: {
                    material: 'mmo',
                    consumptionRate_mg_per_A_year: 1.0,
                    utilization: 0.85,
                    designLifeCap_years: 25,
                    massPerAnode_kg: 25
                },
                lock: {
                    soilResistivity: true,
                    protectedSurface: true,
                    designCurrent: true,
                    cableLength: true,
                    cableSection: true,
                    structureResistance: true
                }
            }
        },
        cp: { current: 0, irDrop: 0, requiredOnPotential: -850 },
        anodes: {
            totalMass: 0,
            count: 0,
            actualLife: 0,
            safetyFactor: 1.1,
            soilResistivity: 100,
            freePotential: -600,
            finalResistanceFactor: 1.5,
            initialCurrent: 0,
            finalCurrent: 0,
            currentDensity: 0,        // A/m² (canonique)
            currentDensity_mA: 0,     // P1-04 : mA/m² (dérivé)
            densityOk: false,
            anodeMaterial: 'Mg_HC',
            units: null                // P1-04 : unités canoniques propagées
        },
        iccp: {
            current: 0,
            calculatedRequirements: { current: 0, voltage: 0, power: 0 },
            transformerRectifierSelection: null,
            voltage: 0,
            power: 0,
            powerInitial: 0,           // P1-02 : conservé pour traçabilité
            powerDesign: 0,            // P1-02 : puissance de conception
            voltageFinal: 0,
            currentDensity: 0,         // A/m² (canonique)
            currentDensity_mA: 0,      // P0-02 : mA/m² (dérivé)
            densityOk: false,
            groundbedResistance: 0,
            lifeEstimate: 0,           // alias de lifeDesign
            lifeTheoretical: 0,        // P1-05
            lifeDesign: 0,             // P1-05
            lifeDetails: null,         // P0-03
            iccpCurrentSource: 'unknown', // P0-01
            iccpSourceLabel: 'Inconnu',   // P0-01
            safetyFactorPower: 1.15,   // P1-02
            groundbedParams: {
                rho: 100,
                totalDepth: 200,
                activeDepth: 150,
                anodeCount: 16,
                anodeLength: 1.5,
                anodeDiameter: 0.075,
                anodeWeight: 25,
                anodeCapacity: 2.5,
                cableLength: 100,
                cableSection: 35,
                agingFactor: 1.2,
                safetyFactor: 1.1,
                targetCurrent: 0
            },
            reinforcementZones: []
        },
        monitoring: { points: [] },
        dashboard: { systeme: [] },
        systems: [],
        equipments: [],
        fieldMeasurements: [],
        groundbed: { results: null },
        interference: { results: null },
        testPosts: { posts: [], totalLength: 0, spacing: 0 },
                mapPoints: [],
        history: [],
        groundbeds: []
        // NOTE : La version applicative est centralisée dans
        // APP_CONFIG.VERSION (engine.js). Aucune version globale
        // ne doit être déclarée dans state.version.
    };
    let currentProjectId = null;
    let projectsList = [];
    let saveQueue = Promise.resolve();

    // OPTIM : Cache des équipements pour éviter les rechargements redondants
    let _lastProjectId = null;
    let _lastEquipments = null;
    let _equipmentsLoaded = false;

    // ============================================================
    // FONCTIONS DE GESTION D'ÉTAT
    // ============================================================
    function getState() { return state; }
    function getCurrentProjectId() { return currentProjectId; }
    function setCurrentProjectId(id) { currentProjectId = id; }
    function getProjectsList() { return projectsList; }
    function setProjectsList(list) { projectsList = list; }

    function getSystems() {
        if (!state.dashboard) state.dashboard = { systeme: [] };
        if (!state.dashboard.systeme) state.dashboard.systeme = [];
        return state.dashboard.systeme;
    }

    function getSystem(systemId) {
        if (!systemId) return null;
        const systems = getSystems();
        return systems.find(s => s.id === systemId) || null;
    }

    function getCurrentSystemId() {
        let id = localStorage.getItem('activeSystemId');
        if (id && getSystem(id)) return id;
        const systems = getSystems();
        if (systems.length > 0) {
            const first = systems[0];
            localStorage.setItem('activeSystemId', first.id);
            return first.id;
        }
        return null;
    }

    function setCurrentSystemId(systemId) {
        if (systemId && getSystem(systemId)) {
            localStorage.setItem('activeSystemId', systemId);
        }
    }

    function getActiveSystem() {
        const id = getCurrentSystemId();
        return id ? getSystem(id) : null;
    }

    // ============================================================
    // GESTION DES SYSTÈMES
    // ============================================================
    function createSystem(name, type) {
        if (!currentProjectId) return null;
        const systems = getSystems();
        const system = {
            id: Utils.generateId(),
            name: name || 'Système CP',
            type: type || 'mixte',
            params: { cp: {}, anodes: {}, iccp: {}, groundbed: {}, interference: {} },
            results: { cp: {}, anodes: {}, iccp: {}, groundbed: {}, interference: {}, monitoring: [] },
            history: [],
            equipmentIds: [],
            rectifiers: [],
            groundbedId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        systems.push(system);
        saveCurrentProject();
        addHistoryEntry('system', `Création système ${system.name}`, system.id);
        return system;
    }

    function deleteSystem(systemId) {
        let systems = getSystems();
        systems = systems.filter(s => s.id !== systemId);
        state.dashboard.systeme = systems;
        state.equipments.forEach(eq => {
            if (eq.systemId === systemId) delete eq.systemId;
        });
        if (getCurrentSystemId() === systemId) {
            localStorage.removeItem('activeSystemId');
            if (systems.length > 0) setCurrentSystemId(systems[0].id);
        }
        saveCurrentProject();
        addHistoryEntry('system', `Suppression système ${systemId}`, '');
        invalidateSystemCurrentCache(systemId);
        invalidateSurfaceCache();
    }

    // ============================================================
    // GESTION DES REDRESSEURS
    // ============================================================
    function addRectifier(systemId, name, status, current, voltage, power) {
        const system = getSystem(systemId);
        if (!system) return null;
        if (!system.rectifiers) system.rectifiers = [];
        const rectifier = {
            id: Utils.generateId(),
            name: name || 'Redresseur',
            status: status || 'off',
            current: Utils.safeNumber(current, 0),
            voltage: Utils.safeNumber(voltage, 0),
            power: Utils.safeNumber(power, 0)
        };
        system.rectifiers.push(rectifier);
        saveCurrentProject();
        addHistoryEntry('rectifier', `Ajout redresseur ${rectifier.name}`, `${rectifier.current}A / ${rectifier.voltage}V`);
        return rectifier;
    }

    function deleteRectifier(systemId, rectifierId) {
        const system = getSystem(systemId);
        if (!system) return;
        system.rectifiers = (system.rectifiers || []).filter(r => r.id !== rectifierId);
        saveCurrentProject();
    }

    function updateRectifierStatus(systemId, rectifierId, newStatus) {
        const system = getSystem(systemId);
        if (!system) return;
        const rectifier = (system.rectifiers || []).find(r => r.id === rectifierId);
        if (!rectifier) return;
        rectifier.status = newStatus;
        saveCurrentProject();
    }

    function syncSelectedTransformerRectifier(systemId, selection, coordinates) {
        const system = getSystem(systemId);
        const selected = selection && selection.selected;
        if (!system || !selected) return null;
        if (!Array.isArray(system.rectifiers)) system.rectifiers = [];

        let rectifier = system.rectifiers.find(item => item.id === 'TR-OPTIMAL') ||
            system.rectifiers.find(item => item.name === 'TR-OPTIMAL');
        if (!rectifier) {
            rectifier = {
                id: 'TR-OPTIMAL',
                name: 'TR-OPTIMAL',
                status: 'off',
                current: 0,
                voltage: 0,
                power: 0
            };
            system.rectifiers.push(rectifier);
        }

        Object.assign(rectifier, {
            name: 'TR-OPTIMAL',
            manufacturer: selected.manufacturer || null,
            model: selected.model || selected.id,
            current: Utils.safeNumber(selected.nominalCurrent, 0),
            voltage: Utils.safeNumber(selected.nominalVoltage, 0),
            power: Utils.safeNumber(selected.nominalPower, 0),
            nominalCurrent: Utils.safeNumber(selected.nominalCurrent, 0),
            nominalVoltage: Utils.safeNumber(selected.nominalVoltage, 0),
            nominalPower: Utils.safeNumber(selected.nominalPower, 0),
            technicalCharacteristics: {
                supplyVoltage: selected.supplyVoltage || null,
                phases: selected.phases || null,
                frequencyHz: selected.frequencyHz || null,
                technology: selected.technology || null,
                regulation: selected.regulation || null,
                cooling: selected.cooling || null,
                enclosureProtection: selected.enclosureProtection || null
            },
            selectionPolicy: selection.selectionPolicy || 'TECHNICAL_RATINGS_ONLY',
            selectionStatus: selection.status,
            source: selected.source || null,
            sourceDocument: selected.sourceDocument || null,
            sourceUrl: selected.sourceUrl || null,
            updatedAt: new Date().toISOString()
        });
        const resolvedCoordinates = coordinates || rectifier.coordinates;
        if (resolvedCoordinates && Number.isFinite(Number(resolvedCoordinates.lat)) && Number.isFinite(Number(resolvedCoordinates.lon))) {
            rectifier.coordinates = { lat: Number(resolvedCoordinates.lat), lon: Number(resolvedCoordinates.lon), alt: Number(resolvedCoordinates.alt) || 0 };
        }

        const projectId = state.project && state.project.id;
        let mapEquipment = state.equipments.find(item =>
            item.type === 'rectifier' &&
            item.projectId === projectId &&
            (item.id === rectifier.equipmentId || item.tag === 'TR-OPTIMAL')
        );
        if (!mapEquipment && rectifier.coordinates && projectId) {
            mapEquipment = addEquipmentDirect({
                id: 'TR-OPTIMAL-' + Date.now(),
                tag: 'TR-OPTIMAL',
                type: 'rectifier',
                projectId,
                systemId: system.id,
                coordinates: { ...rectifier.coordinates },
                surface: 0,
                included: true,
                manufacturer: rectifier.manufacturer,
                model: rectifier.model,
                current: rectifier.current,
                voltage: rectifier.voltage,
                power: rectifier.power,
                nominalCurrent: rectifier.nominalCurrent,
                nominalVoltage: rectifier.nominalVoltage,
                nominalPower: rectifier.nominalPower,
                technicalCharacteristics: rectifier.technicalCharacteristics,
                selectionStatus: rectifier.selectionStatus,
                selectionPolicy: rectifier.selectionPolicy,
                source: rectifier.source,
                sourceDocument: rectifier.sourceDocument,
                sourceUrl: rectifier.sourceUrl
            });
        }
        if (mapEquipment) {
            rectifier.equipmentId = mapEquipment.id;
            Object.assign(mapEquipment, {
                tag: 'TR-OPTIMAL',
                systemId: system.id,
                manufacturer: rectifier.manufacturer,
                model: rectifier.model,
                current: rectifier.current,
                voltage: rectifier.voltage,
                power: rectifier.power,
                nominalCurrent: rectifier.nominalCurrent,
                nominalVoltage: rectifier.nominalVoltage,
                nominalPower: rectifier.nominalPower,
                technicalCharacteristics: rectifier.technicalCharacteristics,
                selectionStatus: rectifier.selectionStatus,
                selectionPolicy: rectifier.selectionPolicy,
                source: rectifier.source,
                sourceDocument: rectifier.sourceDocument,
                sourceUrl: rectifier.sourceUrl,
                updatedAt: rectifier.updatedAt
            });
            if (rectifier.coordinates) mapEquipment.coordinates = { ...rectifier.coordinates };
            StorageManager.saveEquipment(mapEquipment);
            syncEquipmentSystemRelationship(mapEquipment, mapEquipment.systemId);
        }
        system.updatedAt = new Date().toISOString();
        saveCurrentProject();
        return rectifier;
    }

    // ============================================================
    // GESTION DES ÉQUIPEMENTS SYSTÈMES
    // ============================================================
    function getSystemEquipment(systemId) {
        const system = getSystem(systemId);
        if (!system) return [];
        const ids = system.equipmentIds || [];
        return state.equipments.filter(eq => ids.includes(eq.id));
    }

    // OPTIM : Cache avec invalidation conditionnelle
    let _systemCurrentCache = new Map();
    let _cacheVersion = 0;

    function invalidateSystemCurrentCache(systemId) {
        _cacheVersion++;
        if (systemId) _systemCurrentCache.delete(systemId);
        else _systemCurrentCache.clear();
    }

    function getSystemTotalCurrent(systemId) {
        const cacheKey = systemId + '_' + _cacheVersion;
        if (_systemCurrentCache.has(cacheKey)) {
            return _systemCurrentCache.get(cacheKey);
        }
        const system = getSystem(systemId);
        if (!system) return 0;
        const ids = system.equipmentIds || [];
        let total = 0;
        ids.forEach(eqId => {
            const eq = state.equipments.find(e => e.id === eqId);
            if (eq && eq.cpData && eq.cpData.calculated && typeof eq.cpData.results.currentAmperes === 'number') {
                total += eq.cpData.results.currentAmperes;
            }
        });
        _systemCurrentCache.set(cacheKey, total);
        return total;
    }

    // ============================================================
    // SAUVEGARDE DES PARAMÈTRES SYSTÈMES
    // ============================================================
    function saveSystemParams(systemId, module, params) {
        const system = getSystem(systemId);
        if (!system) return false;
        if (!system.params) system.params = {};
        system.params[module] = { ...system.params[module], ...params };
        system.updatedAt = new Date().toISOString();
        saveCurrentProject();
        invalidateSystemCurrentCache(systemId);
        return true;
    }

    function sanitizeAnodeState(snapshot) {
        if (typeof CalculationEngine !== 'undefined' && typeof CalculationEngine.normalizeSACPResult === 'function') {
            return CalculationEngine.normalizeSACPResult(snapshot || {});
        }

        const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
        const totalMass = Number(source.totalMass) || 0;
        const count = Number(source.count) || 0;
        const actualLife = Number(source.actualLife) || 0;
        const valid = totalMass > 0 && count > 0;
        const sanitized = {
            ...source,
            totalMass: valid ? totalMass : 0,
            count: valid ? count : 0,
            actualLife: valid ? actualLife : 0,
            initialCurrent: valid ? (Number(source.initialCurrent) || 0) : 0,
            finalCurrent: valid ? (Number(source.finalCurrent) || 0) : 0,
            currentDensity: valid ? (Number(source.currentDensity) || 0) : 0,
            currentDensity_mA: valid ? (Number(source.currentDensity_mA) || 0) : 0,
            densityOk: Boolean(source.densityOk) && valid
        };
        return sanitized;
    }

    function sanitizeGroundbedState(snapshot) {
        if (typeof CalculationEngine !== 'undefined' && typeof CalculationEngine.normalizeGroundbedResult === 'function') {
            return CalculationEngine.normalizeGroundbedResult(snapshot || {});
        }

        const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
        const asNumber = (value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : 0;
        };
        const R_total = asNumber(source.R_total);
        const I_total = asNumber(source.I_total);
        const J_anode = asNumber(source.J_anode);
        const lifeWithSafety = asNumber(source.lifeWithSafety);
        const requiredAnodeCount = asNumber(source.requiredAnodeCount);
        const anodeCount = asNumber(source.anodeCount);
        const totalMass = asNumber(source.totalMass);
        const valid = R_total > 0 && I_total > 0 && anodeCount > 0 && totalMass > 0 && J_anode > 0 && lifeWithSafety > 0;
        return {
            ...source,
            R_total: valid ? R_total : 0,
            I_total: valid ? I_total : 0,
            V_rectifier: valid ? asNumber(source.V_rectifier) : 0,
            P_rectifier: valid ? asNumber(source.P_rectifier) : 0,
            J_anode: valid ? J_anode : 0,
            J_anode_mA: valid ? asNumber(source.J_anode_mA) : 0,
            densityLimit: valid ? asNumber(source.densityLimit) : 0,
            densityOk: Boolean(source.densityOk) && valid,
            lifeWithSafety: valid ? lifeWithSafety : 0,
            requiredAnodeCount: valid ? requiredAnodeCount : 0,
            anodeCount: valid ? anodeCount : 0,
            totalMass: valid ? totalMass : 0
        };
    }

    function sanitizeICCPState(snapshot) {
        const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
        const asNumber = (value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : 0;
        };
        const current = asNumber(source.current);
        const voltage = asNumber(source.voltage);
        const powerDesign = asNumber(source.powerDesign);
        const powerInitial = asNumber(source.powerInitial);
        const valid = current > 0 || voltage > 0 || powerDesign > 0 || powerInitial > 0;

        return {
            ...source,
            current: valid ? current : 0,
            requiredCurrent: valid ? asNumber(source.requiredCurrent) : 0,
            selectedCurrent: valid ? asNumber(source.selectedCurrent) : 0,
            currentMarginRatio: valid ? asNumber(source.currentMarginRatio) : null,
            currentMarginPercent: valid ? asNumber(source.currentMarginPercent) : null,
            voltage: valid ? voltage : 0,
            voltageFinal: valid ? asNumber(source.voltageFinal) : 0,
            rectifierCurrent: valid ? asNumber(source.rectifierCurrent) : 0,
            rectifierVoltage: valid ? asNumber(source.rectifierVoltage) : 0,
            power: valid ? asNumber(source.power) : 0,
            powerInitial: valid ? powerInitial : 0,
            powerDesign: valid ? powerDesign : 0,
            rectifierPower: valid ? asNumber(source.rectifierPower) : 0,
            currentDensity: valid ? asNumber(source.currentDensity) : 0,
            currentDensity_mA: valid ? asNumber(source.currentDensity_mA) : 0,
            densityOk: Boolean(source.densityOk) && valid,
            groundbedResistance: valid ? asNumber(source.groundbedResistance) : 0,
            lifeEstimate: valid ? asNumber(source.lifeEstimate) : 0,
            lifeTheoretical: valid ? asNumber(source.lifeTheoretical) : 0,
            lifeDesign: valid ? asNumber(source.lifeDesign) : 0,
            lifeDetails: valid ? (source.lifeDetails || null) : null,
            lifeValidationStatus: valid ? (source.lifeValidationStatus || 'NOT_VALIDATED_MANUFACTURER_DATA_REQUIRED')
                : 'NOT_VALIDATED_MANUFACTURER_DATA_REQUIRED'
        };
    }

    function saveSystemResults(systemId, module, results) {
        const system = getSystem(systemId);
        if (!system) return;
        if (!system.results) system.results = {};
        const normalized = module === 'anodes'
            ? sanitizeAnodeState(results)
            : module === 'groundbed'
                ? sanitizeGroundbedState(results)
                : module === 'iccp'
                    ? sanitizeICCPState(results)
                    : results;
        system.results[module] = { ...system.results[module], ...normalized };
        system.updatedAt = new Date().toISOString();
        saveCurrentProject();
        invalidateSystemCurrentCache(systemId);
    }

    // Keep derived module results aligned after backup import or legacy restore.
    function normalizeCalculationState() {
        const systems = state.dashboard?.systeme || [];
        const activeSystem = systems.find(system => system.id === getCurrentSystemId()) || systems[0];
        const selectedGroundbedId = activeSystem?.groundbedId;
        const selectedGroundbed = selectedGroundbedId
            ? state.groundbeds?.find(groundbed => groundbed.id === selectedGroundbedId)
            : null;
        const groundbed = selectedGroundbed?.results || state.groundbed?.results || state.groundbeds?.[0]?.results;
        const groundbedParams = selectedGroundbed?.parameters || state.groundbeds?.[0]?.parameters || {};
        const iccp = state.iccp || (state.iccp = {});
        const anodes = state.anodes || (state.anodes = {});
        Object.assign(anodes, sanitizeAnodeState(anodes));
        Object.assign(iccp, sanitizeICCPState(iccp));
        if (state.project) {
            state.project.currentRequired = Number(state.cp && state.cp.current) > 0
                ? Number(state.cp.current)
                : 0;
        }
        if (groundbed) {
            Object.assign(groundbed, sanitizeGroundbedState(groundbed));
        }

        if (groundbed && Number(groundbed.R_total) > 0) {
            const current = Number(iccp.current) > 0
                ? Number(iccp.current)
                : Number(groundbed.I_total) || 0;
            const backEmf = Number(iccp.backEmfVoltage) > 0 ? Number(iccp.backEmfVoltage) : 2;
            const aging = Number(groundbedParams.agingFactor) > 0
                ? Number(groundbedParams.agingFactor)
                : (Number(iccp.iccpAgingFactor) > 0 ? Number(iccp.iccpAgingFactor) : 1.2);
            const safety = Number(iccp.safetyFactorPower) > 0 ? Number(iccp.safetyFactorPower) : 1.15;
            const resistance = Number(groundbed.R_total);
            const voltage = current * resistance + backEmf;
            const voltageFinal = current * resistance * aging + backEmf;

            iccp.current = current;
            iccp.voltage = voltage;
            iccp.voltageFinal = voltageFinal;
            iccp.rectifierCurrent = current;
            iccp.rectifierVoltage = Math.max(voltageFinal, 12);
            iccp.powerInitial = current * voltage;
            iccp.powerDesign = iccp.powerInitial * safety;
            iccp.power = iccp.powerDesign;
            iccp.rectifierPower = iccp.powerDesign;
            iccp.groundbedResistance = resistance;
            iccp.R_groundbed_pure = groundbed.R_groundbed_pure;
            iccp.R_well = groundbed.R_well;
            iccp._includesCable = groundbed._includesCable;
            iccp._includesStructure = groundbed._includesStructure;
        }

        const ac = state.interference?.results;
        if (ac && ac.acStatus) {
            const corrective = ac.acStatus === 'Action corrective obligatoire' || ac.dcStatus === 'Élevé';
            const surveillance = ac.acStatus === 'Surveillance nécessaire' || ac.dcStatus === 'Modéré';
            ac.globalStatus = corrective
                ? '🔴 ACTION OBLIGATOIRE'
                : surveillance ? '🟡 SURVEILLANCE NÉCESSAIRE' : '🟢 ACCEPTABLE';
        }

        if (activeSystem) {
            if (!activeSystem.results) activeSystem.results = {};
            activeSystem.results.iccp = { ...activeSystem.results.iccp, ...iccp };
            activeSystem.results.anodes = { ...activeSystem.results.anodes, ...anodes };
            if (groundbed) {
                activeSystem.results.groundbed = { ...activeSystem.results.groundbed, ...groundbed };
            }
            if (ac) {
                activeSystem.results.interference = { ...activeSystem.results.interference, ...ac };
            }
        }

        return state;
    }

    function loadSystemParams(systemId, module) {
        const system = getSystem(systemId);
        if (!system) return {};
        if (!system.params) system.params = {};
        return system.params[module] || {};
    }

    function loadSystemResults(systemId, module) {
        const system = getSystem(systemId);
        if (!system) return {};
        if (!system.results) system.results = {};
        return system.results[module] || {};
    }

    // ============================================================
    // HISTORIQUE
    // ============================================================
    function addHistoryEntry(module, action, result, systemId) {
        const sysId = systemId || getCurrentSystemId();
        const entry = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
            timestamp: new Date().toISOString(),
            module: module,
            projectId: currentProjectId,
            projectName: state.project.name || 'Projet par défaut',
            systemId: sysId,
            systemName: sysId ? (getSystem(sysId)?.name || 'Système inconnu') : 'Aucun système',
            action: action,
            result: result
        };
        state.history.unshift(entry);
        if (state.history.length > 200) state.history = state.history.slice(0, 200);
        if (sysId) {
            const sys = getSystem(sysId);
            if (sys) {
                if (!sys.history) sys.history = [];
                sys.history.unshift(entry);
                if (sys.history.length > 200) sys.history = sys.history.slice(0, 200);
            }
        }
        StorageManager.saveHistory(state.history).catch(err => console.warn('History save error:', err));
        saveCurrentProject();
    }

    // ============================================================
    // MÉTHODE POUR OBTENIR LES ÉQUIPEMENTS DU PROJET ACTUEL (AVEC CACHE)
    // ============================================================
    async function getEquipmentsForCurrentProject(forceRefresh = false) {
        const projectId = getCurrentProjectId();
        if (!projectId) return [];

        if (!forceRefresh && _lastProjectId === projectId && _equipmentsLoaded && _lastEquipments !== null) {
            return _lastEquipments;
        }

        const equipments = await StorageManager.loadEquipmentsForProject(projectId, forceRefresh);
        _lastProjectId = projectId;
        _lastEquipments = equipments;
        _equipmentsLoaded = true;
        state.equipments = equipments;
        return equipments;
    }

    // ============================================================
    // P0-05 : Migration des paramètres partagés (projets anciens)
    // ============================================================
    /**
     * Assure la présence des champs P0-05, P0-03, P1-05 dans
     * state.project.shared. Ne modifie pas les valeurs existantes.
     */
    function migrateSharedParams() {
        if (!state.project) return;
        if (!state.project.shared) {
            state.project.shared = {
                soilResistivity: state.project.resistivity || 100,
                groundbedFormationResistivity: null,
                protectedSurface: state.project.surface || 0,
                designCurrent: 0,
                cableLength: 50,
                cableSection: 16,
                structureResistance: 0.02,
                iccpAnodeConfig: {
                    material: 'mmo',
                    consumptionRate_mg_per_A_year: 1.0,
                    utilization: 0.85,
                    designLifeCap_years: 25,
                    massPerAnode_kg: 25
                },
                lock: {
                    soilResistivity: true,
                    protectedSurface: true,
                    designCurrent: true,
                    cableLength: true,
                    cableSection: true,
                    structureResistance: true
                }
            };
            return;
        }

        const shared = state.project.shared;
        let modified = false;

        // P0-05 : groundbedFormationResistivity
        if (shared.groundbedFormationResistivity === undefined) {
            shared.groundbedFormationResistivity = null;
            modified = true;
            console.log('[Controller] P0-05 : groundbedFormationResistivity initialisé à null');
        }

        // P0-03 : iccpAnodeConfig
        if (!shared.iccpAnodeConfig) {
            shared.iccpAnodeConfig = {
                material: 'mmo',
                consumptionRate_mg_per_A_year: 1.0,
                utilization: 0.85,
                designLifeCap_years: 25,
                massPerAnode_kg: 25
            };
            modified = true;
            console.log('[Controller] P0-03 : iccpAnodeConfig initialisé');
        }

        // P1-05 : designLifeTarget
        if (state.project.designLifeTarget === undefined) {
            state.project.designLifeTarget = 25;
            modified = true;
            console.log('[Controller] P1-05 : designLifeTarget initialisé à 25 ans');
        }

        if (modified) {
            console.log('[Controller] Migration shared params effectuée');
        }
    }

    // ============================================================
    // P1-04 : Migration des champs anodes (currentDensity_mA, units)
    // ============================================================
    function migrateAnodesFields() {
        if (!state.anodes) return;
        let modified = false;

        if (state.anodes.currentDensity_mA === undefined) {
            state.anodes.currentDensity_mA = 0;
            modified = true;
        }
        if (state.anodes.units === undefined) {
            state.anodes.units = null;
            modified = true;
        }

        if (modified) {
            console.log('[Controller] P1-04 : Migration anodes effectuée');
        }
    }

    // ============================================================
    // P0-01/P1-02/P1-05 : Migration des champs ICCP
    // ============================================================
    function migrateICCPFields() {
        if (!state.iccp) return;
        let modified = false;

        if (state.iccp.powerDesign === undefined) {
            state.iccp.powerDesign = state.iccp.power || 0;
            modified = true;
        }
        if (state.iccp.powerInitial === undefined) {
            state.iccp.powerInitial = state.iccp.power || 0;
            modified = true;
        }
        if (state.iccp.lifeTheoretical === undefined) {
            state.iccp.lifeTheoretical = 0;
            modified = true;
        }
        if (state.iccp.lifeDesign === undefined) {
            state.iccp.lifeDesign = state.iccp.lifeEstimate || 0;
            modified = true;
        }
        if (state.iccp.lifeDetails === undefined) {
            state.iccp.lifeDetails = null;
            modified = true;
        }
        if (state.iccp.iccpCurrentSource === undefined) {
            state.iccp.iccpCurrentSource = 'cp_calculated';
            modified = true;
        }
        if (state.iccp.iccpSourceLabel === undefined) {
            state.iccp.iccpSourceLabel = 'CP calcule';
            modified = true;
        }
        if (state.iccp.safetyFactorPower === undefined) {
            state.iccp.safetyFactorPower = 1.15;
            modified = true;
        }
        if (state.iccp.currentDensity_mA === undefined) {
            state.iccp.currentDensity_mA = (state.iccp.currentDensity || 0) * 1000;
            modified = true;
        }

        if (modified) {
            console.log('[Controller] Migration ICCP fields effectuée');
        }
    }

    // ============================================================
    // CHARGEMENT DE PROJET (OPTIMISÉ)
    // ============================================================
    function loadProject(projectId) {
        return new Promise(async (resolve, reject) => {
            const projects = await StorageManager.loadProjects();
            const project = projects.find(p => p.id === projectId);
            if (!project) { reject('Projet introuvable'); return; }
            currentProjectId = projectId;
            localStorage.setItem('lastProjectId', projectId);

            const migratedData = migrateGroupsToSysteme(project.data);
            project.data = migratedData;
            state = Utils.deepClone(project.data);

            // --- CHARGEMENT IMMÉDIAT DES ÉQUIPEMENTS DU PROJET ---
            const freshEquipments = await StorageManager.loadEquipmentsForProject(projectId);
            state.equipments = freshEquipments;
            _lastProjectId = projectId;
            _lastEquipments = freshEquipments;
            _equipmentsLoaded = true;
            // -------------------------------------------------------

            if (!state.dashboard) state.dashboard = { systeme: [] };
            if (!state.dashboard.systeme) state.dashboard.systeme = [];
            if (!state.history) state.history = [];
            if (!state.mapPoints) state.mapPoints = [];
            if (!state.iccp) state.iccp = { current: 0, voltage: 0, power: 0, voltageFinal: 0, currentDensity: 0, densityOk: false, groundbedParams: {}, reinforcementZones: [] };
            if (!state.iccp.groundbedParams) state.iccp.groundbedParams = {};
            if (!state.iccp.reinforcementZones) state.iccp.reinforcementZones = [];
            if (!state.groundbeds) state.groundbeds = [];

            // P0-05/P0-03/P1-05 : Migration des paramètres partagés
            migrateSharedParams();
            // P1-04 : Migration des champs anodes
            migrateAnodesFields();
            // P0-01/P1-02/P1-05 : Migration des champs ICCP
            migrateICCPFields();

            migrateGroundbeds();

            if (!state.project.shared) {
                state.project.shared = {
                    soilResistivity: 100,
                    groundbedFormationResistivity: null,
                    protectedSurface: 0,
                    designCurrent: 0,
                    cableLength: 50,
                    cableSection: 16,
                    structureResistance: 0.02,
                    iccpAnodeConfig: {
                        material: 'mmo',
                        consumptionRate_mg_per_A_year: 1.0,
                        utilization: 0.85,
                        designLifeCap_years: 25,
                        massPerAnode_kg: 25
                    },
                    lock: {
                        soilResistivity: true,
                        protectedSurface: true,
                        designCurrent: true,
                        cableLength: true,
                        cableSection: true,
                        structureResistance: true
                    }
                };
            }

            const fieldMeas = await StorageManager.loadFieldMeasurementsForProject(projectId);
            state.fieldMeasurements = fieldMeas;

            const mapPoints = await StorageManager.loadMapPoints(projectId);
            state.mapPoints = mapPoints;

            const history = await StorageManager.loadHistory();
            if (history.length > 0) state.history = history;

            invalidateSurfaceCache();
            invalidateSystemCurrentCache();

            if (typeof CoordSystem !== 'undefined') {
                const ref = CoordSystem.getReference();
                const firstWithCoords = state.equipments.find(eq => eq.coordinates);
                if (firstWithCoords) {
                    const coords = firstWithCoords.coordinates;
                    let lat, lon, alt = 0;
                    if (Array.isArray(coords) && coords.length > 0) {
                        lat = coords[0].lat;
                        lon = coords[0].lon;
                        alt = coords[0].alt || 0;
                    } else if (coords.lat !== undefined) {
                        lat = coords.lat;
                        lon = coords.lon;
                        alt = coords.alt || 0;
                    }
                    if (CoordSystem.isValid(lat, lon, alt)) {
                        CoordSystem.setReference(lat, lon, alt);
                    }
                } else {
                    CoordSystem.setReference(30.123456, 8.123456, 0);
                }
            }

            if (typeof window.CPController !== 'undefined' && window.CPController.syncSurfaceFromEquipments) {
                window.CPController.syncSurfaceFromEquipments();
            }

            normalizeCalculationState();
            saveCurrentProject();

            document.dispatchEvent(new CustomEvent('projectLoaded', { detail: { projectId } }));
            resolve();
        });
    }

    // ============================================================
    // MIGRATION DES DONNÉES
    // ============================================================
    function migrateGroupsToSysteme(projectData) {
        if (projectData.dashboard && projectData.dashboard.groups) {
            const groups = projectData.dashboard.groups;
            const systems = [];
            groups.forEach((g, idx) => {
                const sys = {
                    id: g.id || 'sys_' + Date.now() + '_' + idx,
                    name: g.label || 'Système ' + (idx + 1),
                    type: 'mixte',
                    params: { cp: {}, anodes: {}, iccp: {}, groundbed: {}, interference: {} },
                    results: { cp: {}, anodes: {}, iccp: {}, groundbed: {}, interference: {}, monitoring: [] },
                    history: [],
                    equipmentIds: g.equipmentIds || [],
                    rectifiers: [],
                    groundbedId: null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                if (g.percentage) sys.params.percentage = g.percentage;
                systems.push(sys);
            });
            projectData.dashboard.systeme = systems;
            delete projectData.dashboard.groups;
        }
        if (!projectData.dashboard) projectData.dashboard = {};
        if (!projectData.dashboard.systeme) projectData.dashboard.systeme = [];
        projectData.dashboard.systeme.forEach(sys => {
            if (!sys.params) sys.params = { cp: {}, anodes: {}, iccp: {}, groundbed: {}, interference: {} };
            if (!sys.results) sys.results = { cp: {}, anodes: {}, iccp: {}, groundbed: {}, interference: {}, monitoring: [] };
            if (!sys.history) sys.history = [];
            if (!sys.equipmentIds) sys.equipmentIds = [];
            if (!sys.rectifiers) sys.rectifiers = [];
            if (!sys.id) sys.id = 'sys_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
            if (!sys.name) sys.name = 'Système ' + (projectData.dashboard.systeme.indexOf(sys) + 1);
            if (!sys.type) sys.type = 'mixte';
            if (!sys.createdAt) sys.createdAt = new Date().toISOString();
            if (!sys.updatedAt) sys.updatedAt = new Date().toISOString();
            if (!sys.groundbedId) sys.groundbedId = null;
        });
        return projectData;
    }

    // ============================================================
    // GESTION DES GROUNDBEDS
    // ============================================================
    function getGroundbeds() { return state.groundbeds || []; }

    function getGroundbedById(id) { return getGroundbeds().find(g => g.id === id) || null; }

    /**
     * Crée un nouveau groundbed.
     *
     * ✅ CORRECTION BUG HORS-AUDIT (v8.8) :
     *    Le projectId est désormais accepté en 5e paramètre et affecté
     *    AVANT la persistance du groundbed.
     *
     * @param {string} name - Nom du puits
     * @param {Object} parameters - Paramètres de calcul
     * @param {Object} results - Résultats de calcul
     * @param {Object|Array|null} coordinates - Coordonnées GPS
     * @param {string} [projectId] - ID du projet à associer.
     *        Si absent, utilise le projet courant (currentProjectId).
     * @returns {Object|null} Le groundbed créé
     */
    function createGroundbed(name, parameters, results, coordinates, projectId) {
        let normalizedCoords = coordinates;
        if (coordinates && typeof CoordSystem !== 'undefined') {
            if (CoordSystem.validateCoordinates) {
                if (!CoordSystem.validateCoordinates(coordinates)) {
                    console.warn('[Controller] Coordonnées groundbed invalides, ignorées.');
                    normalizedCoords = null;
                } else {
                    normalizedCoords = CoordSystem.normalizeCoordinates ? CoordSystem.normalizeCoordinates(coordinates) : coordinates;
                }
            }
        }

        // ✅ FIX : projectId affecté AVANT la persistance
        const effectiveProjectId = projectId || currentProjectId || null;

        const newGb = {
            id: Utils.generateId(),
            name: name || 'Puits anodique',
            projectId: effectiveProjectId,
            parameters: parameters || {},
            results: results || {},
            coordinates: normalizedCoords || null,
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        state.groundbeds.push(newGb);
        saveCurrentProject();
        addHistoryEntry('groundbed', `Création puits ${newGb.name}`, `v${newGb.version}`);
        return newGb;
    }

    function updateGroundbed(id, updates) {
        const gb = getGroundbedById(id);
        if (!gb) return null;
        if (updates.coordinates && typeof CoordSystem !== 'undefined') {
            if (CoordSystem.validateCoordinates) {
                if (!CoordSystem.validateCoordinates(updates.coordinates)) {
                    console.warn('[Controller] Coordonnées groundbed invalides, conservées.');
                } else {
                    updates.coordinates = CoordSystem.normalizeCoordinates ? CoordSystem.normalizeCoordinates(updates.coordinates) : updates.coordinates;
                }
            }
        }
        Object.assign(gb, updates);
        gb.version = (gb.version || 0) + 1;
        gb.updatedAt = new Date().toISOString();
        saveCurrentProject();
        addHistoryEntry('groundbed', `Mise à jour puits ${gb.name}`, `v${gb.version}`);
        return gb;
    }

    function deleteGroundbed(id) {
        const gb = getGroundbedById(id);
        if (!gb) return;
        state.groundbeds = state.groundbeds.filter(g => g.id !== id);
        state.systems.forEach(sys => {
            if (sys.groundbedId === id) {
                sys.groundbedId = null;
                if (sys.results && sys.results.iccp) {
                    sys.results.iccp.calculationVersion = null;
                }
            }
        });
        saveCurrentProject();
        addHistoryEntry('groundbed', `Suppression puits ${gb.name}`, '');
    }

    // ============================================================
    // migrateGroundbeds – CORRIGÉ
    // ============================================================
    /**
     * Migration des données groundbeds.
     *
     * ✅ CORRECTION BUG HORS-AUDIT :
     *    Migre les groundbeds existants SANS projectId vers le projet courant.
     */
    function migrateGroundbeds() {
        // ─── Fix : Assigner un projectId aux groundbeds orphelins ───
        if (state.groundbeds && state.groundbeds.length > 0) {
            let migratedCount = 0;
            state.groundbeds.forEach(gb => {
                if (!gb.projectId && currentProjectId) {
                    gb.projectId = currentProjectId;
                    migratedCount++;
                }
            });
            if (migratedCount > 0) {
                console.log(`[Controller] Migration: ${migratedCount} groundbed(s) associés au projet ${currentProjectId}`);
                saveCurrentProject();
            }
            return;
        }

        let systemsToMigrate = state.systems.filter(sys => sys.type === 'iccp' && sys.groundbedId === null);
        systemsToMigrate.forEach(sys => {
            const oldParams = sys.params?.groundbed || {};
            if (Object.keys(oldParams).length > 0) {
                delete sys.params.groundbed;
                if (sys.results && sys.results.groundbed) delete sys.results.groundbed;
                console.log(`[Controller] Anciens paramètres groundbed supprimés pour le système ${sys.name}`);
            }
        });

        if (state.iccp && state.iccp.groundbedParams && Object.keys(state.iccp.groundbedParams).length > 0) {
            delete state.iccp.groundbedParams;
            if (state.groundbed) delete state.groundbed.results;
            console.log('[Controller] Anciens paramètres groundbed supprimés de iccp.');
        }

        saveCurrentProject();
    }

    // ============================================================
    // VÉRIFICATION DES DOUBLONS D'ÉQUIPEMENTS
    // ============================================================
    function isEquipmentDuplicate(tag, projectId, excludeId) {
        if (!tag || !projectId) return false;
        const normalizedTag = tag.trim().toLowerCase();
        return state.equipments.some(eq =>
            eq.projectId === projectId &&
            eq.tag && eq.tag.trim().toLowerCase() === normalizedTag &&
            (excludeId ? eq.id !== excludeId : true)
        );
    }

    // ============================================================
    // VALIDATION CENTRALISÉE DES COORDONNÉES (Gère les tableaux de points)
    // ============================================================
    function validateEquipmentCoordinates(coordinates) {
        if (!coordinates) return true;
        if (typeof CoordSystem !== 'undefined' && CoordSystem.validateCoordinates) {
            return CoordSystem.validateCoordinates(coordinates);
        }
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
        if (!coordinates) return null;
        if (typeof CoordSystem !== 'undefined' && CoordSystem.normalizeCoordinates) {
            return CoordSystem.normalizeCoordinates(coordinates);
        }
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
    // FONCTIONS DE SYNCHRONISATION ÉQUIPEMENT ↔ SYSTÈME
    // ============================================================
    function syncEquipmentSystemRelationship(equipment, oldSystemId) {
        if (!equipment || !equipment.id) return;

        const newSystemId = equipment.systemId || null;

        if (oldSystemId && oldSystemId !== newSystemId) {
            const oldSystem = getSystem(oldSystemId);
            if (oldSystem && Array.isArray(oldSystem.equipmentIds)) {
                oldSystem.equipmentIds = oldSystem.equipmentIds.filter(id => id !== equipment.id);
            }
        }

        if (newSystemId) {
            const newSystem = getSystem(newSystemId);
            if (newSystem) {
                if (!Array.isArray(newSystem.equipmentIds)) {
                    newSystem.equipmentIds = [];
                }
                if (!newSystem.equipmentIds.includes(equipment.id)) {
                    newSystem.equipmentIds.push(equipment.id);
                }
            }
        }
    }

    function cleanupOrphanEquipmentReferences(equipmentId) {
        const systems = getSystems();
        let modified = false;
        systems.forEach(sys => {
            if (Array.isArray(sys.equipmentIds)) {
                const len = sys.equipmentIds.length;
                sys.equipmentIds = sys.equipmentIds.filter(id => id !== equipmentId);
                if (sys.equipmentIds.length !== len) {
                    modified = true;
                }
            }
        });
        if (modified) {
            saveCurrentProject();
        }
    }

    // ============================================================
    // CRÉATION DE PROJET
    // ============================================================
    function createNewProject(projectId, name, type) {
        return new Promise(async (resolve, reject) => {
            const newId = projectId.trim();
            if (!newId) { reject('ID projet requis'); return; }
            await loadProjectsList();
            const all = projectsList;
            if (all.find(p => p.id === newId)) { reject('Cet ID existe déjà'); return; }

            const defaults = APP_CONFIG.ILLIZI_DEFAULTS;
            const newAppState = {
                project: {
                    id: newId,
                    name: name || defaults.projectName,
                    surface: 0,
                    currentRequired: 0,
                    resistivity: defaults.resistivity,
                    coating: defaults.coating,
                    standards: [],
                    cpSystemType: defaults.cpSystemType,
                    defectDensity: defaults.defectDensity,
                    agingFactor: defaults.agingFactor,
                    targetPotential: defaults.targetPotential,
                    norm: defaults.norm,
                    envSoilResistivity: defaults.soilResistivity,
                    envSoilPh: defaults.soilPh,
                    envSoilMoisture: defaults.soilMoisture,
                    envSoilChlorides: defaults.soilChlorides,
                    envSoilSulfates: defaults.soilSulfates,
                    envSoilRedox: defaults.soilRedox,
                    envWaterSalinity: defaults.waterSalinity,
                    envWaterConductivity: defaults.waterConductivity,
                    envWaterTemp: defaults.waterTemperature,
                    envWaterDO: defaults.waterDO,
                    cpEnvironment: defaults.environment,
                    currentDensity: defaults.currentDensity,
                    // P1-05 : durée de vie de conception cible
                    designLifeTarget: 25,
                    shared: {
                        soilResistivity: defaults.soilResistivity,
                        // P0-05 : null par défaut (utilise soilResistivity)
                        groundbedFormationResistivity: null,
                        protectedSurface: 0,
                        designCurrent: 0,
                        cableLength: defaults.cableLength,
                        cableSection: defaults.cableSection,
                        structureResistance: defaults.structureResistance,
                        // P0-03 : config anodes ICCP
                        iccpAnodeConfig: {
                            material: 'mmo',
                            consumptionRate_mg_per_A_year: 1.0,
                            utilization: 0.85,
                            designLifeCap_years: 25,
                            massPerAnode_kg: 25
                        },
                        lock: {
                            soilResistivity: true,
                            protectedSurface: true,
                            designCurrent: true,
                            cableLength: true,
                            cableSection: true,
                            structureResistance: true
                        }
                    }
                },
                cp: { current: 0, irDrop: 0, requiredOnPotential: defaults.targetPotential },
                anodes: {
                    totalMass: 0,
                    count: 0,
                    actualLife: 0,
                    safetyFactor: defaults.safetyFactor,
                    soilResistivity: defaults.soilResistivity,
                    freePotential: -600,
                    finalResistanceFactor: 1.5,
                    initialCurrent: 0,
                    finalCurrent: 0,
                    currentDensity: 0,
                    currentDensity_mA: 0,       // P1-04
                    densityOk: false,
                    anodeMaterial: defaults.anodeMaterial,
                    units: null                  // P1-04
                },
                iccp: {
                    current: 0,
                    voltage: 0,
                    power: 0,
                    powerInitial: 0,             // P1-02
                    powerDesign: 0,              // P1-02
                    voltageFinal: 0,
                    currentDensity: 0,
                    currentDensity_mA: 0,        // P0-02
                    densityOk: false,
                    groundbedResistance: 0,
                    lifeEstimate: 0,
                    lifeTheoretical: 0,          // P1-05
                    lifeDesign: 0,               // P1-05
                    lifeDetails: null,           // P0-03
                    iccpCurrentSource: 'unknown',// P0-01
                    iccpSourceLabel: 'Inconnu',  // P0-01
                    safetyFactorPower: 1.15,     // P1-02
                    groundbedParams: {
                        rho: defaults.soilResistivity,
                        totalDepth: defaults.gbTotalDepth,
                        activeDepth: defaults.gbActiveDepth,
                        anodeCount: defaults.gbAnodeCount,
                        anodeLength: defaults.gbAnodeLength,
                        anodeDiameter: defaults.gbAnodeDiameter / 1000,
                        anodeWeight: defaults.gbAnodeWeight,
                        anodeCapacity: defaults.gbAnodeCapacity,
                        cableLength: defaults.gbCableLength,
                        cableSection: defaults.gbCableSection,
                        agingFactor: defaults.gbAgingFactor,
                        safetyFactor: defaults.gbSafetyFactor,
                        targetCurrent: 0
                    },
                    reinforcementZones: []
                },
                monitoring: { points: [] },
                dashboard: { systeme: [] },
                systems: [],
                equipments: [],
                fieldMeasurements: [],
                groundbed: { results: null },
                interference: { results: null },
                testPosts: { posts: [], totalLength: 0, spacing: 0 },
                mapPoints: [],
                history: [],
                groundbeds: [],
                version: APP_CONFIG.VERSION
            };

            const newProject = {
                id: newId,
                name: name,
                type: type,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                data: newAppState
            };

            await StorageManager.saveProject(newProject);
            await loadProjectsList();

            const systems = getSystems();
            if (systems.length === 0) {
                createSystem('Système principal', 'mixte');
            }
            if (typeof window.CPController !== 'undefined' && window.CPController.syncSurfaceFromEquipments) {
                window.CPController.syncSurfaceFromEquipments();
            }
            resolve(newProject);
        });
    }

    // ============================================================
    // AJOUT DIRECT D'ÉQUIPEMENT (AVEC SYNCHRONISATION)
    // ============================================================
    function addEquipmentDirect(equipment) {
        if (!equipment.id) equipment.id = Utils.generateId();

        if (isEquipmentDuplicate(equipment.tag, equipment.projectId)) {
            throw new Error(`Un équipement avec le tag "${equipment.tag}" existe déjà dans ce projet.`);
        }

        if (equipment.coordinates) {
            if (!validateEquipmentCoordinates(equipment.coordinates)) {
                throw new Error(`Coordonnées GPS invalides pour l'équipement ${equipment.tag}`);
            }
            equipment.coordinates = normalizeEquipmentCoordinates(equipment.coordinates);
        }
        if (!equipment.coordinates && (equipment.lat !== undefined || equipment.lon !== undefined)) {
            const lat = parseFloat(equipment.lat);
            const lon = parseFloat(equipment.lon);
            if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                equipment.coordinates = {
                    lat: lat,
                    lon: lon,
                    alt: equipment.alt !== undefined ? parseFloat(equipment.alt) : null
                };
                delete equipment.lat;
                delete equipment.lon;
                delete equipment.alt;
            }
        }

        if (!equipment.cpData) equipment.cpData = { parameters: {}, results: {}, calculated: false, lastCalculationDate: null };
        if (equipment.included === undefined) equipment.included = true;
        if (!equipment.dimensions) equipment.dimensions = {};
        if (!equipment.systemId) equipment.systemId = null;
        if (!equipment.material) equipment.material = 'acier';
        if (!equipment.wallThickness) equipment.wallThickness = 8.0;
        if (!equipment.coatingType) equipment.coatingType = '3LPE';
        if (!equipment.coatingCondition) equipment.coatingCondition = 'neuf';
        if (!equipment.coatingThickness) equipment.coatingThickness = 0;
        if (!equipment.soilResistivity) equipment.soilResistivity = 0;
        state.equipments.push(equipment);

        syncEquipmentSystemRelationship(equipment, null);

        StorageManager.saveEquipment(equipment);
        invalidateSurfaceCache();
        invalidateSystemCurrentCache();

        document.dispatchEvent(new CustomEvent('equipmentUpdated', {
            detail: { equipmentId: equipment.id, action: 'add' }
        }));

        return equipment;
    }

    function removeEquipmentFromSystem(equipmentId) {
        const systems = getSystems();
        systems.forEach(sys => {
            if (sys.equipmentIds && sys.equipmentIds.includes(equipmentId)) {
                sys.equipmentIds = sys.equipmentIds.filter(id => id !== equipmentId);
            }
        });
        invalidateSystemCurrentCache();
    }

    // ============================================================
    // GESTION DE LA SURFACE (avec cache)
    // ============================================================
    let _cachedSurface = null;
    let _cachedSurfaceProjectId = null;
    let _surfaceCacheVersion = 0;

    function getTotalEquipmentSurface() {
        const projectId = getCurrentProjectId();
        if (!projectId) return 0;
        if (_cachedSurfaceProjectId === projectId && _cachedSurface !== null && _surfaceCacheVersion > 0) {
            return _cachedSurface;
        }
        let total = 0;
        const eqs = state.equipments;
        eqs.forEach(eq => {
            if (eq.projectId === projectId && eq.included !== false) {
                total += Utils.safeNumber(eq.surface);
            }
        });
        _cachedSurface = total;
        _cachedSurfaceProjectId = projectId;
        _surfaceCacheVersion++;
        return total;
    }

    function invalidateSurfaceCache() {
        _cachedSurface = null;
        _cachedSurfaceProjectId = null;
        _surfaceCacheVersion++;
    }

    function getSharedParams() { return state.project.shared || {}; }

    function loadProjectsList() {
        return StorageManager.loadProjects().then(list => { projectsList = list; return list; });
    }

    // ============================================================
    // deleteEquipment avec sauvegarde FORCÉE et rechargement (optimisé)
    // ============================================================
    async function deleteEquipment(equipmentId) {
        try {
            const equipment = state.equipments.find(e => e.id === equipmentId);
            if (!equipment) throw new Error('Équipement introuvable.');

            const projectId = equipment.projectId;
            const tag = equipment.tag;

            if (window.GisIntegration && typeof window.GisIntegration.removeEquipmentMarker === 'function') {
                window.GisIntegration.removeEquipmentMarker(equipmentId);
            }
            if (window.Gis3D && typeof window.Gis3D.removeEquipment === 'function') {
                window.Gis3D.removeEquipment(equipmentId);
            }

            const index = state.equipments.indexOf(equipment);
            if (index > -1) {
                state.equipments.splice(index, 1);
            }

            // Mettre à jour le cache
            if (_lastProjectId === projectId && _lastEquipments) {
                const idx = _lastEquipments.findIndex(e => e.id === equipmentId);
                if (idx >= 0) _lastEquipments.splice(idx, 1);
            }

            cleanupOrphanEquipmentReferences(equipmentId);

            await StorageManager.deleteEquipment(equipmentId);
            Logger.info(`[Controller] Équipement ${tag} supprimé de IndexedDB`);

            const measurements = state.fieldMeasurements.filter(m => m.assetId === equipmentId);
            for (const meas of measurements) {
                await StorageManager.deleteFieldMeasurement(meas.id);
                const measIndex = state.fieldMeasurements.indexOf(meas);
                if (measIndex > -1) {
                    state.fieldMeasurements.splice(measIndex, 1);
                }
            }

            removeEquipmentFromSystem(equipmentId);

            invalidateSurfaceCache();
            invalidateSystemCurrentCache();
            StorageManager.invalidateCache(projectId);

            await saveCurrentProject();
            Logger.info(`[Controller] Projet sauvegardé sans l'équipement ${tag}`);

            // Recharger les équipements pour être cohérent
            const freshEquipments = await StorageManager.loadEquipmentsForProject(projectId, true);
            state.equipments = freshEquipments;
            _lastEquipments = freshEquipments;
            _equipmentsLoaded = true;
            _lastProjectId = projectId;
            Logger.info(`[Controller] Équipements rechargés depuis IndexedDB: ${freshEquipments.length}`);

            try {
                const projects = await StorageManager.loadProjects();
                projectsList = projects;
            } catch (e) {
                Logger.warn('[Controller] Erreur rechargement projets:', e);
            }

            addHistoryEntry('equipements', `Suppression équipement ${tag}`, '');

            document.dispatchEvent(new CustomEvent('equipmentUpdated', {
                detail: { equipmentId: equipment.id, action: 'delete' }
            }));

            if (window.UI && typeof window.UI.refreshEquipmentListUI === 'function') {
                setTimeout(() => {
                    window.UI.refreshEquipmentListUI(true);
                }, 100);
            }
            if (window.CPController && typeof window.CPController.updateDashboard === 'function') {
                window.CPController.updateDashboard();
            }

            return { success: true, equipmentId: equipmentId };

        } catch (error) {
            console.error('Erreur deleteEquipment:', error);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('❌ Erreur lors de la suppression : ' + error.message, 'error');
            }
            throw error;
        }
    }

    // ============================================================
    // saveEquipment avec sauvegarde FORCÉE (optimisé)
    // ============================================================
    async function saveEquipment(equipment) {
        if (!equipment || !equipment.id) throw new Error('Équipement invalide');

        if (isEquipmentDuplicate(equipment.tag, equipment.projectId, equipment.id)) {
            throw new Error(`Un équipement avec le tag "${equipment.tag}" existe déjà dans ce projet.`);
        }

        if (equipment.coordinates) {
            if (!validateEquipmentCoordinates(equipment.coordinates)) {
                throw new Error(`Coordonnées GPS invalides pour l'équipement ${equipment.tag}`);
            }
            equipment.coordinates = normalizeEquipmentCoordinates(equipment.coordinates);
        }
        if (!equipment.coordinates && (equipment.lat !== undefined || equipment.lon !== undefined)) {
            const lat = parseFloat(equipment.lat);
            const lon = parseFloat(equipment.lon);
            if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                equipment.coordinates = {
                    lat: lat,
                    lon: lon,
                    alt: equipment.alt !== undefined ? parseFloat(equipment.alt) : null
                };
                delete equipment.lat;
                delete equipment.lon;
                delete equipment.alt;
            }
        }

        const existing = state.equipments.find(e => e.id === equipment.id);
        const oldSystemId = existing ? existing.systemId : null;

        await StorageManager.saveEquipment(equipment);

        if (existing) {
            Object.assign(existing, equipment);
        } else {
            state.equipments.push(equipment);
        }

        // Mettre à jour le cache
        if (_lastProjectId === equipment.projectId && _lastEquipments) {
            const idx = _lastEquipments.findIndex(e => e.id === equipment.id);
            if (idx >= 0) _lastEquipments[idx] = equipment;
            else _lastEquipments.push(equipment);
        }

        syncEquipmentSystemRelationship(equipment, oldSystemId);

        invalidateSurfaceCache();
        invalidateSystemCurrentCache();

        await saveCurrentProject();

        document.dispatchEvent(new CustomEvent('equipmentUpdated', {
            detail: { equipmentId: equipment.id, action: 'update' }
        }));

        return equipment;
    }

    // ============================================================
    // saveProject avec sauvegarde FORCÉE (optimisé)
    // ============================================================
    async function saveCurrentProject() {
        return new Promise((resolve, reject) => {
            if (!currentProjectId) { resolve(); return; }

            saveQueue = saveQueue.then(async () => {
                try {
                    normalizeCalculationState();
                    const project = {
                        id: currentProjectId,
                        name: state.project.name,
                        type: state.project.cpSystemType,
                        createdAt: state.project.createdAt || new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        data: Utils.deepClone(state)
                    };
                    await StorageManager.saveProject(project);

                    const all = await StorageManager.loadProjects();
                    projectsList = all;

                    resolve();
                } catch (err) {
                    console.error('Erreur sauvegarde projet:', err);
                    reject(err);
                }
            });
            saveQueue.catch(err => reject(err));
        });
    }

    // ============================================================
    // SUPPRESSION DU PROJET ACTUEL
    // ============================================================
    async function deleteCurrentProject() {
        if (!currentProjectId) return;
        try {
            await StorageManager.deleteProjectCascade(currentProjectId);
            state.dashboard.systeme = [];
            state.systems = [];
            state.equipments = [];
            state.fieldMeasurements = [];
            state.mapPoints = [];
            state.groundbeds = [];
            state.history = [];
            currentProjectId = null;
            _lastProjectId = null;
            _lastEquipments = null;
            _equipmentsLoaded = false;
            await loadProjectsList();
            invalidateSurfaceCache();
            invalidateSystemCurrentCache();
        } catch (err) {
            console.error('Erreur deleteCurrentProject:', err);
            throw err;
        }
    }

    // ============================================================
    // MISE À JOUR DES PARAMÈTRES PARTAGÉS
    // ============================================================
    function updateSharedParam(key, value) {
        const shared = getSharedParams();
        if (shared.lock && shared.lock[key] !== undefined) {
            shared[key] = Utils.safeNumber(value, shared[key]);
            saveCurrentProject();
        }
    }

    /**
     * P0-05 : Mise à jour de la résistivité de la couche d'installation
     * des anodes. Distincte de soilResistivity (résistivité projet).
     *
     * @param {number|null} value - Résistivité en Ω·m, ou null pour
     *                              utiliser soilResistivity.
     */
    function updateGroundbedFormationResistivity(value) {
        const shared = getSharedParams();
        if (value === null || value === undefined || value === '') {
            shared.groundbedFormationResistivity = null;
        } else {
            const num = Utils.safeNumber(value, null);
            shared.groundbedFormationResistivity = (num > 0) ? num : null;
        }
        saveCurrentProject();
        console.log('[Controller] P0-05 : groundbedFormationResistivity =',
                    shared.groundbedFormationResistivity);
    }

    /**
     * P1-05 : Mise à jour de la durée de vie de conception cible.
     *
     * @param {number} years - Durée en années (défaut 25).
     */
    function updateDesignLifeTarget(years) {
        const val = Utils.safeNumber(years, 25);
        state.project.designLifeTarget = (val > 0) ? val : 25;
        saveCurrentProject();
        console.log('[Controller] P1-05 : designLifeTarget =', state.project.designLifeTarget);
    }

    /**
     * P0-03 : Mise à jour de la config anodes ICCP.
     */
    function updateICCPAnodeConfig(config) {
        const shared = getSharedParams();
        if (!shared.iccpAnodeConfig) {
            shared.iccpAnodeConfig = {
                material: 'mmo',
                consumptionRate_mg_per_A_year: 1.0,
                utilization: 0.85,
                designLifeCap_years: 25,
                massPerAnode_kg: 25
            };
        }
        Object.assign(shared.iccpAnodeConfig, config || {});
        saveCurrentProject();
    }

    // ============================================================
    // v9.1 : INTÉGRATION DES PATCHES
    // ============================================================

    /**
     * v9.1 : Résout le courant cible selon une priorité en cascade.
     *
     * Fusion de ui-groundbed-consistency-patch.js v2.1 (resolveTargetCurrent).
     * Délègue à window.DataResolver si disponible, sinon fallback inline.
     *
     * Priorité :
     *   1. state.iccp.current     (ICCP calculé)
     *   2. state.cp.current       (CP calculé)
     *   3. surface × densité/1000 (fallback)
     *
     * @param {Object} [options]
     * @param {number} [options.surfaceM2] - Surface totale (m²)
     * @param {number} [options.currentDensity_mA_m2] - Densité (mA/m²)
     * @returns {{value: number, source: string, label: string}}
     */
    function resolveTargetCurrent(options) {
        const opts = Object.assign({}, options || {});

        const selectedIccpSource = typeof document !== 'undefined'
            ? (document.getElementById('iccpCurrentSource')?.value || null)
            : null;
        const stateIccpSource = state.iccp && state.iccp.iccpCurrentSource;
        if (selectedIccpSource === 'cp_calculated' || stateIccpSource === 'cp_calculated') {
            const cpCurrent = Number(state.cp && state.cp.current) || 0;
            if (cpCurrent > 0) {
                return { value: cpCurrent, source: 'cp', label: 'CP calcule' };
            }
            return { value: 0, source: 'none', label: 'CP calcule non disponible' };
        }

        // Compléter avec la surface courante si non fournie
        if (opts.surfaceM2 === undefined) {
            opts.surfaceM2 = getTotalEquipmentSurface();
        }

        // Déléguer à DataResolver (module source officiel)
        if (typeof window !== 'undefined' &&
            window.DataResolver &&
            typeof window.DataResolver.resolvePreferredCurrent === 'function') {
            return window.DataResolver.resolvePreferredCurrent(opts);
        }

        // Fallback inline (si DataResolver non chargé)
        const iccpCurrent = (state.iccp && state.iccp.current) || 0;
        const cpCurrent = (state.cp && state.cp.current) || 0;

        if (isFinite(iccpCurrent) && iccpCurrent > 0) {
            return { value: iccpCurrent, source: 'iccp', label: 'ICCP calcule' };
        }
        if (isFinite(cpCurrent) && cpCurrent > 0) {
            return { value: cpCurrent, source: 'cp', label: 'CP calcule' };
        }

        const surface = Utils.safeNumber(opts.surfaceM2, 0);
        const density = Utils.safeNumber(opts.currentDensity_mA_m2, 0);
        if (surface > 0 && density > 0) {
            return {
                value: (surface * density) / 1000,
                source: 'surface',
                label: 'Surface x densite (fallback)'
            };
        }

        return { value: 0, source: 'none', label: 'Aucune source' };
    }

    /**
     * v9.1 : Nettoie les sauvegardes d'urgence obsolètes.
     *
     * Fusion de storage-patch.js (patch 5).
     * Supprime les entrées localStorage `cp_emergency_*` de plus de
     * 5 minutes pour éviter les faux positifs de restauration.
     *
     * @returns {number} Nombre d'entrées nettoyées
     */
    function cleanEmergencyBackups() {
        try {
            const emergencyKeys = [
                'cp_emergency_last',
                'cp_emergency_before_close',
                'cp_emergency_pagehide',
                'cp_emergency_unload',
                'cp_emergency_manual'
            ];

            let cleaned = 0;
            emergencyKeys.forEach(key => {
                const data = localStorage.getItem(key);
                if (!data) return;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed && parsed.timestamp &&
                        (Date.now() - parsed.timestamp > 300000)) { // 5 minutes
                        localStorage.removeItem(key);
                        cleaned++;
                    }
                } catch (e) {
                    // JSON invalide → supprimer
                    localStorage.removeItem(key);
                    cleaned++;
                }
            });

            if (cleaned > 0) {
                console.log(`[ProjectManager] ${cleaned} sauvegarde(s) d'urgence obsolète(s) nettoyée(s)`);
            }
            return cleaned;
        } catch (e) {
            console.warn('[ProjectManager] Erreur cleanEmergencyBackups:', e);
            return 0;
        }
    }

    /**
     * v9.1 : Migration "Grounded optimal" → "Groundbed optimal".
     *
     * Fusion de ui-groundbed-consistency-patch.js v2.1
     * (migrateGroundedToGroundbed).
     *
     * Corrige la faute de frappe historique présente dans certains
     * projets créés par l'optimiseur ICCP v3.1 antérieur.
     *
     * @returns {number} Nombre d'éléments migrés
     */
    function migrateGroundedToGroundbed() {
        let count = 0;

        // 1. Équipements
        if (state.equipments && state.equipments.length > 0) {
            state.equipments.forEach(eq => {
                if (eq && eq.tag === 'Grounded optimal') {
                    eq.tag = 'Groundbed optimal';
                    count++;
                    try {
                        StorageManager.saveEquipment(eq);
                    } catch (e) {
                        console.warn('[Controller] Erreur sauvegarde equipment migré:', e);
                    }
                }
            });
        }

        // 2. Groundbeds (state.groundbeds)
        if (state.groundbeds && state.groundbeds.length > 0) {
            state.groundbeds.forEach(gb => {
                if (gb && gb.name === 'Grounded optimal') {
                    gb.name = 'Groundbed optimal';
                    count++;
                }
            });
        }

        // 3. Fallback legacy (state.groundbed.results) — pas de champ name
        //    à migrer dans ce cas.

        if (count > 0) {
            console.log('[Controller] Migration Grounded→Groundbed:', count, 'element(s)');
            try {
                saveCurrentProject();
            } catch (e) {
                console.warn('[Controller] Erreur saveCurrentProject après migration:', e);
            }
        }
        return count;
    }

    // ============================================================
    // EXPOSITION PUBLIQUE
    // ============================================================
    return {
        state,
        getState,
        getCurrentProjectId,
        setCurrentProjectId,
        getProjectsList,
        setProjectsList,
        getSystems,
        getSystem,
        getCurrentSystemId,
        setCurrentSystemId,
        getActiveSystem,
        createSystem,
        deleteSystem,
        addRectifier,
        syncSelectedTransformerRectifier,
        deleteRectifier,
        updateRectifierStatus,
        getSystemEquipment,
        getSystemTotalCurrent,
        saveSystemParams,
        saveSystemResults,
        normalizeCalculationState,
        loadSystemParams,
        loadSystemResults,
        addHistoryEntry,
        loadProject,
        saveCurrentProject,
        createNewProject,
        deleteCurrentProject,
        loadProjectsList,
        migrateGroupsToSysteme,
        migrateSharedParams,
        migrateAnodesFields,
        migrateICCPFields,
        getGroundbeds,
        getGroundbedById,
        createGroundbed,
        updateGroundbed,
        deleteGroundbed,
        migrateGroundbeds,
        getSharedParams,
        updateSharedParam,
        updateGroundbedFormationResistivity,  // P0-05
        updateDesignLifeTarget,               // P1-05
        updateICCPAnodeConfig,                // P0-03
        removeEquipmentFromSystem,
        getTotalEquipmentSurface,
        invalidateSurfaceCache,
        invalidateSystemCurrentCache,
        addEquipmentDirect,
        saveEquipment,
        deleteEquipment,
        isEquipmentDuplicate,
        validateEquipmentCoordinates,
        normalizeEquipmentCoordinates,
        getEquipmentsForCurrentProject,
        // ============================================================
        // v9.1 : Nouvelles méthodes intégrées depuis les patches
        // ============================================================
        resolveTargetCurrent,                 // ← ui-groundbed-consistency v2.1
        cleanEmergencyBackups,                // ← storage-patch v1.0
        migrateGroundedToGroundbed,           // ← ui-groundbed-consistency v2.1
        // ============================================================
        // MÉTHODES POUR LA VISUALISATION 3D
        // ============================================================
        getAllEquipments: function(projectId) {
            const state = this.getState();
            if (projectId === '__all__' || projectId === null || projectId === undefined) {
                return state.equipments.filter(eq => eq.included !== false);
            }
            return state.equipments.filter(eq => eq.projectId === projectId && eq.included !== false);
        },

        getEquipmentsWithValidGPS: function(projectId) {
            const equipments = this.getAllEquipments(projectId);
            const valid = [];
            const invalid = [];
            const missing = [];

            const isValidCoord = function(lat, lon) {
                if (lat === undefined || lon === undefined) return false;
                const latNum = parseFloat(lat);
                const lonNum = parseFloat(lon);
                if (isNaN(latNum) || isNaN(lonNum)) return false;
                if (latNum < -90 || latNum > 90) return false;
                if (lonNum < -180 || lonNum > 180) return false;
                return true;
            };

            const isZeroCoord = function(lat, lon) {
                return Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9;
            };

            for (const eq of equipments) {
                const coords = eq.coordinates;
                if (!coords) {
                    missing.push(eq);
                    continue;
                }

                let hasValid = false;
                let points = [];

                if (Array.isArray(coords)) {
                    points = coords;
                } else if (coords.lat !== undefined && coords.lon !== undefined) {
                    points = [coords];
                }

                if (points.length === 0) {
                    missing.push(eq);
                    continue;
                }

                for (const p of points) {
                    const lat = Utils.safeNumber(p.lat);
                    const lon = Utils.safeNumber(p.lon);
                    if (isValidCoord(lat, lon) && !isZeroCoord(lat, lon)) {
                        hasValid = true;
                        break;
                    }
                }

                if (hasValid) {
                    valid.push(eq);
                } else {
                    invalid.push(eq);
                }
            }

            return { valid, invalid, missing };
        },

        hasValidGPS: function(equipment) {
            if (!equipment || !equipment.coordinates) return false;
            const coords = equipment.coordinates;

            let points = [];
            if (Array.isArray(coords)) {
                points = coords;
            } else if (coords.lat !== undefined && coords.lon !== undefined) {
                points = [coords];
            } else {
                return false;
            }

            const isValidCoord = function(lat, lon) {
                if (lat === undefined || lon === undefined) return false;
                const latNum = parseFloat(lat);
                const lonNum = parseFloat(lon);
                if (isNaN(latNum) || isNaN(lonNum)) return false;
                if (latNum < -90 || latNum > 90) return false;
                if (lonNum < -180 || lonNum > 180) return false;
                return true;
            };

            const isZeroCoord = function(lat, lon) {
                return Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9;
            };

            for (const p of points) {
                const lat = Utils.safeNumber(p.lat);
                const lon = Utils.safeNumber(p.lon);
                if (isValidCoord(lat, lon) && !isZeroCoord(lat, lon)) {
                    return true;
                }
            }
            return false;
        }
    };
})();

window.ProjectManager = ProjectManager;

// ============================================================
// v9.1 : Nettoyage automatique des sauvegardes d'urgence obsolètes
//        au démarrage (déplacé depuis storage-patch.js)
// ============================================================
if (typeof window !== 'undefined') {
    setTimeout(function() {
        try {
            if (typeof ProjectManager !== 'undefined' &&
                typeof ProjectManager.cleanEmergencyBackups === 'function') {
                ProjectManager.cleanEmergencyBackups();
            }
        } catch (e) {
            console.warn('[Controller] Erreur cleanEmergencyBackups au démarrage:', e);
        }
    }, 1000);
}

// ============================================================
// FIN DE controller.js (VERSION 9.1 – INTÉGRATION PATCHES)
// ============================================================