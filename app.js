// ============================================================
// app.js – CP Engineer Pro – Point d'entrée & initialisation
// Version applicative : définie par APP_CONFIG.VERSION (engine.js).
// Ce fichier ne déclare PAS de version globale concurrente.
//
// Corrections appliquées :
//   P1-04 : Anti-récursion renforcée
//     - SaveSystem._saveToken : identifiant unique par sauvegarde
//     - SaveSystem._recursionGuard : compteur de récursion active
//     - Tous les listeners vérifient DEUX conditions :
//         · _fromSave === true (émission storage-proxy.js)
//         · SaveSystem.isInternalSave() === true (sauvegarde en cours)
//     - beforeunload/pagehide : guard explicite contre les appels
//       pendant une sauvegarde déjà en cours
//     - setInterval périodique : guard isInternalSave() strict
//     - Listener storage : guard anti-récursion
//     - Cohérent avec storage-proxy.js v8.9
//
//   V10 (AUDIT SÉCURITÉ) : showLoginModal()
//     - Suppression des credentials par défaut pré-remplis
//       ("admin" / "admin123" pré-remplis, hint "Utilisateur par défaut")
//     - Ajout de autocomplete="username" / "current-password"
//     - Attribution d'un id="loginModalTitle" pour aria-labelledby
//     - Suppression du hint "Utilisateur par défaut : admin / admin123"
//     - Effacement du mot de passe après tentative
// ============================================================

// ============================================================
// P3-28 : Système de logging contrôlé
// ============================================================
const Logger = {
    _level: 'INFO',
    _levels: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NONE: 4 },

    setLevel: function(level) {
        if (this._levels[level] !== undefined) {
            this._level = level;
            localStorage.setItem('cp_log_level', level);
        }
    },

    getLevel: function() {
        return this._level;
    },

    debug: function(...args) {
        if (this._levels[this._level] <= this._levels.DEBUG) {
            console.log(...args);
        }
    },

    info: function(...args) {
        if (this._levels[this._level] <= this._levels.INFO) {
            console.info(...args);
        }
    },

    warn: function(...args) {
        if (this._levels[this._level] <= this._levels.WARN) {
            console.warn(...args);
        }
    },

    error: function(...args) {
        if (this._levels[this._level] <= this._levels.ERROR) {
            console.error(...args);
        }
    }
};

const savedLevel = localStorage.getItem('cp_log_level');
if (savedLevel && Logger._levels[savedLevel] !== undefined) {
    Logger._level = savedLevel;
} else if (window.location.search.includes('debug')) {
    Logger._level = 'DEBUG';
}

window.Logger = Logger;

// ============================================================
// Déclaration globale de _defaultsApplied
// ============================================================
window._defaultsApplied = false;

// ============================================================
// Définition de AppState
// ============================================================
const AppState = {
    currentLinkState: { current: false, surface: false, targetPot: false },
    gndLinkState: { resistivity: false, current: false },
    ifLinkState: { current: false, potential: false },
    surfaceSyncEnabled: true,
    editMode: false,
    editingEquipId: null,
    map: null
};
window.AppState = AppState;

// ============================================================
// SYSTÈME DE SAUVEGARDE ULTRA-ROBUSTE ET OPTIMISÉ
// Version 9.2 – P1-04 : Anti-récursion renforcée (token + guard)
// ============================================================

const SaveSystem = {
    _lastSaveTime: null,
    _isSaving: false,
    _saveTimeout: null,
    _isClosing: false,

    // ─── P1-04 : Compteur de profondeur de sauvegarde ───
    _internalSaveDepth: 0,

    // ─── P1-04 : Token unique par sauvegarde ───
    _currentSaveToken: null,
    _saveTokenCounter: 0,

    // ─── P1-04 : Guard anti-récursion explicite ───
    _recursionGuard: 0,

    /**
     * Démarre une sauvegarde interne.
     * Incrémente la profondeur et génère un token unique.
     * @returns {string} Le token associé
     */
    beginInternalSave: function() {
        this._internalSaveDepth++;
        this._saveTokenCounter++;
        this._currentSaveToken = 'app_save_' + Date.now() + '_' + this._saveTokenCounter;
        return this._currentSaveToken;
    },

    /**
     * Termine une sauvegarde interne.
     */
    endInternalSave: function() {
        this._internalSaveDepth = Math.max(0, this._internalSaveDepth - 1);
        if (this._internalSaveDepth === 0) {
            this._currentSaveToken = null;
        }
    },

    /**
     * Indique si une sauvegarde interne est en cours.
     * @returns {boolean}
     */
    isInternalSave: function() {
        return this._internalSaveDepth > 0 || this._isSaving;
    },

    /**
     * Renvoie le token courant (pour diagnostic).
     * @returns {string|null}
     */
    getCurrentSaveToken: function() {
        return this._currentSaveToken;
    },

    /**
     * Renvoie la profondeur actuelle (pour diagnostic).
     * @returns {number}
     */
    getSaveDepth: function() {
        return this._internalSaveDepth;
    },

    scheduleSave: function(immediate = false) {
        // ─── P1-04 : Guard anti-récursion ───
        if (this.isInternalSave()) {
            this._recursionGuard++;
            Logger.debug('[SaveSystem] scheduleSave ignoré (sauvegarde interne) — recursionGuard=' + this._recursionGuard);
            return;
        }
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }

        if (immediate) {
            this._performSave();
        } else {
            this._saveTimeout = setTimeout(() => {
                this._performSave();
            }, 2000);
        }
    },

    fullSave: function(showToast = true) {
        return this._performSave(showToast);
    },

    queueSave: function(showToast = false) {
        this.scheduleSave(false);
    },

    _performSave: async function(showToast = true) {
        if (this._isSaving) {
            this._recursionGuard++;
            if (showToast && window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('⏳ Sauvegarde déjà en cours...', 'info');
            }
            return;
        }

        this._isSaving = true;
        const saveToken = this.beginInternalSave();

        if (window.UI && typeof window.UI.updateSaveStatus === 'function') {
            window.UI.updateSaveStatus('saving', 'Sauvegarde en cours...');
        }

        try {
            Logger.info('[SaveSystem] Début sauvegarde... token=' + saveToken);

            if (typeof ProjectManager !== 'undefined') {
                await ProjectManager.saveCurrentProject();
                Logger.info('[SaveSystem] ✅ Projet sauvegardé');
            }

            if (typeof ProjectManager !== 'undefined') {
                const history = ProjectManager.getState().history;
                if (history && history.length > 0) {
                    await StorageManager.saveHistory(history);
                    Logger.info('[SaveSystem] ✅ Historique sauvegardé');
                }
            }

            if (typeof ProjectManager !== 'undefined') {
                const groundbed = ProjectManager.getState().groundbed?.results;
                if (groundbed) {
                    await StorageManager.saveGroundbedData(groundbed);
                    Logger.info('[SaveSystem] ✅ Groundbed sauvegardé');
                }
            }

            if (typeof ProjectManager !== 'undefined') {
                const interference = ProjectManager.getState().interference?.results;
                if (interference) {
                    await StorageManager.saveInterferenceData(interference);
                    Logger.info('[SaveSystem] ✅ Interférences sauvegardées');
                }
            }

            if (typeof ProjectManager !== 'undefined') {
                const equipments = ProjectManager.getState().equipments;
                for (const eq of equipments) {
                    await StorageManager.saveEquipment(eq);
                }
                Logger.info(`[SaveSystem] ✅ ${equipments.length} équipements sauvegardés`);
            }

            if (typeof ProjectManager !== 'undefined') {
                const state = ProjectManager.getState();
                const measurements = Array.isArray(state.fieldMeasurements) ? state.fieldMeasurements : [];
                for (const measurement of measurements) {
                    await StorageManager.saveFieldMeasurement(measurement);
                }
                const mapPoints = Array.isArray(state.mapPoints) ? state.mapPoints : [];
                for (const point of mapPoints) {
                    await StorageManager.saveMapPoint(point);
                }
                Logger.info(`[SaveSystem] ✅ ${measurements.length} mesures et ${mapPoints.length} points sauvegardés`);
            }

            await this._saveLocalStorage();

            const now = new Date();
            this._lastSaveTime = now;
            localStorage.setItem('cp_last_save_time', now.toISOString());

            if (window.UI && typeof window.UI.updateSaveStatus === 'function') {
                window.UI.updateSaveStatus('saved', `Sauvegardé à ${now.toLocaleTimeString()}`);
            }

            if (showToast && window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('✅ Sauvegarde réussie !', 'success');
            }

            Logger.info('[SaveSystem] Sauvegarde terminée avec succès');

        } catch (error) {
            Logger.error('[SaveSystem] Erreur de sauvegarde:', error);

            if (window.UI && typeof window.UI.updateSaveStatus === 'function') {
                window.UI.updateSaveStatus('error', 'Erreur de sauvegarde');
            }

            await this._emergencySaveOnly();

            if (showToast && window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('⚠️ Erreur de sauvegarde, mais une copie d\'urgence a été créée.', 'warning');
            }
        } finally {
            this.endInternalSave();
            this._isSaving = false;
            this._saveTimeout = null;
        }
    },

    _saveLocalStorage: async function() {
        try {
            if (typeof ProjectManager === 'undefined') return;
            const state = ProjectManager.getState();
            const projectId = ProjectManager.getCurrentProjectId();
            const backupData = {
                projectId: projectId,
                timestamp: Date.now(),
                version: typeof APP_CONFIG !== 'undefined' ? APP_CONFIG.VERSION : '9.6.0',
                state: Utils.deepClone(state),
                schemaVersion: (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.DATA_SCHEMA_VERSION)
                    ? APP_CONFIG.DATA_SCHEMA_VERSION
                    : 3
            };
            localStorage.setItem('cp_full_backup', JSON.stringify(backupData));
            if (projectId) {
                localStorage.setItem(`cp_project_backup_${projectId}`, JSON.stringify({
                    id: projectId,
                    data: state,
                    timestamp: Date.now()
                }));
            }
            Logger.info('[SaveSystem] ✅ localStorage sauvegardé');
        } catch (e) {
            Logger.warn('[SaveSystem] Erreur localStorage:', e);
            this._cleanLocalStorage();
        }
    },

    _emergencySaveOnly: async function() {
        try {
            if (typeof ProjectManager === 'undefined') return;
            const state = ProjectManager.getState();
            const projectId = ProjectManager.getCurrentProjectId();
            const emergencyData = {
                timestamp: Date.now(),
                state: Utils.deepClone(state),
                projectId: projectId,
                type: 'EMERGENCY_BACKUP'
            };
            localStorage.setItem('cp_emergency_last', JSON.stringify(emergencyData));
            try {
                document.cookie = `cp_emergency=${encodeURIComponent(JSON.stringify(emergencyData))}; path=/; max-age=86400`;
            } catch (e) {}
            Logger.info('[SaveSystem] ✅ Sauvegarde d\'urgence créée');
        } catch (e) {
            Logger.error('[SaveSystem] Échec total de la sauvegarde d\'urgence:', e);
        }
    },

    saveOnClose: async function() {
        if (this._isClosing) {
            Logger.info('[SaveSystem] Fermeture déjà en cours, ignorée');
            return;
        }

        if (this.isInternalSave()) {
            Logger.info('[SaveSystem] saveOnClose ignoré (sauvegarde interne en cours)');
            return;
        }

        this._isClosing = true;

        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }

        Logger.info('[SaveSystem] Sauvegarde avant fermeture...');

        try {
            await this._performSave(false);
            Logger.info('[SaveSystem] ✅ Sauvegarde fermeture réussie');
        } catch (error) {
            Logger.error('[SaveSystem] Échec sauvegarde fermeture, tentative d\'urgence...');
            await this._emergencySaveOnly();
            Logger.info('[SaveSystem] ✅ Sauvegarde d\'urgence créée pour la fermeture');
        } finally {
            this._isClosing = false;
        }
    },

    _cleanLocalStorage: function() {
        try {
            const keys = Object.keys(localStorage);
            const backupKeys = keys.filter(k => k.startsWith('cp_') && k.includes('backup'));
            if (backupKeys.length > 5) {
                backupKeys.sort();
                const toDelete = backupKeys.slice(0, backupKeys.length - 5);
                toDelete.forEach(key => localStorage.removeItem(key));
            }
        } catch (e) {}
    },

    restoreFromBackup: async function(backupData) {
        try {
            const restoredState = backupData && (backupData.state || backupData.data);
            if (!restoredState || typeof restoredState !== 'object') {
                throw new Error('Données de sauvegarde invalides');
            }
            if (typeof ProjectManager === 'undefined') {
                throw new Error('ProjectManager non disponible');
            }
            const state = ProjectManager.getState();
            Object.assign(state, restoredState);
            const restoredProjectId = backupData.projectId || (state.project && state.project.id);
            if (!restoredProjectId) {
                throw new Error('Identifiant du projet absent de la sauvegarde');
            }
            if (!state.project) state.project = {};
            state.project.id = restoredProjectId;
            if (typeof ProjectManager.normalizeCalculationState === 'function') {
                ProjectManager.normalizeCalculationState();
            }
            ProjectManager.setCurrentProjectId(restoredProjectId);
            localStorage.setItem('lastProjectId', restoredProjectId);
            await this._performSave(false);
            if (typeof StorageManager !== 'undefined') {
                StorageManager.invalidateCache(restoredProjectId);
            }
            if (typeof ProjectManager.loadProjectsList === 'function') {
                await ProjectManager.loadProjectsList();
            }
            if (typeof ProjectManager.getEquipmentsForCurrentProject === 'function') {
                await ProjectManager.getEquipmentsForCurrentProject(true);
            }
            if (window.UI) {
                const projectSelector = document.getElementById('projectSelector');
                if (typeof window.UI.populateProjectSelector === 'function') window.UI.populateProjectSelector();
                if (projectSelector) projectSelector.value = restoredProjectId;
                if (typeof window.UI.refreshEquipmentListUI === 'function') window.UI.refreshEquipmentListUI(true);
                if (typeof window.UI.updateDashboard === 'function') window.UI.updateDashboard();
            }
            document.dispatchEvent(new CustomEvent('projectLoaded', {
                detail: { projectId: restoredProjectId, source: 'backup-restore' }
            }));
            setTimeout(() => {
                const projectSelector = document.getElementById('projectSelector');
                if (projectSelector && projectSelector.querySelector(`option[value="${restoredProjectId}"]`)) {
                    projectSelector.value = restoredProjectId;
                }
            }, 350);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('✅ Données restaurées avec succès !', 'success');
            }
            return true;
        } catch (error) {
            Logger.error('[SaveSystem] Erreur de restauration:', error);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('❌ Erreur lors de la restauration', 'error');
            }
            return false;
        }
    },

    exportBackup: function() {
        try {
            if (typeof ProjectManager === 'undefined') {
                throw new Error('ProjectManager non disponible');
            }
            const state = ProjectManager.getState();
            const projectId = ProjectManager.getCurrentProjectId();
            const backup = {
                type: 'CP_ENGINEER_BACKUP',
                version: typeof APP_CONFIG !== 'undefined' ? APP_CONFIG.VERSION : '9.6.0',
                date: new Date().toISOString(),
                projectId: projectId,
                projectName: state.project?.name || 'Projet',
                data: Utils.deepClone(state)
            };
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cp_backup_${projectId}_${new Date().toISOString().slice(0,10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('✅ Sauvegarde exportée en fichier', 'success');
            }
        } catch (error) {
            Logger.error('[SaveSystem] Erreur export:', error);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('❌ Erreur lors de l\'export', 'error');
            }
        }
    },

    importBackup: async function(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.type !== 'CP_ENGINEER_BACKUP' && !data.data) {
                throw new Error('Format de fichier invalide');
            }
            const confirmed = confirm(
                `⚠️ Attention !\n\nCette opération va remplacer toutes les données actuelles.\n` +
                `Projet : ${data.projectName || 'N/A'}\nDate : ${data.date || 'N/A'}\nVersion : ${data.version || 'N/A'}\n\nContinuer ?`
            );
            if (confirmed) {
                await this.restoreFromBackup(data);
            }
        } catch (error) {
            Logger.error('[SaveSystem] Erreur import:', error);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('❌ Erreur lors de l\'import : ' + error.message, 'error');
            }
        }
    },

    getLastSaveTime: function() {
        const saved = localStorage.getItem('cp_last_save_time');
        return saved ? new Date(saved) : null;
    },

    healthCheck: function() {
        const checks = { indexedDB: false, localStorage: false, emergency: false };
        if (typeof StorageManager !== 'undefined' && StorageManager.getDB()) {
            checks.indexedDB = true;
        }
        try {
            if (localStorage.getItem('cp_full_backup')) checks.localStorage = true;
            if (localStorage.getItem('cp_emergency_last')) checks.emergency = true;
        } catch (e) {}
        return checks;
    }
};

