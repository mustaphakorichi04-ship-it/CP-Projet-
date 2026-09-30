// ============================================================
// ICCPOptimizationEngine.js – CP Engineer Pro
// Moteur d'optimisation des positions du TR et du puits anodique
// Version 2.5 – INTÉGRATION DES PATCHES (v3.1 + cable-sync)
// ============================================================
// CORRECTIONS v2.5 (INTÉGRATION DES PATCHES) :
//   ✅ ICCPOptimizationEngine-v3-patch.js v3.1 → _applyOptimalGB()
//      Réécriture complète de la méthode avec :
//        - Résolution dynamique de targetCurrent (ICCP > CP)
//        - Synchronisation state.groundbeds[] ET state.groundbed.results
//        - Association au système actif avec targetCurrent
//        - Sync UI (gbTargetCurrent) avec feedback visuel vert
//
//   ✅ iccp-cable-sync-patch.js v1.1 (partie ICCPOptimizationEngine)
//      → _displayResultsInUI() appelle UI.syncCableCurrentFromICCP()
//        en fin de méthode pour pré-remplir #cableCurrent
//
// CORRECTIONS v2.4 (conservées) :
//   P0-02 : Unités canoniques (J_anode_mA propagé depuis engine v8.5)
//   P0-03 : lifeDesign propagé dans _applyOptimalGB
//   P0-04 : R_groundbed_pure / R_well utilisés explicitement
//   P0-05 : rhoProject / rhoGroundbed / rho_eff propagés
//   P1-02 : powerDesign utilisé dans _displayResultsInUI et _exportReport
//   P1-05 : lifeDesign / lifeTheoretical distingués dans _exportReport
//   v2.3  : _applyOptimalGB transmet projectId en 5e paramètre
//   v2.2  : P0-04b / P2-01 / P2-03 (via engine.js v8.4)
//   v2.1  : P1-03 section pipeline corrigée (π/4 × [D² - (D-2t)²])
// ============================================================

