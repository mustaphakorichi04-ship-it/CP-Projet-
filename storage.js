// ============================================================
// storage.js – CP Engineer Pro – Persistance IndexedDB + localStorage
// Module persistance. Version applicative : APP_CONFIG.VERSION (engine.js).
// ============================================================
// CORRECTIONS APPLIQUÉES :
//   P0-05 : normalizeEquipment() préserve groundbedFormationResistivity
//           et designLifeTarget sur l'équipement (cohérence cache).
//   P1-04 : normalizeEquipment() préserve cpData.results.currentDensity_mA
//           et cpData.results.units (unités canoniques).
//   P1-05 : Bump du schéma (CURRENT_SCHEMA_VERSION 2 → 3) pour tracer
//           la présence de designLifeTarget dans state.project.
//   Le reste du fichier est inchangé — les nouveaux champs de
//   state.project (designLifeTarget, groundbedFormationResistivity,
//   iccpAnodeConfig) sont persistés automatiquement via
//   Utils.deepClone(state) dans saveProject().
// ============================================================
// Historique :
//   v8.7 – forceSave/forceDelete synchrones (fix race condition)
//   v9.0 – Ajout des nouveaux champs (P0-05 / P1-04 / P1-05)
// ============================================================

const StorageManager = (function() {
    let db = null;
    let useLocalStorage = false;
    let encryptionKey = null;
    let _indexedDBFailCount = 0;
    const MAX_INDEXEDDB_FAILS = 3;

    // ============================================================
    // P1-05 : Bump du schéma (2 → 3) suite à l'ajout de
    //         designLifeTarget dans state.project.
    // ============================================================
    // Ces deux constantes sont exposées par APP_CONFIG. On les
    // synchronise à l'initialisation pour garantir la cohérence.
    const STORAGE_VERSION = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.STORAGE_VERSION)
        ? APP_CONFIG.STORAGE_VERSION
        : 24;
    const CURRENT_SCHEMA_VERSION = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.DATA_SCHEMA_VERSION)
        ? APP_CONFIG.DATA_SCHEMA_VERSION
        : 3;

    // OPTIM : Cache LRU pour les projets et équipements
    const _memoryCache = {
        projects: null,
        equipments: new Map(),
        fieldMeasurements: new Map(),
        mapPoints: new Map(),
        history: null,
        groundbedData: null,
        interferenceData: null
    };

    // OPTIM : Cache LRU pour les équipements (limité à 50 projets)
    const _equipmentCacheLRU = new Map();
    const MAX_CACHED_PROJECTS = 50;

    let _encryptionSalt = null;
    let _saveQueue = Promise.resolve();

    // ============================================================
    // LOCAL STORAGE HELPERS
    // ============================================================
    function getLS(key) {
        try {
            const v = localStorage.getItem('cp_' + key);
            if (v) {
                try { return JSON.parse(v); } catch (e) { return v; }
            }
            return null;
        } catch (e) { return null; }
    }

    function setLS(key, value) {
        try {
            localStorage.setItem('cp_' + key, JSON.stringify(value));
        } catch (e) { console.warn('localStorage set error:', e); }
    }

    function removeLS(key) {
        try {
            localStorage.removeItem('cp_' + key);
        } catch (e) {
            console.warn('localStorage remove error:', e);
        }
    }

    // ============================================================
    // PERSIST-010 : Sauvegarde DIRECTE et SYNCHRONE (sans batch)
    // ✅ CORRECTION v8.7 : écriture IndexedDB immédiate avec attente de la transaction
    //   pour éviter la race condition avec loadEquipmentsForProject.
    // ============================================================
    async function forceSave(storeName, key, value) {
        if (useLocalStorage) {
            try {
                if (storeName === 'history' || storeName === 'groundbedData' || storeName === 'interferenceData') {
                    // Ces stores contiennent un objet unique
                    setLS(storeName, value && value.data !== undefined ? value.data : value);
                } else {
                    let all = getLS(storeName);
                    if (!Array.isArray(all)) all = [];
                    const idx = all.findIndex(item => item && item.id === key);
                    if (idx >= 0) all[idx] = value;
                    else all.push(value);
                    setLS(storeName, all);
                }
            } catch (e) {
                console.warn('[Storage] Erreur forceSave localStorage:', e);
            }
            return;
        }
        if (!db) throw new Error('DB not initialized');

        // ✅ Écriture DIRECTE dans IndexedDB avec attente de la transaction
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.put(value);

        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
    }

    // ============================================================
    // PERSIST-011 : Suppression DIRECTE et SYNCHRONE (sans batch)
    // ✅ CORRECTION v8.7 : garantir que la suppression est effective avant tout reload
    // ============================================================
    async function forceDelete(storeName, key) {
        if (useLocalStorage) {
            try {
                let all = getLS(storeName);
                if (Array.isArray(all)) {
                    all = all.filter(item => !item || item.id !== key);
                    setLS(storeName, all);
                }
            } catch (e) {
                console.warn('[Storage] Erreur forceDelete localStorage:', e);
            }
            return;
        }
        if (!db) throw new Error('DB not initialized');

        // ✅ Suppression DIRECTE dans IndexedDB avec attente de la transaction
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.delete(key);

        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
    }

    // ============================================================
    // PERSIST-019 : Fonction promisifyRequest
    // ============================================================
    function promisifyRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // ============================================================
    // PERSIST-015 : Normalisation des équipements
    // ------------------------------------------------------------
    // P0-05 : Préserve explicitement groundbedFormationResistivity
    //         et designLifeTarget sur l'équipement (cohérence cache).
    // P1-04 : Préserve explicitement cpData.results.currentDensity_mA
    //         et cpData.results.units (unités canoniques).
    // ============================================================
    function normalizeEquipment(eq) {
        if (!eq) return eq;
        if (!eq.cpData) eq.cpData = { parameters: {}, results: {}, calculated: false, lastCalculationDate: null };
        if (eq.included === undefined) eq.included = true;
        if (!eq.dimensions) eq.dimensions = {};
        if (!eq.systemId) eq.systemId = null;
        if (!eq.material) eq.material = 'acier';
        if (!eq.wallThickness) eq.wallThickness = 8.0;
        if (!eq.coatingType) eq.coatingType = '3LPE';
        if (!eq.coatingCondition) eq.coatingCondition = 'neuf';
        if (!eq.coatingThickness) eq.coatingThickness = 0;
        if (eq.soilResistivity === undefined || eq.soilResistivity === null) eq.soilResistivity = 0;

        // ============================================================
        // P1-04 : Préservation des champs canoniques dans cpData.results
        // ------------------------------------------------------------
        // Si le calcul CP a été effectué, les résultats contiennent
        // des champs optionnels qu'il ne faut PAS écraser.
        // On garantit la présence des clés (avec valeur null si absentes)
        // pour éviter les `undefined` en aval.
        // ============================================================
        if (eq.cpData && eq.cpData.results) {
            if (eq.cpData.results.currentDensity_mA === undefined) {
                eq.cpData.results.currentDensity_mA = null;
            }
            if (eq.cpData.results.units === undefined) {
                eq.cpData.results.units = null;
            }
        } else if (eq.cpData && !eq.cpData.results) {
            eq.cpData.results = {
                currentDensity_mA: null,
                units: null
            };
        }

        // ============================================================
        // P0-05 : Préservation de groundbedFormationResistivity et
        //         designLifeTarget sur l'équipement (le cas échéant).
        // ------------------------------------------------------------
        // Ces champs ne sont normalement pas portés par les équipements,
        // mais s'ils existent (ex. équipement de type 'groundbed' avec
        // des métadonnées de formation), on les préserve.
        // ============================================================
        if (eq.groundbedFormationResistivity === undefined) {
            eq.groundbedFormationResistivity = null;
        }
        if (eq.designLifeTarget === undefined) {
            eq.designLifeTarget = null;
        }

        if (eq.coordinates) {
            if (Array.isArray(eq.coordinates)) {
                if (eq.coordinates.length > 0 && Array.isArray(eq.coordinates[0])) {
                    eq.coordinates = eq.coordinates.map(p => ({
                        lat: parseFloat(p[0]),
                        lon: parseFloat(p[1]),
                        alt: (p[2] !== undefined && p[2] !== null) ? parseFloat(p[2]) : null
                    })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
                }
                else if (eq.coordinates.length > 0 && typeof eq.coordinates[0] === 'object') {
                    eq.coordinates = eq.coordinates.map(p => ({
                        lat: parseFloat(p.lat || p.latitude),
                        lon: parseFloat(p.lon || p.longitude || p.lng),
                        alt: p.alt !== undefined ? parseFloat(p.alt) : null
                    })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
                }
            } else if (typeof eq.coordinates === 'object' && eq.coordinates.lat !== undefined) {
                eq.coordinates = [{
                    lat: parseFloat(eq.coordinates.lat),
                    lon: parseFloat(eq.coordinates.lon),
                    alt: eq.coordinates.alt !== undefined ? parseFloat(eq.coordinates.alt) : null
                }];
            }
        }

        return eq;
    }

    // ============================================================
    // ENCRYPTION
    // ============================================================
    function getEncryptionSalt() {
        if (_encryptionSalt) return _encryptionSalt;
        const stored = getLS('encryption_salt');
        if (stored && typeof stored === 'string' && stored.length >= 16) {
            _encryptionSalt = stored;
        } else {
            const array = new Uint8Array(16);
            crypto.getRandomValues(array);
            _encryptionSalt = Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
            setLS('encryption_salt', _encryptionSalt);
        }
        return _encryptionSalt;
    }

    async function initEncryption() {
        try {
            if (!window.isSecureContext) {
                console.warn('Contexte non sécurisé – chiffrement désactivé.');
                encryptionKey = null;
                return false;
            }
            const salt = getEncryptionSalt();
            encryptionKey = await Utils.deriveKey(salt);
            return true;
        } catch (e) {
            console.warn('Chiffrement non disponible:', e);
            encryptionKey = null;
            return false;
        }
    }

    // ============================================================
    // INDEXEDDB INITIALIZATION
    // ============================================================
    function initDatabase() {
        return new Promise((resolve) => {
            try {
                if (!window.indexedDB) {
                    console.warn('IndexedDB non disponible, basculement vers localStorage');
                    useLocalStorage = true;
                    resolve();
                    return;
                }
            } catch (e) {
                console.warn('IndexedDB non disponible, basculement vers localStorage');
                useLocalStorage = true;
                resolve();
                return;
            }

            const req = indexedDB.open('CPEngineerDB', STORAGE_VERSION);
            req.onupgradeneeded = function(e) {
                const dbInst = e.target.result;
                if (!dbInst.objectStoreNames.contains('projects')) {
                    dbInst.createObjectStore('projects', { keyPath: 'id' });
                }
                if (!dbInst.objectStoreNames.contains('equipments')) {
                    const store = dbInst.createObjectStore('equipments', { keyPath: 'id' });
                    store.createIndex('projectId', 'projectId', { unique: false });
                }
                if (!dbInst.objectStoreNames.contains('fieldMeasurements')) {
                    const store2 = dbInst.createObjectStore('fieldMeasurements', { keyPath: 'id' });
                    store2.createIndex('projectId', 'projectId', { unique: false });
                    store2.createIndex('assetId', 'assetId', { unique: false });
                }
                if (!dbInst.objectStoreNames.contains('mapPoints')) {
                    const store3 = dbInst.createObjectStore('mapPoints', { keyPath: 'id' });
                    store3.createIndex('projectId', 'projectId', { unique: false });
                }
                if (!dbInst.objectStoreNames.contains('groundbedData')) {
                    dbInst.createObjectStore('groundbedData', { keyPath: 'id' });
                }
                if (!dbInst.objectStoreNames.contains('interferenceData')) {
                    dbInst.createObjectStore('interferenceData', { keyPath: 'id' });
                }
                if (!dbInst.objectStoreNames.contains('history')) {
                    dbInst.createObjectStore('history', { keyPath: 'id' });
                }
            };
            req.onsuccess = function(e) {
                db = e.target.result;
                db.onerror = function(event) {
                    if (event.target.error && event.target.error.name === 'QuotaExceededError') {
                        console.warn('QuotaExceededError – basculement vers localStorage');
                        useLocalStorage = true;
                    }
                };
                resolve();
            };
            req.onerror = function(e) {
                console.error('IndexedDB error:', e);
                useLocalStorage = true;
                resolve();
            };
        });
    }

    // ============================================================
    // PROJETS
    // ------------------------------------------------------------
    // NOTE : Les nouveaux champs (designLifeTarget, groundbedFormationResistivity,
    //        iccpAnodeConfig) sont persistés automatiquement via
    //        Utils.deepClone(state) dans saveProject() appelé par
    //        ProjectManager.saveCurrentProject().
    // ============================================================
    async function saveProject(project) {
        if (!project || !project.id || !project.data) {
            throw new Error('Projet invalide');
        }

        if (!project.data.schemaVersion) {
            project.data.schemaVersion = CURRENT_SCHEMA_VERSION;
        }

        project._lastModified = Date.now();
        project._version = STORAGE_VERSION;

        if (_memoryCache.projects) {
            const idx = _memoryCache.projects.findIndex(p => p.id === project.id);
            if (idx >= 0) _memoryCache.projects[idx] = project;
            else _memoryCache.projects.push(project);
        }

        await forceSave('projects', project.id, project);

        try {
            let all = getLS('projects');
            if (!Array.isArray(all)) all = [];
            const idx = all.findIndex(p => p.id === project.id);
            if (idx >= 0) all[idx] = project;
            else all.push(project);
            setLS('projects', all);
        } catch (e) {
            console.warn('[Storage] Erreur sync localStorage:', e);
        }

        return project;
    }

    async function loadProjects() {
        if (_memoryCache.projects !== null) return _memoryCache.projects;
        try {
            if (useLocalStorage) return getLS('projects') || [];
            if (!db) return getLS('projects') || [];
            const tx = db.transaction('projects', 'readonly');
            const all = await promisifyRequest(tx.objectStore('projects').getAll());
            const result = all || [];
            _memoryCache.projects = result;
            return result;
        } catch (e) {
            console.warn('[Storage] Erreur loadProjects:', e);
            const local = getLS('projects') || [];
            _memoryCache.projects = local;
            return local;
        }
    }

    // ============================================================
    // PERSIST-018 : Suppression de projet EN CASCADE
    // ============================================================
    async function deleteProjectCascade(projectId) {
        if (!projectId) return;

        const equipments = await loadEquipmentsForProject(projectId);
        for (const eq of equipments) {
            await forceDelete('equipments', eq.id);
        }
        _memoryCache.equipments.delete(projectId);
        _equipmentCacheLRU.delete(projectId);

        const measurements = await loadFieldMeasurementsForProject(projectId);
        for (const m of measurements) {
            await forceDelete('fieldMeasurements', m.id);
        }
        _memoryCache.fieldMeasurements.delete(projectId);

        const mapPoints = await loadMapPoints(projectId);
        for (const p of mapPoints) {
            await forceDelete('mapPoints', p.id);
        }
        _memoryCache.mapPoints.delete(projectId);

        await forceDelete('projects', projectId);

        try {
            let all = getLS('projects') || [];
            all = all.filter(p => p.id !== projectId);
            setLS('projects', all);

            let eqAll = getLS('equipments') || [];
            eqAll = eqAll.filter(e => e.projectId !== projectId);
            setLS('equipments', eqAll);

            let measAll = getLS('fieldMeasurements') || [];
            measAll = measAll.filter(m => m.projectId !== projectId);
            setLS('fieldMeasurements', measAll);
        } catch (e) {
            console.warn('[Storage] Erreur nettoyage localStorage:', e);
        }

        invalidateCache(projectId);
        _memoryCache.projects = null;

        return true;
    }

    // ============================================================
    // ÉQUIPEMENTS (OPTIMISÉ : cache LRU)
    // ------------------------------------------------------------
    // P1-04 : normalizeEquipment() préserve les champs canoniques
    //         (currentDensity_mA, units) lors du chargement.
    // P0-05 : normalizeEquipment() garantit la présence de
    //         groundbedFormationResistivity et designLifeTarget.
    // ============================================================
    async function loadEquipmentsForProject(projectId, forceRefresh = false) {
        if (!projectId) return [];

        if (!forceRefresh && _equipmentCacheLRU.has(projectId)) {
            const cached = _equipmentCacheLRU.get(projectId);
            _equipmentCacheLRU.delete(projectId);
            _equipmentCacheLRU.set(projectId, cached);
            return cached;
        }

        if (!forceRefresh && _memoryCache.equipments.has(projectId)) {
            const eqs = _memoryCache.equipments.get(projectId);
            if (_equipmentCacheLRU.size >= MAX_CACHED_PROJECTS) {
                const firstKey = _equipmentCacheLRU.keys().next().value;
                _equipmentCacheLRU.delete(firstKey);
            }
            _equipmentCacheLRU.set(projectId, eqs);
            return eqs;
        }

        if (!useLocalStorage && db) {
            try {
                const tx = db.transaction('equipments', 'readonly');
                const store = tx.objectStore('equipments');

                let eqs = [];
                if (store.indexNames.contains('projectId')) {
                    const index = store.index('projectId');
                    eqs = await promisifyRequest(index.getAll(projectId));
                } else {
                    const all = await promisifyRequest(store.getAll());
                    eqs = all.filter(e => e.projectId === projectId);
                }

                eqs = eqs.map(eq => normalizeEquipment(eq));
                _memoryCache.equipments.set(projectId, eqs);
                if (_equipmentCacheLRU.size >= MAX_CACHED_PROJECTS) {
                    const firstKey = _equipmentCacheLRU.keys().next().value;
                    _equipmentCacheLRU.delete(firstKey);
                }
                _equipmentCacheLRU.set(projectId, eqs);
                return eqs;
            } catch (e) {
                console.warn('[Storage] Erreur chargement IndexedDB:', e);
            }
        }

        try {
            const all = getLS('equipments') || [];
            const eqs = all.filter(e => e.projectId === projectId).map(normalizeEquipment);
            _memoryCache.equipments.set(projectId, eqs);
            if (_equipmentCacheLRU.size >= MAX_CACHED_PROJECTS) {
                const firstKey = _equipmentCacheLRU.keys().next().value;
                _equipmentCacheLRU.delete(firstKey);
            }
            _equipmentCacheLRU.set(projectId, eqs);
            return eqs;
        } catch (e) {
            console.warn('[Storage] Erreur chargement localStorage:', e);
            return [];
        }
    }

    // ============================================================
    // PERSIST-012 : Sauvegarde d'équipement AVEC validation
    // ------------------------------------------------------------
    // P1-04 / P0-05 : normalizeEquipment() est appelé avant écriture
    //                 pour garantir la présence des champs canoniques.
    // ============================================================
    async function saveEquipment(equipment) {
        if (!equipment || !equipment.id) throw new Error('Équipement invalide');

        // P1-04 / P0-05 : Normalisation défensive avant sauvegarde
        // (garantit que currentDensity_mA, units, groundbedFormationResistivity
        //  et designLifeTarget sont présents dans l'objet persisté)
        normalizeEquipment(equipment);

        const projectId = equipment.projectId;
        if (projectId && _memoryCache.equipments.has(projectId)) {
            const eqs = _memoryCache.equipments.get(projectId);
            const idx = eqs.findIndex(e => e.id === equipment.id);
            if (idx >= 0) eqs[idx] = equipment;
            else eqs.push(equipment);
            if (_equipmentCacheLRU.has(projectId)) {
                _equipmentCacheLRU.delete(projectId);
                _equipmentCacheLRU.set(projectId, eqs);
            }
        }

        await forceSave('equipments', equipment.id, equipment);

        try {
            let all = getLS('equipments');
            if (!Array.isArray(all)) all = [];
            const idx = all.findIndex(e => e.id === equipment.id);
            if (idx >= 0) all[idx] = equipment;
            else all.push(equipment);
            setLS('equipments', all);
        } catch (e) {
            console.warn('[Storage] Erreur sync localStorage:', e);
        }

        // Invalider le cache pour ce projet
        invalidateCache(projectId);

        return equipment;
    }

    // ============================================================
    // PERSIST-013 : Suppression d'équipement AVEC nettoyage total
    // ============================================================
    async function deleteEquipment(equipId) {
        if (!equipId) throw new Error('ID équipement requis');

        let projectId = null;
        for (const [pid, eqs] of _memoryCache.equipments) {
            const idx = eqs.findIndex(e => e.id === equipId);
            if (idx >= 0) {
                eqs.splice(idx, 1);
                _memoryCache.equipments.set(pid, eqs);
                if (_equipmentCacheLRU.has(pid)) {
                    _equipmentCacheLRU.delete(pid);
                    _equipmentCacheLRU.set(pid, eqs);
                }
                projectId = pid;
                break;
            }
        }

        await forceDelete('equipments', equipId);

        try {
            let all = getLS('equipments') || [];
            all = all.filter(e => e.id !== equipId);
            setLS('equipments', all);
        } catch (e) {
            console.warn('[Storage] Erreur suppression localStorage:', e);
        }

        try {
            const measurements = await loadAllFieldMeasurements();
            const toDelete = measurements.filter(m => m.assetId === equipId);
            for (const m of toDelete) {
                await forceDelete('fieldMeasurements', m.id);
            }
        } catch (e) {
            console.warn('[Storage] Erreur suppression mesures associées:', e);
        }

        if (projectId) {
            invalidateCache(projectId);
        }

        return true;
    }

    // ============================================================
    // MESURES TERRAIN (avec cache)
    // ============================================================
    async function loadAllFieldMeasurements() {
        if (useLocalStorage) return getLS('fieldMeasurements') || [];
        if (!db) return getLS('fieldMeasurements') || [];
        try {
            const tx = db.transaction('fieldMeasurements', 'readonly');
            const all = await promisifyRequest(tx.objectStore('fieldMeasurements').getAll());
            return all || [];
        } catch (e) {
            return getLS('fieldMeasurements') || [];
        }
    }

    async function loadFieldMeasurementsForProject(projectId) {
        if (!projectId) return [];
        if (_memoryCache.fieldMeasurements.has(projectId)) {
            return _memoryCache.fieldMeasurements.get(projectId);
        }
        try {
            const all = await loadAllFieldMeasurements();
            const filtered = all.filter(m => m.projectId === projectId);
            _memoryCache.fieldMeasurements.set(projectId, filtered);
            return filtered;
        } catch (e) {
            return [];
        }
    }

    async function loadFieldMeasurementsForAsset(assetId) {
        if (!assetId) return [];
        const all = await loadAllFieldMeasurements();
        return all.filter(m => m.assetId === assetId);
    }

    async function saveFieldMeasurement(measurement) {
        if (!measurement || !measurement.id) throw new Error('Mesure invalide');
        const projectId = measurement.projectId;
        if (projectId && _memoryCache.fieldMeasurements.has(projectId)) {
            const meas = _memoryCache.fieldMeasurements.get(projectId);
            meas.push(measurement);
        }
        await forceSave('fieldMeasurements', measurement.id, measurement);
        try {
            let all = getLS('fieldMeasurements') || [];
            const idx = all.findIndex(item => item && item.id === measurement.id);
            if (idx >= 0) all[idx] = measurement;
            else all.push(measurement);
            setLS('fieldMeasurements', all);
        } catch (e) {}
        return measurement;
    }

    async function deleteFieldMeasurement(measId) {
        if (!measId) return;
        for (const [projectId, meas] of _memoryCache.fieldMeasurements) {
            const idx = meas.findIndex(m => m.id === measId);
            if (idx >= 0) {
                meas.splice(idx, 1);
                break;
            }
        }
        await forceDelete('fieldMeasurements', measId);
        try {
            let all = getLS('fieldMeasurements') || [];
            all = all.filter(m => m.id !== measId);
            setLS('fieldMeasurements', all);
        } catch (e) {}
    }

    // ============================================================
    // POINTS CARTOGRAPHIQUES
    // ============================================================
    async function loadAllMapPoints() {
        if (useLocalStorage) return getLS('mapPoints') || [];
        if (!db) return getLS('mapPoints') || [];
        try {
            const tx = db.transaction('mapPoints', 'readonly');
            const all = await promisifyRequest(tx.objectStore('mapPoints').getAll());
            return all || [];
        } catch (e) {
            return getLS('mapPoints') || [];
        }
    }

    async function loadMapPoints(projectId) {
        if (!projectId) return [];
        if (_memoryCache.mapPoints.has(projectId)) {
            return _memoryCache.mapPoints.get(projectId);
        }
        try {
            const all = await loadAllMapPoints();
            const filtered = all.filter(p => p.projectId === projectId);
            _memoryCache.mapPoints.set(projectId, filtered);
            return filtered;
        } catch (e) {
            return [];
        }
    }

    async function saveMapPoint(point) {
        if (!point || !point.id) throw new Error('Point invalide');
        const projectId = point.projectId;
        if (projectId && _memoryCache.mapPoints.has(projectId)) {
            const pts = _memoryCache.mapPoints.get(projectId);
            const idx = pts.findIndex(p => p.id === point.id);
            if (idx >= 0) pts[idx] = point;
            else pts.push(point);
        }
        await forceSave('mapPoints', point.id, point);
        try {
            let all = getLS('mapPoints') || [];
            const idx = all.findIndex(p => p.id === point.id);
            if (idx >= 0) all[idx] = point;
            else all.push(point);
            setLS('mapPoints', all);
        } catch (e) {}
        return point;
    }

    async function deleteMapPoint(pointId) {
        if (!pointId) return;
        for (const [projectId, pts] of _memoryCache.mapPoints) {
            const idx = pts.findIndex(p => p.id === pointId);
            if (idx >= 0) {
                pts.splice(idx, 1);
                break;
            }
        }
        await forceDelete('mapPoints', pointId);
        try {
            let all = getLS('mapPoints') || [];
            all = all.filter(p => p.id !== pointId);
            setLS('mapPoints', all);
        } catch (e) {}
    }

    // ============================================================
    // HISTORIQUE
    // ============================================================
    async function loadHistoryData() {
        if (useLocalStorage) return getLS('history') || [];
        if (!db) return getLS('history') || [];
        try {
            const tx = db.transaction('history', 'readonly');
            const result = await promisifyRequest(tx.objectStore('history').get('history'));
            return result ? result.data || [] : [];
        } catch (e) {
            return getLS('history') || [];
        }
    }

    async function loadHistory() {
        if (_memoryCache.history !== null) return _memoryCache.history;
        try {
            const result = await loadHistoryData();
            _memoryCache.history = result;
            return result;
        } catch (e) {
            const local = getLS('history') || [];
            _memoryCache.history = local;
            return local;
        }
    }

    async function saveHistory(history) {
        _memoryCache.history = history;
        await forceSave('history', 'history', { id: 'history', data: history });
        try { setLS('history', history); } catch (e) {}
    }

    // ============================================================
    // GROUNDBEDS
    // ------------------------------------------------------------
    // P0-05 : Les résultats groundbed contiennent désormais
    //         rhoProject / rhoGroundbed (traçabilité).
    //         Ces champs sont persistés automatiquement via forceSave().
    // ============================================================
    async function loadGroundbedDataFromDB() {
        if (useLocalStorage) return getLS('groundbedData') || null;
        if (!db) return getLS('groundbedData') || null;
        try {
            const tx = db.transaction('groundbedData', 'readonly');
            const result = await promisifyRequest(tx.objectStore('groundbedData').get('current'));
            return result || null;
        } catch (e) {
            return getLS('groundbedData') || null;
        }
    }

    async function loadGroundbedData() {
        if (_memoryCache.groundbedData !== null) return _memoryCache.groundbedData;
        try {
            const result = await loadGroundbedDataFromDB();
            _memoryCache.groundbedData = result;
            return result;
        } catch (e) {
            const local = getLS('groundbedData') || null;
            _memoryCache.groundbedData = local;
            return local;
        }
    }

    async function saveGroundbedData(data) {
        _memoryCache.groundbedData = data;
        await forceSave('groundbedData', 'current', { id: 'current', ...data });
        try { setLS('groundbedData', data); } catch (e) {}
    }

    // ============================================================
    // INTERFÉRENCES
    // ============================================================
    async function loadInterferenceDataFromDB() {
        if (useLocalStorage) return getLS('interferenceData') || null;
        if (!db) return getLS('interferenceData') || null;
        try {
            const tx = db.transaction('interferenceData', 'readonly');
            const result = await promisifyRequest(tx.objectStore('interferenceData').get('current'));
            return result || null;
        } catch (e) {
            return getLS('interferenceData') || null;
        }
    }

    async function loadInterferenceData() {
        if (_memoryCache.interferenceData !== null) return _memoryCache.interferenceData;
        try {
            const result = await loadInterferenceDataFromDB();
            _memoryCache.interferenceData = result;
            return result;
        } catch (e) {
            const local = getLS('interferenceData') || null;
            _memoryCache.interferenceData = local;
            return local;
        }
    }

    async function saveInterferenceData(data) {
        _memoryCache.interferenceData = data;
        await forceSave('interferenceData', 'current', { id: 'current', ...data });
        try { setLS('interferenceData', data); } catch (e) {}
    }

    // ============================================================
    // PERSIST-016 : Vider COMPLÈTEMENT le cache
    // ============================================================
    function invalidateCache(projectId) {
        if (projectId) {
            _memoryCache.equipments.delete(projectId);
            _memoryCache.fieldMeasurements.delete(projectId);
            _memoryCache.mapPoints.delete(projectId);
            _equipmentCacheLRU.delete(projectId);
        } else {
            _memoryCache.equipments.clear();
            _memoryCache.fieldMeasurements.clear();
            _memoryCache.mapPoints.clear();
            _equipmentCacheLRU.clear();
            _memoryCache.projects = null;
            _memoryCache.history = null;
            _memoryCache.groundbedData = null;
            _memoryCache.interferenceData = null;
        }
    }

    // ============================================================
    // INVALIDATION FORCÉE DU CACHE - POUR BOUTON ENREGISTRER
    // ============================================================
    async function forceInvalidateCache(projectId) {
        if (!projectId) {
            console.warn('[Storage] forceInvalidateCache: projectId manquant');
            return [];
        }

        try {
            if (_memoryCache) {
                _memoryCache.equipments.delete(projectId);
                _memoryCache.fieldMeasurements.delete(projectId);
                _memoryCache.mapPoints.delete(projectId);
                _equipmentCacheLRU.delete(projectId);
            }

            const freshEquipments = await loadEquipmentsForProject(projectId, true);

            if (typeof ProjectManager !== 'undefined' && ProjectManager.getState) {
                const state = ProjectManager.getState();
                if (state) {
                    state.equipments = freshEquipments;
                    console.log(`[Storage] Cache invalidé et rechargé: ${freshEquipments.length} équipements`);
                }
            }

            return freshEquipments;
        } catch (e) {
            console.warn('[Storage] Erreur rechargement après invalidation:', e);
            return [];
        }
    }

    // ============================================================
    // API PUBLIQUE
    // ============================================================
    return {
        initDatabase,
        initEncryption,
        getDB: () => db,
        getUseLocalStorage: () => useLocalStorage,
        setUseLocalStorage: (val) => { useLocalStorage = val; },
        getLS,
        setLS,
        removeLS,
        saveProject,
        loadProjects,
        deleteProjectCascade,
        loadEquipmentsForProject,
        saveEquipment,
        deleteEquipment,
        loadFieldMeasurementsForProject,
        loadFieldMeasurementsForAsset,
        saveFieldMeasurement,
        deleteFieldMeasurement,
        saveMapPoint,
        deleteMapPoint,
        loadMapPoints,
        saveHistory,
        loadHistory,
        saveGroundbedData,
        loadGroundbedData,
        saveInterferenceData,
        loadInterferenceData,
        invalidateCache,
        forceInvalidateCache,
        STORAGE_VERSION,
        CURRENT_SCHEMA_VERSION,
        // Exposé pour usage externe (cohérence avec migration)
        _normalizeEquipment: normalizeEquipment
    };
})();

// ============================================================
// FIN DE storage.js (VERSION 9.0 – P0-05 / P1-04 / P1-05 APPLIQUÉS)
// ============================================================