window.SaveSystem = SaveSystem;

// ============================================================
// INSTALLATION DES ÉCOUTEURS OPTIMISÉS
// ============================================================

// ─── P1-04 : setInterval périodique protégé par isInternalSave ───
setInterval(() => {
    if (!document.hidden && !SaveSystem.isInternalSave()) {
        SaveSystem.scheduleSave(false);
    }
}, 30000);

// ─── P1-04 : equipmentUpdated → save immédiate sauf si interne ───
document.addEventListener('equipmentUpdated', function(e) {
    if (SaveSystem.isInternalSave()) {
        Logger.debug('[app.js] equipmentUpdated ignoré (sauvegarde interne)');
        return;
    }
    SaveSystem.scheduleSave(true);
});

// ─── P1-04 : calculationCompleted → save immédiate sauf si interne ───
document.addEventListener('calculationCompleted', function(e) {
    if (SaveSystem.isInternalSave()) return;
    SaveSystem.scheduleSave(true);
});

// ─── P1-04 : projectLoaded → save différée avec guard ───
document.addEventListener('projectLoaded', function(e) {
    setTimeout(() => {
        if (!SaveSystem.isInternalSave()) {
            SaveSystem.scheduleSave(true);
        } else {
            Logger.debug('[app.js] projectLoaded save ignorée (sauvegarde interne)');
        }
    }, 1000);
});

// ─── P1-04 : dataSynced → filtre strict à deux niveaux ───
document.addEventListener('dataSynced', function(e) {
    const detail = e.detail || {};

    // Filtre anti-récursion #1 : flag explicite
    if (detail._fromSave === true) {
        Logger.debug('[app.js] dataSynced ignoré (_fromSave=true)');
        return;
    }

    // Filtre anti-récursion #2 : sauvegarde en cours
    if (SaveSystem.isInternalSave()) {
        Logger.debug('[app.js] dataSynced ignoré (sauvegarde en cours)');
        return;
    }

    // Événement légitime → déclencher sauvegarde
    SaveSystem.scheduleSave(true);
});

// ─── P1-04 : beforeunload protégé ───
window.addEventListener('beforeunload', function(e) {
    if (SaveSystem._saveTimeout) {
        clearTimeout(SaveSystem._saveTimeout);
        SaveSystem._saveTimeout = null;
    }
    if (!SaveSystem.isInternalSave() && !SaveSystem._isClosing) {
        SaveSystem.saveOnClose();
    }
}, { passive: true });

// ─── P1-04 : pagehide protégé ───
window.addEventListener('pagehide', function() {
    if (!window._isClosing && !SaveSystem.isInternalSave() && !SaveSystem._isClosing) {
        window._isClosing = true;
        SaveSystem.saveOnClose();
    }
}, { passive: true });

// ─── P1-04 : unload → écriture d'urgence uniquement ───
window.addEventListener('unload', function() {
    try {
        if (typeof ProjectManager !== 'undefined') {
            const state = ProjectManager.getState();
            const projectId = ProjectManager.getCurrentProjectId();
            localStorage.setItem('cp_emergency_unload', JSON.stringify({
                projectId: projectId,
                timestamp: Date.now(),
                state: Utils.deepClone(state),
                type: 'UNLOAD'
            }));
        }
    } catch (err) {}
}, { passive: true });

// ============================================================
// autoRestoreOnLoad (protégé contre la récursion)
// ============================================================
async function autoRestoreOnLoad() {
    Logger.info('[SaveSystem] Vérification des sauvegardes...');

    const emergencyKeys = [
        { key: 'cp_emergency_before_close', label: 'avant fermeture' },
        { key: 'cp_emergency_pagehide', label: 'page cachée' },
        { key: 'cp_emergency_unload', label: 'déchargement' }
    ];

    for (const { key, label } of emergencyKeys) {
        const data = localStorage.getItem(key);
        if (!data) continue;

        try {
            const parsed = JSON.parse(data);
            const age = Date.now() - parsed.timestamp;

            if (age < 30000 && parsed.state && parsed.projectId) {
                if (typeof ProjectManager !== 'undefined') {
                    const currentState = ProjectManager.getState();
                    const currentProjectId = ProjectManager.getCurrentProjectId();

                    if (currentProjectId === parsed.projectId && currentState.equipments) {
                        const sameEquipmentCount =
                            currentState.equipments.length === (parsed.state.equipments || []).length;

                        if (sameEquipmentCount) {
                            Logger.info(`[SaveSystem] Sauvegarde ${label} identique aux données actuelles — suppression silencieuse.`);
                            localStorage.removeItem(key);
                            continue;
                        }
                    }
                }

                Logger.info(`[SaveSystem] Sauvegarde ${label} trouvée (${Math.round(age/1000)}s)`);
                const restore = confirm(
                    `⚠️ Une sauvegarde d'urgence (${label}) a été trouvée (${Math.round(age/1000)}s).\n\n` +
                    `Voulez-vous restaurer les données ?`
                );
                if (restore) {
                    await SaveSystem.restoreFromBackup(parsed);
                    localStorage.removeItem(key);
                    if (typeof cleanupDemoEquipments === 'function') cleanupDemoEquipments();
                    return;
                }
            }

            localStorage.removeItem(key);

        } catch (e) {
            localStorage.removeItem(key);
        }
    }

    Logger.info('[SaveSystem] Aucune sauvegarde d\'urgence critique trouvée.');
}

// ============================================================
// DÉMARRAGE AUTOMATIQUE DE LA 3D (PERMANENT)
// ============================================================

function start3DRenderLoop() {
    try {
        if (window.Gis3D && typeof window.Gis3D.startRenderLoop === 'function') {
            window.Gis3D.startRenderLoop();
            console.log('[3D] ✅ Boucle de rendu démarrée');
        }
    } catch (e) {
        console.warn('[3D] Erreur démarrage rendu:', e);
    }
}

