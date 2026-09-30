// ============================================================
// dataResolver.js – CP Engineer Pro
// API officielle de résolution des données communes
// Version 2.0 – Module source (extrait et refondu de
//              data-sync-patch.js v1.0)
// ============================================================
// MISSION (cf. ROLE.txt Phase 6) :
//   Fournir une source de vérité unique pour la résolution :
//     - Pipelines d'un projet (avec longueurs calculées)
//     - Systèmes CP d'un projet (avec sélection préférée)
//     - Courant cible préféré (fusion avec la logique de
//       ui-groundbed-consistency-patch.js v2.1)
//
// PRINCIPE DIRECTEUR :
//   - API pure, sans effet de bord
//   - Aucun monkey-patching
//   - Aucun listener d'événement
//   - Aucune dépendance UI
//   - Exposé sur window.DataResolver
//   - Idempotent (garde __v2)
//
// DÉPENDANCES (toutes optionnelles avec fallback) :
//   - ProjectManager : getState, getSystems, getSystem,
//                      getCurrentProjectId
//   - CoordSystem    : pipelineLength
//   - GeoUtils       : pathLength, distanceHaversine
//   - Utils          : safeNumber
//   - StorageManager : loadEquipmentsForProject
//
// CHARGEMENT (index.html) :
//   APRÈS controller.js, AVANT ui.js
//   <script src="dataResolver.js" defer></script>
// ============================================================