(function() {
    'use strict';

    /**
     * Moteur d'optimisation ICCP
     * Détermine les positions optimales du transformateur-redresseur (TR)
     * et du deep well groundbed pour les pipelines d'un projet donné.
     */
    const ICCPOptimizationEngine = {

        // Version du moteur d'optimisation ICCP (cycle de vie indépendant)
        VERSION: '2.5.0',

        // ============================================================
        // 1. CONFIGURATION & CONSTANTES
        // ============================================================

        /**
         * Données par défaut des pipelines pour PROJ-001 (fallback legacy).
         * N'est utilisé QUE si l'utilisateur travaille explicitement sur PROJ-001
         * et qu'aucun pipeline n'a été chargé depuis IndexedDB.
         */
        PIPELINES: {
            'EMK-42': {
                id: 'EMK-42',
                coordinates: [
                    { lat: 30.162156, lon: 8.050464 },
                    { lat: 30.161586, lon: 8.050122 },
                    { lat: 30.161231, lon: 8.054703 },
                    { lat: 30.160539, lon: 8.055417 },
                    { lat: 30.160244, lon: 8.060528 },
                    { lat: 30.162936, lon: 8.066114 },
                    { lat: 30.166556, lon: 8.067347 },
                    { lat: 30.172881, lon: 8.074397 },
                    { lat: 30.174708, lon: 8.076975 },
                    { lat: 30.175325, lon: 8.078672 },
                    { lat: 30.174283, lon: 8.087736 },
                    { lat: 30.189231, lon: 8.106906 },
                    { lat: 30.186967, lon: 8.097372 }
                ],
                diameter_m: 0.610,
                coatingEfficiency: 0.95,
                currentDensity: 10,
                defectDensity: 0.05,
                agingFactor: 1.2,
                soilResistivity: 100,
                norm: 'ISO 15589-1'
            },
            'EME-14': {
                id: 'EME-14',
                coordinates: [
                    { lat: 30.162011, lon: 8.050336 },
                    { lat: 30.162086, lon: 8.049519 },
                    { lat: 30.161578, lon: 8.049389 },
                    { lat: 30.160122, lon: 8.050747 },
                    { lat: 30.157697, lon: 8.050875 },
                    { lat: 30.153636, lon: 8.047667 },
                    { lat: 30.153111, lon: 8.047486 },
                    { lat: 30.148836, lon: 8.051528 }
                ],
                diameter_m: 0.410,
                coatingEfficiency: 0.96,
                currentDensity: 10,
                defectDensity: 0.04,
                agingFactor: 1.2,
                soilResistivity: 100,
                norm: 'ISO 15589-1'
            },
            'EMN-11': {
                id: 'EMN-11',
                coordinates: [
                    { lat: 30.285417, lon: 8.085167 },
                    { lat: 30.284500, lon: 8.086722 },
                    { lat: 30.283583, lon: 8.087028 },
                    { lat: 30.283389, lon: 8.087167 },
                    { lat: 30.282472, lon: 8.087139 },
                    { lat: 30.278139, lon: 8.085056 },
                    { lat: 30.278111, lon: 8.084806 },
                    { lat: 30.278056, lon: 8.084306 },
                    { lat: 30.272944, lon: 8.084222 },
                    { lat: 30.272972, lon: 8.085361 },
                    { lat: 30.272194, lon: 8.089306 },
                    { lat: 30.272000, lon: 8.089333 },
                    { lat: 30.269472, lon: 8.093083 },
                    { lat: 30.268694, lon: 8.093333 },
                    { lat: 30.267622, lon: 8.093325 },
                    { lat: 30.266806, lon: 8.093417 },
                    { lat: 30.263861, lon: 8.093528 },
                    { lat: 30.259111, lon: 8.093472 },
                    { lat: 30.258917, lon: 8.092342 }
                ],
                diameter_m: 0.300,
                coatingEfficiency: 0.95,
                currentDensity: 10,
                defectDensity: 0.05,
                agingFactor: 1.2,
                soilResistivity: 80,
                norm: 'ISO 15589-1'
            }
        },

        /** Paramètres CP par défaut */
        DEFAULT_CP_PARAMS: {
            currentDensity: 10,
            coatingEfficiency: 0.95,
            defectDensity: 0.05,
            agingFactor: 1.2,
            targetPotential: -850,
            norm: 'ISO 15589-1'
        },

        /** Paramètres d'optimisation */
        OPTIMIZATION_PARAMS: {
            gridStepDeg: 0.002,
            gridPadding: 0.02,
            minTR_GB_Distance: 200,
            maxTR_GB_Distance: 5000,
            weightUniformity: 0.35,
            weightCurrent: 0.25,
            weightAttenuation: 0.20,
            weightLosses: 0.10,
            weightInterference: 0.05,
            weightDistancePenalty: 0.05,
            // Contraintes de position du deep-well groundbed.
            // Une valeur nulle conserve le comportement historique ; une valeur
            // positive doit être fournie/validée par l'étude d'implantation.
            groundbedMinStructureDistance: 200,
            groundbedMaxStructureDistance: Infinity
        },

        /**
         * Épaisseur de paroi par défaut pour les pipelines (m).
         * Utilisée dans _computeAttenuationConstant lorsque aucune
         * épaisseur spécifique n'est disponible sur l'équipement.
         * Valeur typique pour pipeline acier transport hydrocarbures.
         */
        DEFAULT_WALL_THICKNESS_M: 0.008,

        /**
         * Résistivité électrique de l'acier (Ω·m).
         * Valeur standard pour acier au carbone (API 5L).
         */
        RHO_STEEL_OHM_M: 1.7e-7,

        /**
         * Paramètres groundbed par défaut utilisés lorsqu'on doit
         * pré-calculer un groundbed optimal (P0-04b / v2.2).
         *
         * P0-05 : rhoProject distinct de rhoGroundbed.
         */
        DEFAULT_GROUNDBED_PARAMS: {
            rho: 30,
            rhoProject: 100,
            rhoGroundbed: 30,
            totalDepth: 200,
            activeDepth: 150,
            anodeCount: 16,
            anodeLength: 1.5,
            anodeDiameter: 75,
            anodeWeight: 25,
            anodeCapacity: 2.5,
            cableLength: 100,
            cableSection: 35,
            agingFactor: 1.2,
            safetyFactor: 1.1,
            targetCurrent: 0,
            structureResistance: 0.02,
            boreholeDiameter: 300,
            desiredLife: 25,
            anodeType: 'mmo'
        },

        // ============================================================
        // 2. MÉTHODES UTILITAIRES
        // ============================================================

        _getActiveProjectId: function() {
            if (typeof ProjectManager === 'undefined' || typeof ProjectManager.getCurrentProjectId !== 'function') {
                throw new Error('ProjectManager non disponible. Impossible de déterminer le projet actif.');
            }
            const id = ProjectManager.getCurrentProjectId();
            if (!id || id === '__all__') {
                throw new Error('Aucun projet actif. Sélectionnez un projet unique (pas "Tous les projets") avant d\'optimiser.');
            }
            return id;
        },

        _getActiveProjectName: function() {
            try {
                if (typeof ProjectManager === 'undefined') return 'N/A';
                const state = ProjectManager.getState();
                return (state && state.project && state.project.name) ? state.project.name : 'N/A';
            } catch (e) {
                return 'N/A';
            }
        },

        _getProjectSoilResistivity: function() {
            try {
                if (typeof ProjectManager === 'undefined') return 100;
                const state = ProjectManager.getState();
                if (state && state.project) {
                    if (state.project.shared && typeof state.project.shared.soilResistivity === 'number') {
                        return state.project.shared.soilResistivity;
                    }
                    if (typeof state.project.resistivity === 'number') {
                        return state.project.resistivity;
                    }
                }
            } catch (e) {
                console.warn('[ICCPOptimization] Erreur _getProjectSoilResistivity:', e.message);
            }
            return 100;
        },

        _getGroundbedFormationResistivity: function() {
            try {
                if (typeof ProjectManager === 'undefined') return this._getProjectSoilResistivity();
                const state = ProjectManager.getState();
                if (state && state.project && state.project.shared) {
                    const gbRho = state.project.shared.groundbedFormationResistivity;
                    if (typeof gbRho === 'number' && gbRho > 0) {
                        return gbRho;
                    }
                }
            } catch (e) {
                console.warn('[ICCPOptimization] Erreur _getGroundbedFormationResistivity:', e.message);
            }
            return this._getProjectSoilResistivity();
        },

        _haversineDistance: function(lat1, lon1, lat2, lon2) {
            const R = 6371000;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                      Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        },

        _pipelineLength: function(coords) {
            if (!coords || coords.length < 2) return 0;
            let total = 0;
            for (let i = 0; i < coords.length - 1; i++) {
                total += this._haversineDistance(
                    coords[i].lat, coords[i].lon,
                    coords[i + 1].lat, coords[i + 1].lon
                );
            }
            return total;
        },

        _computeExposedArea: function(pipeline) {
            const length = this._pipelineLength(pipeline.coordinates);
            const diameter = pipeline.diameter_m || 0.3;
            const surface = Math.PI * diameter * length;
            const eps = pipeline.coatingEfficiency || 0.95;
            const DF = pipeline.defectDensity || 0.05;
            const k = pipeline.agingFactor || 1.2;
            return surface * (1 - eps) * DF * k;
        },

        _computeCurrentDemand: function(pipeline) {
            if (typeof CalculationEngine === 'undefined' ||
                typeof CalculationEngine.requiredCurrent !== 'function') {
                throw new Error('CalculationEngine.requiredCurrent est requis pour l\'optimisation ICCP.');
            }

            const length = this._pipelineLength(pipeline.coordinates);
            const diameter = pipeline.diameter_m ?? 0.3;
            const surface = Math.PI * diameter * length;
            const J = pipeline.currentDensity ?? 10;
            const eps = pipeline.coatingEfficiency ?? 0.95;
            const DF = pipeline.defectDensity ?? 0.05;
            const k = pipeline.agingFactor ?? 1.2;
            const result = CalculationEngine.requiredCurrent(
                surface,
                J,
                eps,
                DF,
                k,
                pipeline.norm || 'ISO 15589-1'
            );
            return result.currentAmperes;
        },

        /**
         * Convertit les équipements non-pipeline pertinents pour la protection
         * cathodique en structures géométriques consommables par l'optimiseur.
         * Le fond d'un réservoir est représenté par son centre et des points
         * périphériques afin d'éviter une optimisation sur un seul centroïde.
         */
        _equipmentsToProtectedStructures: function(equipments) {
            const protectedTypes = new Set([
                'reservoir_fond', 'reservoir_toit', 'tank', 'reservoir'
            ]);
            const structures = [];

            (equipments || []).forEach(eq => {
                if (!eq || !protectedTypes.has(String(eq.type || '').toLowerCase())) return;

                let coordinates = eq.coordinates || [];
                if (typeof coordinates === 'string') {
                    try { coordinates = JSON.parse(coordinates); } catch (e) { coordinates = []; }
                }
                const center = Array.isArray(coordinates)
                    ? coordinates[0]
                    : coordinates;
                if (!center || !isFinite(Number(center.lat)) || !isFinite(Number(center.lon))) return;

                const lat = Number(center.lat);
                const lon = Number(center.lon);
                const diameter = Number(eq.dimensions?.diametre_m || eq.diameter || 0);
                const points = [{ lat, lon }];
                if (diameter > 0) {
                    // Approximation locale suffisante pour la génération de
                    // candidats ; les calculs de courant restent ceux du moteur.
                    const radiusDegLat = (diameter / 2) / 111320;
                    const cosLat = Math.max(0.2, Math.cos(lat * Math.PI / 180));
                    const radiusDegLon = radiusDegLat / cosLat;
                    for (let i = 0; i < 16; i++) {
                        const angle = (2 * Math.PI * i) / 16;
                        points.push({
                            lat: lat + radiusDegLat * Math.sin(angle),
                            lon: lon + radiusDegLon * Math.cos(angle)
                        });
                    }
                }

                let currentRequired = 0;
                try {
                    if (typeof CalculationEngine !== 'undefined' &&
                        typeof CalculationEngine.calculateEquipmentResistances === 'function' &&
                        typeof CalculationEngine.requiredCurrent === 'function') {
                        const resistances = CalculationEngine.calculateEquipmentResistances(
                            eq,
                            Number(eq.soilResistivity) > 0 ? Number(eq.soilResistivity) : undefined
                        );
                        const area = Number(resistances?.soilContactArea || resistances?.surfaceArea || 0);
                        const density = Number(eq.currentDensity ?? 10);
                        const efficiency = Number(eq.coatingEfficiency ?? 0.95);
                        const defectDensity = Number(eq.defectDensity ?? 0.05);
                        const agingFactor = Number(eq.agingFactor ?? 1.2);
                        if (area > 0 && density > 0) {
                                    currentRequired = CalculationEngine.requiredCurrent(
                                area, density, efficiency, defectDensity,
                                agingFactor, eq.norm || 'API RP 651'
                            ).currentAmperes;
                        }
                    }
                } catch (e) {
                    console.warn('[ICCPOptimization] Courant réservoir non calculé:', e.message);
                }

                structures.push({
                    id: eq.tag || eq.id,
                    type: 'tank_bottom',
                    sourceType: eq.type,
                    coordinates: points,
                    diameter: diameter,
                    currentRequired,
                    criticality: Number(eq.criticality) > 0 ? Number(eq.criticality) : 1,
                    soilResistivity: Number(eq.soilResistivity) > 0 ? Number(eq.soilResistivity) : null,
                    surfaceArea: Number((typeof CalculationEngine !== 'undefined' &&
                        typeof CalculationEngine.calculateEquipmentResistances === 'function')
                        ? (CalculationEngine.calculateEquipmentResistances(eq)?.soilContactArea || 0)
                        : (diameter > 0 ? (Math.PI * diameter * diameter / 4) : 0))
                });
            });
            return structures;
        },

        _structurePoints: function(structure) {
            return Array.isArray(structure?.coordinates) ? structure.coordinates : [];
        },

        _distanceToStructure: function(position, structure, mode) {
            const points = this._structurePoints(structure);
            if (!points.length) return Infinity;
            const distances = points.map(point => this._haversineDistance(
                position.lat, position.lon, point.lat, point.lon
            ));
            if (mode === 'min') return Math.min(...distances);
            return distances.reduce((sum, value) => sum + value, 0) / distances.length;
        },

        _structureCurrentDemand: function(structure) {
            const value = Number(structure?.currentRequired);
            return Number.isFinite(value) && value > 0 ? value : 0;
        },

        _isGroundbedPositionAllowed: function(position, structures, params) {
            const minimumDistance = Number(params?.groundbedMinStructureDistance) || 0;
            if (minimumDistance <= 0) return true;
            return structures.every(structure =>
                this._distanceToStructure(position, structure, 'min') >= minimumDistance
            );
        },

        /**
         * Purpose: Calcule la section transversale métallique d'un tuyau
         *          cylindrique à paroi d'épaisseur t.
         */
        _computePipeCrossSection: function(outerDiameter, wallThickness) {
            const D = parseFloat(outerDiameter);
            const t = parseFloat(wallThickness);
            if (!isFinite(D) || D <= 0) return 0;
            if (!isFinite(t) || t <= 0) return 0;
            const innerDiameter = D - 2 * t;
            if (innerDiameter <= 0) {
                console.warn('[ICCPOptimization] Épaisseur de paroi invalide (> D/2)');
                return Math.PI * (D / 2) * (D / 2);
            }
            const A = Math.PI / 4 * (D * D - innerDiameter * innerDiameter);
            return isFinite(A) && A > 0 ? A : 0;
        },

        _computeAttenuationConstant: function(pipeline, rho_soil) {
            const length = this._pipelineLength(pipeline.coordinates);
            if (!isFinite(length) || length <= 0) return 0;

            const diameter = pipeline.diameter_m || 0.3;
            if (!isFinite(diameter) || diameter <= 0) return 0;

            const wallThickness = (isFinite(pipeline.wallThickness_m) && pipeline.wallThickness_m > 0)
                ? pipeline.wallThickness_m
                : this.DEFAULT_WALL_THICKNESS_M;

            const crossSection = this._computePipeCrossSection(diameter, wallThickness);
            if (!isFinite(crossSection) || crossSection <= 0) {
                console.warn('[ICCPOptimization] Section pipeline invalide pour ' +
                             (pipeline.id || 'pipeline inconnu'));
                return 0;
            }

            const rho_steel = this.RHO_STEEL_OHM_M;
            const R_long = rho_steel / crossSection;

            const r = diameter / 2;
            if (!isFinite(r) || r <= 0) return 0;

            const ratio_4L_over_r = 4 * length / r;
            if (ratio_4L_over_r <= 1) return 0;
            const R_fuite = (rho_soil / (2 * Math.PI * length)) * Math.log(ratio_4L_over_r);

            const R_fuite_lin = R_fuite * length;
            if (!isFinite(R_fuite_lin) || R_fuite_lin <= 0) return 0;

            const alpha = Math.sqrt(R_long / R_fuite_lin);
            return isFinite(alpha) && alpha > 0 ? alpha : 0;
        },

        _currentAtDistance: function(I0, alpha, x) {
            if (alpha <= 0) return I0;
            return I0 * Math.exp(-alpha * x);
        },

        _computeScore: function(trPos, gbPos, pipelines, params, protectedStructures) {
            const w = params || this.OPTIMIZATION_PARAMS;
        const structures = (protectedStructures && protectedStructures.length)
                ? protectedStructures
                : pipelines.map(p => ({
                    id: p.id,
                    type: 'pipeline',
                    coordinates: p.coordinates,
                    currentRequired: this._computeCurrentDemand(p),
                    weight: this._pipelineLength(p.coordinates),
                    criticality: 1
                }));

            const distances = structures.map(s => this._distanceToStructure(trPos, s, 'average'));
            if (!distances.length) return 0;
            const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;
            const uniformity = 1 / (1 + distances.reduce((a, b) => a + Math.pow(b - avgDist, 2), 0) / (distances.length * 1000));

            let totalCurrent = 0;
            let totalLength = 0;
            structures.forEach(s => {
                const I_req = this._structureCurrentDemand(s);
                const d = this._distanceToStructure(trPos, s, 'average');
                const I_recv = I_req / (1 + d / 1000);
                const weight = Number(s.weight) > 0
                    ? Number(s.weight)
                    : (Number(s.criticality) > 0 ? Number(s.criticality) : 1);
                totalCurrent += I_recv * weight;
                totalLength += weight;
            });
            const currentScore = totalLength > 0 ? totalCurrent / totalLength : 0;

            let attenuationPenalty = 0;
            pipelines.forEach(p => {
                const first = p.coordinates[0];
                const last = p.coordinates[p.coordinates.length - 1];
                const d1 = this._haversineDistance(trPos.lat, trPos.lon, first.lat, first.lon);
                const d2 = this._haversineDistance(trPos.lat, trPos.lon, last.lat, last.lon);
                const maxDist = Math.max(d1, d2);
                if (maxDist > 5000) {
                    attenuationPenalty += (maxDist - 5000) / 10000;
                }
            });
            const attenuationScore = 1 / (1 + attenuationPenalty);

            const dTR_GB = this._haversineDistance(trPos.lat, trPos.lon, gbPos.lat, gbPos.lon);
            let lossesPenalty = 0;
            if (dTR_GB < w.minTR_GB_Distance) {
                lossesPenalty += (w.minTR_GB_Distance - dTR_GB) / w.minTR_GB_Distance;
            } else if (dTR_GB > w.maxTR_GB_Distance) {
                lossesPenalty += (dTR_GB - w.maxTR_GB_Distance) / w.maxTR_GB_Distance;
            }
            const lossesScore = 1 / (1 + lossesPenalty);

            let interferencePenalty = 0;
            structures.forEach(s => {
                const d = this._distanceToStructure(gbPos, s, 'min');
                const minimumDistance = Number(w.groundbedMinStructureDistance) > 0
                    ? Number(w.groundbedMinStructureDistance) : 50;
                if (d < minimumDistance) {
                    interferencePenalty += (minimumDistance - d) / minimumDistance;
                }
                if (Number.isFinite(Number(w.groundbedMaxStructureDistance)) &&
                    Number(w.groundbedMaxStructureDistance) > 0 &&
                    d > Number(w.groundbedMaxStructureDistance)) {
                    interferencePenalty += (d - Number(w.groundbedMaxStructureDistance)) /
                        Number(w.groundbedMaxStructureDistance);
                }
            });
            const interferenceScore = 1 / (1 + interferencePenalty);

            const bbox = this._computeBoundingBox(structures);
            const centerLat = (bbox.minLat + bbox.maxLat) / 2;
            const centerLon = (bbox.minLon + bbox.maxLon) / 2;
            const dTR_center = this._haversineDistance(trPos.lat, trPos.lon, centerLat, centerLon);
            const dGB_center = this._haversineDistance(gbPos.lat, gbPos.lon, centerLat, centerLon);
            const distancePenalty = (dTR_center + dGB_center) / 100000;

            const score = w.weightUniformity * uniformity +
                          w.weightCurrent * currentScore +
                          w.weightAttenuation * attenuationScore +
                          w.weightLosses * lossesScore +
                          w.weightInterference * interferenceScore -
                          w.weightDistancePenalty * distancePenalty;

            return Math.max(0, Math.min(1, score));
        },

        _computeCentroid: function(coords) {
            if (!coords || coords.length === 0) return { lat: 0, lon: 0 };
            let sumLat = 0, sumLon = 0;
            coords.forEach(p => {
                sumLat += p.lat;
                sumLon += p.lon;
            });
            return { lat: sumLat / coords.length, lon: sumLon / coords.length };
        },

        _computeBoundingBox: function(structures) {
            let minLat = Infinity, maxLat = -Infinity;
            let minLon = Infinity, maxLon = -Infinity;
            structures.forEach(p => {
                (p.coordinates || []).forEach(c => {
                    if (c.lat < minLat) minLat = c.lat;
                    if (c.lat > maxLat) maxLat = c.lat;
                    if (c.lon < minLon) minLon = c.lon;
                    if (c.lon > maxLon) maxLon = c.lon;
                });
            });
            return { minLat, maxLat, minLon, maxLon };
        },

        _generateGrid: function(bbox, step, padding) {
            const latMin = bbox.minLat - padding;
            const latMax = bbox.maxLat + padding;
            const lonMin = bbox.minLon - padding;
            const lonMax = bbox.maxLon + padding;
            const points = [];
            for (let lat = latMin; lat <= latMax; lat += step) {
                for (let lon = lonMin; lon <= lonMax; lon += step) {
                    points.push({ lat, lon });
                }
            }
            return points;
        },

        // ============================================================
        // 3. OPTIMISATION
        // ============================================================

        optimize: function(options) {
            options = options || {};

            let pipelines = options.pipelines;
            if (!pipelines || pipelines.length === 0) {
                const currentProjectId = (typeof ProjectManager !== 'undefined' && ProjectManager.getCurrentProjectId)
                    ? ProjectManager.getCurrentProjectId()
                    : null;

                if (currentProjectId && currentProjectId !== 'PROJ-001') {
                    throw new Error(
                        `Aucun pipeline valide trouvé pour le projet ${currentProjectId}. ` +
                        `Ajoutez des équipements de type "pipeline_enterre" avec coordonnées GPS avant d'optimiser.`
                    );
                }
                pipelines = Object.values(this.PIPELINES);
            }

            const cpParams = { ...this.DEFAULT_CP_PARAMS, ...options.cpParams };
            pipelines = pipelines.map(p => ({
                ...p,
                currentDensity: p.currentDensity || cpParams.currentDensity,
                coatingEfficiency: p.coatingEfficiency || cpParams.coatingEfficiency,
                defectDensity: p.defectDensity || cpParams.defectDensity,
                agingFactor: p.agingFactor || cpParams.agingFactor,
                targetPotential: p.targetPotential || cpParams.targetPotential,
                norm: p.norm || cpParams.norm
            }));

            const optimParams = { ...this.OPTIMIZATION_PARAMS, ...options.optimParams };
            const protectedStructures = Array.isArray(options.protectedStructures)
                ? options.protectedStructures : [];
            const pipelineStructures = pipelines.map(p => ({
                id: p.id,
                type: 'pipeline',
                coordinates: p.coordinates,
                currentRequired: this._computeCurrentDemand(p),
                weight: this._pipelineLength(p.coordinates),
                criticality: 1
            }));
            const structures = pipelineStructures.concat(protectedStructures);

            const totalCurrent = structures.reduce((sum, structure) =>
                sum + this._structureCurrentDemand(structure), 0);
            const totalSurface = pipelines.reduce((sum, p) => sum + this._computeExposedArea(p), 0) +
                protectedStructures.reduce((sum, structure) => sum + (Number(structure.surfaceArea) || 0), 0);

            const bbox = this._computeBoundingBox(structures);
            const padding = optimParams.gridPadding;
            const step = optimParams.gridStepDeg;
            const gridPoints = this._generateGrid(bbox, step, padding);

            if (gridPoints.length === 0) {
                throw new Error('Aucun point de grille généré. Vérifiez les coordonnées des pipelines.');
            }

            const gbInitial = this._computeCentroid(
                structures.reduce((acc, structure) => acc.concat(structure.coordinates || []), [])
            );

            let bestTR = null;
            let bestTRScore = -Infinity;

            gridPoints.forEach(point => {
                const score = this._computeScore(point, gbInitial, pipelines, optimParams, structures);
                if (score > bestTRScore) {
                    bestTRScore = score;
                    bestTR = { ...point };
                }
            });

            let bestGB = null;
            let bestGBScore = -Infinity;

            gridPoints.forEach(point => {
                const d = this._haversineDistance(bestTR.lat, bestTR.lon, point.lat, point.lon);
                if (d < optimParams.minTR_GB_Distance || d > optimParams.maxTR_GB_Distance ||
                    !this._isGroundbedPositionAllowed(point, structures, optimParams)) {
                    return;
                }
                const score = this._computeScore(bestTR, point, pipelines, optimParams, structures);
                if (score > bestGBScore) {
                    bestGBScore = score;
                    bestGB = { ...point };
                }
            });

            if (!bestGB) {
                gridPoints.forEach(point => {
                    const score = this._computeScore(bestTR, point, pipelines, optimParams, structures);
                    if (score > bestGBScore) {
                        bestGBScore = score;
                        bestGB = { ...point };
                    }
                });
            }

            const refined = this._localSearch(bestTR, bestGB, pipelines, optimParams, 5, structures);

            let results = {
                tr: refined.tr,
                groundbed: refined.gb,
                score: refined.score,
                totalCurrent: totalCurrent,
                totalSurface: totalSurface,
                pipelines: pipelines.map(p => {
                    const length = this._pipelineLength(p.coordinates);
                    const I_req = this._computeCurrentDemand(p);
                    const centroid = this._computeCentroid(p.coordinates);
                    const dTR = this._haversineDistance(refined.tr.lat, refined.tr.lon, centroid.lat, centroid.lon);
                    const dGB = this._haversineDistance(refined.gb.lat, refined.gb.lon, centroid.lat, centroid.lon);
                    const alpha = this._computeAttenuationConstant(p, p.soilResistivity || 100);
                    const I_at_centroid = this._currentAtDistance(I_req, alpha, dTR);
                    return {
                        id: p.id,
                        length: length,
                        currentRequired: I_req,
                        distanceToTR: dTR,
                        distanceToGB: dGB,
                        currentAtCentroid: I_at_centroid,
                        attenuationConstant: alpha,
                        coordinates: p.coordinates
                    };
                }),
                bbox: bbox,
                gridPoints: gridPoints.length,
                protectedStructures: protectedStructures.map(structure => ({
                    id: structure.id,
                    type: structure.type,
                    sourceType: structure.sourceType,
                    diameter: structure.diameter,
                    surfaceArea: structure.surfaceArea,
                    currentRequired: structure.currentRequired,
                    distanceToTR: this._distanceToStructure(refined.tr, structure, 'min'),
                    distanceToGB: this._distanceToStructure(refined.gb, structure, 'min'),
                    coordinates: structure.coordinates
                })),
                positionChecks: {
                    trGroundbedDistance: this._haversineDistance(
                        refined.tr.lat, refined.tr.lon, refined.gb.lat, refined.gb.lon
                    ),
                    groundbedMinStructureDistance: Math.min(...structures.map(structure =>
                        this._distanceToStructure(refined.gb, structure, 'min'))),
                    groundbedMaxStructureDistance: Math.max(...structures.map(structure =>
                        this._distanceToStructure(refined.gb, structure, 'min'))),
                    groundbedPositionCompliant: this._isGroundbedPositionAllowed(
                        refined.gb, structures, optimParams
                    )
                },
                optimParams: optimParams
            };

            if (typeof CableLengthEngine !== 'undefined'
                && typeof CableLengthEngine.enrichWithCableLengths === 'function') {
                try {
                    results = CableLengthEngine.enrichWithCableLengths(results, {
                        marginPercent: 10,
                        negativeStrategy: 'worst'
                    });
                } catch (e) {
                    console.warn('[ICCPOptimization] Calcul longueurs câbles échoué:', e);
                }
            }

            return results;
        },

        _localSearch: function(tr, gb, pipelines, params, iterations, protectedStructures) {
            let bestTR = { ...tr };
            let bestGB = { ...gb };
            let bestScore = this._computeScore(bestTR, bestGB, pipelines, params, protectedStructures);

            const step = params.gridStepDeg / 2;
            for (let iter = 0; iter < iterations; iter++) {
                let improved = false;
                const offsets = [
                    [0, 0],
                    [step, 0], [-step, 0],
                    [0, step], [0, -step],
                    [step, step], [step, -step],
                    [-step, step], [-step, -step]
                ];
                for (const offsetTR of offsets) {
                    const candidateTR = {
                        lat: bestTR.lat + offsetTR[0],
                        lon: bestTR.lon + offsetTR[1]
                    };
                    for (const offsetGB of offsets) {
                        const candidateGB = {
                            lat: bestGB.lat + offsetGB[0],
                            lon: bestGB.lon + offsetGB[1]
                        };
                        const d = this._haversineDistance(candidateTR.lat, candidateTR.lon, candidateGB.lat, candidateGB.lon);
                        if (d < params.minTR_GB_Distance || d > params.maxTR_GB_Distance ||
                            !this._isGroundbedPositionAllowed(candidateGB, protectedStructures || [], params)) continue;
                        const score = this._computeScore(candidateTR, candidateGB, pipelines, params, protectedStructures);
                        if (score > bestScore) {
                            bestScore = score;
                            bestTR = candidateTR;
                            bestGB = candidateGB;
                            improved = true;
                        }
                    }
                }
                if (!improved) break;
            }

            return { tr: bestTR, gb: bestGB, score: bestScore };
        },

        // ============================================================
        // 4. MÉTHODES D'INTÉGRATION
        // ============================================================

        runForProject: async function(projectId, options) {
            const effectiveProjectId = projectId || this._getActiveProjectId();

            if (!effectiveProjectId) {
                throw new Error('Aucun projet actif. Sélectionnez un projet avant d\'optimiser.');
            }

            if (effectiveProjectId === 'PROJ-001') {
                if (typeof ProjectManager !== 'undefined') {
                    const state = ProjectManager.getState();
                    const equipments = state.equipments.filter(eq =>
                        eq.projectId === effectiveProjectId &&
                        (eq.type === 'pipeline_enterre' || eq.type === 'pipeline_offshore' ||
                         ['reservoir_fond', 'reservoir_toit', 'tank', 'reservoir'].includes(eq.type))
                    );

                    if (equipments.length > 0) {
                        const pipelines = this._equipmentsToPipelines(equipments);
                        if (pipelines.length > 0) {
                            return this.optimize({
                                ...options,
                                pipelines,
                                protectedStructures: this._equipmentsToProtectedStructures(equipments)
                            });
                        }
                    }
                }
                return this.optimize(options);
            }

            if (typeof ProjectManager !== 'undefined') {
                const state = ProjectManager.getState();
                const equipments = state.equipments.filter(eq =>
                    eq.projectId === effectiveProjectId &&
                    (eq.type === 'pipeline_enterre' || eq.type === 'pipeline_offshore' ||
                     ['reservoir_fond', 'reservoir_toit', 'tank', 'reservoir'].includes(eq.type))
                );

                if (equipments.length === 0) {
                    throw new Error(
                        `Aucun pipeline trouvé pour le projet ${effectiveProjectId}. ` +
                        `Ajoutez des pipelines avec coordonnées GPS dans le module "Équipements".`
                    );
                }

                const pipelines = this._equipmentsToPipelines(equipments);

                if (pipelines.length === 0) {
                    throw new Error(
                        `Aucun pipeline avec coordonnées valides pour le projet ${effectiveProjectId}.`
                    );
                }

                return this.optimize({
                    ...options,
                    pipelines,
                    protectedStructures: this._equipmentsToProtectedStructures(equipments)
                });
            }

            throw new Error('ProjectManager non disponible.');
        },

        _equipmentsToPipelines: function(equipments) {
            // FIX-RESERVOIR (2026-09-26) : Exclure les réservoirs/tanks de la liste des pipelines.
            // Ces équipements sont traités séparément dans _equipmentsToProtectedStructures()
            // et affichés avec le badge orange "Réservoir" (API 651 / NACE SP0193).
            // Sans ce filtre, Reservoir-1 apparaissait dans la liste des pipelines avec
            // une atténuation longitudinale (α) calculée à tort (N/A pour les structures concentrées).
            const RESERVOIR_TYPES = new Set(['reservoir_fond', 'reservoir_toit', 'tank', 'reservoir']);
            return equipments
                .filter(eq => !RESERVOIR_TYPES.has(String(eq.type || '').toLowerCase()))
                .map(eq => {
                const coords = eq.coordinates || [];
                let parsedCoords = coords;
                if (typeof coords === 'string') {
                    try { parsedCoords = JSON.parse(coords); } catch (e) { parsedCoords = []; }
                }
                if (!Array.isArray(parsedCoords) || parsedCoords.length === 0) {
                    if (parsedCoords && parsedCoords.lat !== undefined && parsedCoords.lon !== undefined) {
                        parsedCoords = [parsedCoords];
                    } else {
                        parsedCoords = [];
                    }
                }
                let wallThickness_m = null;
                if (eq.wallThickness && isFinite(eq.wallThickness) && eq.wallThickness > 0) {
                    wallThickness_m = eq.wallThickness / 1000;
                } else if (eq.dimensions && eq.dimensions.epaisseur_m &&
                           isFinite(eq.dimensions.epaisseur_m) && eq.dimensions.epaisseur_m > 0) {
                    wallThickness_m = eq.dimensions.epaisseur_m;
                }
                return {
                    id: eq.tag || eq.id,
                    coordinates: parsedCoords,
                    diameter_m: eq.dimensions?.diametre_m || 0.3,
                    wallThickness_m: wallThickness_m,
                    coatingEfficiency: eq.coatingEfficiency || 0.95,
                    currentDensity: eq.currentDensity || 10,
                    defectDensity: eq.defectDensity || 0.05,
                    agingFactor: eq.agingFactor || 1.2,
                    soilResistivity: eq.soilResistivity || 100,
                    norm: 'ISO 15589-1'
                };
            }).filter(p => p.coordinates.length >= 2);
        },

        updateUI: function(results) {
            if (typeof UI === 'undefined') return;

            if (UI.showToast) {
                UI.showToast(`✅ Optimisation ICCP terminée. Score: ${(results.score * 100).toFixed(1)}%`, 'success');
            }

            this._displayResultsInUI(results);
        },

        // ============================================================
        // _displayResultsInUI – v2.5
        //   + Ajout : appel UI.syncCableCurrentFromICCP() en fin
        //     (fusion iccp-cable-sync-patch v1.1)
        // ============================================================
        _displayResultsInUI: function(results) {
            const container = document.getElementById('iccpOptimizationResults');
            if (!container) return;

            const projectId = (typeof ProjectManager !== 'undefined' && ProjectManager.getCurrentProjectId)
                ? ProjectManager.getCurrentProjectId()
                : 'N/A';
            const projectName = this._getActiveProjectName();

            const rhoProject = this._getProjectSoilResistivity();
            const rhoGroundbed = this._getGroundbedFormationResistivity();
            const rhoDivergence = (rhoProject > 0 && rhoGroundbed > 0)
                ? Math.abs(rhoGroundbed - rhoProject) / Math.max(rhoProject, rhoGroundbed)
                : 0;

            let html = `
                <div class="card" style="margin-top: 1rem; border-color: var(--accent-cyan);">
                    <div class="card-header">
                        <h3><i class="fas fa-robot"></i> Optimisation ICCP — ${projectName} (${projectId})</h3>
                        <span class="badge success">Score: ${(results.score * 100).toFixed(1)}%</span>
                    </div>
                    <div class="card-body">

                        <div class="result-cards">
                            <div class="result-card highlight">
                                <span class="result-label">TR optimal</span>
                                <span class="result-value">${results.tr.lat.toFixed(6)}, ${results.tr.lon.toFixed(6)}</span>
                                <span class="result-unit">lat, lon</span>
                            </div>
                            <div class="result-card highlight">
                                <span class="result-label">Groundbed optimal</span>
                                <span class="result-value">${results.groundbed.lat.toFixed(6)}, ${results.groundbed.lon.toFixed(6)}</span>
                                <span class="result-unit">lat, lon</span>
                            </div>

                            ${results.cableLengths ? `
                            <div class="result-card" style="border-color: var(--accent-cyan);">
                                <span class="result-label">Câble positif TR→GB</span>
                                <span class="result-value" style="color: var(--accent-cyan);">${results.cableLengths.positive.roundedM}</span>
                                <span class="result-unit">m</span>
                            </div>
                            <div class="result-card" style="border-color: var(--accent-cyan);">
                                <span class="result-label">Câble négatif TR→Structure</span>
                                <span class="result-value" style="color: var(--accent-cyan);">${results.cableLengths.negative.roundedM}</span>
                                <span class="result-unit">m</span>
                            </div>
                            <div class="result-card highlight" style="border-color: var(--accent-green);">
                                <span class="result-label">Longueur totale (+10 %)</span>
                                <span class="result-value" style="color: var(--accent-green);">${results.cableLengths.total.roundedM}</span>
                                <span class="result-unit">m</span>
                            </div>
                            ` : ''}

                            <div class="result-card">
                                <span class="result-label">Courant total requis</span>
                                <span class="result-value">${results.totalCurrent.toFixed(3)}</span>
                                <span class="result-unit">A</span>
                            </div>
                            <div class="result-card">
                                <span class="result-label">Surface totale exposée</span>
                                <span class="result-value">${results.totalSurface.toFixed(1)}</span>
                                <span class="result-unit">m²</span>
                            </div>
                        </div>

                        <div style="margin-top: 0.5rem; padding: 0.4rem 0.6rem; background: var(--bg-elevated); border-radius: var(--radius-sm); border-left: 3px solid var(--accent-cyan);">
                            <div style="font-size: 0.75rem; color: var(--text-secondary);">
                                <strong>Traçabilité résistivité (P0-05) :</strong>
                                ρ_projet = <strong>${rhoProject} Ω·m</strong>
                                &nbsp;|&nbsp;
                                ρ_groundbed = <strong>${rhoGroundbed} Ω·m</strong>
                                ${rhoDivergence > 0.5 ? `<span style="color: var(--accent-orange);"> ⚠️ Divergence ${(rhoDivergence * 100).toFixed(0)}% (justification stratigraphique requise)</span>` : ''}
                            </div>
                        </div>

                        <table class="tech-table" style="margin-top: 0.5rem;">
                            <thead>
                                <tr>
                                    <th>Structure / Équipement</th>
                                    <th>Type</th>
                                    <th>Dimension</th>
                                    <th>Courant requis (A)</th>
                                    <th>Dist. TR (m)</th>
                                    <th>Dist. GB (m)</th>
                                    <th>α (1/m)</th>
                                </tr>
                            </thead>
                            <tbody>
                    `;
            (results.pipelines || []).forEach(p => {
                html += `
                    <tr>
                        <td><strong>${p.id}</strong></td>
                        <td><span class="badge" style="font-size:0.7rem;">Pipeline</span></td>
                        <td>${p.length.toFixed(0)} m (longueur)</td>
                        <td>${p.currentRequired.toFixed(3)}</td>
                        <td>${p.distanceToTR.toFixed(0)}</td>
                        <td>${p.distanceToGB.toFixed(0)}</td>
                        <td>${p.attenuationConstant ? p.attenuationConstant.toFixed(6) : '—'}</td>
                    </tr>
                `;
            });
            (results.protectedStructures || []).forEach(s => {
                const dimStr = s.diameter > 0 ? `Ø ${s.diameter.toFixed(1)} m` : (s.surfaceArea > 0 ? `${s.surfaceArea.toFixed(1)} m² (fond)` : '—');
                html += `
                    <tr style="background: rgba(230, 126, 34, 0.08);">
                        <td><strong>${s.id}</strong></td>
                        <td><span class="badge" style="font-size:0.7rem; background: var(--accent-orange, #e67e22); color: #fff;">Réservoir</span></td>
                        <td>${dimStr}</td>
                        <td>${(Number(s.currentRequired) || 0).toFixed(3)}</td>
                        <td>${(Number(s.distanceToTR) || 0).toFixed(0)}</td>
                        <td>${(Number(s.distanceToGB) || 0).toFixed(0)}</td>
                        <td><span style="color: var(--text-muted); font-size:0.8rem;" title="Structure concentrée (NACE SP0193 / API RP 651) — atténuation longitudinale non applicable">N/A (API 651)</span></td>
                    </tr>
                `;
            });
            html += `
                            </tbody>
                        </table>
                        <div style="margin-top: 0.5rem; font-size: 0.8rem; color: var(--text-muted);">
                            <i class="fas fa-info-circle"></i>
                            Positions optimales calculées par grille de recherche et descente locale.
                            Score basé sur l'uniformité, le courant distribué, l'atténuation et les pertes.
                            ${results.gridPoints ? `Grille: ${results.gridPoints} points.` : ''}
                            ${results.positionChecks ? `<br>
                            Distance TR–Groundbed : ${results.positionChecks.trGroundbedDistance.toFixed(0)} m |
                            Distance minimale Groundbed–structure : ${results.positionChecks.groundbedMinStructureDistance.toFixed(0)} m |
                            ${results.positionChecks.groundbedPositionCompliant ? 'Contrainte de distance respectée' : '⚠️ Contrainte de distance non respectée — aucun candidat conforme dans la grille'}` : ''}
                        </div>
                        <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
                            <button id="applyOptimalTRBtn" class="btn btn-primary touch-target">
                                <i class="fas fa-check"></i> Appliquer le TR optimal
                            </button>
                            <button id="applyOptimalGBBtn" class="btn btn-primary touch-target">
                                <i class="fas fa-check"></i> Appliquer le Groundbed optimal
                            </button>
                            <button id="exportOptimizationReportBtn" class="btn btn-info touch-target">
                                <i class="fas fa-file-export"></i> Exporter le rapport
                            </button>
                        </div>
                    </div>
                </div>
            `;
            container.innerHTML = html;

            if (results.cableLengths && results.cableLengths.total) {
                try {
                    const lengthInput = document.getElementById('cableLengthDC');
                    const badge = document.getElementById('cableLengthAutoBadge');
                    if (lengthInput) {
                        lengthInput.value = results.cableLengths.total.roundedM;
                        lengthInput.title =
                            'Auto : ' + results.cableLengths.total.geometricM.toFixed(0) +
                            ' m géo + ' + results.cableLengths.total.marginM.toFixed(0) +
                            ' m marge (10 %) = ' + results.cableLengths.total.roundedM + ' m';
                    }
                    if (badge) {
                        badge.textContent =
                            'auto +10 % (' + results.cableLengths.total.geometricM.toFixed(0) + ' m géo)';
                        badge.style.display = 'inline';
                    }
                    if (typeof UI !== 'undefined' && typeof UI.showToast === 'function') {
                        UI.showToast(
                            '✅ Longueur câble pré-remplie : ' +
                            results.cableLengths.total.roundedM + ' m (+10 %)',
                            'info'
                        );
                    }
                    // Synchronisation automatique vers le formulaire CP (Résistance des câbles)
                    if (typeof UI !== 'undefined' && typeof UI.syncCableLengthFromICCP === 'function') {
                        UI.syncCableLengthFromICCP(results.cableLengths.total.roundedM, { silent: true });
                    }
                } catch (e) {
                    console.warn('[ICCPOptimization] Pré-remplissage longueur échoué:', e);
                }
            }

            const applyTRBtn = document.getElementById('applyOptimalTRBtn');
            if (applyTRBtn) {
                applyTRBtn.addEventListener('click', () => {
                    this._applyOptimalTR(results.tr);
                });
            }
            const applyGBBtn = document.getElementById('applyOptimalGBBtn');
            if (applyGBBtn) {
                applyGBBtn.addEventListener('click', () => {
                    this._applyOptimalGB(results.groundbed, results.tr);
                });
            }
            const exportBtn = document.getElementById('exportOptimizationReportBtn');
            if (exportBtn) {
                exportBtn.addEventListener('click', () => {
                    this._exportReport(results);
                });
            }

            // ============================================================
            // v2.5 : SYNCHRONISATION CÂBLE DC
            //        (fusion iccp-cable-sync-patch.js v1.1)
            // ------------------------------------------------------------
            // Auto-pré-remplit #cableCurrent avec le courant total optimisé
            // ET aligne state.iccp.current pour cohérence inter-modules.
            // ============================================================
            try {
                if (results && isFinite(results.totalCurrent) && results.totalCurrent > 0) {
                    // Aligner state.iccp.current
                    if (typeof ProjectManager !== 'undefined') {
                        const st = ProjectManager.getState();
                        if (st && st.iccp) {
                            st.iccp.current = results.totalCurrent;
                        }
                    }

                    // Pré-remplir #cableCurrent via UI
                    if (typeof UI !== 'undefined' &&
                        typeof UI.syncCableCurrentFromICCP === 'function') {
                        UI.syncCableCurrentFromICCP(
                            results.totalCurrent,
                            'Optimisation ICCP',
                            { silent: true }
                        );

                        if (typeof UI.showToast === 'function') {
                            UI.showToast(
                                '✅ Courant câble pré-rempli : ' +
                                results.totalCurrent.toFixed(3) + ' A',
                                'info'
                            );
                        }
                    }
                }
            } catch (e) {
                console.warn('[ICCPOptimization v2.5] Erreur syncCableCurrentFromICCP:', e);
            }
        },

        _applyOptimalTR: function(trPos) {
            if (typeof ProjectManager === 'undefined') {
                console.warn('[ICCPOptimization] ProjectManager non disponible');
                if (typeof UI !== 'undefined' && UI.showToast) {
                    UI.showToast('❌ ProjectManager non disponible.', 'error');
                }
                return;
            }

            let projectId;
            try {
                projectId = this._getActiveProjectId();
            } catch (err) {
                if (typeof UI !== 'undefined' && UI.showToast) {
                    UI.showToast('⚠️ ' + err.message, 'warning');
                }
                return;
            }

            const state = ProjectManager.getState();
            const activeSys = ProjectManager.getActiveSystem();
            const selectedTR = state.iccp?.transformerRectifierSelection?.selected || {};
            const selectedTRTechnicalCharacteristics = {
                supplyVoltage: selectedTR.supplyVoltage || null,
                phases: selectedTR.phases || null,
                frequencyHz: selectedTR.frequencyHz || null,
                technology: selectedTR.technology || null,
                regulation: selectedTR.regulation || null,
                cooling: selectedTR.cooling || null,
                enclosureProtection: selectedTR.enclosureProtection || null
            };

            let existing = state.equipments.find(eq =>
                eq.type === 'rectifier' && eq.projectId === projectId
            );
            // ─── Référence de l'équipement TR (pour synchronisation) ───
            let trEquipmentId = null;

            if (existing) {
                existing.coordinates = { lat: trPos.lat, lon: trPos.lon, alt: 0 };
                existing.tag = existing.tag || 'TR-OPTIMAL';
                existing.manufacturer = selectedTR.manufacturer || existing.manufacturer || null;
                existing.model = selectedTR.model || selectedTR.id || existing.model || null;
                existing.nominalCurrent = Number(selectedTR.nominalCurrent) || existing.nominalCurrent || 0;
                existing.nominalVoltage = Number(selectedTR.nominalVoltage) || existing.nominalVoltage || 0;
                existing.nominalPower = Number(selectedTR.nominalPower) || existing.nominalPower || 0;
                existing.technicalCharacteristics = selectedTRTechnicalCharacteristics;
                if (!existing.systemId && activeSys) existing.systemId = activeSys.id;
                ProjectManager.saveEquipment(existing);
                trEquipmentId = existing.id;
                if (typeof UI !== 'undefined' && UI.showToast) {
                    UI.showToast(`✅ Position du TR mise à jour pour ${projectId}.`, 'success');
                }
            } else {
                const newTR = {
                    id: 'TR-OPTIMAL-' + Date.now(),
                    tag: 'TR-OPTIMAL',
                    type: 'rectifier',
                    projectId: projectId,
                    coordinates: { lat: trPos.lat, lon: trPos.lon, alt: 0 },
                    surface: 0,
                    included: true,
                    systemId: activeSys ? activeSys.id : null,
                    dimensions: {},
                    material: 'acier',
                    wallThickness: 8.0,
                    coatingType: '3LPE',
                    coatingCondition: 'neuf',
                    coatingThickness: 0,
                    soilResistivity: 0,
                    manufacturer: selectedTR.manufacturer || null,
                    model: selectedTR.model || selectedTR.id || null,
                    nominalCurrent: Number(selectedTR.nominalCurrent) || 0,
                    nominalVoltage: Number(selectedTR.nominalVoltage) || 0,
                    nominalPower: Number(selectedTR.nominalPower) || 0,
                    technicalCharacteristics: selectedTRTechnicalCharacteristics,
                    cpData: { calculated: false, results: {}, parameters: {} }
                };
                const created = ProjectManager.addEquipmentDirect(newTR);
                trEquipmentId = (created && created.id) ? created.id : newTR.id;
                if (typeof UI !== 'undefined' && UI.showToast) {
                    UI.showToast(`✅ TR optimal ajouté au projet ${projectId}.`, 'success');
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // BUG-CP-A09 : Synchronisation complète du TR dans le système actif.
            // ------------------------------------------------------------
            // 1. Ajouter/mettre à jour activeSys.rectifiers[]
            // 2. Persister activeSys.params.iccp.trCoordinates
            // 3. Persister activeSys.params.iccp.trSource
            //
            // Utilise UNIQUEMENT l'API publique existante de ProjectManager :
            //   - getActiveSystem()
            //   - saveSystemParams(systemId, module, params)
            //   - saveCurrentProject()
            //
            // NOTE : le tableau state.rectifiers[] n'existe PAS dans le
            //        state réel. Les redresseurs sont dans
            //        state.dashboard.systeme[].rectifiers[].
            // ═══════════════════════════════════════════════════════════════
            if (activeSys && trEquipmentId) {
                // 1. Enregistrer le rectifier dans activeSys.rectifiers[]
                if (!Array.isArray(activeSys.rectifiers)) {
                    activeSys.rectifiers = [];
                }
                let existingRect = activeSys.rectifiers.find(r =>
                    r && r.equipmentId === trEquipmentId
                );
                if (existingRect) {
                    existingRect.lat = trPos.lat;
                    existingRect.lon = trPos.lon;
                    existingRect.alt = 0;
                    existingRect.updatedAt = new Date().toISOString();
                } else {
                    activeSys.rectifiers.push({
                        id: 'RECT-' + Date.now(),
                        name: 'TR-OPTIMAL',
                        equipmentId: trEquipmentId,
                        status: 'off',
                        current: 0,
                        voltage: 0,
                        power: 0,
                        lat: trPos.lat,
                        lon: trPos.lon,
                        alt: 0,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                }

                // 2 + 3. Persister les coordonnées et la source dans params.iccp
                try {
                    ProjectManager.saveSystemParams(activeSys.id, 'iccp', {
                        trCoordinates: { lat: trPos.lat, lon: trPos.lon, alt: 0 },
                        trSource: 'optimization',
                        trEquipmentId: trEquipmentId,
                        trAppliedAt: new Date().toISOString()
                    });
                } catch (e) {
                    console.warn('[ICCPOptimization] Impossible de persister trCoordinates:', e.message);
                }

                // Sauvegarde finale du projet (le système modifié doit être persisté)
                try {
                    ProjectManager.saveCurrentProject();
                } catch (e) {
                    console.warn('[ICCPOptimization] saveCurrentProject error:', e.message);
                }
            }

            if (typeof UI !== 'undefined') {
                if (UI.refreshEquipmentListUI) UI.refreshEquipmentListUI(true);
                if (UI.renderSystems) UI.renderSystems();
                if (UI.renderDynamicEquipmentList) UI.renderDynamicEquipmentList();
            }
            if (window.GisIntegration && typeof window.GisIntegration.loadPoints === 'function') {
                window.GisIntegration.loadPoints(projectId, true);
            }
            if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                window.Gis3D.loadData(projectId);
            }
        },
        // ============================================================
        // _applyOptimalGB – v2.5
        //   ⭐ INTÉGRATION COMPLÈTE de ICCPOptimizationEngine-v3-patch.js v3.1
        // ------------------------------------------------------------
        // Changements majeurs vs v2.4 :
        //   1. Résolution dynamique de targetCurrent = iccp.current || cp.current
        //      (au lieu de lire uniquement les defaults)
        //   2. Synchronisation BOTH :
        //        - state.groundbeds[] (tableau)
        //        - state.groundbed.results (legacy)
        //   3. Association au système actif :
        //        - activeSys.groundbedId = gbId
        //        - activeSys.params.groundbed.targetCurrent
        //   4. Sync #gbTargetCurrent avec feedback visuel vert
        //   5. Save project DANS la méthode (une seule fois à la fin)
        // ============================================================
        _applyOptimalGB: function(gbPos, trPos) {
            if (typeof ProjectManager === 'undefined') {
                console.warn('[ICCPOptimization] ProjectManager non disponible');
                if (typeof UI !== 'undefined' && UI.showToast) {
                    UI.showToast('❌ ProjectManager non disponible.', 'error');
                }
                return;
            }

            let projectId;
            try {
                projectId = this._getActiveProjectId();
            } catch (err) {
                if (typeof UI !== 'undefined' && UI.showToast) {
                    UI.showToast('⚠️ ' + err.message, 'warning');
                }
                return;
            }

            const state = ProjectManager.getState();
            const activeSys = ProjectManager.getActiveSystem();

            // ============================================================
            // Utiliser la même résolution que le module Groundbed manuel.
            // Cela respecte notamment la source ICCP sélectionnée (CP calculé
            // ne doit pas reprendre un ancien courant ICCP manuel).
            const resolvedTarget = window.CPController &&
                typeof window.CPController._resolveGroundbedTargetCurrent === 'function'
                ? window.CPController._resolveGroundbedTargetCurrent(0)
                : { value: (state.cp && state.cp.current) || 0, source: 'cp', label: 'CP calcule' };
            const targetCurrent = resolvedTarget.value || 0;
            const iccpCurrent = (state.iccp && state.iccp.current) || 0;
            const cpCurrent = (state.cp && state.cp.current) || 0;

            console.log('[ICCPOptimization v2.5] targetCurrent =', targetCurrent.toFixed(3), 'A',
                        '(source:', resolvedTarget.source, '/ ICCP:', iccpCurrent.toFixed(3), '/ CP:', cpCurrent.toFixed(3), ')');

            // ============================================================
            // P0-05 : Récupération des résistivités
            // ============================================================
            const rhoProject = this._getProjectSoilResistivity();
            const rhoGroundbed = this._getGroundbedFormationResistivity();

            // ---- Construction des paramètres groundbed ----
            const gbParams = Object.assign({}, this.DEFAULT_GROUNDBED_PARAMS);

            gbParams.rhoProject = rhoProject;
            gbParams.rhoGroundbed = rhoGroundbed;
            gbParams.rho = rhoGroundbed;

            // v3.1 : injection du courant cible résolu
            gbParams.targetCurrent = targetCurrent;
            gbParams.projectId = projectId;

            // P0-03 : Configuration anodes ICCP
            try {
                if (state.project && state.project.shared && state.project.shared.iccpAnodeConfig) {
                    gbParams.iccpAnodeConfig = state.project.shared.iccpAnodeConfig;
                    gbParams.anodeType = state.project.shared.iccpAnodeConfig.material || gbParams.anodeType;
                }
            } catch (e) {
                console.warn('[ICCPOptimization] Impossible de récupérer iccpAnodeConfig:', e.message);
            }

            // ============================================================
            // P0-04b : Pré-calcul des résultats groundbed
            // ============================================================
            let gbResults = {};
            try {
                if (typeof CalculationEngine !== 'undefined'
                    && typeof CalculationEngine.designGroundbed === 'function') {
                    gbResults = CalculationEngine.designGroundbed(gbParams) || {};
                    console.log('[ICCPOptimization v2.5] designGroundbed :',
                                'I =', (gbResults.I_total || 0).toFixed(3), 'A',
                                '| V =', (gbResults.V_rectifier || 0).toFixed(1), 'V',
                                '| R =', (gbResults.R_total || 0).toFixed(4), 'Ω');

                    // P0-03 / P1-05 : durées de vie ICCP
                    if (typeof Utils !== 'undefined' && typeof Utils.calculateICCPAnodeLife === 'function') {
                        try {
                            const anodeType = gbParams.anodeType || 'mmo';
                            const massPerAnode = gbParams.anodeWeight || 25;
                            const I_per_anode = (gbResults.I_total || 0) / Math.max(1, gbParams.anodeCount || 1);
                            if (I_per_anode > 0) {
                                const lifeDetails = Utils.calculateICCPAnodeLife(
                                    anodeType, massPerAnode, I_per_anode, 0.85
                                );
                                if (lifeDetails && !lifeDetails.error) {
                                    gbResults.lifeTheoretical = lifeDetails.lifeTheoretical;
                                    gbResults.lifeDesign = lifeDetails.lifeDesign;
                                    gbResults.lifeDetails = lifeDetails;
                                }
                            }
                        } catch (e) {
                            console.warn('[ICCPOptimization v2.5] Calcul lifeDesign échoué:', e.message);
                        }
                    }
                } else {
                    console.warn('[ICCPOptimization] CalculationEngine.designGroundbed indisponible.');
                }
            } catch (e) {
                console.warn('[ICCPOptimization] Échec du pré-calcul groundbed :', e);
                gbResults = {};
            }

            // P0-05 : traçabilité
            gbResults.rhoProject = rhoProject;
            gbResults.rhoGroundbed = rhoGroundbed;
            gbResults.rho_eff = gbResults.rho_eff || rhoGroundbed;

            // ============================================================
            // 1. state.groundbeds[] (tableau) — création ou mise à jour
            // ============================================================
            let existingGB = state.groundbeds.find(gb =>
                gb.projectId === projectId &&
                gb.name && gb.name.indexOf('optimal') !== -1
            );

            let gbId = null;
            if (existingGB) {
                existingGB.name = 'Groundbed optimal';
                existingGB.coordinates = { lat: gbPos.lat, lon: gbPos.lon, alt: 0 };
                existingGB.parameters = gbParams;
                existingGB.results = gbResults;
                existingGB.updatedAt = new Date().toISOString();
                ProjectManager.updateGroundbed(existingGB.id, existingGB);
                gbId = existingGB.id;
                console.log('[ICCPOptimization v2.5] Groundbed existant mis à jour :', gbId);
            } else {
                const created = ProjectManager.createGroundbed(
                    'Groundbed optimal',
                    gbParams,
                    gbResults,
                    { lat: gbPos.lat, lon: gbPos.lon, alt: 0 },
                    projectId
                );
                if (created) gbId = created.id;
                console.log('[ICCPOptimization v2.5] Nouveau groundbed créé :', gbId);
            }

            // ============================================================
            // 2. ⭐ FIX v3.1 : state.groundbed.results (legacy)
            // ------------------------------------------------------------
            // Ce champ est lu par _displayResultsInUI, les KPI, etc.
            // Il doit être synchronisé avec le groundbed optimal.
            // ============================================================
            if (!state.groundbed) state.groundbed = {};
            state.groundbed.results = Object.assign({}, gbResults);
            console.log('[ICCPOptimization v2.5] ✅ state.groundbed.results synchronisé :',
                        'I_total =', (state.groundbed.results.I_total || 0).toFixed(3), 'A');

            // ============================================================
            // 3. Équipement type 'groundbed' (pour 3D et cartographie)
            // ============================================================
            let existingEquip = state.equipments.find(eq =>
                eq.type === 'groundbed' &&
                eq.projectId === projectId &&
                eq.tag && eq.tag.toLowerCase().indexOf('optimal') !== -1
            );

            if (existingEquip) {
                existingEquip.tag = 'Groundbed optimal';
                existingEquip.coordinates = { lat: gbPos.lat, lon: gbPos.lon, alt: 0 };
                existingEquip.parameters = gbParams;
                existingEquip.results = gbResults;
                if (!existingEquip.systemId && activeSys) existingEquip.systemId = activeSys.id;
                ProjectManager.saveEquipment(existingEquip);
                console.log('[ICCPOptimization v2.5] Équipement groundbed mis à jour');
            } else {
                ProjectManager.addEquipmentDirect({
                    id: 'GB-EQUIP-' + Date.now(),
                    tag: 'Groundbed optimal',
                    type: 'groundbed',
                    projectId: projectId,
                    coordinates: { lat: gbPos.lat, lon: gbPos.lon, alt: 0 },
                    surface: 0,
                    included: true,
                    systemId: activeSys ? activeSys.id : null,
                    dimensions: {
                        totalDepth: gbParams.totalDepth,
                        activeDepth: gbParams.activeDepth,
                        anodeCount: gbParams.anodeCount,
                        anodeLength: gbParams.anodeLength,
                        anodeDiameter: gbParams.anodeDiameter
                    },
                    parameters: gbParams,
                    results: gbResults,
                    material: 'acier',
                    wallThickness: 8.0,
                    coatingType: '3LPE',
                    coatingCondition: 'neuf',
                    coatingThickness: 0,
                    soilResistivity: 0,
                    cpData: { calculated: false, results: {}, parameters: {} }
                });
                console.log('[ICCPOptimization v2.5] Nouvel équipement groundbed créé');
            }

            // ============================================================
            // 4. Association au système actif
            // ============================================================
            if (activeSys && activeSys.type === 'iccp' && gbId) {
                activeSys.groundbedId = gbId;
                if (!activeSys.params) activeSys.params = {};
                if (!activeSys.params.groundbed) activeSys.params.groundbed = {};
                activeSys.params.groundbed.targetCurrent = targetCurrent;
                activeSys.params.groundbed.targetCurrentSource = resolvedTarget.source || 'none';
                console.log('[ICCPOptimization v2.5] Système ICCP associé :', activeSys.name);
            }

            // Sauvegarde unique à la fin
            ProjectManager.saveCurrentProject();

            // ============================================================
            // 5. Synchronisation UI : #gbTargetCurrent avec feedback vert
            // ============================================================
            const targetInput = document.getElementById('gbTargetCurrent');
            if (targetInput && targetCurrent > 0) {
                targetInput.value = targetCurrent.toFixed(3);
                targetInput.style.borderColor = 'var(--accent-green)';
                targetInput.style.background = 'rgba(52, 199, 89, 0.08)';
                targetInput.title = 'Courant cible synchronisé (' +
                                    (resolvedTarget.label || resolvedTarget.source) + ': ' +
                                    targetCurrent.toFixed(3) + ' A)';
            }

            // ============================================================
            // 6. Refresh UI (composants concernés)
            // ============================================================
            if (typeof UI !== 'undefined') {
                if (UI.renderGroundbedList) UI.renderGroundbedList();
                if (UI.populateICCPGroundbedSelectors) UI.populateICCPGroundbedSelectors();
                if (UI.refreshEquipmentListUI) UI.refreshEquipmentListUI(true);
                if (UI.renderSystems) UI.renderSystems();
                if (UI.renderDynamicEquipmentList) UI.renderDynamicEquipmentList();
            }
            if (window.GisIntegration && typeof window.GisIntegration.loadPoints === 'function') {
                window.GisIntegration.loadPoints(projectId, true);
            }
            if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                window.Gis3D.loadData(projectId);
            }

            if (typeof UI !== 'undefined' && UI.showToast) {
                UI.showToast(
                    '✅ Groundbed optimal appliqué (I = ' +
                    (gbResults.I_total || 0).toFixed(2) + ' A)',
                    'success'
                );
            }
        },

        // ============================================================
        // _exportReport – v2.5
        // ============================================================
        _exportReport: function(results) {
            const projectId = (typeof ProjectManager !== 'undefined' && ProjectManager.getCurrentProjectId)
                ? ProjectManager.getCurrentProjectId()
                : 'PROJ';
            const projectName = this._getActiveProjectName();

            const rhoProject = this._getProjectSoilResistivity();
            const rhoGroundbed = this._getGroundbedFormationResistivity();
            const rhoDivergence = (rhoProject > 0 && rhoGroundbed > 0)
                ? Math.abs(rhoGroundbed - rhoProject) / Math.max(rhoProject, rhoGroundbed)
                : 0;

            let gbResults = null;
            try {
                if (typeof ProjectManager !== 'undefined') {
                    const state = ProjectManager.getState();
                    const optimalGB = (state.groundbeds || []).find(gb =>
                        gb.projectId === projectId && gb.name === 'Groundbed optimal'
                    );
                    if (optimalGB && optimalGB.results) {
                        gbResults = optimalGB.results;
                    } else if (state.groundbed && state.groundbed.results) {
                        gbResults = state.groundbed.results;
                    }
                }
            } catch (e) {
                console.warn('[ICCPOptimization] Impossible de récupérer gbResults:', e.message);
            }

            let report = [];
            report.push('═══════════════════════════════════════════════════════════════');
            report.push('       RAPPORT D\'OPTIMISATION ICCP - ' + projectName + ' (' + projectId + ')');
            report.push('═══════════════════════════════════════════════════════════════');
            report.push('');
            report.push(`📅 Date : ${new Date().toLocaleString('fr-FR')}`);
            report.push(`📊 Score global : ${(results.score * 100).toFixed(1)}%`);
            report.push('');
            report.push('───────────────────────────────────────────────────────────────');
            report.push('  POSITIONS OPTIMALES');
            report.push('───────────────────────────────────────────────────────────────');
            report.push(`  TR (Transformateur-Redresseur) :`);
            report.push(`    Latitude  : ${results.tr.lat.toFixed(6)}° N`);
            report.push(`    Longitude : ${results.tr.lon.toFixed(6)}° E`);
            report.push(`  Groundbed (Puits anodique) :`);
            report.push(`    Latitude  : ${results.groundbed.lat.toFixed(6)}° N`);
            report.push(`    Longitude : ${results.groundbed.lon.toFixed(6)}° E`);
            report.push('');

            report.push('───────────────────────────────────────────────────────────────');
            report.push('  TRAÇABILITÉ RÉSISTIVITÉ (P0-05)');
            report.push('───────────────────────────────────────────────────────────────');
            report.push(`  Résistivité projet (source de vérité) : ${rhoProject} Ω·m`);
            report.push(`  Résistivité groundbed (formation)     : ${rhoGroundbed} Ω·m`);
            if (rhoDivergence > 0.5) {
                report.push(`  ⚠️  Divergence significative : ${(rhoDivergence * 100).toFixed(0)}%`);
                report.push(`      Justification stratigraphique requise.`);
            }
            report.push('');

            report.push('───────────────────────────────────────────────────────────────');
            report.push('  DONNÉES DE CONCEPTION');
            report.push('───────────────────────────────────────────────────────────────');
            report.push(`  Courant total requis : ${results.totalCurrent.toFixed(3)} A`);
            report.push(`  Surface totale exposée : ${results.totalSurface.toFixed(1)} m²`);
            report.push('');

            if (gbResults && (gbResults.R_total || gbResults.I_total)) {
                report.push('───────────────────────────────────────────────────────────────');
                report.push('  RÉSULTATS GROUNDBED PRÉ-CALCULÉS');
                report.push('───────────────────────────────────────────────────────────────');

                if (gbResults.R_groundbed_pure !== undefined) {
                    report.push(`  R_groundbed_pure (R_group + R_well) : ${gbResults.R_groundbed_pure.toFixed(4)} Ω`);
                }
                if (gbResults.R_group !== undefined) {
                    report.push(`  R_group (Sunde)                     : ${gbResults.R_group.toFixed(4)} Ω`);
                }
                if (gbResults.R_well !== undefined) {
                    report.push(`  R_well (Dwight forage)              : ${gbResults.R_well.toFixed(4)} Ω`);
                }
                if (gbResults.R_cable !== undefined) {
                    report.push(`  R_cable (aller-retour)              : ${gbResults.R_cable.toFixed(4)} Ω`);
                }
                if (gbResults.R_struct !== undefined) {
                    report.push(`  R_struct                            : ${gbResults.R_struct.toFixed(4)} Ω`);
                }
                if (gbResults.R_total !== undefined) {
                    report.push(`  R_total                             : ${gbResults.R_total.toFixed(4)} Ω`);
                }
                if (gbResults.I_total !== undefined) {
                    report.push(`  I_total                             : ${gbResults.I_total.toFixed(3)} A`);
                }
                if (gbResults.V_rectifier !== undefined) {
                    report.push(`  V_rectifier                         : ${gbResults.V_rectifier.toFixed(1)} V`);
                }
                if (gbResults.P_rectifier !== undefined) {
                    report.push(`  P_rectifier                         : ${gbResults.P_rectifier.toFixed(0)} W`);
                }

                if (gbResults.J_anode !== undefined) {
                    report.push(`  J_anode (canonique)                 : ${gbResults.J_anode.toFixed(3)} A/m²`);
                }
                if (gbResults.J_anode_mA !== undefined) {
                    report.push(`  J_anode (équivalent)                : ${gbResults.J_anode_mA.toFixed(1)} mA/m²`);
                }

                if (gbResults.lifeDesign !== undefined && gbResults.lifeDesign !== null) {
                    report.push(`  Durée de vie (conception)           : ${gbResults.lifeDesign.toFixed(1)} ans (plafonnée)`);
                }
                if (gbResults.lifeTheoretical !== undefined && gbResults.lifeTheoretical !== null) {
                    report.push(`  Durée de vie (théorique)            : ${gbResults.lifeTheoretical.toFixed(1)} ans (calcul brut)`);
                }
                if (gbResults.lifeDetails && gbResults.lifeDetails.designLifeCap) {
                    report.push(`  Plafond de conception               : ${gbResults.lifeDetails.designLifeCap} ans`);
                }

                report.push('');
            }

            report.push('───────────────────────────────────────────────────────────────');
            report.push('  DÉTAIL PAR STRUCTURE / ÉQUIPEMENT PROTÉGÉ');
            report.push('───────────────────────────────────────────────────────────────');
            report.push('  Équipement  | Type      | Dimension    | I_req (A) | Dist TR (m) | Dist GB (m) | α (1/m)');
            report.push('  ------------|-----------|--------------|-----------|-------------|-------------|--------');
            (results.pipelines || []).forEach(p => {
                const alphaStr = p.attenuationConstant ? p.attenuationConstant.toFixed(6) : '—';
                report.push(`  ${p.id.padEnd(11)} | Pipeline  | ${(p.length.toFixed(0) + ' m').padStart(12)} | ${p.currentRequired.toFixed(3).padStart(9)} | ${p.distanceToTR.toFixed(0).padStart(11)} | ${p.distanceToGB.toFixed(0).padStart(11)} | ${alphaStr}`);
            });
            (results.protectedStructures || []).forEach(s => {
                const dimStr = s.diameter > 0 ? `Ø ${s.diameter.toFixed(1)} m` : (s.surfaceArea > 0 ? `${s.surfaceArea.toFixed(1)} m²` : '—');
                report.push(`  ${s.id.padEnd(11)} | Réservoir | ${dimStr.padStart(12)} | ${(Number(s.currentRequired) || 0).toFixed(3).padStart(9)} | ${(Number(s.distanceToTR) || 0).toFixed(0).padStart(11)} | ${(Number(s.distanceToGB) || 0).toFixed(0).padStart(11)} | N/A (API 651)`);
            });
            report.push('');
            if (results.cableLengths) {
                report.push('───────────────────────────────────────────────────────────────');
                report.push('  LONGUEURS DE CÂBLES DC (CIRCUIT COMPLET ALLER-RETOUR)');
                report.push('───────────────────────────────────────────────────────────────');
                report.push(`  Câble positif TR→GB          : ${results.cableLengths.positive.roundedM} m`);
                report.push(`  Câble négatif TR→Structure   : ${results.cableLengths.negative.roundedM} m`);
                report.push(`  Longueur totale boucle (+10%): ${results.cableLengths.total.roundedM} m`);
                report.push('');
            }
            report.push('═══════════════════════════════════════════════════════════════');
            report.push('  Rapport généré par CP Engineer Pro - Moteur ICCP v2.5');
            report.push('  Conforme NACE SP0169 / ISO 15589-1');
            report.push('  Compatible engine.js v8.5 / controller.js v9.1 / ui.js v9.3');
            report.push('  Intégration patches : v3.1 (_applyOptimalGB) + cable-sync v1.1');
            report.push('═══════════════════════════════════════════════════════════════');

            const blob = new Blob([report.join('\n')], { type: 'text/plain;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `rapport_optimisation_ICCP_${projectId}_${new Date().toISOString().slice(0, 10)}.txt`;
            a.click();
            if (typeof UI !== 'undefined' && UI.showToast) {
                UI.showToast('✅ Rapport d\'optimisation exporté.', 'success');
            }
        },

        // ============================================================
        // 5. API PUBLIQUE
        // ============================================================

        run: async function(projectId, options, updateUI) {
            try {
                const effectiveProjectId = projectId || this._getActiveProjectId();

                if (!effectiveProjectId) {
                    throw new Error('Aucun projet actif. Sélectionnez un projet avant d\'optimiser.');
                }

                const results = await this.runForProject(effectiveProjectId, options || {});
                if (updateUI !== false) {
                    this.updateUI(results);
                }
                return results;
            } catch (error) {
                console.error('[ICCPOptimization] Erreur:', error);
                if (typeof UI !== 'undefined' && UI.showToast) {
                    UI.showToast(`❌ Erreur d'optimisation : ${error.message}`, 'error');
                }
                throw error;
            }
        },

        getOptimalPositions: function(projectId, options) {
            const effectiveProjectId = projectId || this._getActiveProjectId();
            return this.runForProject(effectiveProjectId, options || {});
        },

        suggestStandards: function(pipelines) {
            if (!pipelines) pipelines = Object.values(this.PIPELINES);
            const types = pipelines.map(p => p.type || 'pipeline_enterre');
            const uniqueTypes = [...new Set(types)];
            const standards = uniqueTypes.map(t => {
                const base = (t === 'pipeline_offshore') ? 'DNV-RP-B401' : 'ISO 15589-1';
                return {
                    type: t,
                    primary: base,
                    suggested: [base, 'NACE SP0169', 'ISO 15589-2']
                };
            });
            return standards;
        },

    };

    // ============================================================
    // 6. INTÉGRATION AVEC L'APPLICATION
    // ============================================================

    window.ICCPOptimizationEngine = ICCPOptimizationEngine;

    if (typeof window.CPController !== 'undefined') {
        window.CPController.optimizeICCP = async function(projectId, options) {
            const effectiveProjectId = projectId || this.getCurrentProjectId();
            return ICCPOptimizationEngine.run(effectiveProjectId, options, true);
        };
        window.CPController.getOptimalICCPPositions = function(projectId, options) {
            const effectiveProjectId = projectId || this.getCurrentProjectId();
            return ICCPOptimizationEngine.getOptimalPositions(effectiveProjectId, options);
        };
        console.log('[ICCPOptimization] Intégré dans CPController.');
    }

    document.addEventListener('DOMContentLoaded', function() {
        const moduleICCP = document.getElementById('module-iccp');
        if (moduleICCP) {
            const existingActions = moduleICCP.querySelector('.form-actions');
            if (existingActions && !document.getElementById('iccpOptimizeBtn')) {
                const optBtn = document.createElement('button');
                optBtn.type = 'button';
                optBtn.className = 'btn btn-info touch-target';
                optBtn.id = 'iccpOptimizeBtn';
                optBtn.innerHTML = '<i class="fas fa-robot"></i> Optimiser les positions';
                optBtn.title = 'Lancer l\'optimisation ICCP pour déterminer les positions optimales du TR et du groundbed.';
                optBtn.addEventListener('click', async function() {
                    this.disabled = true;
                    this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Optimisation en cours...';
                    try {
                        if (typeof ProjectManager === 'undefined') {
                            throw new Error('ProjectManager non disponible.');
                        }
                        const projectId = ProjectManager.getCurrentProjectId();
                        if (!projectId || projectId === '__all__') {
                            throw new Error('Sélectionnez un projet unique (pas "Tous les projets") avant d\'optimiser.');
                        }
                        await window.ICCPOptimizationEngine.run(projectId, {}, true);
                    } catch (error) {
                        console.error('[ICCPOptimization] Erreur:', error);
                        if (typeof UI !== 'undefined' && UI.showToast) {
                            UI.showToast('❌ ' + error.message, 'error');
                        }
                    } finally {
                        this.disabled = false;
                        this.innerHTML = '<i class="fas fa-robot"></i> Optimiser les positions';
                    }
                });
                const saveBtn = document.getElementById('saveIccpSystemBtn');
                if (saveBtn) {
                    existingActions.insertBefore(optBtn, saveBtn);
                } else {
                    existingActions.appendChild(optBtn);
                }
                console.log('[ICCPOptimization] Bouton d\'optimisation ajouté.');
            }
        }

        const iccpModule = document.getElementById('module-iccp');
        if (iccpModule && !document.getElementById('iccpOptimizationResults')) {
            const resultsContainer = document.createElement('div');
            resultsContainer.id = 'iccpOptimizationResults';
            resultsContainer.style.marginTop = '1rem';
            const iccpResultsContent = document.getElementById('iccpResultsContent');
            if (iccpResultsContent && iccpResultsContent.parentNode) {
                iccpResultsContent.parentNode.insertBefore(resultsContainer, iccpResultsContent.nextSibling);
            } else {
                iccpModule.appendChild(resultsContainer);
            }
        }
    });

    console.log('[ICCPOptimization] ===================================================');
    console.log('[ICCPOptimization] Moteur d\'optimisation ICCP v2.5 chargé.');
    console.log('[ICCPOptimization] ===================================================');
    console.log('[ICCPOptimization] ✅ v2.5 : INTÉGRATION ICCPOptimizationEngine-v3-patch v3.1');
    console.log('[ICCPOptimization]    - _applyOptimalGB : résolution ICCP > CP');
    console.log('[ICCPOptimization]    - Synchronisation state.groundbed.results (legacy)');
    console.log('[ICCPOptimization]    - Association système ICCP avec targetCurrent');
    console.log('[ICCPOptimization] ✅ v2.5 : INTÉGRATION iccp-cable-sync-patch v1.1');
    console.log('[ICCPOptimization]    - _displayResultsInUI → UI.syncCableCurrentFromICCP()');
    console.log('[ICCPOptimization] ✅ P0-02 : Unités canoniques (J_anode, J_anode_mA)');
    console.log('[ICCPOptimization] ✅ P0-03 : lifeDesign / lifeTheoretical');
    console.log('[ICCPOptimization] ✅ P0-04 : R_groundbed_pure / R_well exposés');
    console.log('[ICCPOptimization] ✅ P0-05 : rhoProject / rhoGroundbed traçables');
    console.log('[ICCPOptimization] ✅ P1-02 : powerDesign dans le rapport');
    console.log('[ICCPOptimization] ✅ P1-05 : lifeDesign vs lifeTheoretical distingués');
    console.log('[ICCPOptimization] ✅ Compatible engine.js v8.5 / controller.js v9.1 / ui.js v9.3');
    console.log('[ICCPOptimization] ===================================================');

})();
// ============================================================
// FIN DE ICCPOptimizationEngine.js (VERSION 2.5)
// ============================================================