function start3DSimulation() {
    try {
        if (window.Simulation3D && typeof window.Simulation3D.start === 'function') {
            if (window.Gis3D && typeof window.Gis3D.isReady === 'function' && !window.Gis3D.isReady()) {
                console.log('[3D] Gis3D non prêt, simulation différée...');
                setTimeout(start3DSimulation, 1000);
                return;
            }
            setTimeout(function() {
                window.Simulation3D.start();
                console.log('[3D] ✅ Simulation démarrée');
            }, 1000);
        }
    } catch (e) {
        console.warn('[3D] Erreur démarrage simulation:', e);
    }
}

function save3DState() {
    try {
        if (window.Gis3D && window.Gis3D.isReady()) {
            const camera = window.Gis3D.getCamera();
            const controls = window.Gis3D.getControls();
            if (camera && controls) {
                const state = {
                    camera: {
                        position: camera.position.toArray(),
                        target: controls.target.toArray()
                    },
                    timestamp: Date.now(),
                    projectId: ProjectManager.getCurrentProjectId()
                };
                localStorage.setItem('cp_3d_camera_state', JSON.stringify(state));
            }
        }
    } catch(e) {}
}

function restore3DState() {
    try {
        const saved = localStorage.getItem('cp_3d_camera_state');
        if (!saved) return false;
        const state = JSON.parse(saved);
        if (Date.now() - state.timestamp > 3600000) return false;

        if (window.Gis3D && window.Gis3D.isReady()) {
            const camera = window.Gis3D.getCamera();
            const controls = window.Gis3D.getControls();
            if (camera && controls) {
                camera.position.fromArray(state.camera.position);
                controls.target.fromArray(state.camera.target);
                controls.update();
                console.log('[3D] ✅ État de la caméra restauré');
                return true;
            }
        }
        return false;
    } catch(e) {
        return false;
    }
}

// Écouter les événements pour recharger la 3D
document.addEventListener('equipmentUpdated', function(e) {
    const module3d = document.getElementById('module-visualisation3d');
    if (module3d && module3d.classList.contains('active')) {
        console.log('[3D] Équipement mis à jour, rechargement...');
        setTimeout(function() {
            if (typeof Gis3D !== 'undefined' && Gis3D.isReady()) {
                const projectId = ProjectManager.getCurrentProjectId() || '__all__';
                Gis3D.loadData(projectId);
                start3DRenderLoop();
                setTimeout(start3DSimulation, 500);
            }
        }, 300);
    }
});

document.addEventListener('projectLoaded', function(e) {
    const module3d = document.getElementById('module-visualisation3d');
    if (module3d && module3d.classList.contains('active')) {
        console.log('[3D] Projet chargé, rechargement...');
        setTimeout(function() {
            if (typeof Gis3D !== 'undefined' && Gis3D.isReady()) {
                const projectId = e.detail?.projectId || ProjectManager.getCurrentProjectId() || '__all__';
                Gis3D.loadData(projectId);
                start3DRenderLoop();
                setTimeout(start3DSimulation, 500);
                setTimeout(restore3DState, 800);
            }
        }, 500);
    }
});

document.addEventListener('DOMContentLoaded', function() {
    document.addEventListener('moduleChanged', function(e) {
        if (e.detail?.moduleId === 'visualisation3d') {
            setTimeout(function() {
                start3DRenderLoop();
                start3DSimulation();
                setTimeout(restore3DState, 800);
            }, 500);
        }
    });

    const module3d = document.getElementById('module-visualisation3d');
    if (module3d && module3d.classList.contains('active')) {
        setTimeout(function() {
            start3DRenderLoop();
            start3DSimulation();
            setTimeout(restore3DState, 800);
        }, 1000);
    }
});

window.addEventListener('beforeunload', save3DState);

setInterval(function() {
    const module3d = document.getElementById('module-visualisation3d');
    if (module3d && module3d.classList.contains('active')) {
        save3DState();
    }
}, 10000);

document.addEventListener('gis3d:loaded', function() {
    setTimeout(function() {
        restore3DState();
    }, 500);
});

// Fonction de rechargement manuel UNIQUE (sans boucle)
let _lastRefresh3D = 0;
let _refresh3DTimeout = null;

window.refresh3D = function() {
    const now = Date.now();
    if (now - _lastRefresh3D < 1500) {
        console.log('[3D] ⏳ Rechargement trop rapide, attendre 1.5s');
        return;
    }
    _lastRefresh3D = now;

    if (_refresh3DTimeout) {
        clearTimeout(_refresh3DTimeout);
        _refresh3DTimeout = null;
    }

    _refresh3DTimeout = setTimeout(function() {
        console.log('[3D] 🔄 Rechargement manuel...');
        const module3d = document.getElementById('module-visualisation3d');
        if (module3d && module3d.classList.contains('active') && typeof Gis3D !== 'undefined') {
            const projectId = ProjectManager.getCurrentProjectId() || '__all__';
            Gis3D.loadData(projectId);
            start3DRenderLoop();
            setTimeout(start3DSimulation, 500);
            setTimeout(function() {
                restore3DState();
                console.log('[3D] ✅ Rechargement manuel terminé');
            }, 800);
        }
        _refresh3DTimeout = null;
    }, 300);
};

console.log('[3D] ✅ Initialisation automatique configurée');
console.log('[3D] 💡 Utilisez refresh3D() pour recharger manuellement');

// ============================================================
// Nettoyage sécurisé des équipements de démonstration
// ============================================================
const DEMO_PATTERNS = ['PIPELINE DEMO', 'ANODE WELL', 'RECTIFIER TR-001', 'TP-001'];

async function cleanupDemoEquipments() {
    const projectId = ProjectManager.getCurrentProjectId();
    if (!projectId) return;
    const state = ProjectManager.getState();
    const equipments = state.equipments.filter(eq => eq.projectId === projectId);

    const demoEquips = equipments.filter(eq =>
        eq.isDemo === true ||
        DEMO_PATTERNS.some(pattern => eq.tag && eq.tag.includes(pattern))
    );

    if (demoEquips.length === 0) return;
    Logger.info(`[App] Suppression de ${demoEquips.length} équipement(s) de démonstration.`);

    const hasLegacyPattern = demoEquips.some(eq => DEMO_PATTERNS.some(p => eq.tag && eq.tag.includes(p)));
    if (hasLegacyPattern) {
        const confirmDelete = confirm(
            `⚠️ Des équipements de démonstration (${demoEquips.map(eq => eq.tag).join(', ')}) vont être supprimés.\n` +
            `Voulez-vous continuer ?`
        );
        if (!confirmDelete) {
            Logger.info('[App] Nettoyage annulé par l\'utilisateur.');
            return;
        }
    }

    for (const eq of demoEquips) {
        try {
            await ProjectManager.deleteEquipment(eq.id);
            Logger.debug(`[App] Supprimé: ${eq.tag}`);
        } catch (err) {
            Logger.warn(`[App] Erreur suppression ${eq.tag}:`, err);
        }
    }

    const freshEquipments = await StorageManager.loadEquipmentsForProject(projectId, true);
    state.equipments = freshEquipments;
    await ProjectManager.saveCurrentProject();
    if (window.UI && typeof window.UI.showToast === 'function') {
        window.UI.showToast(`🧹 ${demoEquips.length} équipement(s) de démonstration nettoyés.`, 'info');
    }
    if (window.UI && typeof window.UI.refreshEquipmentListUI === 'function') {
        window.UI.refreshEquipmentListUI(true);
    }
    if (window.CPController && typeof window.CPController.updateDashboard === 'function') {
        window.CPController.updateDashboard();
    }
}

// ============================================================
// WORKER CP
// ============================================================

if (window.Worker) {
    try {
        const worker = new Worker('cp-worker.js');
        window.cpWorker = worker;
        Logger.info('Web Worker CP chargé avec succès');
        worker.onerror = function(e) {
            Logger.error('Erreur Worker:', e.message);
            window.cpWorker = null;
            if (window.CPController && typeof window.CPController.setWorker === 'function') {
                window.CPController.setWorker(null);
            }
        };
        if (window.CPController && typeof window.CPController.setWorker === 'function') {
            window.CPController.setWorker(worker);
        }
    } catch(e) {
        Logger.warn('Web Worker non disponible, utilisation du mode fallback:', e.message);
        window.cpWorker = null;
        if (window.CPController && typeof window.CPController.setWorker === 'function') {
            window.CPController.setWorker(null);
        }
    }
} else {
    Logger.warn('Web Workers non supportés par ce navigateur');
    window.cpWorker = null;
    if (window.CPController && typeof window.CPController.setWorker === 'function') {
        window.CPController.setWorker(null);
    }
}

// ============================================================
// OPTIM : Chargement asynchrone des modules lourds avec feedback
// ============================================================
const lazyModules = {
    gisIntegration: null,
    gis3d: null,
    simulation3d: null,
    loading: {
        gisIntegration: false,
        gis3d: false,
        simulation3d: false
    },
    status: {
        gisIntegration: 'idle',
        gis3d: 'idle',
        simulation3d: 'idle'
    }
};

function updateModuleStatus(moduleName, status, message) {
    lazyModules.status[moduleName] = status;
    if (window.UI && typeof window.UI.showToast === 'function') {
        const type = status === 'error' ? 'error' : (status === 'loading' ? 'info' : 'success');
        window.UI.showToast(message || `Module ${moduleName} : ${status}`, type);
    }
    document.dispatchEvent(new CustomEvent('moduleLoadStatus', {
        detail: { moduleName, status, message }
    }));
}