(function() {
    'use strict';

    // ============================================================
    // 0. GARDE D'IDEMPOTENCE
    // ============================================================
    if (typeof window === 'undefined') return;
    if (window.DataResolver && window.DataResolver.__v2) {
        console.log('[DataResolver] Déjà chargé (v2) — ignoré.');
        return;
    }

    // ============================================================
    // 1. CONSTANTES DE DOMAINE
    // ============================================================

    /**
     * Types d'équipements considérés comme pipelines.
     */
    const PIPELINE_TYPES = ['pipeline_enterre', 'pipeline_offshore'];

    /**
     * Priorité de sélection des systèmes CP (du plus prioritaire
     * au moins prioritaire).
     */
    const SYSTEM_TYPE_PRIORITY = ['iccp', 'mixte', 'anodes'];

    /**
     * Sources possibles du courant cible (ordre de priorité).
     */
    const CURRENT_SOURCE = {
        ICCP: 'iccp',
        CP: 'cp',
        SURFACE: 'surface',
        NONE: 'none'
    };

    // ============================================================
    // 2. HELPERS INTERNES (fallbacks robustes)
    // ============================================================

    /**
     * Convertit une valeur en nombre sûr.
     * Utilise Utils.safeNumber si disponible, sinon fallback local.
     */
    function safeNumber(value, defaultValue) {
        const fallback = (defaultValue !== undefined) ? defaultValue : 0;
        if (value === undefined || value === null || value === '') return fallback;

        if (typeof window.Utils !== 'undefined' &&
            typeof window.Utils.safeNumber === 'function') {
            return window.Utils.safeNumber(value, fallback);
        }

        const num = parseFloat(String(value).trim().replace(',', '.'));
        return isNaN(num) ? fallback : num;
    }

    /**
     * Retourne l'état global du projet courant (ou null).
     */
    function getAppState() {
        if (typeof window.ProjectManager === 'undefined' ||
            typeof window.ProjectManager.getState !== 'function') {
            return null;
        }
        try {
            return window.ProjectManager.getState() || null;
        } catch (e) {
            console.warn('[DataResolver] getState error:', e.message);
            return null;
        }
    }

    /**
     * Retourne l'ID du projet courant (ou null).
     */
    function getCurrentProjectId() {
        if (typeof window.ProjectManager === 'undefined' ||
            typeof window.ProjectManager.getCurrentProjectId !== 'function') {
            return null;
        }
        try {
            return window.ProjectManager.getCurrentProjectId() || null;
        } catch (e) {
            return null;
        }
    }

    // ============================================================
    // 3. API PUBLIQUE : DataResolver
    // ============================================================
    const DataResolver = {

        __v2: true,

        VERSION: '2.0.0',

        // --------------------------------------------------------
        // 3.1 PIPELINES
        // --------------------------------------------------------

        /**
         * Récupère tous les pipelines d'un projet donné.
         * Source : state.equipments[] (source de vérité unique).
         *
         * @param {string} projectId
         * @returns {Array<Object>}
         */
        getProjectPipelines: function(projectId) {
            if (!projectId || projectId === '__all__') return [];

            const state = getAppState();
            if (!state || !Array.isArray(state.equipments)) return [];

            return state.equipments.filter(function(eq) {
                return eq &&
                       eq.projectId === projectId &&
                       PIPELINE_TYPES.indexOf(eq.type) !== -1;
            });
        },

        /**
         * Récupère un pipeline par son ID.
         * @param {string} pipelineId
         * @returns {Object|null}
         */
        getPipelineById: function(pipelineId) {
            if (!pipelineId) return null;

            const state = getAppState();
            if (!state || !Array.isArray(state.equipments)) return null;

            return state.equipments.find(function(eq) {
                return eq && eq.id === pipelineId;
            }) || null;
        },

        /**
         * Calcule la longueur d'un pipeline en mètres.
         *
         * Priorité 1 : dimensions.longueur_m (déclaration utilisateur)
         * Priorité 2 : CoordSystem.pipelineLength() sur GPS
         * Priorité 3 : GeoUtils.pathLength() sur GPS
         * Priorité 4 : GeoUtils.distanceHaversine() segment par segment
         *
         * @param {Object} pipeline
         * @returns {number} Longueur en mètres (0 si indisponible)
         */
        getPipelineLengthM: function(pipeline) {
            if (!pipeline) return 0;

            // Priorité 1 : dimension déclarée
            if (pipeline.dimensions &&
                pipeline.dimensions.longueur_m !== undefined &&
                pipeline.dimensions.longueur_m !== null) {
                const declared = safeNumber(pipeline.dimensions.longueur_m, 0);
                if (declared > 0) return declared;
            }

            // Priorité 2 / 3 / 4 : calcul depuis coordonnées GPS
            const coords = pipeline.coordinates;
            if (!Array.isArray(coords) || coords.length < 2) return 0;

            // Priorité 2 : CoordSystem
            if (typeof window.CoordSystem !== 'undefined' &&
                typeof window.CoordSystem.pipelineLength === 'function') {
                try {
                    const len = window.CoordSystem.pipelineLength(coords);
                    if (isFinite(len) && len > 0) return len;
                } catch (e) {
                    // Silencieux — on passe à la priorité suivante
                }
            }

            // Priorité 3 : GeoUtils.pathLength
            if (typeof window.GeoUtils !== 'undefined' &&
                typeof window.GeoUtils.pathLength === 'function') {
                try {
                    const len = window.GeoUtils.pathLength(coords);
                    if (isFinite(len) && len > 0) return len;
                } catch (e) {
                    // Silencieux
                }
            }

            // Priorité 4 : GeoUtils.distanceHaversine segment par segment
            if (typeof window.GeoUtils !== 'undefined' &&
                typeof window.GeoUtils.distanceHaversine === 'function') {
                try {
                    let total = 0;
                    for (let i = 0; i < coords.length - 1; i++) {
                        total += window.GeoUtils.distanceHaversine(
                            coords[i].lat, coords[i].lon,
                            coords[i + 1].lat, coords[i + 1].lon
                        );
                    }
                    if (isFinite(total) && total > 0) return total;
                } catch (e) {
                    // Silencieux
                }
            }

            return 0;
        },

        /**
         * Longueur d'un pipeline en km.
         * @param {Object} pipeline
         * @returns {number}
         */
        getPipelineLengthKm: function(pipeline) {
            return this.getPipelineLengthM(pipeline) / 1000;
        },

        /**
         * Somme des longueurs de tous les pipelines d'un projet, en km.
         * @param {string} projectId
         * @returns {number}
         */
        getProjectTotalLengthKm: function(projectId) {
            const pipelines = this.getProjectPipelines(projectId);
            if (pipelines.length === 0) return 0;

            let totalM = 0;
            for (let i = 0; i < pipelines.length; i++) {
                totalM += this.getPipelineLengthM(pipelines[i]);
            }
            return totalM / 1000;
        },

        /**
         * Détermine la longueur pertinente pour le module Test Posts.
         *
         * Règles métier :
         *   Cas A : pipeline spécifié → longueur de CE pipeline
         *   Cas B : projet avec 1 pipeline → longueur de ce pipeline
         *   Cas C : projet avec N pipelines → somme des longueurs
         *   Cas D : aucun pipeline → 0 (état neutre)
         *
         * @param {string} projectId
         * @param {string} [pipelineId]
         * @returns {{lengthKm: number, source: string}}
         */
        resolveLengthForTestPosts: function(projectId, pipelineId) {
            if (!projectId || projectId === '__all__') {
                return { lengthKm: 0, source: 'none' };
            }

            // Cas A : pipeline explicite
            if (pipelineId) {
                const pipeline = this.getPipelineById(pipelineId);
                if (pipeline) {
                    return {
                        lengthKm: this.getPipelineLengthKm(pipeline),
                        source: 'pipeline'
                    };
                }
            }

            // Cas B / C : depuis les pipelines du projet
            const pipelines = this.getProjectPipelines(projectId);
            if (pipelines.length === 0) {
                return { lengthKm: 0, source: 'none' };
            }
            if (pipelines.length === 1) {
                return {
                    lengthKm: this.getPipelineLengthKm(pipelines[0]),
                    source: 'single-pipeline'
                };
            }
            return {
                lengthKm: this.getProjectTotalLengthKm(projectId),
                source: 'project-total'
            };
        },

        // --------------------------------------------------------
        // 3.2 SYSTÈMES CP
        // --------------------------------------------------------

        /**
         * Récupère les systèmes CP d'un projet.
         * Les systèmes sont stockés dans state.dashboard.systeme et
         * sont déjà scopés au projet COURANT. Pour un autre projet,
         * on ne peut pas les charger sans recharger ce projet
         * → retourne [].
         *
         * @param {string} projectId
         * @returns {Array<Object>}
         */
        getProjectSystems: function(projectId) {
            if (!projectId || projectId === '__all__') return [];

            // Ne retourne les systèmes que si le projet est actif
            const currentId = getCurrentProjectId();
            if (currentId !== projectId) return [];

            if (typeof window.ProjectManager === 'undefined' ||
                typeof window.ProjectManager.getSystems !== 'function') {
                return [];
            }

            try {
                return window.ProjectManager.getSystems() || [];
            } catch (e) {
                console.warn('[DataResolver] getProjectSystems error:', e.message);
                return [];
            }
        },

        /**
         * Récupère le système CP associé à un pipeline.
         *
         * Ordre de priorité :
         *   1. pipeline.systemId (lien direct)
         *   2. Recherche dans system.equipmentIds[]
         *
         * @param {string} pipelineId
         * @returns {Object|null}
         */
        getSystemForPipeline: function(pipelineId) {
            if (!pipelineId) return null;

            const pipeline = this.getPipelineById(pipelineId);
            if (!pipeline) return null;

            if (typeof window.ProjectManager === 'undefined') return null;

            // Priorité 1 : systemId direct
            if (pipeline.systemId) {
                try {
                    const sys = window.ProjectManager.getSystem(pipeline.systemId);
                    if (sys) return sys;
                } catch (e) {
                    // Silencieux
                }
            }

            // Priorité 2 : rechercher dans equipmentIds des systèmes
            let systems = [];
            try {
                systems = window.ProjectManager.getSystems() || [];
            } catch (e) {
                return null;
            }

            for (let i = 0; i < systems.length; i++) {
                const sys = systems[i];
                if (sys &&
                    Array.isArray(sys.equipmentIds) &&
                    sys.equipmentIds.indexOf(pipelineId) !== -1) {
                    return sys;
                }
            }

            return null;
        },

        /**
         * Récupère le système CP préféré d'un projet.
         *
         * Priorité métier (SYSTEM_TYPE_PRIORITY) :
         *   1. iccp
         *   2. mixte
         *   3. anodes
         *   4. premier système disponible (fallback)
         *
         * @param {string} projectId
         * @returns {Object|null}
         */
        getPreferredSystem: function(projectId) {
            const systems = this.getProjectSystems(projectId);
            if (systems.length === 0) return null;

            // Priorité par type
            for (let i = 0; i < SYSTEM_TYPE_PRIORITY.length; i++) {
                const targetType = SYSTEM_TYPE_PRIORITY[i];
                const found = systems.find(function(s) {
                    return s && s.type === targetType;
                });
                if (found) return found;
            }

            // Fallback : premier système
            return systems[0];
        },

        /**
         * Résout le système CP à utiliser selon le contexte.
         *
         * @param {string} projectId
         * @param {string} [pipelineId]
         * @returns {{system: Object|null, source: string}}
         */
        resolveSystem: function(projectId, pipelineId) {
            // Priorité 1 : système lié au pipeline
            if (pipelineId) {
                const sys = this.getSystemForPipeline(pipelineId);
                if (sys) {
                    return { system: sys, source: 'pipeline' };
                }
            }

            // Priorité 2 : système préféré du projet
            const preferred = this.getPreferredSystem(projectId);
            if (preferred) {
                return { system: preferred, source: 'project-preferred' };
            }

            return { system: null, source: 'none' };
        },

        // --------------------------------------------------------
        // 3.3 COURANT CIBLE PRÉFÉRÉ
        //     (fusion avec ui-groundbed-consistency-patch.js v2.1)
        // --------------------------------------------------------

        /**
         * Résout le courant cible selon une priorité en cascade :
         *
         *   Priorité 1 : state.iccp.current (courant ICCP calculé)
         *   Priorité 2 : state.cp.current   (courant CP calculé)
         *   Priorité 3 : surface × densité / 1000 (fallback surface)
         *
         * @param {Object} [options]
         * @param {number} [options.surfaceM2] - Surface totale (m²)
         * @param {number} [options.currentDensity_mA_m2] - Densité (mA/m²)
         * @returns {{value: number, source: string, label: string}}
         */
        resolvePreferredCurrent: function(options) {
            const opts = options || {};
            const state = getAppState();

            // Priorité 1 : ICCP
            const iccpCurrent = (state && state.iccp && state.iccp.current) || 0;
            if (isFinite(iccpCurrent) && iccpCurrent > 0) {
                return {
                    value: iccpCurrent,
                    source: CURRENT_SOURCE.ICCP,
                    label: 'ICCP calcule'
                };
            }

            // Priorité 2 : CP
            const cpCurrent = (state && state.cp && state.cp.current) || 0;
            if (isFinite(cpCurrent) && cpCurrent > 0) {
                return {
                    value: cpCurrent,
                    source: CURRENT_SOURCE.CP,
                    label: 'CP calcule'
                };
            }

            // Priorité 3 : surface × densité / 1000
            const surfaceM2 = safeNumber(opts.surfaceM2, 0);
            const density = safeNumber(opts.currentDensity_mA_m2, 0);

            if (surfaceM2 > 0 && density > 0) {
                const surfaceCurrent = (surfaceM2 * density) / 1000;
                if (surfaceCurrent > 0) {
                    return {
                        value: surfaceCurrent,
                        source: CURRENT_SOURCE.SURFACE,
                        label: 'Surface x densite (fallback)'
                    };
                }
            }

            // Aucune source disponible
            return {
                value: 0,
                source: CURRENT_SOURCE.NONE,
                label: 'Aucune source'
            };
        },

        /**
         * Calcule le courant depuis une surface totale et une densité.
         * Helper utilitaire pour éviter la duplication.
         *
         * @param {number} surfaceM2 - Surface totale (m²)
         * @param {number} currentDensity_mA_m2 - Densité (mA/m²)
         * @returns {number} Courant en A
         */
        computeSurfaceCurrent: function(surfaceM2, currentDensity_mA_m2) {
            const surface = safeNumber(surfaceM2, 0);
            const density = safeNumber(currentDensity_mA_m2, 0);
            if (surface <= 0 || density <= 0) return 0;
            return (surface * density) / 1000;
        },

        // --------------------------------------------------------
        // 3.4 PIPELINES DEPUIS INDEXEDDB (async)
        // --------------------------------------------------------

        /**
         * Charge les pipelines d'un projet depuis IndexedDB.
         * Force la lecture fraîche (ignore le cache mémoire).
         *
         * Utile pour les modules qui doivent garantir la fraîcheur
         * des données (Test Posts, PDF, etc.).
         *
         * @param {string} projectId
         * @returns {Promise<Array<Object>>}
         */
        loadPipelinesFromIndexedDB: async function(projectId) {
            if (!projectId || projectId === '__all__') return [];

            if (typeof window.StorageManager === 'undefined' ||
                typeof window.StorageManager.loadEquipmentsForProject !== 'function') {
                console.warn('[DataResolver] StorageManager indisponible, fallback state.');
                return this.getProjectPipelines(projectId);
            }

            let equipments = [];
            try {
                equipments = await window.StorageManager.loadEquipmentsForProject(
                    projectId,
                    true // forceRefresh
                );
            } catch (e) {
                console.warn('[DataResolver] loadEquipmentsForProject error:', e.message);
                return this.getProjectPipelines(projectId);
            }

            // Fallback : si vide, essayer via state.equipments
            if (!Array.isArray(equipments) || equipments.length === 0) {
                equipments = this.getProjectPipelines(projectId);
            }

            if (!Array.isArray(equipments)) return [];

            return equipments.filter(function(eq) {
                return eq && PIPELINE_TYPES.indexOf(eq.type) !== -1;
            });
        },

        /**
         * Version async de resolveLengthForTestPosts qui utilise
         * IndexedDB comme source prioritaire.
         *
         * @param {string} projectId
         * @param {string} [pipelineId]
         * @returns {Promise<{lengthKm: number, source: string}>}
         */
        resolveLengthFromIndexedDB: async function(projectId, pipelineId) {
            if (!projectId || projectId === '__all__') {
                return { lengthKm: 0, source: 'none' };
            }

            const pipelines = await this.loadPipelinesFromIndexedDB(projectId);

            // Cas A : pipeline explicite
            if (pipelineId) {
                const pipeline = pipelines.find(function(p) {
                    return p && p.id === pipelineId;
                });
                if (pipeline) {
                    return {
                        lengthKm: this.getPipelineLengthKm(pipeline),
                        source: 'pipeline'
                    };
                }
            }

            // Cas B / C : depuis les pipelines du projet
            if (pipelines.length === 0) {
                return { lengthKm: 0, source: 'none' };
            }
            if (pipelines.length === 1) {
                return {
                    lengthKm: this.getPipelineLengthKm(pipelines[0]),
                    source: 'single-pipeline'
                };
            }

            let totalM = 0;
            const self = this;
            pipelines.forEach(function(p) {
                totalM += self.getPipelineLengthM(p);
            });
            return {
                lengthKm: totalM / 1000,
                source: 'project-total'
            };
        },

        // --------------------------------------------------------
        // 3.5 MÉTADONNÉES
        // --------------------------------------------------------

        /**
         * Retourne les métadonnées du module (diagnostic).
         * @returns {Object}
         */
        getMetadata: function() {
            return {
                version: this.VERSION,
                pipelineTypes: PIPELINE_TYPES.slice(),
                systemPriority: SYSTEM_TYPE_PRIORITY.slice(),
                currentSources: Object.assign({}, CURRENT_SOURCE),
                dependencies: {
                    ProjectManager: typeof window.ProjectManager !== 'undefined',
                    StorageManager: typeof window.StorageManager !== 'undefined',
                    CoordSystem: typeof window.CoordSystem !== 'undefined',
                    GeoUtils: typeof window.GeoUtils !== 'undefined',
                    Utils: typeof window.Utils !== 'undefined'
                }
            };
        }
    };

    // ============================================================
    // 4. EXPOSITION GLOBALE
    // ============================================================
    window.DataResolver = DataResolver;

    // Extension optionnelle de CPController (si présent)
    // pour faciliter l'accès depuis les contrôleurs.
    if (typeof window.CPController !== 'undefined') {
        window.CPController.getProjectPipelines = function(projectId) {
            return DataResolver.getProjectPipelines(projectId);
        };
        window.CPController.getPipelineLengthKm = function(pipelineOrId) {
            const p = (typeof pipelineOrId === 'string')
                ? DataResolver.getPipelineById(pipelineOrId)
                : pipelineOrId;
            return DataResolver.getPipelineLengthKm(p);
        };
        window.CPController.getProjectTotalLengthKm = function(projectId) {
            return DataResolver.getProjectTotalLengthKm(projectId);
        };
        window.CPController.getPreferredSystem = function(projectId) {
            return DataResolver.getPreferredSystem(projectId);
        };
        window.CPController.resolvePreferredCurrent = function(options) {
            return DataResolver.resolvePreferredCurrent(options);
        };
    }

    // ============================================================
    // 5. LOG DE DÉMARRAGE
    // ============================================================
    console.log('[DataResolver] ===================================================');
    console.log('[DataResolver] v' + DataResolver.VERSION + ' — API officielle de resolution');
    console.log('[DataResolver] ===================================================');
    console.log('[DataResolver] API disponible :');
    console.log('[DataResolver]   - getProjectPipelines(projectId)');
    console.log('[DataResolver]   - getPipelineById(pipelineId)');
    console.log('[DataResolver]   - getPipelineLengthM(pipeline)');
    console.log('[DataResolver]   - getPipelineLengthKm(pipeline)');
    console.log('[DataResolver]   - getProjectTotalLengthKm(projectId)');
    console.log('[DataResolver]   - resolveLengthForTestPosts(projectId, pipelineId)');
    console.log('[DataResolver]   - loadPipelinesFromIndexedDB(projectId) [async]');
    console.log('[DataResolver]   - resolveLengthFromIndexedDB(projectId, pipelineId) [async]');
    console.log('[DataResolver]   - getProjectSystems(projectId)');
    console.log('[DataResolver]   - getSystemForPipeline(pipelineId)');
    console.log('[DataResolver]   - getPreferredSystem(projectId)');
    console.log('[DataResolver]   - resolveSystem(projectId, pipelineId)');
    console.log('[DataResolver]   - resolvePreferredCurrent(options)');
    console.log('[DataResolver]   - computeSurfaceCurrent(surfaceM2, density)');
    console.log('[DataResolver]   - getMetadata()');
    console.log('[DataResolver] ===================================================');

})();

// ============================================================
// FIN DE dataResolver.js (VERSION 2.0)
// ============================================================