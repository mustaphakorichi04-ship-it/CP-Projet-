// ============================================================
// cableLengthEngine.js – CP Engineer Pro
// Moteur de calcul des longueurs de câbles DC (ICCP)
// Version 1.0
// Dépend de : GeoUtils (ou fallback intégré), CoordSystem (optionnel)
// Exposé globalement sur window.CableLengthEngine
// ============================================================

(function() {
    'use strict';

    const CableLengthEngine = {

        // ============================================================
        // 1. CONFIGURATION & CONSTANTES
        // ============================================================

        VERSION: '1.0.0',

        /**
         * Paramètres par défaut. Tous surchargeables via options.
         */
        DEFAULTS: {
            marginPercent: 10,        // Marge projet (+10 %)
            verticalPerEnd: 2,        // Remontée verticale (m) par extrémité
            crossingUnit: 10,         // Traversée route/rail estimée (m)
            slackPercent: 4,          // Mou / slack (% de L_horizontale)
            reservePerEnd: 4,         // Réserve par extrémité (m)
            roundStep: 5,             // Arrondi commercial (m)
            rhoCu: 0.0175,            // Ω·mm²/m pour cuivre
            rhoAl: 0.0283,            // Ω·mm²/m pour aluminium
            negativeStrategy: 'worst' // 'nearest' | 'worst' | 'sum'
        },

        /**
         * Sections commerciales normalisées (mm²).
         */
        COMMERCIAL_SECTIONS: [
            1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70,
            95, 120, 150, 185, 240, 300, 400, 500, 630, 800, 1000
        ],

        // ============================================================
        // 2. API PRINCIPALE
        // ============================================================

        /**
         * Calcule les longueurs de câbles DC pour une configuration TR/GB/pipelines.
         *
         * @param {Object} tr         { lat, lon, alt? }  position TR
         * @param {Object} gb         { lat, lon, alt? }  position groundbed
         * @param {Array}  pipelines  [{ id, tag?, coordinates: [{lat,lon,alt?}, ...] }, ...]
         * @param {Object} options    Surcharges (voir DEFAULTS)
         * @returns {Object} Résultat structuré
         */
        computeCableLengths: function(tr, gb, pipelines, options) {
            // ---- Validation ----
            if (!this._isValidPoint(tr)) {
                throw new Error('Position TR invalide ou manquante.');
            }
            if (!this._isValidPoint(gb)) {
                throw new Error('Position Groundbed invalide ou manquante.');
            }
            if (!Array.isArray(pipelines) || pipelines.length === 0) {
                throw new Error('Aucun pipeline fourni pour le calcul du câble négatif.');
            }

            const opt = Object.assign({}, this.DEFAULTS, options || {});

            // ---- 1. Câble POSITIF : TR → GB ----
            const L_pos_geo = this._haversine(tr, gb);
            const positive = this._applyAllowances(L_pos_geo, opt, 'POSITIVE');

            // ---- 2. Câble NÉGATIF : TR → pipeline ----
            const negative = this._computeNegative(tr, pipelines, opt);

            // ---- 3. Total ----
            const total = {
                geometricM:   positive.geometricM + negative.geometricM,
                designM:      positive.designM    + negative.designM,
                marginM:      positive.marginM    + negative.marginM,
                withMarginM:  positive.withMarginM + negative.withMarginM,
                roundedM:     this._roundUp(
                                  positive.withMarginM + negative.withMarginM,
                                  opt.roundStep
                              )
            };

            return {
                positive:  positive,
                negative:  negative,
                total:     total,
                options:   opt,
                computedAt: new Date().toISOString(),
                source: 'CableLengthEngine.v' + this.VERSION
            };
        },

        /**
         * Calcule la section commerciale d'un câble DC.
         * Réutilisable, ne duplique pas UI.calculateCableSection().
         *
         * @param {number} current      Courant (A)
         * @param {number} length       Longueur (m)
         * @param {number} voltageDrop  Chute de tension admissible (V)
         * @param {string} material     'cu' | 'al'
         * @returns {Object|null}
         */
        calculateSection: function(current, length, voltageDrop, material) {
            if (current <= 0 || length <= 0 || voltageDrop <= 0) return null;
            if (material !== 'cu' && material !== 'al') return null;
            const rho = (material === 'al') ? this.DEFAULTS.rhoAl : this.DEFAULTS.rhoCu;
            const S_theorique = (2 * rho * length * current) / voltageDrop;
            const selected = this.COMMERCIAL_SECTIONS.find(s => s >= S_theorique)
                          || this.COMMERCIAL_SECTIONS[this.COMMERCIAL_SECTIONS.length - 1];
            const dV_reel = (2 * rho * length * current) / selected;
            const withinVoltageDrop = dV_reel <= voltageDrop;
            return {
                theoreticalMm2: S_theorique,
                selectedMm2: selected,
                actualDropV: dV_reel,
                withinVoltageDrop: withinVoltageDrop,
                status: withinVoltageDrop ? 'PASS' : 'LIMIT_EXCEEDED',
                warning: withinVoltageDrop ? null : 'La section commerciale maximale ne respecte pas la chute de tension admissible.',
                material: material,
                current: current,
                length: length,
                voltageDrop: voltageDrop
            };
        },

        /**
         * Enrichit un résultat d'optimisation ICCP avec les longueurs de câbles.
         * Appelé par ICCPOptimizationEngine.optimize() avant le return.
         *
         * @param {Object} optResults  Résultat de ICCPOptimizationEngine.optimize()
         * @param {Object} options     Surcharges
         * @returns {Object} optResults enrichi avec .cableLengths
         */
        enrichWithCableLengths: function(optResults, options) {
            if (!optResults || !optResults.tr || !optResults.groundbed) {
                console.warn('[CableLengthEngine] enrichWithCableLengths: résultats d\'optimisation incomplets.');
                return optResults;
            }
            try {
                // Combiner pipelines et structures protégées (ex: réservoirs)
                const allStructures = (optResults.pipelines || []).concat(
                    (optResults.protectedStructures || []).map(s => ({
                        id: s.id,
                        tag: s.id,
                        coordinates: s.coordinates,
                        type: s.type || 'reservoir'
                    }))
                );
                optResults.cableLengths = this.computeCableLengths(
                    optResults.tr,
                    optResults.groundbed,
                    allStructures.length > 0 ? allStructures : (optResults.pipelines || []),
                    options
                );
                console.log(
                    '[CableLengthEngine] Longueurs calculées : TR→GB = ' +
                    optResults.cableLengths.positive.roundedM + ' m, TR→Structure = ' +
                    optResults.cableLengths.negative.roundedM + ' m, Total = ' +
                    optResults.cableLengths.total.roundedM + ' m'
                );
            } catch (e) {
                console.warn('[CableLengthEngine] Échec enrichissement :', e.message);
                optResults.cableLengths = null;
                optResults.cableLengthsError = e.message;
            }
            return optResults;
        },

        /**
         * Calcule les longueurs à partir de l'état du projet (TR/GB/pipelines/réservoirs
         * déjà présents dans les équipements). Fallback hors optimisation.
         *
         * @param {string} projectId
         * @param {Object} options
         * @returns {Object|null}
         */
        computeFromProjectState: function(projectId, options) {
            if (typeof ProjectManager === 'undefined') return null;
            const state = ProjectManager.getState();
            if (!state || !state.equipments) return null;

            const eqs = state.equipments.filter(e => e.projectId === projectId);

            const trEq = eqs.find(e => e.type === 'rectifier' && this._hasCoords(e));
            const gbEq = eqs.find(e => e.type === 'groundbed' && this._hasCoords(e));
            const structures = eqs.filter(e =>
                (e.type === 'pipeline_enterre' || e.type === 'pipeline_offshore' ||
                 ['reservoir_fond', 'reservoir_toit', 'tank', 'reservoir'].includes(e.type)) &&
                this._hasCoords(e)
            );

            if (!trEq || !gbEq || structures.length === 0) {
                return null;
            }

            const trPos = this._firstPoint(trEq.coordinates);
            const gbPos = this._firstPoint(gbEq.coordinates);
            const structData = structures.map(p => ({
                id: p.tag || p.id,
                coordinates: this._extractCoords(p.coordinates),
                type: p.type
            }));

            return this.computeCableLengths(trPos, gbPos, structData, options);
        },

        // ============================================================
        // 3. HELPERS PRIVÉS
        // ============================================================

        _isValidPoint: function(p) {
            return p && typeof p.lat === 'number' && typeof p.lon === 'number'
                && !isNaN(p.lat) && !isNaN(p.lon)
                && p.lat >= -90 && p.lat <= 90
                && p.lon >= -180 && p.lon <= 180;
        },

        _hasCoords: function(eq) {
            if (!eq || !eq.coordinates) return false;
            if (Array.isArray(eq.coordinates)) return eq.coordinates.length > 0;
            return typeof eq.coordinates.lat === 'number';
        },

        _firstPoint: function(coords) {
            if (Array.isArray(coords) && coords.length > 0) return coords[0];
            if (coords && typeof coords.lat === 'number') return coords;
            return null;
        },

        _extractCoords: function(coords) {
            if (Array.isArray(coords)) {
                return coords.filter(c => this._isValidPoint(c));
            }
            if (this._isValidPoint(coords)) return [coords];
            return [];
        },

        /**
         * Distance de Haversine (m). Réutilise GeoUtils si disponible.
         */
        _haversine: function(p1, p2) {
            if (typeof GeoUtils !== 'undefined'
                && typeof GeoUtils.distanceHaversine === 'function') {
                return GeoUtils.distanceHaversine(p1.lat, p1.lon, p2.lat, p2.lon);
            }
            const R = 6371000;
            const TO_RAD = Math.PI / 180;
            const dLat = (p2.lat - p1.lat) * TO_RAD;
            const dLon = (p2.lon - p1.lon) * TO_RAD;
            const a = Math.sin(dLat / 2) ** 2
                    + Math.cos(p1.lat * TO_RAD)
                    * Math.cos(p2.lat * TO_RAD)
                    * Math.sin(dLon / 2) ** 2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        },

        /**
         * Applique toutes les majorations à une longueur géométrique.
         */
        _applyAllowances: function(L_geo, opt, routeType) {
            const L_vertical  = opt.verticalPerEnd * 2;
            const L_crossings = opt.crossingUnit;
            const L_slack     = L_geo * (opt.slackPercent / 100);
            const L_reserve   = opt.reservePerEnd * 2;
            const L_design    = L_geo + L_vertical + L_crossings + L_slack + L_reserve;
            const L_margin    = L_design * (opt.marginPercent / 100);
            const L_withMargin = L_design + L_margin;
            return {
                routeType:     routeType,
                geometricM:    L_geo,
                verticalM:     L_vertical,
                crossingsM:    L_crossings,
                slackM:        L_slack,
                reserveM:      L_reserve,
                designM:       L_design,
                marginM:       L_margin,
                marginPercent: opt.marginPercent,
                withMarginM:   L_withMargin,
                roundedM:      this._roundUp(L_withMargin, opt.roundStep)
            };
        },

        /**
         * Calcule la longueur négative TR → pipeline(s).
         */
        _computeNegative: function(tr, pipelines, opt) {
            const perPipeline = [];

            pipelines.forEach(p => {
                const coords = this._extractCoords(p.coordinates);
                if (coords.length === 0) return;
                const nearest = this._nearestPoint(tr, coords);
                if (!nearest) return;
                const L_geo = this._haversine(tr, nearest.point);
                const allowances = this._applyAllowances(L_geo, opt, 'NEGATIVE');
                perPipeline.push({
                    id: p.id || p.tag || 'pipeline',
                    nearestPoint: nearest.point,
                    geometricDistance: L_geo,
                    ...allowances
                });
            });

            if (perPipeline.length === 0) {
                return {
                    perPipeline: [],
                    geometricM: 0,
                    designM: 0,
                    withMarginM: 0,
                    roundedM: 0,
                    strategy: opt.negativeStrategy,
                    warning: 'Aucun pipeline avec coordonnées valides.'
                };
            }

            let selected;
            if (opt.negativeStrategy === 'sum') {
                selected = perPipeline.reduce((acc, p) => ({
                    geometricM:  acc.geometricM + p.geometricM,
                    designM:     acc.designM + p.designM,
                    withMarginM: acc.withMarginM + p.withMarginM,
                    roundedM:    acc.roundedM + p.roundedM
                }), { geometricM: 0, designM: 0, withMarginM: 0, roundedM: 0 });
            } else if (opt.negativeStrategy === 'worst') {
                selected = perPipeline.reduce((a, b) => a.withMarginM > b.withMarginM ? a : b);
            } else { // 'nearest' — câble vers le pipeline le plus proche
                selected = perPipeline.reduce((a, b) => a.withMarginM < b.withMarginM ? a : b);
            }

            return {
                perPipeline:  perPipeline,
                geometricM:   selected.geometricM,
                verticalM:    selected.verticalM   || opt.verticalPerEnd * 2,
                crossingsM:   selected.crossingsM  || opt.crossingUnit,
                slackM:       selected.slackM      || 0,
                reserveM:     selected.reserveM    || opt.reservePerEnd * 2,
                designM:      selected.designM,
                marginM:      selected.marginM     || 0,
                withMarginM:  selected.withMarginM,
                roundedM:     selected.roundedM,
                strategy:     opt.negativeStrategy
            };
        },

        /**
         * Point d'un tracé le plus proche d'une origine.
         */
        _nearestPoint: function(origin, coords) {
            let best = null;
            let bestD = Infinity;
            for (const c of coords) {
                if (!this._isValidPoint(c)) continue;
                const d = this._haversine(origin, c);
                if (d < bestD) {
                    bestD = d;
                    best = c;
                }
            }
            return best ? { point: best, distance: bestD } : null;
        },

        /**
         * Arrondi commercial.
         */
        _roundUp: function(value, step) {
            step = step || 5;
            return Math.ceil(value / step) * step;
        }
    };

    // ============================================================
    // 4. EXPOSITION GLOBALE
    // ============================================================
    window.CableLengthEngine = CableLengthEngine;

    console.log('[CableLengthEngine] v' + CableLengthEngine.VERSION + ' chargé avec succès.');

})();