function loadScript(src, version) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const versionParam = version || Date.now().toString(36);
        script.src = src + '?v=' + versionParam;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Échec du chargement de ${src}`));
        document.head.appendChild(script);
    });
}

async function loadModule(moduleName) {
    if (lazyModules[moduleName]) {
        updateModuleStatus(moduleName, 'ready', `Module ${moduleName} déjà chargé.`);
        return;
    }
    if (lazyModules.loading[moduleName]) {
        return new Promise(resolve => {
            const check = () => {
                if (lazyModules[moduleName]) {
                    resolve();
                } else if (lazyModules.status[moduleName] === 'error') {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }

    lazyModules.loading[moduleName] = true;
    updateModuleStatus(moduleName, 'loading', `Chargement du module ${moduleName}...`);

    try {
        const version = APP_CONFIG ? APP_CONFIG.VERSION : '9.0';
        switch (moduleName) {
            case 'gisIntegration':
                await loadScript('gisIntegration.js', version || '8.23');
                lazyModules.gisIntegration = window.GisIntegration;
                break;
            case 'gis3d':
                await loadScript('gis3d.js', version);
                lazyModules.gis3d = window.Gis3D;
                break;
            case 'simulation3d':
                await loadScript('simulation3d.js', version);
                lazyModules.simulation3d = window.Simulation3D;
                break;
            default:
                throw new Error(`Module inconnu : ${moduleName}`);
        }
        lazyModules.loading[moduleName] = false;
        updateModuleStatus(moduleName, 'ready', `Module ${moduleName} chargé avec succès.`);
        Logger.info(`✅ Module ${moduleName} chargé avec succès`);
    } catch (err) {
        lazyModules.loading[moduleName] = false;
        updateModuleStatus(moduleName, 'error', `❌ Erreur chargement ${moduleName}: ${err.message}`);
        Logger.error(`❌ Erreur chargement module ${moduleName}:`, err);
        throw err;
    }
}

function runCalculation(type, params) {
    return new Promise((resolve, reject) => {
        const workerAvailable = window.cpWorker && typeof window.cpWorker.postMessage === 'function';
        if (workerAvailable) {
            const messageId = Utils.generateId();
            const timeoutId = setTimeout(() => {
                window.cpWorker.removeEventListener('message', messageHandler);
                Logger.warn(`[Worker] Timeout pour le calcul ${type}, basculement vers le Main Thread.`);
                try {
                    const fallbackResult = CalculationEngine[type](params);
                    resolve(fallbackResult);
                } catch (fallbackError) {
                    reject(new Error(`Worker timeout et fallback échoué: ${fallbackError.message}`));
                }
            }, 30000);
            const messageHandler = function(event) {
                const data = event.data;
                if (data.id === messageId) {
                    clearTimeout(timeoutId);
                    window.cpWorker.removeEventListener('message', messageHandler);
                    if (data.error) {
                        Logger.warn(`[Worker] Erreur pour ${type}: ${data.error}, basculement vers le Main Thread.`);
                        try {
                            const fallbackResult = CalculationEngine[type](params);
                            resolve(fallbackResult);
                        } catch (fallbackError) {
                            reject(new Error(`Worker error et fallback échoué: ${fallbackError.message}`));
                        }
                    } else {
                        resolve(data.result);
                    }
                }
            };
            window.cpWorker.addEventListener('message', messageHandler);
            try {
                window.cpWorker.postMessage({
                    id: messageId,
                    type: type,
                    params: params,
                    appVersion: (typeof APP_CONFIG !== 'undefined') ? APP_CONFIG.VERSION : '9.6.0'
                });
            } catch (error) {
                clearTimeout(timeoutId);
                window.cpWorker.removeEventListener('message', messageHandler);
                Logger.warn(`[Worker] Échec d'envoi pour ${type}: ${error.message}, basculement vers le Main Thread.`);
                try {
                    const fallbackResult = CalculationEngine[type](params);
                    resolve(fallbackResult);
                } catch (fallbackError) {
                    reject(new Error(`Worker send error et fallback échoué: ${fallbackError.message}`));
                }
            }
        } else {
            Logger.info(`[runCalculation] Worker non disponible, fallback direct pour ${type}.`);
            try {
                const fallbackResult = CalculationEngine[type](params);
                resolve(fallbackResult);
            } catch (fallbackError) {
                reject(new Error(`Fallback direct échoué: ${fallbackError.message}`));
            }
        }
    });
}

// ============================================================
// P3-31 : Classification des erreurs pour unhandledrejection
// ============================================================
const ERROR_TYPES = {
    CALCULATION: 'CALCULATION_ERROR',
    LOAD: 'LOAD_ERROR',
    STORAGE: 'STORAGE_ERROR',
    WORKER: 'WORKER_ERROR',
    PDF: 'PDF_ERROR',
    GIS: 'GIS_ERROR',
    NETWORK: 'NETWORK_ERROR',
    VALIDATION: 'VALIDATION_ERROR',
    UNKNOWN: 'UNKNOWN_ERROR'
};

function classifyError(error) {
    if (!error) return ERROR_TYPES.UNKNOWN;
    const message = error.message || String(error);
    if (message.includes('calcul') || message.includes('calculation')) return ERROR_TYPES.CALCULATION;
    if (message.includes('load') || message.includes('chargement')) return ERROR_TYPES.LOAD;
    if (message.includes('storage') || message.includes('IndexedDB') || message.includes('localStorage')) return ERROR_TYPES.STORAGE;
    if (message.includes('worker') || message.includes('Worker')) return ERROR_TYPES.WORKER;
    if (message.includes('pdf') || message.includes('PDF') || message.includes('jspdf')) return ERROR_TYPES.PDF;
    if (message.includes('gis') || message.includes('map') || message.includes('Leaflet')) return ERROR_TYPES.GIS;
    if (message.includes('network') || message.includes('fetch')) return ERROR_TYPES.NETWORK;
    if (message.includes('validation') || message.includes('validate')) return ERROR_TYPES.VALIDATION;
    return ERROR_TYPES.UNKNOWN;
}

// ============================================================
// GESTION DE L'AUTHENTIFICATION — V10 : retrait creds par défaut
// ============================================================

/**
 * V10 : Modal de login sécurisé.
 *
 * CORRECTIONS APPLIQUÉES (AUDIT SÉCURITÉ) :
 *   ❌ SUPPRIMÉ : value="admin" sur #loginUsername
 *   ❌ SUPPRIMÉ : value="admin123" sur #loginPassword
 *   ❌ SUPPRIMÉ : hint "Utilisateur par défaut : admin / admin123"
 *   ✅ AJOUTÉ   : autocomplete="username" / "current-password"
 *   ✅ AJOUTÉ   : attributs required + aria-required
 *   ✅ AJOUTÉ   : effacement du mot de passe après tentative
 *   ✅ AJOUTÉ   : focus initial sur username (accessibilité)
 *
 * Compatible V04 (HttpOnly Cookie) :
 *   - En cas de succès, StorageManager.login() gère le cookie + CSRF
 *   - Cette fonction ne manipule JAMAIS directement le token
 */
function showLoginModal() {
    return new Promise((resolve) => {
        let modal = document.getElementById('loginModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'loginModal';
            modal.className = 'modal';
            modal.style.display = 'flex';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'loginModalTitle');

            // ============================================================
            // V10 : Champs SANS valeur par défaut
            // ------------------------------------------------------------
            // ⚠️ INTERDIT : value="admin" / value="admin123" (credentials
            //    par défaut facilitant le credential stuffing).
            // ⚠️ INTERDIT : hint textuel révélant les identifiants.
            // ============================================================
            modal.innerHTML = `
                <div class="modal-content" style="max-width: 400px;">
                    <h3 id="loginModalTitle"><i class="fas fa-lock" aria-hidden="true"></i> Connexion au serveur</h3>
                    <p style="color:var(--text-secondary); margin-bottom: 1rem;">
                        Veuillez vous authentifier pour accéder aux données du serveur.
                    </p>
                    <div class="form-group">
                        <label for="loginUsername">Nom d'utilisateur</label>
                        <input type="text"
                               id="loginUsername"
                               placeholder="Nom d'utilisateur"
                               autocomplete="username"
                               autocapitalize="off"
                               autocorrect="off"
                               spellcheck="false"
                               required
                               aria-required="true">
                    </div>
                    <div class="form-group">
                        <label for="loginPassword">Mot de passe</label>
                        <input type="password"
                               id="loginPassword"
                               placeholder="Mot de passe"
                               autocomplete="current-password"
                               required
                               aria-required="true">
                    </div>
                    <div id="loginError"
                         style="color:var(--accent-red); font-size:0.85rem; margin-top:0.5rem; display:none;"
                         role="alert"
                         aria-live="assertive"></div>
                    <div class="btn-group" style="margin-top: 1rem;">
                        <button id="loginSubmitBtn" class="btn btn-primary touch-target">
                            <i class="fas fa-sign-in-alt" aria-hidden="true"></i> Se connecter
                        </button>
                        <button id="loginOfflineBtn" class="btn btn-secondary touch-target">
                            Mode hors ligne
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const submitBtn = document.getElementById('loginSubmitBtn');
            const offlineBtn = document.getElementById('loginOfflineBtn');
            const usernameInput = document.getElementById('loginUsername');
            const passwordInput = document.getElementById('loginPassword');
            const errorEl = document.getElementById('loginError');

            const doLogin = async () => {
                const username = usernameInput.value.trim();
                const password = passwordInput.value;

                if (!username || !password) {
                    errorEl.textContent = 'Veuillez saisir un nom d\'utilisateur et un mot de passe.';
                    errorEl.style.display = 'block';
                    return;
                }
                errorEl.style.display = 'none';
                errorEl.textContent = '';
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Connexion...';

                try {
                    // StorageManager.login() gère :
                    //   - le mode HttpOnly (cookie + CSRF)
                    //   - le mode legacy (JWT localStorage)
                    await StorageManager.login(username, password);

                    // Effacer les champs sensibles du DOM dès que possible
                    passwordInput.value = '';

                    modal.style.display = 'none';
                    resolve(true);
                } catch (err) {
                    // V12 : message uniforme (pas de fuite d'info)
                    errorEl.textContent = err.message || 'Erreur de connexion. Vérifiez vos identifiants.';
                    errorEl.style.display = 'block';
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fas fa-sign-in-alt" aria-hidden="true"></i> Se connecter';
                    passwordInput.focus();
                }
            };

            submitBtn.addEventListener('click', doLogin);
            usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
            passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

            offlineBtn.addEventListener('click', () => {
                modal.style.display = 'none';
                // Effacer tout mot de passe saisi
                passwordInput.value = '';
                resolve(false);
            });

            // Focus initial (accessibilité)
            setTimeout(() => usernameInput.focus(), 100);
        } else {
            modal.style.display = 'flex';
            const errorEl = document.getElementById('loginError');
            if (errorEl) {
                errorEl.style.display = 'none';
                errorEl.textContent = '';
            }
            // Effacer tout mot de passe résiduel du DOM
            const pw = document.getElementById('loginPassword');
            if (pw) pw.value = '';
            const un = document.getElementById('loginUsername');
            if (un) setTimeout(() => un.focus(), 100);
        }
    });
}

async function ensureAuthentication() {
    if (StorageManager.isAuthenticated && StorageManager.isAuthenticated()) {
        Logger.info('[App] Utilisateur déjà authentifié.');
        return true;
    }
    // Legacy : vérification token (non-HttpOnly uniquement)
    if (!StorageManager.usesHttpOnlyCookie ||
        !StorageManager.usesHttpOnlyCookie()) {
        if (StorageManager.getToken && StorageManager.getToken()) {
            Logger.info('[App] Token récupéré depuis le stockage.');
            return true;
        }
    }
    Logger.info('[App] Aucune session trouvée, demande de login.');
    const authenticated = await showLoginModal();
    if (authenticated) {
        Logger.info('[App] Authentification réussie.');
        return true;
    } else {
        Logger.info('[App] Mode hors ligne sélectionné.');
        return false;
    }
}

// ============================================================
// ÉVÉNEMENT CENTRALISÉ POUR LA 3D
// ============================================================
document.addEventListener('refreshGIS3D', function() {
    try {
        if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
            if (window.Gis3D.isReady && window.Gis3D.isReady()) {
                window.Gis3D.loadData();
            } else if (window.Gis3D.whenReady) {
                window.Gis3D.whenReady().then(() => {
                    window.Gis3D.loadData();
                }).catch(() => {});
            } else {
                window.Gis3D.loadData();
            }
        }
    } catch (e) {
        console.warn('[App] Erreur refreshGIS3D:', e);
    }
});

// ============================================================
// PARTIE 2/2 — INITIALISATION PRINCIPALE
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (typeof GeoUtils === 'undefined') {
            Logger.warn('GeoUtils non défini, utilisation d\'un fallback');
            window.GeoUtils = {
                getReference: function() { return { lat: 30.123456, lon: 8.123456 }; },
                formatCoord: function(val, decimals) {
                    if (val === undefined || val === null || typeof val !== 'number' || isNaN(val)) return '?';
                    return val.toFixed(decimals || 6);
                }
            };
        }

        // ============================================================
        // BOUTON ENREGISTRER TOUT
        // ============================================================
        function setupSaveAllButton() {
            try {
                const saveBtn = document.getElementById('saveAllBtn');
                if (!saveBtn) return;
                const indicator = document.getElementById('saveAllIndicator');
                if (!indicator) return;
                let isSaving = false;

                function updateSaveAllButtonState(status, message) {
                    saveBtn.classList.remove('saving');
                    indicator.className = '';

                    switch(status) {
                        case 'saving':
                            indicator.className = 'saving';
                            saveBtn.classList.add('saving');
                            saveBtn.innerHTML = `
                                <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>
                                <span style="font-weight:600;">Enregistrement...</span>
                                <span class="save-indicator-mini saving"></span>
                            `;
                            break;
                        case 'saved':
                            indicator.className = 'saved';
                            saveBtn.innerHTML = `
                                <i class="fas fa-check-circle" aria-hidden="true"></i>
                                <span style="font-weight:600;">Enregistré</span>
                                <span class="save-success-text show">✓</span>
                                <span class="save-indicator-mini saved"></span>
                            `;
                            if (window.UI && typeof UI.showToast === 'function') {
                                UI.showToast('✅ Toutes les données ont été enregistrées avec succès !', 'success');
                            }
                            setTimeout(() => {
                                if (saveBtn && !isSaving) {
                                    saveBtn.innerHTML = `
                                        <i class="fas fa-save" aria-hidden="true"></i>
                                        <span style="font-weight:600;">Enregistrer</span>
                                        <span class="save-indicator-mini saved"></span>
                                    `;
                                }
                            }, 2000);
                            break;
                        case 'error':
                            indicator.className = 'error';
                            saveBtn.innerHTML = `
                                <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
                                <span style="font-weight:600;">Erreur</span>
                                <span class="save-indicator-mini error"></span>
                            `;
                            if (window.UI && typeof UI.showToast === 'function') {
                                UI.showToast('❌ Erreur lors de l\'enregistrement !', 'error');
                            }
                            setTimeout(() => {
                                if (saveBtn && !isSaving) {
                                    saveBtn.innerHTML = `
                                        <i class="fas fa-save" aria-hidden="true"></i>
                                        <span style="font-weight:600;">Enregistrer</span>
                                        <span class="save-indicator-mini saved"></span>
                                    `;
                                    indicator.className = 'saved';
                                }
                            }, 3000);
                            break;
                        default:
                            indicator.className = 'saved';
                            saveBtn.classList.remove('saving');
                    }
                }

                async function performFullSave() {
                    if (isSaving) {
                        if (window.UI && typeof UI.showToast === 'function') {
                            UI.showToast('⏳ Enregistrement déjà en cours...', 'info');
                        }
                        return;
                    }
                    isSaving = true;
                    try {
                        updateSaveAllButtonState('saving');

                        if (typeof ProjectManager !== 'undefined') {
                            await ProjectManager.saveCurrentProject();
                            Logger.info('[SaveAll] Projet sauvegardé');
                        }
                        if (typeof SaveSystem !== 'undefined') {
                            await SaveSystem.fullSave(false);
                            Logger.info('[SaveAll] Sauvegarde système complète');
                        }
                        if (typeof SaveSystem !== 'undefined' && typeof ProjectManager !== 'undefined') {
                            const state = ProjectManager.getState();
                            const projectId = ProjectManager.getCurrentProjectId();
                            localStorage.setItem('cp_emergency_manual', JSON.stringify({
                                projectId: projectId,
                                timestamp: Date.now(),
                                state: Utils.deepClone(state),
                                type: 'MANUAL_SAVE'
                            }));
                            Logger.info('[SaveAll] Sauvegarde d\'urgence manuelle');
                        }
                        if (typeof StorageManager !== 'undefined' && typeof ProjectManager !== 'undefined') {
                            StorageManager.invalidateCache(ProjectManager.getCurrentProjectId());
                            const freshEquipments = await StorageManager.loadEquipmentsForProject(
                                ProjectManager.getCurrentProjectId(),
                                true
                            );
                            if (freshEquipments) {
                                ProjectManager.getState().equipments = freshEquipments;
                                Logger.info(`[SaveAll] ${freshEquipments.length} équipements rechargés et vérifiés`);
                            }
                        }
                        if (typeof UI !== 'undefined') {
                            if (UI.refreshEquipmentListUI) UI.refreshEquipmentListUI(true);
                            if (UI.updateDashboard) UI.updateDashboard();
                            if (UI.renderSystems) UI.renderSystems();
                            if (UI.populateAllSystemSelectors) UI.populateAllSystemSelectors();
                            Logger.info('[SaveAll] Interface mise à jour');
                        }
                        updateSaveAllButtonState('saved');
                        document.dispatchEvent(new CustomEvent('manualSaveCompleted', {
                            detail: { timestamp: Date.now(), projectId: ProjectManager.getCurrentProjectId() }
                        }));
                    } catch (error) {
                        Logger.error('[SaveAll] Erreur lors de l\'enregistrement complet:', error);
                        updateSaveAllButtonState('error');
                        try {
                            if (typeof SaveSystem !== 'undefined') {
                                await SaveSystem._emergencySaveOnly();
                                Logger.info('[SaveAll] Sauvegarde d\'urgence de récupération effectuée');
                            }
                        } catch (e) {
                            Logger.error('[SaveAll] Échec de la sauvegarde d\'urgence:', e);
                        }
                    } finally {
                        isSaving = false;
                    }
                }

                saveBtn.addEventListener('click', performFullSave);
                document.addEventListener('keydown', function(e) {
                    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 's' || e.key === 'S')) {
                        e.preventDefault();
                        performFullSave();
                    }
                });
                window.addEventListener('beforeunload', function() {
                    if (!isSaving) {
                        performFullSave().catch(() => {});
                    }
                }, { passive: true });
                Logger.info('[SaveAll] Bouton "Enregistrer tout" initialisé avec succès');
            } catch (e) {
                Logger.warn('[SaveAll] Erreur setupSaveAllButton:', e);
            }
        }

        // ============================================================
        // ATTENTE DE UI AVEC TIMEOUT ROBUSTE
        // ============================================================
        let attempts = 0;
        const maxAttempts = 100;
        let uiReady = false;
        let cpControllerReady = false;

        while (attempts < maxAttempts) {
            if (typeof UI !== 'undefined' && UI && typeof UI.init === 'function') {
                uiReady = true;
                Logger.info('[App] UI détecté à la tentative ' + (attempts + 1));
            }
            if (typeof CPController !== 'undefined' && CPController && typeof CPController.updateDashboard === 'function') {
                cpControllerReady = true;
                Logger.info('[App] CPController détecté à la tentative ' + (attempts + 1));
            }
            if (uiReady && cpControllerReady) break;
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        if (typeof UI === 'undefined' || !UI || typeof UI.init !== 'function') {
            Logger.warn('[App] UI non détecté après timeout, tentative de récupération...');
            await new Promise(r => setTimeout(r, 500));
            if (typeof window.UI !== 'undefined' && window.UI && typeof window.UI.init === 'function') {
                Logger.info('[App] UI récupéré depuis window.UI après délai supplémentaire');
                try {
                    await window.UI.init();
                    Logger.info('[App] UI initialisé avec succès après récupération');
                } catch (e) {
                    Logger.error('[App] Erreur lors de l\'initialisation de UI après récupération:', e);
                }
            } else {
                Logger.error('[App] UI non chargé après timeout ! Création d\'un fallback minimal.');
                if (typeof window.UI === 'undefined') {
                    const _uiMethods = [
                        'refreshEquipmentListUI','updateDashboard','renderSystems','populateAllSystemSelectors',
                        'populateProjectSelector','loadProjectParams','applyIlliziDefaults','initDashboardCharts',
                        'refreshEquipmentList','refreshFieldMeasurementsTable','refreshAssetDropdownForFieldMeas',
                        'updateCorrosivity','populateGroundbedProjectSelect','populateInterferenceProjectSelect',
                        'populatePipelineSelects','refreshHistoryTable','loadHistory','drawGroundbedVisual',
                        'updateEquipTypeOptions','updateEquipDimensionsFields','computeEquipSurface','updateDimensionsFields',
                        'autoFillFromEnvironment','setModulesActivation','updateDashboardChartsData','updatePotentialChart',
                        'renderReinforcementZones','renderGroundbedList','populateICCPGroundbedSelectors','openGroundbedForm',
                        'populateResistiveParams','applyResistiveModel','syncSharedParams','validateSystem','updateDerivedFields',
                        'toggleSharedLock','exportGlobalReport','exportGroundbedPDF','exportInterferencePDF',
                        'displayCPResults','displayAnodeResults','displayICCPResults','displayGroundbedResults',
                        'displayInterferenceResults','displayRectifierResults','refreshMapPointsTable',
                        'populateVis3dSystemSelector','renderDynamicEquipmentList','generateSoilFromResistivity',
                        'generateWaterFromEnvironment','syncAllEquipmentToGIS','syncAllEquipmentTo3D',
                        'syncEquipmentToGIS','syncEquipmentTo3D','calculateCableSection','applyCableToICCP',
                        'linkCableCurrentToICCP','generateTestPosts','exportPostsPDF','exportPostsCSV',
                        'suggestStandards','autoDetectZones','setFieldSource','updateSyncBadges'
                    ];
                    const _uiFallback = {
                        init: function() { return Promise.resolve(); },
                        showToast: function(msg, type) { console.log('[UI Fallback]', msg, type); },
                        updateSaveStatus: function(status, message) { console.log('[SaveStatus]', status, message); },
                        getDomElement: function(id) { return document.getElementById(id); },
                        getFieldValue: function(selectId, manualId) {
                            const select = document.getElementById(selectId);
                            if (!select) return 0;
                            if (select.value === 'manual') {
                                const manual = document.getElementById(manualId);
                                return parseFloat(manual?.value) || 0;
                            }
                            return parseFloat(select.value) || 0;
                        }
                    };
                    _uiMethods.forEach(m => { _uiFallback[m] = function() {}; });
                    window.UI = _uiFallback;
                    Logger.info('[App] UI fallback créé (' + _uiMethods.length + ' méthodes)');
                    uiReady = true;
                }
            }
        }

        setupSaveAllButton();

        let projectLoadedTimeout = null;
        document.addEventListener('projectLoaded', function(e) {
            clearTimeout(projectLoadedTimeout);
            projectLoadedTimeout = setTimeout(async () => {
                try {
                    const projectId = e.detail?.projectId || ProjectManager.getCurrentProjectId();
                    if (!projectId) return;
                    if (typeof UI.applyIlliziDefaults === 'function' && !window._defaultsApplied) {
                        UI.applyIlliziDefaults();
                        window._defaultsApplied = true;
                        Logger.info('✅ applyIlliziDefaults appelé depuis projectLoaded');
                    }
                    if (typeof UI.loadProjectParams === 'function') UI.loadProjectParams();
                    if (typeof CPController.syncSurfaceFromEquipments === 'function') {
                        CPController.syncSurfaceFromEquipments();
                    }
                    await cleanupDemoEquipments();
                    if (lazyModules.gisIntegration) {
                        const existingMap = lazyModules.gisIntegration.getMap();
                        if (!existingMap) lazyModules.gisIntegration.init('mapContainer');
                        lazyModules.gisIntegration.loadPoints(projectId);
                    }
                    document.dispatchEvent(new CustomEvent('refreshGIS3D'));
                    if (lazyModules.simulation3d && lazyModules.simulation3d.isRunning) {
                        lazyModules.simulation3d.reload();
                    }
                    if (typeof CPController.updateDashboard === 'function') {
                        CPController.updateDashboard();
                    }
                    if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                        if (window.Gis3D.isReady && window.Gis3D.isReady()) {
                            const sysId = document.getElementById('vis3dSystemSelector')?.value;
                            if (typeof window.Gis3D.setSystemFilter === 'function') {
                                window.Gis3D.setSystemFilter(sysId || null);
                            }
                            window.Gis3D.loadData();
                            Logger.info('[App] Gis3D rechargé après projectLoaded');
                        }
                    }
                    window._last3DProjectId = projectId;
                } catch (err) {
                    Logger.warn('[App] Erreur dans projectLoaded:', err);
                }
            }, 300);
        });

        const idleInit = (fn) => {
            if (window.requestIdleCallback) {
                requestIdleCallback(fn, { timeout: 2000 });
            } else {
                setTimeout(fn, 100);
            }
        };

        await UI.init();
        Logger.info('✅ UI initialisée');

        if (window.TransformerRectifierEngine &&
            typeof window.TransformerRectifierEngine.loadCatalog === 'function') {
            window.TransformerRectifierEngine.loadCatalog('transformers_rectifiers.json')
                .then(catalog => Logger.info('[TR] Catalogue chargé:', catalog.items.length, 'fiches'))
                .catch(err => Logger.warn('[TR] Catalogue non chargé:', err.message));
        }

        const projectId = ProjectManager.getCurrentProjectId();
        if (!projectId) {
            const projects = ProjectManager.getProjectsList();
            if (projects.length > 0) {
                await ProjectManager.loadProject(projects[0].id);
                Logger.info('✅ Projet chargé automatiquement:', projects[0].id);
                if (typeof UI.loadProjectParams === 'function') UI.loadProjectParams();
                if (typeof CPController.syncSurfaceFromEquipments === 'function') {
                    CPController.syncSurfaceFromEquipments();
                }
                await cleanupDemoEquipments();
                if (typeof UI.applyIlliziDefaults === 'function' && !window._defaultsApplied) {
                    UI.applyIlliziDefaults();
                    window._defaultsApplied = true;
                }
            }
        } else {
            if (typeof UI.loadProjectParams === 'function') UI.loadProjectParams();
            await cleanupDemoEquipments();
            if (typeof UI.applyIlliziDefaults === 'function' && !window._defaultsApplied) {
                UI.applyIlliziDefaults();
                window._defaultsApplied = true;
            }
        }

        // ============================================================
        // SYNCHRONISATION AU CHARGEMENT
        // ============================================================
        setTimeout(async () => {
            try {
                const currentProjectId = ProjectManager.getCurrentProjectId();
                if (currentProjectId) {
                    const freshEquipments = await StorageManager.loadEquipmentsForProject(currentProjectId);
                    if (freshEquipments && freshEquipments.length >= 0) {
                        ProjectManager.getState().equipments = freshEquipments;
                        Logger.info(`[App] Équipements synchronisés depuis IndexedDB: ${freshEquipments.length}`);
                    }
                    if (window.UI && typeof window.UI.refreshEquipmentListUI === 'function') {
                        window.UI.refreshEquipmentListUI(true);
                    }
                    if (window.CPController && typeof window.CPController.updateDashboard === 'function') {
                        window.CPController.updateDashboard();
                    }
                    if (window.UI && typeof window.UI.populateProjectSelector === 'function') {
                        window.UI.populateProjectSelector();
                    }
                }
            } catch (err) {
                Logger.warn('[App] Erreur synchronisation au chargement:', err);
            }
        }, 800);

        let syncAttempts = 0;
        const maxSyncAttempts = 6;
        const syncInterval = setInterval(async () => {
            syncAttempts++;
            try {
                const currentProjectId = ProjectManager.getCurrentProjectId();
                if (currentProjectId) {
                    const freshEquipments = await StorageManager.loadEquipmentsForProject(currentProjectId);
                    if (freshEquipments && freshEquipments.length >= 0) {
                        const currentEquipments = ProjectManager.getState().equipments;
                        if (currentEquipments.length !== freshEquipments.length) {
                            ProjectManager.getState().equipments = freshEquipments;
                            Logger.info(`[App] Synchronisation périodique: ${freshEquipments.length} équipements`);
                            if (window.UI && typeof window.UI.refreshEquipmentListUI === 'function') {
                                window.UI.refreshEquipmentListUI(true);
                            }
                        }
                    }
                }
            } catch (err) {
                Logger.warn('[App] Erreur synchronisation périodique:', err);
            }
            if (syncAttempts >= maxSyncAttempts) {
                clearInterval(syncInterval);
                Logger.info('[App] Synchronisation périodique terminée');
            }
        }, 10000);

        setTimeout(async () => {
            try {
                const currentProjectId = ProjectManager.getCurrentProjectId();
                if (currentProjectId) {
                    const freshEquipments = await StorageManager.loadEquipmentsForProject(currentProjectId);
                    if (freshEquipments && freshEquipments.length > 0) {
                        ProjectManager.getState().equipments = freshEquipments;
                        Logger.info('[App] Données rechargées depuis IndexedDB après initialisation');
                        await cleanupDemoEquipments();
                    }
                }
            } catch (err) {
                Logger.warn('[App] Erreur lors du rechargement des données:', err);
            }
        }, 1000);

        setTimeout(() => {
            try {
                const activeProjectId = ProjectManager.getCurrentProjectId();
                if (!activeProjectId) return;
                const mapModule = document.getElementById('module-cartography');
                if (mapModule && mapModule.classList.contains('active') && lazyModules.gisIntegration) {
                    const existingMap = lazyModules.gisIntegration.getMap();
                    if (!existingMap) lazyModules.gisIntegration.init('mapContainer');
                    lazyModules.gisIntegration.loadPoints(activeProjectId);
                }
                const viz3dModule = document.getElementById('module-visualisation3d');
                if (viz3dModule && viz3dModule.classList.contains('active')) {
                    document.dispatchEvent(new CustomEvent('refreshGIS3D'));
                }
            } catch (err) {
                Logger.warn('[App] Erreur setTimeout initial:', err);
            }
        }, 800);

        document.querySelectorAll('.nav-item[data-module]').forEach(item => {
            item.addEventListener('click', async function(e) {
                try {
                    const moduleId = this.dataset.module;
                    if (moduleId === 'cartography') {
                        if (!lazyModules.gisIntegration) {
                            try { await loadModule('gisIntegration'); }
                            catch (err) {
                                Logger.error('Erreur chargement cartographie:', err);
                                if (window.UI) window.UI.showToast('Erreur chargement de la cartographie', 'error');
                                return;
                            }
                        }
                        setTimeout(() => {
                            const projectId = ProjectManager.getCurrentProjectId();
                            if (projectId && lazyModules.gisIntegration) {
                                const existingMap = lazyModules.gisIntegration.getMap();
                                if (!existingMap) lazyModules.gisIntegration.init('mapContainer');
                                lazyModules.gisIntegration.loadPoints(projectId);
                            }
                        }, 200);
                    } else if (moduleId === 'visualisation3d') {
                        if (!lazyModules.gis3d || !lazyModules.simulation3d) {
                            try {
                                await Promise.all([loadModule('gis3d'), loadModule('simulation3d')]);
                            } catch (err) {
                                Logger.error('Erreur chargement 3D:', err);
                                if (window.UI) window.UI.showToast('❌ Erreur chargement de la visualisation 3D', 'error');
                                return;
                            }
                        }
                        if (window.Gis3D && typeof window.Gis3D.whenReady === 'function') {
                            window.Gis3D.whenReady().then(() => {
                                const projectId = ProjectManager.getCurrentProjectId();
                                if (projectId) {
                                    document.dispatchEvent(new CustomEvent('refreshGIS3D'));
                                    if (lazyModules.simulation3d && typeof lazyModules.simulation3d.reload === 'function') {
                                        lazyModules.simulation3d.reload();
                                    }
                                }
                            }).catch(() => {});
                        } else {
                            setTimeout(() => {
                                const projectId = ProjectManager.getCurrentProjectId();
                                if (projectId && lazyModules.gis3d) {
                                    if (typeof lazyModules.gis3d.init === 'function') lazyModules.gis3d.init();
                                    document.dispatchEvent(new CustomEvent('refreshGIS3D'));
                                    if (lazyModules.simulation3d && typeof lazyModules.simulation3d.reload === 'function') {
                                        lazyModules.simulation3d.reload();
                                    }
                                }
                            }, 300);
                        }
                    }
                } catch (err) {
                    Logger.warn('[App] Erreur click nav-item:', err);
                }
            });
        });

        document.addEventListener('equipmentUpdated', function(e) {
            try {
                const module3d = document.getElementById('module-visualisation3d');
                if (module3d && module3d.classList.contains('active') && lazyModules.gis3d) {
                    Logger.info('[app.js] equipmentUpdated détecté, rechargement 3D');
                    document.dispatchEvent(new CustomEvent('refreshGIS3D'));
                }
            } catch (err) {
                Logger.warn('[App] Erreur equipmentUpdated:', err);
            }
        });

        // ============================================================
        // ÉVÉNEMENTS DE SAUVEGARDE
        // ============================================================
        setTimeout(autoRestoreOnLoad, 1500);

        const saveBtn = document.getElementById('saveNowBtn');
        if (saveBtn) saveBtn.addEventListener('click', function() { SaveSystem.fullSave(true); });

        const fullSaveBtn = document.getElementById('forceSaveAllBtn');
        if (fullSaveBtn) fullSaveBtn.addEventListener('click', function() { SaveSystem.fullSave(true); });

        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
                e.preventDefault();
                SaveSystem.fullSave(true);
            }
        });

        setInterval(() => {
            const indicator = document.getElementById('saveIndicator');
            if (indicator) {
                const lastSave = SaveSystem.getLastSaveTime();
                if (lastSave) {
                    const age = (Date.now() - lastSave.getTime()) / 1000;
                    if (age < 60) {
                        indicator.className = 'save-indicator saved';
                        indicator.title = `Sauvegardé il y a ${Math.round(age)}s`;
                    } else if (age < 300) {
                        indicator.className = 'save-indicator saving';
                        indicator.title = `Sauvegarde vieille de ${Math.round(age)}s`;
                    } else {
                        indicator.className = 'save-indicator error';
                        indicator.title = `⚠️ Pas de sauvegarde depuis ${Math.round(age)}s`;
                    }
                }
            }
        }, 5000);

        const sidebarFooter = document.querySelector('.sidebar-footer');
        if (sidebarFooter && !sidebarFooter.querySelector('.save-menu')) {
            const saveMenu = document.createElement('div');
            saveMenu.className = 'save-menu';
            saveMenu.innerHTML = `
                <button class="btn btn-sm btn-success touch-target" id="exportBackupBtn" style="font-size:0.7rem; width:100%;">
                    <i class="fas fa-file-export"></i> Exporter sauvegarde
                </button>
                <button class="btn btn-sm btn-info touch-target" id="importBackupBtn" style="font-size:0.7rem; width:100%;">
                    <i class="fas fa-file-import"></i> Importer sauvegarde
                </button>
            `;
            sidebarFooter.appendChild(saveMenu);
            document.getElementById('exportBackupBtn')?.addEventListener('click', function() {
                if (window.SaveSystem) window.SaveSystem.exportBackup();
            });
            document.getElementById('importBackupBtn')?.addEventListener('click', function() {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.style.display = 'none';
                document.body.appendChild(input);
                input.onchange = function(e) {
                    if (this.files && this.files[0]) {
                        if (window.SaveSystem) window.SaveSystem.importBackup(this.files[0]);
                    }
                    document.body.removeChild(input);
                };
                input.click();
            });
        }

        // ============================================================
        // PERSIST-022 : Rechargement FORCÉ au démarrage
        // ============================================================
        setTimeout(async () => {
            try {
                const currentProjectId = ProjectManager.getCurrentProjectId();
                if (currentProjectId) {
                    const freshEquipments = await StorageManager.loadEquipmentsForProject(currentProjectId, true);
                    // Ne jamais écraser une liste non vide par une lecture
                    // locale vide (base pas encore hydratée) — sinon le
                    // tableau « Équipements » se vide pour un projet peuplé.
                    if (freshEquipments && (freshEquipments.length > 0 || ProjectManager.getState().equipments.length === 0)) {
                        ProjectManager.getState().equipments = freshEquipments;
                        Logger.info(`[App] Équipements rechargés depuis IndexedDB: ${freshEquipments.length}`);
                    } else {
                        Logger.warn('[App] Lecture locale vide ignorée — équipements en mémoire conservés.');
                    }
                    const freshMeasurements = await StorageManager.loadFieldMeasurementsForProject(currentProjectId);
                    if (freshMeasurements) ProjectManager.getState().fieldMeasurements = freshMeasurements;
                    const freshMapPoints = await StorageManager.loadMapPoints(currentProjectId);
                    if (freshMapPoints) ProjectManager.getState().mapPoints = freshMapPoints;
                    if (window.UI && typeof window.UI.refreshEquipmentListUI === 'function') {
                        window.UI.refreshEquipmentListUI(true);
                    }
                    if (window.CPController && typeof window.CPController.updateDashboard === 'function') {
                        window.CPController.updateDashboard();
                    }
                    if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') {
                        window.CPController.syncSurfaceFromEquipments();
                    }
                    if (window.CPController && typeof window.CPController.syncAllEquipmentToGIS === 'function') {
                        window.CPController.syncAllEquipmentToGIS();
                    }
                    if (window.CPController && typeof window.CPController.syncAllEquipmentTo3D === 'function') {
                        window.CPController.syncAllEquipmentTo3D();
                    }
                    await cleanupDemoEquipments();
                    Logger.info('[App] Rechargement complet des données effectué');
                }
            } catch (err) {
                Logger.warn('[App] Erreur rechargement au démarrage:', err);
            }
        }, 800);

        // ============================================================
        // BOUTON DE LOGIN/DÉCONNEXION
        // ============================================================
        const headerRight = document.querySelector('.header-right');
        if (headerRight) {
            const authBtn = document.createElement('button');
            authBtn.className = 'btn btn-secondary touch-target';
            authBtn.id = 'authBtn';
            authBtn.style.marginLeft = '0.5rem';
            const isAuth = StorageManager.isAuthenticated ? StorageManager.isAuthenticated() : false;
            authBtn.innerHTML = isAuth
                ? '<i class="fas fa-sign-out-alt"></i> Déconnexion'
                : '<i class="fas fa-sign-in-alt"></i> Connexion';
            authBtn.title = isAuth
                ? 'Se déconnecter du serveur'
                : 'Se connecter au serveur';
            headerRight.appendChild(authBtn);

            authBtn.addEventListener('click', async function() {
                if (StorageManager.isAuthenticated && StorageManager.isAuthenticated()) {
                    await StorageManager.logout();
                    this.innerHTML = '<i class="fas fa-sign-in-alt"></i> Connexion';
                    this.title = 'Se connecter au serveur';
                } else {
                    const authenticated = await showLoginModal();
                    if (authenticated) {
                        this.innerHTML = '<i class="fas fa-sign-out-alt"></i> Déconnexion';
                        this.title = 'Se déconnecter du serveur';
                        if (window.UI && typeof window.UI.showToast === 'function') {
                            window.UI.showToast('✅ Connecté au serveur.', 'success');
                        }
                        const projectId = ProjectManager.getCurrentProjectId();
                        if (projectId) {
                            await ProjectManager.loadProject(projectId);
                            UI.populateProjectSelector();
                            UI.refreshEquipmentListUI(true);
                            if (window.CPController) {
                                window.CPController.updateDashboard();
                                window.CPController.syncSurfaceFromEquipments();
                                window.CPController.syncAllEquipmentToGIS();
                                window.CPController.syncAllEquipmentTo3D();
                            }
                        }
                    }
                }
            });
        }

        // ============================================================
        // POPULATE SELECTOR INITIAL + RETRY
        // ============================================================
        async function bootstrapProjectSelector() {
            try {
                await ProjectManager.loadProjectsList();
                populateProjectSelector();
                populateTestPostsSelectors();
                populateVis3dSystemSelector();

                if (!window._defaultsApplied) {
                    applyIlliziDefaults();
                    window._defaultsApplied = true;
                }
                ensureAnodeDefaults();
                refreshEquipmentProjectDropdown();
                refreshEquipmentListInCP();
                populateCPEquipmentSelector();
                populateGroundbedProjectSelect();
                populateInterferenceProjectSelect();
                populatePipelineSelects();
                loadHistory();

                if (ProjectManager.getProjectsList().length === 0) {
                    await retryLoadProjectsList();
                }
            } catch (err) {
                console.warn('[App] bootstrapProjectSelector erreur:', err);
            }
        }

        async function retryLoadProjectsList() {
            const delays = [500, 1500, 3000];
            for (let i = 0; i < delays.length; i++) {
                await new Promise(r => setTimeout(r, delays[i]));
                await ProjectManager.loadProjectsList();
                if (ProjectManager.getProjectsList().length > 0) {
                    populateProjectSelector();
                    return;
                }
            }
            console.info('[App] Aucun projet enregistré pour le moment. Le système reste initialisé en mode vide.');
        }

        setTimeout(bootstrapProjectSelector, 100);

        // ─── P1-04 : Listener storage avec guard anti-récursion ───
        let _storageReloadGuard = false;
        let _storageReloadTimeout = null;
        window.addEventListener('storage', function(e) {
            const key = e.key;
            if (key && key.startsWith('cp_')) {
                if (_storageReloadGuard) {
                    Logger.debug('[App] storage ignoré (rechargement déjà en cours)');
                    return;
                }
                if (SaveSystem.isInternalSave()) {
                    Logger.debug('[App] storage ignoré (sauvegarde interne)');
                    return;
                }
                _storageReloadGuard = true;
                if (_storageReloadTimeout) clearTimeout(_storageReloadTimeout);
                _storageReloadTimeout = setTimeout(() => {
                    _storageReloadGuard = false;
                }, 2000);

                ProjectManager.loadProjectsList()
                    .then(() => {
                        refreshEquipmentProjectDropdown();
                        refreshEquipmentListInCP();
                        populateCPEquipmentSelector();
                        populateGroundbedProjectSelect();
                        populateInterferenceProjectSelect();
                        populatePipelineSelects();
                        loadHistory();
                        refreshEquipmentListUI();
                        refreshFieldMeasurementsTable();
                        renderSystems();
                        populateAllSystemSelectors();
                        populateTestPostsSelectors();
                        populateVis3dSystemSelector();
                        _storageReloadGuard = false;
                        if (_storageReloadTimeout) {
                            clearTimeout(_storageReloadTimeout);
                            _storageReloadTimeout = null;
                        }
                    })
                    .catch(err => console.warn('Erreur lors du rechargement après storage:', err));
            }
        });

        // ============================================================
        // projectSelector.onchange
        // ============================================================
        const projectSelector = document.getElementById('projectSelector');
        if (projectSelector) {
            projectSelector.onchange = async (e) => {
                const val = e.target.value;
                if (val === '__all__') {
                    ProjectManager.setCurrentProjectId(null);
                    if (window.GisIntegration) {
                        window.GisIntegration.filters.set('projectId', null);
                    }
                    const filterSelect = document.getElementById('filterEquipProject');
                    if (filterSelect) filterSelect.value = '__all__';
                    if (window.UI) window.UI._equipFilterProject = '';
                    refreshEquipmentListUI(true);
                    if (window.GisIntegration && typeof window.GisIntegration.loadPoints === 'function') {
                        window.GisIntegration.loadPoints(null, true);
                    }
                    populateGroundbedProjectSelect();
                    populateInterferenceProjectSelect();
                    populatePipelineSelects();
                    renderSystems();
                    populateAllSystemSelectors();
                    populateVis3dSystemSelector();
                    if (window.CPController && typeof window.CPController.updateDashboard === 'function') {
                        window.CPController.updateDashboard();
                    }
                    if (window.UI && window.UI.showToast) {
                        window.UI.showToast('Affichage de tous les projets', 'info');
                    }
                    if (window.UI && window.UI.renderDynamicEquipmentList) {
                        window.UI.renderDynamicEquipmentList();
                    }
                    if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                        window.Gis3D.loadData('__all__');
                    }
                    return;
                }

                if (val) {
                    await ProjectManager.loadProject(val);
                    populateProjectSelector();
                    if (window.UI) window.UI._equipCurrentPage = 1;
                    refreshEquipmentListUI(true);
                    refreshFieldMeasurementsTable();
                    refreshAssetDropdownForFieldMeas();
                    populateCPEquipmentSelector();
                    loadProjectParams();
                    if (!window._defaultsApplied) {
                        applyIlliziDefaults();
                        window._defaultsApplied = true;
                    }
                    if (window.GisIntegration) {
                        window.GisIntegration.filters.set('projectId', val);
                    }
                    const filterSelect = document.getElementById('filterEquipProject');
                    if (filterSelect) filterSelect.value = val;
                    if (window.UI) window.UI._equipFilterProject = val;
                    if (window.CPController) {
                        if (typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
                        if (typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
                        if (typeof window.CPController.syncAllEquipmentToGIS === 'function') window.CPController.syncAllEquipmentToGIS();
                        if (typeof window.CPController.syncAllEquipmentTo3D === 'function') window.CPController.syncAllEquipmentTo3D();
                        if (typeof window.CPController.updateDashboardChartsData === 'function') window.CPController.updateDashboardChartsData();
                        if (typeof window.CPController.updatePotentialChart === 'function') window.CPController.updatePotentialChart();
                    }
                    populateGroundbedProjectSelect();
                    populateInterferenceProjectSelect();
                    populatePipelineSelects();
                    loadHistory();
                    renderSystems();
                    populateAllSystemSelectors();
                    populateSystemDropdown();
                    populateTestPostsSelectors();
                    populateVis3dSystemSelector();
                    renderGroundbedList();
                    populateICCPGroundbedSelectors();
                    const activeModule = document.querySelector('.module.active');
                    if (activeModule) {
                        const moduleId = activeModule.id.replace('module-', '');
                        const sysId = ProjectManager.getCurrentProjectId();
                        if (sysId) loadSystemParamsToModule(moduleId, sysId);
                    }
                    if (AppState.map && window.CPController && typeof window.CPController.loadMapPoints === 'function') {
                        window.CPController.loadMapPoints();
                    }
                    if (window.UI && window.UI.renderDynamicEquipmentList) {
                        window.UI.renderDynamicEquipmentList();
                    }
                    if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                        window.Gis3D.loadData(val);
                    }
                }
            };
        }

        // ============================================================
        // SUGGEST STANDARDS / SOIL / WATER
        // ============================================================
        document.getElementById('suggestStandardsBtn')?.addEventListener('click', () => {
            if (window.CPController && typeof window.CPController.suggestStandards === 'function') {
                window.CPController.suggestStandards();
            }
        });

        document.getElementById('generateSoilFromResistivity')?.addEventListener('click', () => {
            generateSoilFromResistivity();
        });

        const autoSoilCheck = document.getElementById('autoGenerateSoil');
        if (autoSoilCheck) {
            autoSoilCheck.addEventListener('change', function() {
                if (this.checked) {
                    generateSoilFromResistivity();
                    const resSelect = document.getElementById('envSoilResistivity');
                    const resManual = document.getElementById('envSoilResistivityManual');
                    const handler = debounce(() => generateSoilFromResistivity(), 500);
                    if (resSelect) resSelect.addEventListener('change', handler);
                    if (resManual) resManual.addEventListener('input', handler);
                    window._autoSoilHandlers = { resSelect, resManual, handler };
                }
            });
        }

        document.getElementById('generateWaterFromEnv')?.addEventListener('click', () => {
            generateWaterFromEnvironment();
        });

        // ============================================================
        // ZONES CRITIQUES + CARTOGRAPHIE
        // ============================================================
        const mapContainer = document.getElementById('mapContainer');
        if (mapContainer) {
            const observer = new MutationObserver(() => {
                const module = document.getElementById('module-cartography');
                if (module && module.classList.contains('active')) {
                    if (!window.GisIntegration || !window.GisIntegration.getMap()) {
                        setTimeout(() => {
                            console.log('[UI] MutationObserver: Activation de la cartographie, initialisation de la carte...');
                            if (window.GisIntegration && typeof window.GisIntegration.init === 'function') {
                                window.GisIntegration.init();
                                setTimeout(() => {
                                    window.GisIntegration.loadPoints(FilterManager.getFilter('projectId'));
                                }, 300);
                            }
                        }, 300);
                    }
                }
            });
            observer.observe(document.getElementById('mainContent'), { childList: true, subtree: true });

            if (document.getElementById('module-cartography')?.classList.contains('active')) {
                setTimeout(() => {
                    console.log('[UI] Initialisation initiale de la cartographie...');
                    if (window.GisIntegration && typeof window.GisIntegration.init === 'function') {
                        window.GisIntegration.init();
                        setTimeout(() => {
                            window.GisIntegration.loadPoints(FilterManager.getFilter('projectId'));
                        }, 300);
                    }
                }, 300);
            }
        }

        // ============================================================
        // FORMULAIRE GROUNDBED + BOUTONS ICCP
        // ============================================================
        const gbForm = document.getElementById('groundbedForm');
        if (gbForm) {
            gbForm.addEventListener('submit', function(e) {
                e.preventDefault();
                const editId = document.getElementById('gbEditId').value;
                if (window.CPController && typeof window.CPController.calculateGroundbed === 'function') {
                    window.CPController.calculateGroundbed(editId || null);
                }
            });
        }

        document.getElementById('gbCreateNewBtn')?.addEventListener('click', () => {
            openGroundbedForm(null);
        });
        document.getElementById('gbFormCancelBtn')?.addEventListener('click', () => {
            document.getElementById('gbFormCard').style.display = 'none';
        });

        document.getElementById('iccpGroundbedSelector')?.addEventListener('change', function() {
            const sysId = ProjectManager.getCurrentSystemId();
            if (sysId) {
                const sys = ProjectManager.getSystem(sysId);
                if (sys && sys.type === 'iccp') {
                    sys.groundbedId = this.value || null;
                    ProjectManager.saveCurrentProject();
                    if (window.UI && window.UI.showToast) {
                        window.UI.showToast('Puits associé au système actif', 'success');
                    }
                    renderSystems();
                }
            }
        });

        document.getElementById('iccpCreateGroundbedBtn')?.addEventListener('click', () => {
            document.getElementById('gbCreateNewBtn').click();
            document.querySelector('.nav-item[data-module="groundbed"]')?.click();
        });

        document.getElementById('iccpRefreshGroundbedBtn')?.addEventListener('click', () => {
            populateICCPGroundbedSelectors();
            if (window.UI && window.UI.showToast) {
                window.UI.showToast('Sélecteur de puits actualisé', 'info');
            }
        });

        // ============================================================
        // COORDSYSTEM REFERENCE
        // ============================================================
        if (typeof CoordSystem !== 'undefined') {
            const pid = ProjectManager.getCurrentProjectId();
            if (pid) {
                const state = ProjectManager.getState();
                const equipments = state.equipments.filter(eq => eq.projectId === pid);
                const firstWithCoords = equipments.find(eq => eq.coordinates);
                if (firstWithCoords) {
                    const coords = firstWithCoords.coordinates;
                    let lat, lon, alt = 0;
                    if (Array.isArray(coords) && coords.length > 0) {
                        lat = coords[0].lat; lon = coords[0].lon; alt = coords[0].alt || 0;
                    } else if (coords.lat !== undefined) {
                        lat = coords.lat; lon = coords.lon; alt = coords.alt || 0;
                    }
                    if (CoordSystem.isValid(lat, lon, alt)) {
                        CoordSystem.setReference(lat, lon, alt);
                    }
                }
            }
        }

        if (!window._defaultsApplied) {
            applyIlliziDefaults();
            window._defaultsApplied = true;
        }
        ensureAnodeDefaults();

        console.log('UI initialisée avec succès.');

    } catch(err) {
        Logger.error('Erreur lors de l\'initialisation:', err);
        const toast = document.getElementById('toastContainer');
        if (toast) {
            const div = document.createElement('div');
            div.className = 'toast';
            div.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Erreur d\'initialisation. Veuillez rafraîchir.';
            toast.appendChild(div);
        }
        setTimeout(() => {
            Logger.info('Tentative de récupération...');
            if (typeof UI !== 'undefined' && typeof UI.init === 'function') {
                UI.init().catch(e => Logger.error('Échec de récupération:', e));
            }
        }, 5000);
    }
});

// ============================================================
// Exports globaux (sécurisés)
// ============================================================
function safeControllerCall(fnName, ...args) {
    if (typeof CPController !== 'undefined' && CPController[fnName]) {
        return CPController[fnName](...args);
    }
    Logger.warn(`CPController.${fnName} non disponible`);
    return null;
}

window.CPEngine = CalculationEngine;
window.StorageManager = StorageManager;
window.UI = UI;
window.Utils = Utils;
window.AppState = AppState;
window.GeoUtils = GeoUtils;

// Exports sans argument (générés par boucle pour compacité)
const _simpleExports = {
    calculateCP: 'calculateCP',
    calculateAnodes: 'calculateAnodes',
    calculateICCP_Advanced: 'calculateICCP',
    calculateGroundbed: 'calculateGroundbed',
    calculateInterference: 'calculateInterference',
    exportPDF: 'exportPDF',
    exportGlobalReport: 'exportGlobalReport',
    generateValidationReport: 'generateValidationReport',
    applyEquipmentTotalToCP: 'applyEquipmentTotalToCP',
    syncSurfaceFromEquipments: 'syncSurfaceFromEquipments',
    updateAnodeCurrentSource: 'updateAnodeCurrentSource',
    updateICCPCurrentSource: 'updateICCPCurrentSource',
    syncGroundbedFromCP: 'syncGroundbedFromCP',
    syncInterferenceFromCP: 'syncInterferenceFromCP',
    checkConsistency: 'checkConsistency',
    refreshDashboard: 'updateDashboard',
    renderSystems: 'renderSystems',
    populateAllSystemSelectors: 'populateAllSystemSelectors',
    refreshEquipmentList: 'refreshEquipmentList',
    refreshFieldMeasurementsTable: 'refreshFieldMeasurementsTable',
    refreshAssetDropdownForFieldMeas: 'refreshAssetDropdownForFieldMeas',
    updateCorrosivity: 'updateCorrosivity',
    populateProjectSelector: 'populateProjectSelector',
    populateGroundbedProjectSelect: 'populateGroundbedProjectSelect',
    populateInterferenceProjectSelect: 'populateInterferenceProjectSelect',
    populatePipelineSelects: 'populatePipelineSelects',
    refreshHistoryTable: 'refreshHistoryTable',
    loadHistory: 'loadHistory',
    updateEquipTypeOptions: 'updateEquipTypeOptions',
    updateEquipDimensionsFields: 'updateEquipDimensionsFields',
    computeEquipSurface: 'computeEquipSurface',
    updateDimensionsFields: 'updateDimensionsFields',
    autoFillFromEnvironment: 'autoFillFromEnvironment',
    initDashboardCharts: 'initDashboardCharts',
    scheduleRenderSystems: 'renderSystems',
    updateGroundbedTargetCurrent: 'updateGroundbedTargetCurrent',
    generateTestPosts: 'generateTestPosts',
    exportPostsPDF: 'exportPostsPDF',
    exportPostsCSV: 'exportPostsCSV',
    calculateCableSection: 'calculateCableSection',
    applyCableToICCP: 'applyCableToICCP',
    suggestStandards: 'suggestStandards',
    generateSoilFromResistivity: 'generateSoilFromResistivity',
    generateWaterFromEnvironment: 'generateWaterFromEnvironment',
    initMap: 'initMap',
    loadMapPoints: 'loadMapPoints',
    centerMap: 'centerMap',
    exportMapData: 'exportMapData',
    analyzeReinforcementNeeds: 'analyzeReinforcementNeeds',
    autoDetectZones: 'autoDetectZones',
    renderReinforcementZones: 'renderReinforcementZones',
    renderGroundbedList: 'renderGroundbedList',
    populateICCPGroundbedSelectors: 'populateICCPGroundbedSelectors',
    populateResistiveParams: 'populateResistiveParams',
    applyResistiveModel: 'applyResistiveModel',
    syncSharedParams: 'syncSharedParams',
    validateSystem: 'validateSystem',
    updateDerivedFields: 'updateDerivedFields'
};

Object.entries(_simpleExports).forEach(([exportName, methodName]) => {
    window[exportName] = () => safeControllerCall(methodName);
});

// Exports avec arguments (individuels)
window.drawGroundbedVisual = (td, ad, ac, al, s) => safeControllerCall('drawGroundbedVisual', td, ad, ac, al, s);
window.setModulesActivation = (type) => safeControllerCall('setModulesActivation', type);
window.addMapPoint = (type, name, lat, lon) => safeControllerCall('addMapPoint', type, name, lat, lon);
window.addReinforcementZone = (name, location, problemType, criticality, additionalCurrent) =>
    safeControllerCall('addReinforcementZone', name, location, problemType, criticality, additionalCurrent);
window.openGroundbedForm = (id) => safeControllerCall('openGroundbedForm', id);
window.toggleSharedLock = (key) => safeControllerCall('toggleSharedLock', key);

// Exports directs (sans CPController)
window.createGroundbed = (name, params) => ProjectManager.createGroundbed(name, params, {});
window.deleteGroundbed = (id) => ProjectManager.deleteGroundbed(id);
window.getGroundbeds = () => ProjectManager.getGroundbeds();
window.calculateEquipmentResistances = (equipment, soilResistivityOverride) =>
    CalculationEngine.calculateEquipmentResistances(equipment, soilResistivityOverride);

// ============================================================
// FIN DE app.js (VERSION 9.6 – P1-04 + V10 APPLIQUÉS)
// ============================================================