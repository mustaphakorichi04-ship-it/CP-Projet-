// ============================================================
// AnodesOptimizationEngine.js – CP Engineer Pro
// VERSION 1.0.0
// ------------------------------------------------------------
// Moteur d'optimisation pour les modes :
//   • Type CP = Anodes    → "Optimisation Anodes"
//     - Placement optimal des anodes sacrificielles (Mg, Zn, Al)
//       sur TOUS les équipements protégés du projet : pipelines
//       ET structures (réservoirs, tanks, fourreaux…) selon
//       DNV-RP-B401 / ISO 15589-1
//     - Calcul du nombre d'anodes, espacement, résistance Dwight
//     - Score basé sur uniformité du courant, espacement ISO
//     - Visualisation GIS : positions sur la carte du module
//       Cartographie + panneau de résultats de dimensionnement
//
//   • Type CP = Mixte     → "Optimisation Mixte"
//     - Appel ICCP (TR + Groundbed) + anodes sacrificielles
//     - Score combiné ICCP 60% + Anodes 40%
//     - Tableau de synthèse double
// ============================================================

(function () {
    'use strict';

    // ============================================================
    // Helpers
    // ============================================================
    function haversineDistance(lat1, lon1, lat2, lon2) {
        if (window.ICCPOptimizationEngine &&
            typeof window.ICCPOptimizationEngine._haversineDistance === 'function') {
            return window.ICCPOptimizationEngine._haversineDistance(lat1, lon1, lat2, lon2);
        }
        const R = 6371000;
        const phi1 = lat1 * Math.PI / 180;
        const phi2 = lat2 * Math.PI / 180;
        const dphi = (lat2 - lat1) * Math.PI / 180;
        const dlam = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function pipelineLength(coordinates) {
        let total = 0;
        for (let i = 1; i < coordinates.length; i++) {
            total += haversineDistance(
                coordinates[i - 1].lat, coordinates[i - 1].lon,
                coordinates[i].lat, coordinates[i].lon
            );
        }
        return total;
    }

    function interpolatePointOnPipeline(coords, fraction) {
        const totalLen = pipelineLength(coords);
        const targetDist = totalLen * Math.max(0, Math.min(1, fraction));
        let accumulated = 0;
        for (let i = 1; i < coords.length; i++) {
            const segLen = haversineDistance(
                coords[i - 1].lat, coords[i - 1].lon,
                coords[i].lat, coords[i].lon
            );
            if (accumulated + segLen >= targetDist) {
                const t = segLen > 0 ? (targetDist - accumulated) / segLen : 0;
                return {
                    lat: coords[i - 1].lat + t * (coords[i].lat - coords[i - 1].lat),
                    lon: coords[i - 1].lon + t * (coords[i].lon - coords[i - 1].lon)
                };
            }
            accumulated += segLen;
        }
        return { ...coords[coords.length - 1] };
    }

    function escapeHtml(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    // ============================================================
    // AnodesOptimizationEngine
    // ============================================================
// ⚠️ CORRECTION n°3 : trace les projets dont les positions TR / Groundbed
    // ont été optimisées. En mode mixte, « Appliquer les anodes au projet »
    // reste verrouillé tant que l'ICCP principal n'est pas positionné.
    var _iccpOptimizedByProject = {};

    // L'ICCP est considéré comme positionné si le TR et le groundbed
    // "optimal" existent déjà dans le projet ( survive au rechargement ).
    function _isIccpPositioned(projectId) {
        if (_iccpOptimizedByProject[projectId]) return true;
        if (typeof ProjectManager === 'undefined' || !ProjectManager.getState) return false;
        try {
            var state = ProjectManager.getState();
            var hasTR = (state.equipments || []).some(function (eq) {
                return eq && eq.projectId === projectId && eq.type === 'rectifier';
            });
            var hasGB = (state.groundbeds || []).some(function (gb) {
                return gb && gb.projectId === projectId &&
                    String(gb.name || '').toLowerCase().indexOf('optimal') !== -1;
            });
            return !!(hasTR && hasGB);
        } catch (e) {
            return false;
        }
    }
    var AnodesOptimizationEngine = {

        VERSION: '1.1.0',

        ANODE_DEFAULTS: {
            'Al_ZnIn': { potential_mV: -1050, capacity_Ah_kg: 2600, density_kg_m3: 2700 },
            'Mg_HC':   { potential_mV: -1700, capacity_Ah_kg: 1230, density_kg_m3: 1740 },
            'Zn_HC':   { potential_mV: -1100, capacity_Ah_kg:  780, density_kg_m3: 7100 }
        },

        DEFAULT_ANODE_MATERIAL: 'Mg_HC',
        FREE_POTENTIAL_STEEL_MV: -600,
        TARGET_POTENTIAL_MV: -850,

        // ── 1. Paramètres & Résistance Dwight ────────────────────
        _getAnodeParameters: function (options, pipeline) {
            options = options || {};
            var getVal = function (id, fallback) {
                var el = document.getElementById(id);
                if (el && el.value !== '' && !isNaN(Number(el.value))) return Number(el.value);
                return fallback;
            };
            var getStr = function (id, fallback) {
                var el = document.getElementById(id);
                return (el && el.value) ? el.value : fallback;
            };

            var state = (typeof ProjectManager !== 'undefined' && ProjectManager.getState) ? ProjectManager.getState() : {};
            var stateAnodes = state.anodes || {};

            var materialKey = options.material || getStr('anodeMaterialSelect', stateAnodes.anodeMaterial || this.DEFAULT_ANODE_MATERIAL);
            var life = Number(options.designLife || getVal('anodeLifeSelect', stateAnodes.life || 25));
            var u = Number(options.utilizationFactor || getVal('anodeUtilizationSelect', 0.85));
            var safety = Number(options.safetyFactor || getVal('safetyFactor', stateAnodes.safetyFactor || 1.1));
            var unitMass = Number(options.unitMass || getVal('anodeMassUnitSelect', 10.0));
            var rho = Number(options.soilResistivity || (pipeline && pipeline.soilResistivity) || getVal('anodeSoilResistivity', stateAnodes.soilResistivity || 23.85));
            var L = Number(options.anodeLength || getVal('anodeLengthSelect', 1.0));
            var d = Number(options.anodeDiameter || getVal('anodeDiameterSelect', 0.10));
            var anodePot = Number(options.anodePotential || getVal('anodePotentialSelect', -1700));
            var targetProtection = Number(options.targetProtection || getVal('targetPotential', -850));
            var finalFactor = Number(options.finalResistanceFactor || getVal('finalResistanceFactor', 1.5));
            var orientation = options.orientation || getStr('anodeOrientationSelect', 'vertical');

            return {
                materialKey: materialKey,
                life: life,
                u: u,
                safety: safety,
                unitMass: unitMass,
                rho: rho,
                L: L,
                d: d,
                anodePot: anodePot,
                targetProtection: targetProtection,
                finalFactor: finalFactor,
                orientation: orientation
            };
        },

        _anodeDwightResistance: function (rho_soil, L_anode, d_anode) {
            if (L_anode <= 0 || d_anode <= 0) return Infinity;
            if (typeof CalculationEngine !== 'undefined' && typeof CalculationEngine.anodeResistanceVertical === 'function') {
                return CalculationEngine.anodeResistanceVertical(rho_soil, L_anode, d_anode);
            }
            var ratio = 8 * L_anode / d_anode;
            if (ratio <= 1) return Infinity;
            return (rho_soil / (2 * Math.PI * L_anode)) * (Math.log(ratio) - 1);
        },

        _anodeOutputCurrent: function (E_anode_mV, E_target_mV, R_anode_ohm) {
            var EMF = Math.abs(E_anode_mV - E_target_mV) / 1000;
            if (R_anode_ohm <= 0 || !isFinite(R_anode_ohm)) return 0;
            return EMF / R_anode_ohm;
        },

        _anodeMassRequired: function (I_req_A, designLife, capacity, uFactor, safety) {
            var hours = designLife * 8760;
            var sf = safety || 1.1;
            return (I_req_A * hours * sf) / (capacity * (uFactor || 0.85));
        },

        // ════════════════════════════════════════════════════════════
        // ── 2bis. Structures protégées hors pipeline (type CP « anodes »)
        // Estimation des anodes pour protéger TOUS les équipements du
        // projet : réservoirs, tanks, fourreaux, supports métalliques…
        // (l'infra CP — rectifier, groundbed, anodes, postes de test —
        // n'est pas une structure à protéger).
        // ════════════════════════════════════════════════════════════
        _PROTECTED_INFRA_TYPES: {
            rectifier: true, groundbed: true, anode: true,
            testpost: true, poste: true, cable: true
        },

        _collectProtectedStructures: function (equipments, projectId) {
            var self = this;
            return (equipments || []).filter(function (eq) {
                if (!eq) return false;
                // CORRECTION visibilité : ne dimensionner que le projet actif.
                // Sans ce filtre, les structures de TOUS les projets étaient
                // mélangées (totaux faux + anodes d'un autre projet).
                if (projectId && eq.projectId && eq.projectId !== projectId) return false;
                if (projectId && !eq.projectId) return false;
                var t = String(eq.type || '').toLowerCase();
                if (t.indexOf('pipeline_') === 0) return false;
                if (self._PROTECTED_INFRA_TYPES[t]) return false;
                if (eq.included === false) return false;
                return true;
            });
        },

        // Coordonnées GPS valides (tableau, objet unique ou JSON string)
        _validCoords: function (eq) {
            var coords = (eq && eq.coordinates) || [];
            if (typeof coords === 'string') {
                try { coords = JSON.parse(coords); } catch (e) { coords = []; }
            }
            if (!Array.isArray(coords)) {
                coords = (coords && coords.lat !== undefined && coords.lon !== undefined) ? [coords] : [];
            }
            return coords.filter(function (c) {
                return c && isFinite(Number(c.lat)) && isFinite(Number(c.lon));
            }).map(function (c) { return { lat: Number(c.lat), lon: Number(c.lon) }; });
        },

        _protectedStructureDims: function (structure) {
            var dims = structure && structure.dimensions;
            if (dims && typeof dims === 'object') {
                return {
                    d: Number(dims.diametre_m) || Number(structure.diameter) || 0,
                    h: Number(dims.hauteur_m) || 0,
                    l: Number(dims.longueur_m) || 0,
                    surface_m2: Number(dims.surface_m2) || Number(structure.surface_m2) || 0
                };
            }
            return {
                d: Number(structure && structure.diameter) || 0,
                h: 0,
                l: 0,
                surface_m2: Number(structure && structure.surface_m2) || 0
            };
        },

        // Surface à protéger (m²) — même hiérarchie que cp-controller.js /
        // ICCPOptimizationEngine : calculateEquipmentResistances →
        // OUVRAGE_TYPES.surfaceFn → formules locales (sans CalculationEngine).
        _protectedStructureSurface: function (structure) {
            var area = 0;
            try {
                if (typeof CalculationEngine !== 'undefined' &&
                    typeof CalculationEngine.calculateEquipmentResistances === 'function') {
                    var rho = Number(structure.soilResistivity) > 0 ? Number(structure.soilResistivity) : undefined;
                    var r = CalculationEngine.calculateEquipmentResistances(structure, rho);
                    area = Number(r && (r.soilContactArea || r.surfaceArea)) || 0;
                }
            } catch (e) { area = 0; }
            if (isFinite(area) && area > 0) return area;

            try {
                if (typeof CalculationEngine !== 'undefined' && CalculationEngine.OUVRAGE_TYPES) {
                    var rule = CalculationEngine.OUVRAGE_TYPES[String(structure.type || '').toLowerCase()];
                    if (rule && typeof rule.surfaceFn === 'function') {
                        var dims = this._protectedStructureDims(structure);
                        var args = (rule.fields || []).map(function (f) {
                            var v = (dims[f] !== undefined && dims[f] !== null && dims[f] > 0)
                                ? dims[f] : Number(structure[f]);
                            return isFinite(v) ? v : 0;
                        });
                        if (args.length && args.every(function (v) { return v > 0; })) {
                            var s = rule.surfaceFn.apply(null, args);
                            if (isFinite(s) && s > 0) return s;
                        }
                    }
                }
            } catch (e2) { /* fallback local ci-dessous */ }

            // Fallback local
            var dl = this._protectedStructureDims(structure);
            var coords = this._validCoords(structure);
            if (coords.length >= 2) {
                var len = pipelineLength(coords);
                if (len > 0) return Math.PI * (dl.d > 0 ? dl.d : 0.3) * len;
            }
            if (dl.surface_m2 > 0) return dl.surface_m2;
            if (dl.d > 0) {
                if (dl.h > 0) return Math.PI * dl.d * dl.h + Math.PI * dl.d * dl.d / 4;
                return Math.PI * dl.d * dl.d / 4;
            }
            return 0;
        },

        // Courant requis d'une structure (A) : CalculationEngine.requiredCurrent
        // quand dispo, sinon repli DNV (surface × DF × k × J / 1000).
        _structureCurrentRequired: function (structure, surface) {
            if (!(surface > 0)) return 0;
            var type = String(structure.type || '').toLowerCase();
            var J = Number(structure.currentDensity);
            if (!(J > 0)) {
                try {
                    if (typeof CalculationEngine !== 'undefined' && CalculationEngine.OUVRAGE_TYPES) {
                        var rule = CalculationEngine.OUVRAGE_TYPES[type];
                        if (rule) {
                            var jd = rule.defaultCurrentDensity;
                            J = (typeof jd === 'function')
                                ? Number(jd(structure.environment || structure.env || ''))
                                : Number(jd);
                        }
                    }
                } catch (e) { J = 0; }
            }
            if (!(J > 0)) J = 10;
            var eps = Number(structure.coatingEfficiency); if (!(eps > 0)) eps = 0.95;
            var DF  = Number(structure.defectDensity);      if (!(DF > 0)) DF  = 0.05;
            var k   = Number(structure.agingFactor);        if (!(k > 0))  k   = 1.2;
            var tankTypes = { reservoir_fond: 1, reservoir_toit: 1, tank: 1, reservoir: 1 };
            var norm = structure.norm ||
                (tankTypes[type] ? 'API RP 651' : 'ISO 15589-1');

            if (typeof CalculationEngine !== 'undefined' &&
                typeof CalculationEngine.requiredCurrent === 'function') {
                var cr = CalculationEngine.requiredCurrent(surface, J, eps, DF, k, norm);
                return Number(cr && cr.currentAmperes) || 0;
            }
            return (surface * DF * k * J) / 1000;
        },

        // Dimensionnement d'une structure non-pipeline.
        // Réutilise optimizeAnodePlacement (moteur DNV éprouvé) via un
        // « shim » : polyline réelle si ≥2 points GPS, sinon couronne
        // périphérique autour du centre (rayon d/2 + 1,5 m, défaut 5 m).
        _optimizeStructureAnodes: function (structure, options) {
            options = options || {};
            var coords = this._validCoords(structure);
            if (!coords.length) return null;

            var dims = this._protectedStructureDims(structure);
            var surface = this._protectedStructureSurface(structure);
            if (!(surface > 0)) return null;

            var isRing = coords.length < 2;
            var path = coords;
            if (isRing) {
                var center = coords[0];
                var radius = dims.d > 0 ? (dims.d / 2 + 1.5) : 5;
                var radiusLat = radius / 111320;
                var cosLat = Math.max(0.2, Math.cos(center.lat * Math.PI / 180));
                var radiusLon = radiusLat / cosLat;
                path = [];
                for (var i = 0; i < 16; i++) {
                    var angle = (2 * Math.PI * i) / 16;
                    path.push({
                        lat: center.lat + radiusLat * Math.sin(angle),
                        lon: center.lon + radiusLon * Math.cos(angle)
                    });
                }
            }

            // Courant : part allouée du global OU calcul propre de la structure
            var I_total = Number(options.allocatedCurrentA || 0);
            if (!(I_total > 0)) I_total = this._structureCurrentRequired(structure, surface);
            if (!(I_total > 0)) return null;

            var shim = {
                id: structure.id || structure.tag,
                coordinates: path,
                diameter_m: dims.d > 0 ? dims.d : 0.3,
                soilResistivity: structure.soilResistivity,
                currentDensity: structure.currentDensity,
                coatingEfficiency: structure.coatingEfficiency,
                defectDensity: structure.defectDensity,
                agingFactor: structure.agingFactor,
                norm: structure.norm
            };
            var sOptions = Object.assign({}, options);
            sOptions.pipelineCurrentA = I_total;

            var res = this.optimizeAnodePlacement(shim, sOptions);
            if (!res) return null;

            res.equipmentTag = structure.tag || structure.id;
            res.equipmentType = structure.type || 'structure';
            res.isStructure = true;
            res.placementMode = isRing ? 'ring' : 'linear';
            res.structureSurfaceM2 = surface;
            (res.anodes || []).forEach(function (a) {
                a.equipmentTag = res.equipmentTag;
                a.equipmentType = res.equipmentType;
            });
            return res;
        },

        // ── 2. Placement optimal anodes sur un pipeline ──────────
        optimizeAnodePlacement: function (pipeline, options) {
            options = options || {};
            var params = this._getAnodeParameters(options, pipeline);
            var mat = params.materialKey;
            var anodeProp = this.ANODE_DEFAULTS[mat] || this.ANODE_DEFAULTS[this.DEFAULT_ANODE_MATERIAL];

            var coords = pipeline.coordinates || [];
            if (coords.length < 2) return null;

            var pipeLen = pipelineLength(coords);
            if (pipeLen <= 0) return null;

            var surfaceArea = Math.PI * (pipeline.diameter_m || 0.3) * pipeLen;

            // 1. Détermination du courant requis du pipeline
            var I_total_A = Number(options.pipelineCurrentA || options.I_req || 0);
            if (I_total_A <= 0) {
                if (typeof CalculationEngine !== 'undefined' && typeof CalculationEngine.requiredCurrent === 'function') {
                    var eps = pipeline.coatingEfficiency != null ? pipeline.coatingEfficiency : 0.95;
                    var DF  = pipeline.defectDensity    != null ? pipeline.defectDensity    : 0.05;
                    var k   = pipeline.agingFactor      != null ? pipeline.agingFactor      : 1.2;
                    var J   = pipeline.currentDensity   != null ? pipeline.currentDensity   : 10;
                    var cr  = CalculationEngine.requiredCurrent(surfaceArea, J, eps, DF, k, pipeline.norm || 'ISO 15589-1');
                    I_total_A = cr.currentAmperes;
                } else {
                    I_total_A = (surfaceArea * 0.05 * 1.2 * 10) / 1000;
                }
            }

            if (I_total_A <= 0) return null;

            // 2. Nombre d'anodes :
            //    a) options.forcedAnodeCount > 0 → nombre ISSU DU
            //       DIMENSIONNEMENT (« Dimensionner », base = courant du
            //       module Calcul CP) : la répartition/position AMPP/NACE
            //       ne recalcule JAMAIS le nombre, elle place uniquement
            //       les anodes dimensionnées.
            //    b) sinon → dimensionnement DNV-RP-B401 / ISO 15589-1
            //       (repli historique : API/tests, mode mixte par zones).
            var nAnodes, massPerAnode, totalMassKg, R_one, I_one, I_final_one, actualLife;
            var dnvResult = null;
            var forcedCount = Math.floor(Number(options.forcedAnodeCount) || 0);

            if (forcedCount > 0) {
                nAnodes      = forcedCount;
                massPerAnode = params.unitMass;
                totalMassKg  = nAnodes * massPerAnode;
                R_one        = this._anodeDwightResistance(params.rho, params.L, params.d);
                var deltaVForced = Math.abs(params.anodePot - params.targetProtection) / 1000;
                I_one        = R_one > 0 && isFinite(R_one) ? deltaVForced / R_one : 0;
                I_final_one  = R_one > 0 && isFinite(R_one) ? deltaVForced / (R_one * params.finalFactor) : 0;
                actualLife   = (totalMassKg * anodeProp.capacity_Ah_kg * params.u) / (I_total_A * 8760);
            } else
            if (typeof CalculationEngine !== 'undefined' && typeof CalculationEngine.designAnodesDNV === 'function') {
                dnvResult = CalculationEngine.designAnodesDNV({
                    I_req: I_total_A,
                    life: params.life,
                    materialKey: mat,
                    u: params.u,
                    safety: params.safety,
                    unitMass: params.unitMass,
                    rho: params.rho,
                    L: params.L,
                    d: params.d,
                    anodePot: params.anodePot,
                    targetProtection: params.targetProtection,
                    finalFactor: params.finalFactor,
                    orientation: params.orientation
                });
            }

            if (dnvResult && !dnvResult.error && dnvResult.count > 0) {
                nAnodes         = dnvResult.count;
                massPerAnode    = params.unitMass;
                totalMassKg     = dnvResult.totalMass;
                R_one           = dnvResult.R_anode;
                I_one           = dnvResult.I_initial_per_anode || (dnvResult.initialCurrent / dnvResult.count);
                I_final_one     = dnvResult.I_final_per_anode || (dnvResult.finalCurrent / dnvResult.count);
                actualLife      = dnvResult.actualLife;
            } else if (forcedCount > 0) {
                // Nombre FORCÉ (répartition du compte « Dimensionner ») :
                // R, I, masse et durée de vie sont déjà calculés par la
                // branche ci-dessus. Surtout PAS de recalcul ici — sinon le
                // nombre dimensionné serait écrasé par le dimensionnement
                // courant/historique (régression exactement interdite).
            } else {
                R_one = this._anodeDwightResistance(params.rho, params.L, params.d);
                var deltaV = Math.abs(params.anodePot - params.targetProtection) / 1000;
                I_one = deltaV / R_one;
                var R_fin = R_one * params.finalFactor;
                I_final_one = deltaV / R_fin;
                var N_curr = Math.ceil(I_total_A / I_final_one);
                var N_m = Math.ceil((I_total_A * params.life * 8760 * params.safety) / (params.u * anodeProp.capacity_Ah_kg * params.unitMass));
                nAnodes = Math.max(1, N_curr, N_m);
                massPerAnode = params.unitMass;
                totalMassKg = nAnodes * massPerAnode;
                actualLife = (totalMassKg * anodeProp.capacity_Ah_kg * params.u) / (I_total_A * 8760);
            }

            var spacing = pipeLen / (nAnodes + 1);

            var anodePositions = [];
            for (var i = 1; i <= nAnodes; i++) {
                var fraction = i / (nAnodes + 1);
                var pos = interpolatePointOnPipeline(coords, fraction);
                anodePositions.push({
                    id: 'ANODE-' + pipeline.id + '-' + i,
                    pipelineId: pipeline.id,
                    lat: pos.lat,
                    lon: pos.lon,
                    index: i,
                    material: mat,
                    potential_mV: params.anodePot,
                    R_ohm: R_one,
                    I_output_A: I_one,
                    I_final_A: I_final_one,
                    mass_kg: massPerAnode,
                    L_anode_m: params.L,
                    d_anode_m: params.d,
                    spacing_m: spacing,
                    distFromStart_m: fraction * pipeLen
                });
            }

            return {
                anodes: anodePositions,
                nAnodes: nAnodes,
                totalCurrentA: I_total_A,
                currentPerAnodeA: I_one,
                currentFinalPerAnodeA: I_final_one,
                massPerAnodeKg: massPerAnode,
                totalMassKg: totalMassKg,
                spacingM: spacing,
                R_anode_ohm: R_one,
                actualLifeYears: actualLife,
                material: mat,
                pipelineId: pipeline.id,
                pipelineLengthM: pipeLen,
                surfaceM2: surfaceArea
            };
        },

        // ── Répartition d'un nombre dimensionné (AMPP/NACE) ─────
        // Répartit « total » anodes entre les équipements au prorata
        // de leur besoin en courant (« weights »), méthode des plus
        // forts restes : Σ alloc === total EXACTEMENT (aucune anode
        // créée ni perdue). Chaque équipement nécessitant un courant
        // reçoit au moins 1 anode quand le total le permet.
        _apportionCount: function (total, weights) {
            var n = weights.length;
            var alloc = [];
            var i;
            for (i = 0; i < n; i++) alloc.push(0);
            total = Math.floor(Number(total) || 0);
            if (total <= 0 || n === 0) return alloc;

            var positive = [];
            var sumW = 0;
            for (i = 0; i < n; i++) {
                var w = Number(weights[i]);
                if (w > 0) { positive.push(i); sumW += w; }
            }
            if (positive.length === 0) {
                // Aucune donnée de courant : répartition uniforme.
                for (i = 0; i < total; i++) alloc[i % n]++;
                return alloc;
            }

            // Couverture minimale : 1 anode par équipement demandeur.
            var base = total >= positive.length ? 1 : 0;
            if (base === 1) {
                for (i = 0; i < positive.length; i++) alloc[positive[i]] = 1;
            }
            var remain = total - base * positive.length;
            if (remain <= 0) {
                if (base === 0) {
                    // Total < nombre d'ouvrages demandeurs : attribuer aux
                    // parts les plus élevées (les plus grands besoins d'abord).
                    var order0 = positive.map(function (idx) { return { i: idx, w: Number(weights[idx]) }; })
                        .sort(function (a, b) { return b.w - a.w; });
                    for (i = 0; i < total; i++) alloc[order0[i].i] = 1;
                }
                return alloc;
            }

            // Reliquat : plus forts restes sur les poids.
            var exact = [];
            var floors = 0;
            for (i = 0; i < n; i++) {
                var e = (Number(weights[i]) > 0) ? remain * (Number(weights[i]) / sumW) : 0;
                exact.push(e);
                var f = Math.floor(e);
                alloc[i] += f;
                floors += f;
            }
            var leftover = remain - floors;
            var orderR = exact.map(function (e2, idx) { return { i: idx, r: e2 - Math.floor(e2) }; })
                .sort(function (a, b) { return b.r - a.r; });
            for (i = 0; i < leftover; i++) alloc[orderR[i].i] += 1;
            return alloc;
        },

        // ── 3. Point d'entrée principal ─────────────────────────
        runForProject: async function (projectId, options) {
            options = options || {};
            var effectiveId = projectId || (
                typeof ProjectManager !== 'undefined' && ProjectManager.getCurrentProjectId
                    ? ProjectManager.getCurrentProjectId() : null
            );
            if (!effectiveId) throw new Error('Aucun projet actif.');

            var state = typeof ProjectManager !== 'undefined' ? ProjectManager.getState() : {};

            // MODIFICATION : détection du mode renforcement mixte (zones analysées)
            var isMixteMode = options.mode === 'mixte';
            var reinforcementAnalysis = state.iccp && state.iccp.reinforcementAnalysis;
            var useReinforcementZones = isMixteMode && reinforcementAnalysis &&
                                        Array.isArray(reinforcementAnalysis.zones) &&
                                        reinforcementAnalysis.zones.length > 0;

            var equipments = (state.equipments || []).filter(function (eq) {
                return eq.projectId === effectiveId &&
                    (eq.type === 'pipeline_enterre' || eq.type === 'pipeline_offshore');
            });

            // ═══ Type CP « anodes » : TOUS les équipements à protéger ═══
            // pipelines + structures hors infra CP (réservoirs, tanks,
            // fourreaux, supports…). En mode mixte, inchangé : seules les
            // zones critiques (pipelines) sont dimensionnées — structures=[]
            // force le comportement historique de la branche mixte.
            var structures = isMixteMode
                ? []
                : AnodesOptimizationEngine._collectProtectedStructures(state.equipments, effectiveId);

            if (equipments.length === 0 && structures.length === 0) {
                if (isMixteMode) {
                    throw new Error('Aucun pipeline trouvé pour le projet ' + effectiveId +
                        '. Ajoutez des pipelines avec coordonnées GPS dans le module Équipements.');
                }
                throw new Error('Aucun équipement à protéger pour le projet ' + effectiveId +
                    '. Ajoutez des pipelines ou des structures (réservoirs, tanks…) avec coordonnées GPS dans le module Équipements.');
            }

            var self = this;

            // ⚠️ CORRECTION (incohérence majeure — type CP « mixte ») :
            // les anodes sacrificielles ne doivent être posées QUE dans les
            // zones critiques déclarées via « + Add Zone ». Sans analyse de
            // zones, on ne lance AUCUN dimensionnement SACP généraliste,
            // sinon des anodes seraient créées hors zones critiques.
            if (isMixteMode && !useReinforcementZones) {
                var emptyParams = self._getAnodeParameters(options);
                var noZoneResults = {
                    mode: 'mixte_no_zones',
                    projectId: effectiveId,
                    score: 0,
                    totalAnodes: 0,
                    totalMassKg: 0,
                    totalCurrentA: 0,
                    allAnodes: [],
                    pipelineResults: [],
                    material: emptyParams.materialKey,
                    reinforcementAnalysis: null,
                    zonesRequired: true
                };
                self._displayResultsInUI(noZoneResults);
                if (typeof UI !== 'undefined' && UI.showToast) {
                    UI.showToast('ℹ️ Mode mixte : aucune anode dimensionnée. ' +
                        'Déclarez vos zones critiques via « + Add Zone », puis cliquez sur « Analyser ».', 'warning');
                }
                console.warn('[AnodesOptimization] Mode mixte sans zones analysées : SACP neutralisé.');
                return noZoneResults;
            }

            var pipelines = equipments.map(function (eq) {
                var coords = eq.coordinates || [];
                if (typeof coords === 'string') {
                    try { coords = JSON.parse(coords); } catch (e) { coords = []; }
                }
                if (!Array.isArray(coords) || coords.length < 2) return null;
                return {
                    id: eq.tag || eq.id,
                    coordinates: coords,
                    diameter_m: (eq.dimensions && eq.dimensions.diametre_m) || 0.3,
                    coatingEfficiency: eq.coatingEfficiency || 0.95,
                    currentDensity: eq.currentDensity || 10,
                    defectDensity: eq.defectDensity || 0.05,
                    agingFactor: eq.agingFactor || 1.2,
                    soilResistivity: eq.soilResistivity || 23.85
                };
            }).filter(Boolean);

            if (pipelines.length === 0 && structures.length === 0)
                throw new Error('Aucun pipeline ni structure exploitable (coordonnées GPS) pour ' + effectiveId + '.');

            // Récupérer le courant requis global UNIQUEMENT si explicitement
            // fourni (options). CORRECTION visibilité : ne PLUS lire le champ
            // « anodeCurrentReq » (défaut manuel 1,0 A) ni state.anodes.
            // Ce 1 A arbitraire écrasait le calcul DNV par équipement via un
            // prorata global et sous-dimensionnait tout le projet (ex. 1 A
            // réparti sur pipelines + tanks au lieu de ~I_req réel par
            // ouvrage). Chaque équipement calcule désormais son propre
            // I_req (DNV-RP-B401 / ISO 15589-1) — la somme = protection
            // complète du projet, comme demandé pour le type CP « anodes ».
            var globalIReq = 0;
            if (useReinforcementZones) {
                // Mode mixte : le courant de renforcement est piloté par les zones analysées
                globalIReq = Number(reinforcementAnalysis.totalAdditionalCurrent) || 0;
                console.log('[AnodesOptimization] Mode mixte : courant de renforcement =',
                    globalIReq.toFixed(3), 'A depuis', reinforcementAnalysis.zones.length, 'zone(s)');
            } else if (options.requiredCurrent > 0) {
                globalIReq = Number(options.requiredCurrent);
            } else if (options.I_req > 0) {
                globalIReq = Number(options.I_req);
            }
            // Sinon globalIReq reste à 0 → chaque équipement calcule son
            // propre I_req (DNV-RP-B401 / ISO 15589-1).

            // MODIFICATION : en mode mixte, placement localisé sur les pipelines critiques
            var pipelineResults = [];
            var equipmentResults = [];   // structures non-pipeline (mode anodes standard)
            var skippedEquipment = [];   // non dimensionnables (infos manquantes) — traçabilité
            var distributionWarnings = []; // répartition du compte dimensionné — traçabilité
            // Nombre d'anodes issu du « Dimensionner » (base = courant du
            // module Calcul CP) : source du compte pour la répartition.
            var dimAnodesCount = Math.floor(Number(state.anodes && state.anodes.count) || 0);

            if (useReinforcementZones) {
                // Regrouper les zones par pipeline (location = tag du pipeline)
                var zonePipelines = {};
                reinforcementAnalysis.zones.forEach(function (zone) {
                    var pid = zone.location || '';
                    if (pid && !zonePipelines[pid]) {
                        var match = pipelines.find(function (p) { return p.id === pid; });
                        if (match) zonePipelines[pid] = match;
                    }
                });

                Object.keys(zonePipelines).forEach(function (pid) {
                    var pipeline = zonePipelines[pid];
                    var pipelineZones = reinforcementAnalysis.zones.filter(function (z) { return z.location === pid; });
                    var pipelineCurrent = pipelineZones.reduce(function (sum, z) {
                        return sum + (Number(z.additionalCurrent) || 0);
                    }, 0);
                    var pOptions = Object.assign({}, options);
                    pOptions.pipelineCurrentA = pipelineCurrent;
                    var res = self.optimizeAnodePlacement(pipeline, pOptions);
                    if (res) {
                        res.reinforcementZones = pipelineZones;
                        // ⚠️ Traçabilité : chaque anode est rattachée à la zone
                        // critique qui motive son implantation. Indispensable pour
                        // que _applyAnodesProject() puisse refuser toute anode
                        // hors zone en type CP « mixte ».
                        if (res.anodes && res.anodes.length) {
                            res.anodes.forEach(function (an, idx) {
                                var zone = pipelineZones[Math.min(
                                    Math.floor(idx * pipelineZones.length / res.anodes.length),
                                    pipelineZones.length - 1)];
                                an.zoneId = zone ? zone.zoneId : null;
                                an.zoneName = zone ? zone.zoneName : null;
                                an.reinforcement = true;
                            });
                        }
                        pipelineResults.push(res);
                    }
                });
            } else if (dimAnodesCount > 0) {
                // ═══ RÉPARTITION DU NOMBRE DIMENSIONNÉ (exigence) ═════
                // Le nombre total d'anodes provient du bouton « Dimensionner »
                // (base : courant du module Calcul CP). ICI : uniquement la
                // répartition AMPP/NACE — au prorata des besoins en courant
                // de chaque équipement (ISO 15589-1 / API RP 651) — puis le
                // positionnement le long des ouvrages. AUCUN recalcul du nombre.
                var unitDefs = [];
                var unitWeights = [];

                pipelines.forEach(function (p) {
                    var pLen2 = pipelineLength(p.coordinates);
                    var pSurf2 = Math.PI * p.diameter_m * pLen2;
                    var w = 0;
                    if (typeof CalculationEngine !== 'undefined' && typeof CalculationEngine.requiredCurrent === 'function') {
                        var crP = CalculationEngine.requiredCurrent(
                            pSurf2,
                            p.currentDensity != null ? p.currentDensity : 10,
                            p.coatingEfficiency != null ? p.coatingEfficiency : 0.95,
                            p.defectDensity != null ? p.defectDensity : 0.05,
                            p.agingFactor != null ? p.agingFactor : 1.2,
                            'ISO 15589-1'
                        );
                        w = Number(crP && crP.currentAmperes) || 0;
                    }
                    if (!(w > 0)) w = (pSurf2 * 0.05 * 1.2 * 10) / 1000;
                    unitDefs.push({ kind: 'pipeline', obj: p });
                    unitWeights.push(w);
                });

                structures.forEach(function (s) {
                    var sTagD = s.tag || s.id;
                    var sTypeD = s.type || 'structure';
                    var sSurfD = self._protectedStructureSurface(s);
                    if (!(sSurfD > 0)) {
                        skippedEquipment.push({
                            id: sTagD, type: sTypeD,
                            reason: 'surface inconnue (dimensions manquantes)'
                        });
                        return;
                    }
                    if (self._validCoords(s).length === 0) {
                        skippedEquipment.push({
                            id: sTagD, type: sTypeD,
                            reason: 'coordonnées GPS manquantes'
                        });
                        return;
                    }
                    unitDefs.push({ kind: 'structure', obj: s });
                    unitWeights.push(self._structureCurrentRequired(s, sSurfD));
                });

                var alloc = self._apportionCount(dimAnodesCount, unitWeights);
                unitDefs.forEach(function (u, idx) {
                    var nI = alloc[idx];
                    if (!(nI > 0)) {
                        distributionWarnings.push({
                            id: u.kind === 'pipeline' ? u.obj.id : (u.obj.tag || u.obj.id),
                            reason: 'aucune anode allouée (part du dimensionnement insuffisante pour ce nombre total)'
                        });
                        return;
                    }
                    var uOptions = Object.assign({}, options);
                    uOptions.forcedAnodeCount = nI;
                    if (u.kind === 'pipeline') {
                        if (unitWeights[idx] > 0) uOptions.pipelineCurrentA = unitWeights[idx];
                        var resD = self.optimizeAnodePlacement(u.obj, uOptions);
                        if (resD) pipelineResults.push(resD);
                    } else {
                        if (unitWeights[idx] > 0) uOptions.allocatedCurrentA = unitWeights[idx];
                        var resDS = self._optimizeStructureAnodes(u.obj, uOptions);
                        if (resDS) {
                            equipmentResults.push(resDS);
                        } else {
                            skippedEquipment.push({
                                id: u.obj.tag || u.obj.id, type: u.obj.type || 'structure',
                                reason: 'courant requis nul ou paramètres invalides'
                            });
                        }
                    }
                });
            } else {
                // ── Repli historique (aucun dimensionnement disponible) : ──
                // chaque équipement calcule son propre I_req puis son propre N
                // (DNV-RP-B401). Conservé pour l'API/tests et les flux externes ;
                // l'interface produit bloque « Optimisation Anodes » tant que
                // « Dimensionner » n'a pas été lancé.
                // Mode normal : optimisation sur TOUS les équipements protégés
                // du projet — pipelines ET structures (réservoirs, tanks…).
                // Surface de référence pour répartir le courant global (A).
                var totalSurface = pipelines.reduce(function (sum, p) {
                    var len = pipelineLength(p.coordinates);
                    return sum + (Math.PI * p.diameter_m * len);
                }, 0);
                structures.forEach(function (s) {
                    totalSurface += self._protectedStructureSurface(s);
                });

                pipelineResults = pipelines.map(function (p) {
                    var pLen = pipelineLength(p.coordinates);
                    var pSurf = Math.PI * p.diameter_m * pLen;
                    var pOptions = Object.assign({}, options);
                    if (globalIReq > 0 && totalSurface > 0) {
                        pOptions.pipelineCurrentA = globalIReq * (pSurf / totalSurface);
                    }
                    return self.optimizeAnodePlacement(p, pOptions);
                }).filter(Boolean);

                structures.forEach(function (s) {
                    var sTag = s.tag || s.id;
                    var sType = s.type || 'structure';
                    var sSurf = self._protectedStructureSurface(s);
                    if (!(sSurf > 0)) {
                        skippedEquipment.push({
                            id: sTag, type: sType,
                            reason: 'surface inconnue (dimensions manquantes)'
                        });
                        return;
                    }
                    if (self._validCoords(s).length === 0) {
                        skippedEquipment.push({
                            id: sTag, type: sType,
                            reason: 'coordonnées GPS manquantes'
                        });
                        return;
                    }
                    var sOptions = Object.assign({}, options);
                    if (globalIReq > 0 && totalSurface > 0) {
                        // Répartition au prorata de la surface protégée
                        sOptions.allocatedCurrentA = globalIReq * (sSurf / totalSurface);
                    }
                    var res = self._optimizeStructureAnodes(s, sOptions);
                    if (res) {
                        equipmentResults.push(res);
                    } else {
                        skippedEquipment.push({
                            id: sTag, type: sType,
                            reason: 'courant requis nul ou paramètres invalides'
                        });
                    }
                });
            }

            if (pipelineResults.length === 0 && equipmentResults.length === 0) {
                if (useReinforcementZones) {
                    throw new Error('Aucune zone critique ne correspond à un pipeline du projet. ' +
                        'Vérifiez que le champ « Localisation » des zones correspond exactement au tag ' +
                        'd\'un équipement pipeline (ex. EMN-11).');
                }
                throw new Error('Calcul d\'anodes impossible : vérifiez les paramètres des pipelines et structures du projet.');
            }

            // TOTAUX : pipelines + structures protégées (couverture totale du projet)
            var allResults   = pipelineResults.concat(equipmentResults);
            var totalAnodes  = allResults.reduce(function (s, r) { return s + r.nAnodes; }, 0);
            var totalMass    = allResults.reduce(function (s, r) { return s + r.totalMassKg; }, 0);
            var totalCurrent = allResults.reduce(function (s, r) { return s + r.totalCurrentA; }, 0);
            var allAnodes    = allResults.reduce(function (a, r) { return a.concat(r.anodes); }, []);
            var score        = self._computeScore(allResults);

            var activeParams = self._getAnodeParameters(options);
            var results = {
                mode: useReinforcementZones ? 'mixte_reinforcement' : 'anodes',
                projectId: effectiveId,
                score: score,
                totalAnodes: totalAnodes,
                totalMassKg: totalMass,
                totalCurrentA: totalCurrent,
                allAnodes: allAnodes,
                pipelineResults: pipelineResults,
                equipmentResults: equipmentResults,
                skippedEquipment: skippedEquipment,
                distributionWarnings: distributionWarnings,
                // Source du nombre total d'anodes (traçabilité) :
                countSource: useReinforcementZones ? 'reinforcement_zones'
                            : (dimAnodesCount > 0 ? 'dimensioned' : 'legacy_fallback'),
                designLife: activeParams.life,
                material: activeParams.materialKey,
                reinforcementAnalysis: useReinforcementZones ? reinforcementAnalysis : null
            };

            self._displayResultsInUI(results);
            self._updateGISLayer(results);

            if (typeof UI !== 'undefined' && UI.showToast) {
                var modeLabel = useReinforcementZones ? 'Renforcement Mixte (zones critiques)' : 'Optimisation Anodes';
                UI.showToast(
                    '✅ ' + modeLabel + ' terminée — ' + totalAnodes + ' anodes · Score: ' +
                    (score * 100).toFixed(1) + '%', 'success'
                );
            }
            return results;
        },

        _computeScore: function (pipelineResults) {
            if (!pipelineResults || pipelineResults.length === 0) return 0;
            var sum = 0;
            pipelineResults.forEach(function (r) {
                var idealSpacing = r.pipelineLengthM / (r.nAnodes + 1);
                var deviation = idealSpacing > 0 ? Math.abs(r.spacingM - idealSpacing) / idealSpacing : 1;
                sum += 1 / (1 + deviation);
            });
            return Math.min(1, sum / pipelineResults.length);
        },

        // ── 4. Affichage UI ──────────────────────────────────────
        _displayResultsInUI: function (results) {
            // Mémorisé pour pouvoir re-rendre le bloc après une optimisation
            // TR / Groundbed (déverrouillage du bouton « Appliquer les anodes »).
            this._lastResults = results;
            var isMixte = String(results.mode || '').indexOf('mixte') === 0;

            // ════════════════════════════════════════════════════════
            // SUPPRESSION UI (type CP « mixte ») — demande explicite :
            // le panneau de résultats « Renforcement Mixte — Zones
            // Critiques » n'est plus affiché dans la page
            // « Système ICCP (Courant Imposé) ».
            //
            // Aucune logique métier touchée :
            //   · _lastResults reste mémorisé (re-rendu TR/Groundbed) ;
            //   · le calcul, le GIS (_updateGISLayer) et les toasts sont
            //     gérés par l'appelant, hors de cette fonction ;
            //   · le rendu du mode anodes standard est inchangé.
            // ════════════════════════════════════════════════════════
            if (isMixte) {
                var mixteContainer = document.getElementById('mixteOptimizationResults');
                if (mixteContainer) mixteContainer.innerHTML = '';
                return;
            }

            var containerId = 'anodesOptimizationResults';
            var container = document.getElementById(containerId);
            if (!container) return;

            var title    = results.mode === 'mixte_reinforcement' ? 'Renforcement Mixte — Zones Critiques'
                          : (results.mode === 'mixte_no_zones' ? 'Optimisation Mixte — Zones critiques requises'
                          : (isMixte ? 'Optimisation Mixte' : 'Optimisation Anodes'));
            var icon     = isMixte ? 'fa-layer-group' : 'fa-circle-nodes';
            var matLabels = { 'Mg_HC': 'Magnésium HC', 'Al_ZnIn': 'Aluminium Zn-In', 'Zn_HC': 'Zinc HC' };
            var matLabel  = matLabels[results.material] || results.material;

            var html = '<div class="card" style="margin-top:1rem;">' +
                '<div class="card-header">' +
                '<h3><i class="fas ' + icon + '"></i> ' + escapeHtml(title) + ' — ' + escapeHtml(results.projectId) + '</h3>' +
                '<span class="badge success">Score: ' + (results.score * 100).toFixed(1) + '%</span>' +
                '</div><div class="card-body">' +
                '<div class="result-cards">' +
                '<div class="result-card highlight"><span class="result-label">Nombre total d\'anodes</span>' +
                '<span class="result-value">' + results.totalAnodes + '</span><span class="result-unit">anodes</span></div>' +
                '<div class="result-card"><span class="result-label">Masse totale</span>' +
                '<span class="result-value">' + results.totalMassKg.toFixed(1) + '</span><span class="result-unit">kg</span></div>' +
                '<div class="result-card"><span class="result-label">Courant total requis</span>' +
                '<span class="result-value">' + results.totalCurrentA.toFixed(3) + '</span><span class="result-unit">A</span></div>' +
                '<div class="result-card"><span class="result-label">Matériau</span>' +
                '<span class="result-value" style="font-size:0.85rem;">' + escapeHtml(matLabel) + '</span>' +
                '<span class="result-unit">anode</span></div>' +
                '</div>';

            if (isMixte && results.iccpResults) {
                var iccp = results.iccpResults;
                html += '<div class="result-cards" style="margin-top:0.5rem;padding-top:0.5rem;">' +
                    '<div class="result-card highlight">' +
                    '<span class="result-label">TR Optimal (ICCP)</span>' +
                    '<span class="result-value" style="font-size:0.8rem;">' + iccp.tr.lat.toFixed(6) + ', ' + iccp.tr.lon.toFixed(6) + '</span>' +
                    '<span class="result-unit">lat, lon</span></div>' +
                    '<div class="result-card">' +
                    '<span class="result-label">Groundbed Optimal</span>' +
                    '<span class="result-value" style="font-size:0.8rem;">' + iccp.groundbed.lat.toFixed(6) + ', ' + iccp.groundbed.lon.toFixed(6) + '</span>' +
                    '<span class="result-unit">lat, lon</span></div>' +
                    '<div class="result-card">' +
                    '<span class="result-label">Courant ICCP</span>' +
                    '<span class="result-value">' + iccp.totalCurrent.toFixed(3) + '</span><span class="result-unit">A</span></div>' +
                    '<div class="result-card">' +
                    '<span class="result-label">Score ICCP</span>' +
                    '<span class="result-value">' + (iccp.score * 100).toFixed(1) + '%</span></div></div>';
            }
            if (results.reinforcementAnalysis && results.reinforcementAnalysis.zones) {
                var ra = results.reinforcementAnalysis;
                html += '<div class="result-cards" style="margin-top:0.5rem;padding-top:0.5rem;">' +
                    '<div class="result-card highlight">' +
                    '<span class="result-label">Courant de renforcement (zones)</span>' +
                    '<span class="result-value">' + ra.totalAdditionalCurrent.toFixed(3) + '</span><span class="result-unit">A</span></div>' +
                    '<div class="result-card">' +
                    '<span class="result-label">Zones critiques traitées</span>' +
                    '<span class="result-value">' + ra.zones.length + '</span><span class="result-unit">zones</span></div>' +
                    '</div>' +
                    '<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-muted);">' +
                    '<i class="fas fa-crosshairs"></i> SACP dimensionné en <strong>renforcement local</strong> ' +
                    'sur les zones critiques uniquement (ICCP = protection principale du réseau).</div>';
            }



            html += '<table class="data-table" style="margin-top:0.8rem;font-size:0.82rem;width:100%;">' +
                '<thead><tr><th>Pipeline</th><th>Long.(m)</th><th>I_req(A)</th>' +
                '<th>N anodes</th><th>Espac.(m)</th><th>Masse/u(kg)</th><th>R(Ω)</th></tr></thead><tbody>';

            (results.pipelineResults || []).forEach(function (r) {
                html += '<tr>' +
                    '<td><strong>' + escapeHtml(r.pipelineId) + '</strong></td>' +
                    '<td>' + r.pipelineLengthM.toFixed(0) + '</td>' +
                    '<td>' + r.totalCurrentA.toFixed(3) + '</td>' +
                    '<td>' + r.nAnodes + '</td>' +
                    '<td>' + r.spacingM.toFixed(0) + '</td>' +
                    '<td>' + r.massPerAnodeKg.toFixed(2) + '</td>' +
                    '<td>' + (isFinite(r.R_anode_ohm) ? r.R_anode_ohm.toFixed(2) : '—') + '</td></tr>';
            });

            var lifeNote = results.designLife > 0 ? results.designLife + ' ans' : '25 ans';
            var countNote = results.countSource === 'dimensioned'
                ? 'Nombre d\'anodes issu du « Dimensionner » (base : courant du module Calcul CP) — ' +
                  'répartition AMPP/NACE le long des ouvrages, sans recalcul.'
                : 'Calcul selon DNV-RP-B401 / ISO 15589-1.';
            html += '</tbody></table>' +
                '<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-muted);">' +
                '<i class="fas fa-info-circle"></i> ' +
                countNote + ' Résistance Dwight (cylindrique). ' +
                'Facteur d\'utilisation 85%. Durée de vie ' + lifeNote + '.</div>';

            // ── Structures protégées (type CP « anodes ») : tout le projet ──
            if (results.equipmentResults && results.equipmentResults.length) {
                html += '<table class="data-table" style="margin-top:0.8rem;font-size:0.82rem;width:100%;">' +
                    '<thead><tr><th>Équipement</th><th>Type</th><th>Long./Perm.(m)</th>' +
                    '<th>Surface(m²)</th><th>I_req(A)</th><th>N anodes</th>' +
                    '<th>Espac.(m)</th><th>Masse/u(kg)</th></tr></thead><tbody>';
                results.equipmentResults.forEach(function (r) {
                    html += '<tr>' +
                        '<td><strong>' + escapeHtml(r.equipmentTag || r.pipelineId) + '</strong></td>' +
                        '<td>' + escapeHtml(r.equipmentType || 'structure') + '</td>' +
                        '<td>' + r.pipelineLengthM.toFixed(0) + '</td>' +
                        '<td>' + (isFinite(r.structureSurfaceM2) ? r.structureSurfaceM2.toFixed(1) : '—') + '</td>' +
                        '<td>' + r.totalCurrentA.toFixed(3) + '</td>' +
                        '<td>' + r.nAnodes + '</td>' +
                        '<td>' + r.spacingM.toFixed(0) + '</td>' +
                        '<td>' + r.massPerAnodeKg.toFixed(2) + '</td></tr>';
                });
                html += '</tbody></table>';
            }
            if (results.skippedEquipment && results.skippedEquipment.length) {
                html += '<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--accent-orange,#f59e0b);">' +
                    '<i class="fas fa-exclamation-triangle"></i> ' +
                    results.skippedEquipment.length + ' équipement(s) non dimensionné(s) : ' +
                    results.skippedEquipment.map(function (s) {
                        return escapeHtml(s.id) + ' (' + escapeHtml(s.reason) + ')';
                    }).join(', ') + '.</div>';
            }

            // ⚠️ CORRECTION (incohérence majeure) : en type CP « mixte », les anodes
            // sacrificielles sont positionnées UNIQUEMENT dans les zones critiques
            // issues de « + Add Zone ». Le bouton générique « Appliquer les anodes
            // au projet » est donc DÉSAKTIVÉ : il porte désormais un bouton
            // dédié, limité au renforcement des zones.
            var isMixteMode = results.mode === 'mixte' || results.mode === 'mixte_reinforcement';
            var noZones = results.mode === 'mixte_no_zones';
            var hasZoneScope = isMixteMode && !noZones &&
                               !!results.reinforcementAnalysis &&
                               Array.isArray(results.reinforcementAnalysis.zones) &&
                               results.reinforcementAnalysis.zones.length > 0 &&
                               (results.allAnodes || []).length > 0;

            html += '<div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">';

            if (isMixteMode || noZones) {
                // Bouton générique INTERDIT en mode mixte
                html += '<button id="applyAnodesBtn" class="btn btn-primary touch-target" disabled ' +
                    'title="Type CP mixte : les anodes sacrificielles ne sont placées que dans les zones critiques (fonction « + Add Zone »).">' +
                    '<i class="fas fa-ban"></i> Appliquer les anodes au projet</button>';
            } else {
                html += '<button id="applyAnodesBtn" class="btn btn-primary touch-target">' +
                    '<i class="fas fa-check"></i> Appliquer les anodes au projet</button>';
            }

            // Bouton dédié au renforcement des zones critiques
            if (hasZoneScope) {
                html += '<button id="applyZoneReinforcementBtn" class="btn btn-success touch-target">' +
                    '<i class="fas fa-map-marker-alt"></i> Appliquer le renforcement des ' +
                    results.reinforcementAnalysis.zones.length + ' zone(s) critique(s)</button>';
            }

            html += '<button id="exportAnodesReportBtn" class="btn btn-info touch-target">' +
                '<i class="fas fa-file-export"></i> Exporter le rapport</button>' +
                '</div>';

            if (noZones) {
                html += '<div style="margin-top:0.4rem;font-size:0.8rem;color:var(--accent-orange,#f59e0b);">' +
                    '<i class="fas fa-circle-info"></i> <strong>Aucune anode calculée.</strong> En type CP « mixte », ' +
                    'le SACP est un renforcement <strong>localisé</strong> : déclarez vos zones critiques via ' +
                    '« + Add Zone », puis cliquez sur « Analyser » avant l\'optimisation.</div>';
            } else if (isMixteMode) {
                html += '<div style="margin-top:0.4rem;font-size:0.8rem;color:var(--accent-orange,#f59e0b);">' +
                    '<i class="fas fa-circle-info"></i> Type CP « mixte » : l\'application des anodes est limitée ' +
                    'aux <strong>zones critiques</strong>. Le bouton global est volontairement désactivé pour ' +
                    'empêcher toute implantation hors zone.</div>';
            }
            html += '</div></div>';

            container.innerHTML = html;

            // Auto-ouverture de l'onglet « Résultats » (module Anodes) :
            // sans cela le panneau est rendu mais reste caché derrière
            // l'onglet « Paramètres » actif → impression « rien ne change ».
            try {
                var resultsPanel = document.getElementById('anode-results-panel');
                var tabsGroup = resultsPanel ? resultsPanel.closest('[data-tabs]') : null;
                if (tabsGroup) {
                    var tabBtn = tabsGroup.querySelector('[data-tab-target="anode-results-panel"]');
                    if (tabBtn) tabBtn.click();
                    else {
                        var _btns = tabsGroup.querySelectorAll('.ui-tab-button');
                        var _panels = tabsGroup.querySelectorAll('.ui-tab-panel');
                        for (var _bi = 0; _bi < _btns.length; _bi++) {
                            var _on = _btns[_bi].getAttribute('data-tab-target') === 'anode-results-panel';
                            _btns[_bi].classList.toggle('active', _on);
                            _btns[_bi].setAttribute('aria-selected', String(_on));
                        }
                        for (var _pi = 0; _pi < _panels.length; _pi++) {
                            var _pa = _panels[_pi].id === 'anode-results-panel';
                            _panels[_pi].classList.toggle('active', _pa);
                            _panels[_pi].hidden = !_pa;
                        }
                    }
                }
            } catch (eTab) { /* affichage seul — jamais bloquant */ }

            var self = this;
            var applyBtn = document.getElementById('applyAnodesBtn');
            if (applyBtn && !applyBtn.disabled && !applyBtn.dataset.optHook) {
                applyBtn.dataset.optHook = '1';
                applyBtn.addEventListener('click', function () { self._applyAnodesProject(results); });
            }

            var zoneBtn = document.getElementById('applyZoneReinforcementBtn');
            if (zoneBtn && !zoneBtn.dataset.optHook) {
                zoneBtn.dataset.optHook = '1';
                zoneBtn.addEventListener('click', function () { self._applyAnodesProject(results); });
            }

            var exportBtn = document.getElementById('exportAnodesReportBtn');
            if (exportBtn && !exportBtn.dataset.optHook) {
                exportBtn.dataset.optHook = '1';
                exportBtn.addEventListener('click', function () { self._exportReport(results); });
            }
        },

        // Recentrage de la carte (module Cartographie) sur les anodes
        _fitMapToAnodes: function () {
            var gisMap = (window.GisIntegration && typeof window.GisIntegration.getMap === 'function')
                ? window.GisIntegration.getMap() : null;
            var layer = window._anodesOptLayer;
            if (!gisMap || !layer || typeof layer.getBounds !== 'function') return false;
            try {
                var bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                    gisMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
                    return true;
                }
            } catch (e) { /* carte non prête */ }
            return false;
        },

        // ── 5. Appliquer au projet ───────────────────────────────
        _applyAnodesProject: function (results) {
            // ⚠️ CORRECTION (incohérence majeure) — GARDE-FOU STRICT.
            // En type CP « mixte », on refuse d'appliquer des anodes qui ne
            // seraient pas rattachées à une zone critique « + Add Zone ».
            // C'est la dernière barrière : même en cas d'appel direct ou de
            // résultat ancien, aucune anode hors zone ne peut être créée.
            var modeStr = String(results.mode || '');
            if (modeStr.indexOf('mixte') === 0) {
                var zones = (results.reinforcementAnalysis &&
                             Array.isArray(results.reinforcementAnalysis.zones))
                            ? results.reinforcementAnalysis.zones : [];
                if (zones.length === 0) {
                    if (typeof UI !== 'undefined' && UI.showToast)
                        UI.showToast('❌ Type CP mixte : aucune zone critique analysée. ' +
                            'Déclarez vos zones via « + Add Zone » puis « Analyser ».', 'error');
                    return;
                }
                var zoneIds = {};
                zones.forEach(function (z) { if (z && z.zoneId) zoneIds[z.zoneId] = true; });
                var anodesToApply = results.allAnodes || [];
                var orphans = anodesToApply.filter(function (a) {
                    var zid = a && a.zoneId;
                    return !zid || !zoneIds[zid];
                });
                if (orphans.length > 0 || anodesToApply.length === 0) {
                    console.warn('[AnodesOptimization] Application refusée : ' +
                        orphans.length + ' anode(s) hors zone critique sur ' + anodesToApply.length + '.');
                    if (typeof UI !== 'undefined' && UI.showToast)
                        UI.showToast('❌ Type CP mixte : application refusée — ' +
                            'les anodes doivent être rattachées à une zone critique « + Add Zone ».', 'error');
                    return;
                }
                console.log('[AnodesOptimization] Renforcement de ' + zones.length +
                    ' zone(s) critique(s) — ' + anodesToApply.length + ' anode(s) autorisée(s).');
            }

            if (typeof ProjectManager === 'undefined') {
                if (typeof UI !== 'undefined' && UI.showToast)
                    UI.showToast('❌ ProjectManager non disponible.', 'error');
                return;
            }
            var state     = ProjectManager.getState();
            var activeSys = ProjectManager.getActiveSystem ? ProjectManager.getActiveSystem() : null;

            // Résolution du système cible : système actif, sinon premier système du projet
            var targetSystemId = activeSys ? activeSys.id : null;
            if (!targetSystemId && Array.isArray(state.systems)) {
                var sysForProject = state.systems.find(function (s) {
                    return s && (s.projectId === results.projectId || !s.projectId);
                });
                if (sysForProject) targetSystemId = sysForProject.id;
            }

            // Index des zones critiques par pipeline (mode renforcement mixte)
            var zonesByPipeline = {};
            if (results.reinforcementAnalysis && Array.isArray(results.reinforcementAnalysis.zones)) {
                results.reinforcementAnalysis.zones.forEach(function (z) {
                    var key = z.location || '';
                    if (!key) return;
                    if (!zonesByPipeline[key]) zonesByPipeline[key] = [];
                    zonesByPipeline[key].push(z);
                });
            }

            // Nettoyer les anciennes anodes de l'optimiseur pour ce projet (évite les doublons)
            var equipments = state.equipments || [];
            var toRemove = equipments.filter(function (eq) {
                return eq.projectId === results.projectId &&
                    (eq.createdByOptimizer === true || (typeof eq.tag === 'string' && eq.tag.indexOf('ANODE-') === 0));
            });
            toRemove.forEach(function (oldEq) {
                if (typeof ProjectManager.deleteEquipment === 'function') {
                    ProjectManager.deleteEquipment(oldEq.id);
                }
            });

            var added = 0;
            var reinforcementMass = 0;
            var reinforcementCurrent = 0;
            var isReinforcement = String(results.mode || '').indexOf('mixte') === 0;
            (results.allAnodes || []).forEach(function (anode) {
                // zoneId porté par l'anode lui-même (calculé dans runForProject).
                // Repli : première zone critique du pipeline concerné.
                var zoneId = anode.zoneId || null;
                if (!zoneId && anode.pipelineId && zonesByPipeline[anode.pipelineId] &&
                    zonesByPipeline[anode.pipelineId].length) {
                    var fallbackZone = zonesByPipeline[anode.pipelineId][0];
                    zoneId = fallbackZone ? (fallbackZone.zoneId || fallbackZone.id || null) : null;
                }
                ProjectManager.saveEquipment({
                    id: 'ANODE-OPT-' + Date.now() + '-' + added,
                    tag: anode.id,
                    type: 'anode',
                    projectId: results.projectId,
                    coordinates: { lat: anode.lat, lon: anode.lon, alt: 0 },
                    included: true,
                    systemId: targetSystemId,
                    dimensions: { longueur_m: anode.L_anode_m, diametre_m: anode.d_anode_m },
                    material: anode.material,
                    nominalCurrent: anode.I_output_A,
                    mass_kg: anode.mass_kg,
                    zoneId: zoneId,
                    pipelineId: anode.pipelineId || null,
                    reinforcement: isReinforcement,
                    createdByOptimizer: true
                });
                reinforcementMass += Number(anode.mass_kg) || 0;
                reinforcementCurrent += Number(anode.I_output_A) || 0;
                added++;
            });

            // Synchroniser le module SACP avec les anodes de renforcement appliquées
            if (isReinforcement) {
                if (!state.anodes) state.anodes = {};
                if (!Number(state.anodes.count)) {
                    state.anodes.count = added;
                    state.anodes.totalMass = reinforcementMass;
                    if (!Number(state.anodes.initialCurrent)) {
                        state.anodes.initialCurrent = reinforcementCurrent;
                    }
                }
                state.iccp = state.iccp || {};
                state.iccp.reinforcementApplied = {
                    count: added,
                    totalMassKg: reinforcementMass,
                    totalCurrentA: reinforcementCurrent,
                    appliedAt: new Date().toISOString()
                };
                if (typeof ProjectManager.saveCurrentProject === 'function') {
                    ProjectManager.saveCurrentProject();
                }
            }

            if (typeof UI !== 'undefined' && UI.showToast)
                UI.showToast('✅ ' + added + ' anode(s) appliquée(s) au projet ' + results.projectId + '.', 'success');
        },

        // ── 6. Mise à jour GIS ──────────────────────────────────
        _updateGISLayer: function (results) {
            try {
                document.dispatchEvent(new CustomEvent('cp:anodesOptimized', {
                    detail: {
                        mode: results.mode,
                        projectId: results.projectId,
                        anodes: results.allAnodes,
                        iccpResults: results.iccpResults || null
                    }
                }));
            } catch (e) {
                console.warn('[AnodesOptimization] GIS dispatch failed:', e);
            }
        },

        // ── 7. Export rapport TXT ────────────────────────────────
        _exportReport: function (results) {
            var lines = [];
            var sep = function () { lines.push('='.repeat(60)); };
            sep();
            var isMixte = String(results.mode || '').indexOf('mixte') === 0;
            var modeLabel = isMixte ? 'OPTIMISATION MIXTE' : 'OPTIMISATION ANODES';
            lines.push('       ' + modeLabel + ' - ' + results.projectId);
            lines.push('       CP Engineer Pro v' + this.VERSION + ' — DNV-RP-B401 / ISO 15589-1');
            sep();
            lines.push('');
            lines.push('Score global         : ' + (results.score * 100).toFixed(1) + ' %');
            lines.push('Nombre total anodes  : ' + results.totalAnodes);
            lines.push('Masse totale         : ' + results.totalMassKg.toFixed(2) + ' kg');
            lines.push('Courant total requis : ' + results.totalCurrentA.toFixed(3) + ' A');
            lines.push('Matériau             : ' + results.material);
            lines.push('');

            if (isMixte && results.iccpResults) {
                var iccp = results.iccpResults;
                lines.push('--- Composante ICCP ---');
                lines.push('TR Optimal    : ' + iccp.tr.lat.toFixed(6) + ', ' + iccp.tr.lon.toFixed(6));
                lines.push('GB Optimal    : ' + iccp.groundbed.lat.toFixed(6) + ', ' + iccp.groundbed.lon.toFixed(6));
                lines.push('Courant ICCP  : ' + iccp.totalCurrent.toFixed(3) + ' A');
                lines.push('Score ICCP    : ' + (iccp.score * 100).toFixed(1) + ' %');
                lines.push('');
            }
            var ra = results.reinforcementAnalysis;
            if (ra && ra.zones && ra.zones.length) {
                lines.push('--- Renforcement local (zones critiques) ---');
                lines.push('Courant de renforcement total : ' + ra.totalAdditionalCurrent.toFixed(3) + ' A');
                lines.push('Anodes de renforcement totales : ' + ra.totalAnodesRequired);
                lines.push('Zones | Localisation | Problème | Courant+ (A) | Anodes');
                lines.push('-'.repeat(90));
                ra.zones.forEach(function (z) {
                    lines.push(
                        String(z.zoneName).padEnd(28) + '| ' +
                        String(z.location || '—').padEnd(14) + ' | ' +
                        String(z.problemType || '—').padEnd(20) + ' | ' +
                        String((z.additionalCurrent || 0).toFixed(3)).padStart(10) + ' | ' +
                        String(z.anodesCount || 0).padStart(6)
                    );
                });
                lines.push('');
            }



            lines.push('--- Détail par pipeline ---');
            lines.push('Pipeline          | Long.(m) | I_req(A) | N_anodes | Esp.(m) | Masse/u(kg) | R(Ω)');
            lines.push('-'.repeat(90));
            (results.pipelineResults || []).forEach(function (r) {
                lines.push(
                    String(r.pipelineId).padEnd(17) + '| ' +
                    String(r.pipelineLengthM.toFixed(0)).padStart(8) + ' | ' +
                    String(r.totalCurrentA.toFixed(3)).padStart(8) + ' | ' +
                    String(r.nAnodes).padStart(8) + ' | ' +
                    String(r.spacingM.toFixed(0)).padStart(7) + ' | ' +
                    String(r.massPerAnodeKg.toFixed(2)).padStart(11) + ' | ' +
                    (isFinite(r.R_anode_ohm) ? r.R_anode_ohm.toFixed(2) : ' N/A')
                );
            });
            if (results.equipmentResults && results.equipmentResults.length) {
                lines.push('--- Détail par équipement protégé (structures) ---');
                lines.push('Équipement      | Type                  | Long/Perm(m) | Surface(m²) | I_req(A) | N_anodes | Esp.(m)');
                lines.push('-'.repeat(100));
                results.equipmentResults.forEach(function (r) {
                    lines.push(
                        String(r.equipmentTag || '—').padEnd(16) + '| ' +
                        String(r.equipmentType || 'structure').padEnd(22) + ' | ' +
                        String(r.pipelineLengthM.toFixed(0)).padStart(11) + ' | ' +
                        String(isFinite(r.structureSurfaceM2) ? r.structureSurfaceM2.toFixed(1) : 'N/A').padStart(10) + ' | ' +
                        String(r.totalCurrentA.toFixed(3)).padStart(8) + ' | ' +
                        String(r.nAnodes).padStart(8) + ' | ' +
                        String(r.spacingM.toFixed(0)).padStart(7)
                    );
                });
            }
            lines.push('');
            lines.push('--- Positions des anodes ---');
            (results.allAnodes || []).forEach(function (a) {
                lines.push(
                    String(a.id).padEnd(30) +
                    ' lat:' + a.lat.toFixed(6) +
                    ' lon:' + a.lon.toFixed(6) +
                    ' I:'  + a.I_output_A.toFixed(4) + 'A' +
                    ' m:'  + a.mass_kg.toFixed(2) + 'kg'
                );
            });
            sep();

            var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
            var url  = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href     = url;
            link.download = 'optimization_' + results.mode + '_' + results.projectId + '.txt';
            link.click();
            URL.revokeObjectURL(url);
        }
    };

    // ============================================================
    // MixteOptimizationEngine
    // ============================================================
    var MixteOptimizationEngine = {

        VERSION: '1.0.0',

        runForProject: async function (projectId, options) {
            options = options || {};
            var effectiveId = projectId || (
                typeof ProjectManager !== 'undefined' && ProjectManager.getCurrentProjectId
                    ? ProjectManager.getCurrentProjectId() : null
            );
            if (!effectiveId) throw new Error('Aucun projet actif.');

            // Garde-fou : zones critiques définies mais non analysées
            var mixteState = (typeof ProjectManager !== 'undefined') ? ProjectManager.getState() : {};
            var definedZones = (mixteState.iccp && Array.isArray(mixteState.iccp.reinforcementZones))
                ? mixteState.iccp.reinforcementZones.length : 0;
            var analysedZones = (mixteState.iccp && mixteState.iccp.reinforcementAnalysis &&
                Array.isArray(mixteState.iccp.reinforcementAnalysis.zones))
                ? mixteState.iccp.reinforcementAnalysis.zones.length : 0;

            if (definedZones > 0 && analysedZones === 0 && typeof UI !== 'undefined' && UI.showToast) {
                UI.showToast('⚠️ ' + definedZones + ' zone(s) définie(s) mais non analysée(s). ' +
                    'Cliquez sur « Analyser » avant l\'optimisation mixte pour un renforcement localisé.', 'warning');
            }


            // 1. Optimisation ICCP
            var iccpResults = null;
            if (typeof window.ICCPOptimizationEngine !== 'undefined') {
                try {
                    iccpResults = await window.ICCPOptimizationEngine.runForProject(effectiveId, options);
                } catch (iccpErr) {
                    console.warn('[MixteOptimization] ICCP partiel:', iccpErr.message);
                }
            }

            // 2. Optimisation Anodes (mode renforcement si zones analysées)
            var anodesOptions = Object.assign({}, options, { mode: 'mixte' });
            var anodesResults = await AnodesOptimizationEngine.runForProject(effectiveId, anodesOptions);

            // 3. Score combiné 60% ICCP + 40% Anodes
            var iccpScore    = iccpResults ? iccpResults.score : 0;
            var anodesScore  = anodesResults.score;
            var combinedScore = iccpResults
                ? (0.6 * iccpScore + 0.4 * anodesScore)
                : anodesScore;

            var hasReinforcement = !!(anodesResults.reinforcementAnalysis &&
                Array.isArray(anodesResults.reinforcementAnalysis.zones) &&
                anodesResults.reinforcementAnalysis.zones.length > 0);

            // ⚠️ CORRECTION : le mode « mixte sans zones » doit être PRÉSERVÉ.
            // Sinon le résultat serait requalifié en « mixte » et l'interface
            // proposerait à nouveau une application d'anodes hors zones.
            var noZonesMode = anodesResults.mode === 'mixte_no_zones';

            var mixteResults = Object.assign({}, anodesResults, {
                mode: noZonesMode ? 'mixte_no_zones'
                       : (hasReinforcement ? 'mixte_reinforcement' : 'mixte'),
                score: combinedScore,
                iccpResults: iccpResults,
                iccpScore: iccpScore,
                anodesScore: anodesScore
            });

            AnodesOptimizationEngine._displayResultsInUI(mixteResults);
            AnodesOptimizationEngine._updateGISLayer(mixteResults);

            if (typeof UI !== 'undefined' && UI.showToast) {
                var label, tone = 'success';
                if (noZonesMode) {
                    label = 'Optimisation Mixte : ICCP optimisé, SACP non dimensionné ' +
                            '(aucune zone critique analysée)';
                    tone = 'warning';
                } else {
                    label = hasReinforcement
                        ? 'Optimisation Mixte (renforcement localisé) terminée'
                        : 'Optimisation Mixte terminée';
                }
                UI.showToast(
                    (tone === 'success' ? '✅ ' : '⚠️ ') + label + ' — Score: ' +
                    (combinedScore * 100).toFixed(1) + '%',
                    tone
                );
            }
            return mixteResults;
        }
    };

    // ============================================================
    // Exposition globale
    // ============================================================
    window.AnodesOptimizationEngine = AnodesOptimizationEngine;
    window.MixteOptimizationEngine  = MixteOptimizationEngine;

    // ============================================================
    // DOMContentLoaded — injection boutons + conteneurs
    // ============================================================
    document.addEventListener('DOMContentLoaded', function () {

        // ── Bouton « Optimisation Anodes » dans module-anodes ────
        // CORRECTION : injecté dans la TOOLBAR (.module-top-actions, à côté
        // de « Dimensionner ») — visible dans TOUS les onglets. L'ancien
        // emplacement (bas de page, .form-actions) + une visibilité pilotée
        // uniquement par le radio Type CP (défaut « mixte ») rendaient le
        // bouton INVISIBLE alors que le système actif est de type « anodes ».
        var moduleAnodes = document.getElementById('module-anodes');
        if (moduleAnodes) {
            var actionsA = moduleAnodes.querySelector('.module-top-actions') ||
                           moduleAnodes.querySelector('.form-actions');
            if (actionsA && !document.getElementById('anodesOptimizeBtn')) {
                var optBtn = document.createElement('button');
                optBtn.type      = 'button';
                optBtn.className = 'btn btn-warning touch-target';
                optBtn.id        = 'anodesOptimizeBtn';
                optBtn.innerHTML = '<i class="fas fa-circle-nodes"></i> Optimisation Anodes';
                optBtn.title     = 'Calcule le placement optimal des anodes sacrificielles selon DNV-RP-B401 / ISO 15589-1.';

                optBtn.addEventListener('click', async function () {
                    this.disabled = true;
                    this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Optimisation en cours...';
                    try {
                        if (typeof ProjectManager === 'undefined')
                            throw new Error('ProjectManager non disponible.');
                        var pid = ProjectManager.getCurrentProjectId();
                        if (!pid || pid === '__all__')
                            throw new Error("Sélectionnez un projet unique avant d'optimiser.");
                        // ═══ Exigence : l'optimisation NE RECALCULE JAMAIS le
                        // nombre d'anodes — elle répartit/positionne celles du
                        // « Dimensionner » (base : courant du module Calcul CP).
                        if (resolveCpType() === 'anodes') {
                            var stOpt = ProjectManager.getState();
                            if (!(stOpt && stOpt.anodes && Number(stOpt.anodes.count) > 0)) {
                                if (typeof UI !== 'undefined' && UI.showToast)
                                    UI.showToast('⚠️ Cliquez d\'abord sur « Dimensionner » : l\'optimisation répartit le nombre d\'anodes dimensionné (base : courant du module Calcul CP), elle ne le recalcule pas.', 'warning');
                                return;
                            }
                        }
                        await window.AnodesOptimizationEngine.runForProject(pid, {});
                    } catch (err) {
                        console.error('[AnodesOptimization]', err);
                        if (typeof UI !== 'undefined' && UI.showToast)
                            UI.showToast('❌ ' + err.message, 'error');
                    } finally {
                        this.disabled = false;
                        this.innerHTML = '<i class="fas fa-circle-nodes"></i> Optimisation Anodes';
                    }
                });

                var saveABtn = document.getElementById('saveAnodesSystemBtn');
                // ⚠️ CORRECTION (bouton jamais injecté) : saveAnodesSystemBtn se
                // trouve dans .form-actions (formulaire), PAS dans
                // .module-top-actions (toolbar). insertBefore() jette une
                // NotFoundError si le nœud de référence n'est pas un enfant du
                // conteneur → le bouton n'était jamais ajouté ET l'exception
                // interrompait tout le reste du handler DOMContentLoaded.
                if (saveABtn && saveABtn.parentNode === actionsA) actionsA.insertBefore(optBtn, saveABtn);
                else actionsA.appendChild(optBtn);
            }

            if (!document.getElementById('anodesOptimizationResults')) {
                var cA = document.createElement('div');
                cA.id = 'anodesOptimizationResults';
                cA.style.marginTop = '1rem';
                var arcA = document.getElementById('anodeResultsContent');
                if (arcA && arcA.parentNode) arcA.parentNode.insertBefore(cA, arcA.nextSibling);
                else moduleAnodes.appendChild(cA);
            }
        }

        // ── « Dimensionner » (formulaire) → dimensionne AUSSI le projet ──
        // CORRECTION : cliquer sur « Dimensionner » ne faisait que le calcul
        // formulaire (CPController.calculateAnodes) — aucune estimation par
        // équipement, aucune position sur la carte, aucun panneau Cartographie.
        // On lance ensuite l'optimisation projet (TOUS les équipements) quand
        // le type CP effectif est « anodes » (système actif ou radio).
        var anodeFormEl = document.getElementById('anodeForm');
        if (anodeFormEl && !anodeFormEl.dataset.optimizeHook) {
            anodeFormEl.dataset.optimizeHook = '1';
            anodeFormEl.addEventListener('submit', function () {
                // ui.js/CPController traitent le formulaire dans leur propre
                // listener (enregistré avant) — on attend la fin du calcul.
                setTimeout(function () {
                    (async function () {
                        try {
                            if (resolveCpType() !== 'anodes') return;
                            if (typeof ProjectManager === 'undefined') return;
                            var pid = ProjectManager.getCurrentProjectId();
                            if (!pid || pid === '__all__') return;
                            await window.AnodesOptimizationEngine.runForProject(pid, {});
                        } catch (err) {
                            console.warn('[AnodesOptimization] Optimisation projet (Dimensionner) :',
                                err && err.message);
                        }
                    })();
                }, 400);
            });
        }

        // ── Bouton « Optimisation Mixte » dans module-iccp ────────
        var moduleICCP = document.getElementById('module-iccp');
        if (moduleICCP) {
            var actionsI = moduleICCP.querySelector('.form-actions');
            if (actionsI && !document.getElementById('mixteOptimizeBtn')) {
                var mixteBtn = document.createElement('button');
                mixteBtn.type      = 'button';
                mixteBtn.className = 'btn btn-info touch-target';
                mixteBtn.id        = 'mixteOptimizeBtn';
                mixteBtn.innerHTML = '<i class="fas fa-layer-group"></i> Optimisation Mixte';
                mixteBtn.title     = 'Optimise simultanément TR/Groundbed (ICCP) et anodes sacrificielles.';
                mixteBtn.style.display = 'inline-flex';

                mixteBtn.addEventListener('click', async function () {
                    this.disabled = true;
                    this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Optimisation en cours...';
                    try {
                        if (typeof ProjectManager === 'undefined')
                            throw new Error('ProjectManager non disponible.');
                        var pid = ProjectManager.getCurrentProjectId();
                        if (!pid || pid === '__all__')
                            throw new Error("Sélectionnez un projet unique avant d'optimiser.");
                        await window.MixteOptimizationEngine.runForProject(pid, {});
                    } catch (err) {
                        console.error('[MixteOptimization]', err);
                        if (typeof UI !== 'undefined' && UI.showToast)
                            UI.showToast('❌ ' + err.message, 'error');
                    } finally {
                        this.disabled = false;
                        this.innerHTML = '<i class="fas fa-layer-group"></i> Optimisation Mixte';
                    }
                });

                var saveIBtn = document.getElementById('saveIccpSystemBtn');
                // Garde-fou identique au bouton anodes : insertBefore() jette
                // si le nœud de référence n'est pas un enfant du conteneur.
                if (saveIBtn && saveIBtn.parentNode === actionsI) actionsI.insertBefore(mixteBtn, saveIBtn);
                else actionsI.appendChild(mixteBtn);
            }

            // ════════════════════════════════════════════════════════
            // SUPPRESSION UI (type CP « mixte ») — demande explicite :
            // le conteneur « mixteOptimizationResults » (panneau « Renforce-
            // ment Mixte — Zones Critiques ») n'est plus créé dans la page
            // « Système ICCP (Courant Imposé) ». Aucun espace résiduel n'est
            // laissé et la logique métier reste inchangée.
            // ════════════════════════════════════════════════════════
        }

        // ── Boutons « Optimiser TR » / « Optimiser Groundbed » (mode ICCP + mixte) ──
        // ⚠️ CORRECTION n°2 : ces 2 boutons n'existaient pas. En mode mixte,
        // seul « Optimisation Mixte » était proposé et le bouton ICCP unique
        // (« Optimiser les positions ») était masqué (display:none) → aucune
        // optimisation TR / Groundbed accessible en mode mixte.
        var moduleICCPTr = document.getElementById('module-iccp');
        if (moduleICCPTr) {
            var actionsTr = moduleICCPTr.querySelector('.form-actions');
            if (actionsTr && !document.getElementById('optimizeTrBtn')) {

                var _runIccpOptimize = async function (btn, label, iconHtml) {
                    btn.disabled = true;
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Optimisation en cours...';
                    try {
                        if (typeof ProjectManager === 'undefined')
                            throw new Error('ProjectManager non disponible.');
                        var pid = ProjectManager.getCurrentProjectId();
                        if (!pid || pid === '__all__')
                            throw new Error("Sélectionnez un projet unique avant d'optimiser.");
                        var res = await window.ICCPOptimizationEngine.run(pid, {}, true);
                        if (typeof UI !== 'undefined' && UI.showToast) {
                            UI.showToast('✅ ' + label + ' optimisé pour ' + pid + '.', 'success');
                        }
                        document.dispatchEvent(new CustomEvent('cp:iccpOptimized', {
                            detail: { projectId: pid, results: res }
                        }));
                        // ⚠️ CORRECTION n°3 : l'ICCP principal est positionné →
                        // débloque « Appliquer les anodes » pour ce projet et
                        // re-rend le bloc de résultats mixte s'il est affiché.
                        _iccpOptimizedByProject[pid] = true;
                        var last = window.AnodesOptimizationEngine && window.AnodesOptimizationEngine._lastResults;
                        if (last && (last.mode === 'mixte' || last.mode === 'mixte_reinforcement')) {
                            window.AnodesOptimizationEngine._displayResultsInUI(last);
                        }
                    } catch (err) {
                        console.error('[ICCPOptimization]', err);
                        if (typeof UI !== 'undefined' && UI.showToast)
                            UI.showToast('❌ ' + err.message, 'error');
                    } finally {
                        btn.disabled = false;
                        btn.innerHTML = iconHtml;
                    }
                };

                // Bouton Optimiser TR
                var trBtn = document.createElement('button');
                trBtn.type = 'button';
                trBtn.className = 'btn btn-info touch-target';
                trBtn.id = 'optimizeTrBtn';
                var trIcon = '<i class="fas fa-bolt"></i> Optimiser TR';
                trBtn.innerHTML = trIcon;
                trBtn.title = 'Détermine la position optimale du redresseur (ICCP principal).';
                trBtn.style.display = "";
                trBtn.addEventListener('click', function () {
                    _runIccpOptimize(this, 'Redresseur (TR)', trIcon);
                });

                // Bouton Optimiser Groundbed
                var gbBtn = document.createElement('button');
                gbBtn.type = 'button';
                gbBtn.className = 'btn btn-info touch-target';
                gbBtn.id = 'optimizeGroundbedBtn';
                var gbIcon = '<i class="fas fa-water"></i> Optimiser Groundbed';
                gbBtn.innerHTML = gbIcon;
                gbBtn.title = 'Détermine la position optimale du puits anodique (déversoir).';
                gbBtn.style.display = 'none';
                gbBtn.addEventListener('click', function () {
                    _runIccpOptimize(this, 'Groundbed (déversoir)', gbIcon);
                });

                var saveTrBtn = document.getElementById('saveIccpSystemBtn');
                // Garde-fou identique au bouton anodes : insertBefore() jette
                // si le nœud de référence n'est pas un enfant du conteneur.
                if (saveTrBtn && saveTrBtn.parentNode === actionsTr) {
                    actionsTr.insertBefore(trBtn, saveTrBtn);
                    actionsTr.insertBefore(gbBtn, saveTrBtn);
                } else {
                    actionsTr.appendChild(trBtn);
                    actionsTr.appendChild(gbBtn);
                }
            }
        }

        // ── Réactivité radio cpSystemType ────────────────────────
        // En mode « mixte », l'ICCP reste la protection PRINCIPALE :
        // les boutons Optimiser TR / Optimiser Groundbed doivent donc
        // être visibles (correction n°2).
        // AnodesOptimizationEngine.js est chargé APRÈS ICCPOptimizationEngine.js
        // → ce gestionnaire est l'unique source de vérité pour ces boutons.
        function applyCpTypeVisibility(t) {
            var anodesBtn = document.getElementById('anodesOptimizeBtn');
            var mixteBtn  = document.getElementById('mixteOptimizeBtn');
            var trBtn     = document.getElementById('optimizeTrBtn');
            var gbBtn     = document.getElementById('optimizeGroundbedBtn');
            // « Optimiser les positions » (bouton combiné historique) :
            // masqué — remplacé par les 2 boutons explicites TR / Groundbed.
            var legacyIccpBtn = document.getElementById('iccpOptimizeBtn');
            if (legacyIccpBtn) legacyIccpBtn.style.display = 'none';

            // CORRECTION visibilité (rien ne s'affichait) :
            // setModulesActivation() désactive TOUS les contrôles du module
            // non-actif (control.disabled = true). Quand le type effectif est
            // « anodes », on doit donc RÉACTIVER le bouton en plus de
            // l'afficher, sinon il reste grisé/incliquable.
            if (anodesBtn) {
                var showAnodes = (t === 'anodes');
                anodesBtn.style.display = showAnodes ? '' : 'none';
                if (showAnodes) anodesBtn.disabled = false;
            }
            if (mixteBtn)  mixteBtn.style.display   = (t === 'mixte')  ? '' : 'none';
            var iccpSideVisible = (t === 'iccp' || t === 'mixte');
            if (trBtn) trBtn.style.display = iccpSideVisible ? '' : 'none';
            if (gbBtn) gbBtn.style.display = iccpSideVisible ? '' : 'none';
        }

        // ════════════════════════════════════════════════════════════
        // CORRECTION VISIBILITÉ v1.1.1 (rien ne s'affichait) ─────────
        // Cause racine n°1 : le radio Type CP (défaut « mixte » coché dans
        // index.html) ne déclenchait JAMAIS setModulesActivation() — le
        // module Anodes restait grisé/désactivé même après clic sur
        // « Anodes », et le bouton « Optimisation Anodes » restait masqué.
        // Cause n°2 : resolveCpType() priorisait le SYSTÈME ACTIF sur le
        // radio explicite de l'utilisateur → le choix « Anodes » était
        // ignoré quand le système actif était mixte.
        // → Le radio explicite est désormais PRIORITAIRE, et tout
        // changement de radio réactive les modules + la visibilité.
        // ════════════════════════════════════════════════════════════
        function resolveCpType() {
            try {
                var checkedRadio = document.querySelector('input[name="cpSystemType"]:checked');
                if (checkedRadio && checkedRadio.value) return checkedRadio.value;
            } catch (e) { /* repli système ci-dessous */ }
            try {
                if (typeof ProjectManager !== 'undefined' && ProjectManager.getActiveSystem) {
                    var sys = ProjectManager.getActiveSystem();
                    var sysType = sys && String(sys.type || '').toLowerCase();
                    if (sysType === 'anodes' || sysType === 'iccp' || sysType === 'mixte') return sysType;
                }
            } catch (e2) { /* repli projet ci-dessous */ }
            if (typeof ProjectManager !== 'undefined') {
                var st = ProjectManager.getState();
                if (st && st.project && st.project.cpSystemType) return st.project.cpSystemType;
            }
            return 'mixte';
        }
        
        // CORRECTION forcée : résoudre le problème de visibilité des boutons TR/Groundbed
        // en mode mixte (problème connu CORRECTION n°2)
        function _forceTrGbButtonsVisibility() {
            var trBtn = document.getElementById('optimizeTrBtn');
            var gbBtn = document.getElementById('optimizeGroundbedBtn');
            if (trBtn && gbBtn) {
                // Forcer la visibilité en mode mixte
                trBtn.style.display = '';
                gbBtn.style.display = '';
                console.log('[AnodesOptimization] Boutons TR/Groundbed forcés visibles');
            }
        }

        // Réactive le module Anodes quand le type effectif est « anodes »
        // (setModulesActivation l'avait désactivé en mode mixte/iccp :
        // .disabled-module + tous les contrôles disabled=true).
        function reactivateAnodesModule() {
            try {
                var mod = document.getElementById('module-anodes');
                if (mod) {
                    mod.classList.remove('disabled-module');
                    mod.setAttribute('aria-disabled', 'false');
                    var ctrls = mod.querySelectorAll('input, select, textarea, button');
                    for (var i = 0; i < ctrls.length; i++) {
                        if (ctrls[i].id !== 'anodesOptimizeBtn') ctrls[i].disabled = false;
                    }
                }
                var nav = document.querySelector('.nav-item[data-module="anodes"]');
                if (nav) {
                    nav.classList.remove('disabled-module');
                    nav.setAttribute('aria-disabled', 'false');
                }
            } catch (e) { /* affichage seul — jamais bloquant */ }
        }

        document.querySelectorAll('input[name="cpSystemType"]').forEach(function (radio) {
            radio.addEventListener('change', function () {
                if (!this.checked) return;
                // Le radio est la source de vérité : synchroniser les modules
                // (ui.js) PUIS la visibilité des boutons d'optimisation.
                try {
                    if (typeof ProjectManager !== 'undefined' && ProjectManager.getState) {
                        var _st = ProjectManager.getState();
                        if (_st && _st.project) _st.project.cpSystemType = this.value;
                    }
                } catch (e) { /* affichage seul */ }
                try {
                    if (window.UI && typeof window.UI.setModulesActivation === 'function') {
                        window.UI.setModulesActivation(this.value);
                    }
                } catch (e2) { /* affichage seul */ }
                if (this.value === 'anodes') reactivateAnodesModule();
                applyCpTypeVisibility(this.value);
            });
        });

        // Changement de système (barre Système / dashboard) → réévaluer
        document.querySelectorAll('.system-selector-bar select, .dashboard-system-selector select')
            .forEach(function (sel) {
                sel.addEventListener('change', function () { applyCpTypeVisibility(resolveCpType()); });
            });

        // (Ré)sélection automatique de système après changement de module
        document.addEventListener('moduleChanged', function () {
            setTimeout(function () {
                var _t = resolveCpType();
                if (_t === 'anodes') reactivateAnodesModule();
                applyCpTypeVisibility(_t);
            }, 650);
        });

        // Rechargement d'un projet → réévaluer
        document.addEventListener('projectLoaded', function () {
            setTimeout(function () {
                var _t = resolveCpType();
                if (_t === 'anodes') reactivateAnodesModule();
                applyCpTypeVisibility(_t);
            }, 100);
        });

        // État initial (priorité radio explicite, sinon système/projet)
        var _initType = resolveCpType();
        if (_initType === 'anodes') reactivateAnodesModule();
        applyCpTypeVisibility(_initType);

        console.log('[AnodesOptimization] ✅ v1.1.1 chargé — modes Anodes (tous équipements) & Mixte actifs.');
    });

    // ============================================================
    // GIS — positions des anodes optimisées → module Cartographie
    // CORRECTION : l'ancien écouteur cherchait window.GISIntegration._map /
    // window.GisMap / window._leafletMap — globaux INEXISTANTS (le vrai est
    // window.GisIntegration.getMap()) : les positions n'apparaissaient
    // JAMAIS. Nouvelle stratégie : couche en file d'attente, ré-application
    // à l'ouverture du module Cartographie (moduleChanged) avec retries,
    // nettoyage au changement de projet.
    // ============================================================
    var _anodesOptPending = null;
    var _anodesLayerRetryTimer = null;

    function _getGisMap() {
        var gis = window.GisIntegration || window.GISIntegration;
        if (gis && typeof gis.getMap === 'function') {
            var m = gis.getMap();
            if (m) return m;
        }
        if (gis && gis._map) return gis._map;
        return window.GisMap || window._leafletMap || null;
    }

    function _fitAnodesLayer(gisMap, group) {
        try {
            if (typeof group.getBounds !== 'function') return;
            var b = group.getBounds();
            if (b && b.isValid()) gisMap.fitBounds(b, { padding: [30, 30], maxZoom: 15 });
        } catch (_) { /* carte non prête */ }
    }

    function _applyAnodesLayer(payload, fitBounds) {
        if (!payload || !payload.anodes || !payload.anodes.length) return false;
        var gisMap = _getGisMap();
        var L = window.L;
        if (!gisMap || typeof gisMap.addLayer !== 'function' || !L) return false;

        if (window._anodesOptLayer) {
            try { gisMap.removeLayer(window._anodesOptLayer); } catch (_) {}
            window._anodesOptLayer = null;
        }

        var markers = [];
        payload.anodes.forEach(function (a) {
            if (!isFinite(Number(a.lat)) || !isFinite(Number(a.lon))) return;
            var m = L.circleMarker([Number(a.lat), Number(a.lon)], {
                radius: 7, fillColor: '#f59e0b', color: '#92400e',
                weight: 1.5, opacity: 1, fillOpacity: 0.85
            });
            var label = a.equipmentTag || a.pipelineId || '—';
            m.bindPopup(
                '<b>' + escapeHtml(a.id) + '</b><br>' +
                'Équipement : ' + escapeHtml(label) +
                (a.equipmentType ? ' (' + escapeHtml(a.equipmentType) + ')' : '') + '<br>' +
                'Matériau : ' + escapeHtml(a.material) + '<br>' +
                'I sortie : ' + Number(a.I_output_A).toFixed(4) + ' A<br>' +
                'Masse    : ' + Number(a.mass_kg).toFixed(2) + ' kg<br>' +
                'Espacement : ' + (isFinite(a.spacing_m) ? Number(a.spacing_m).toFixed(1) : 'N/A') + ' m<br>' +
                'R anode  : ' + (isFinite(a.R_ohm) ? Number(a.R_ohm).toFixed(2) : 'N/A') + ' Ω'
            );
            markers.push(m);
        });
        if (!markers.length) return false;

        var group = (typeof L.featureGroup === 'function') ? L.featureGroup(markers) : L.layerGroup(markers);
        group.addTo(gisMap);
        window._anodesOptLayer = group;

        if (fitBounds) {
            var carto = document.getElementById('module-cartography');
            if (carto && carto.classList.contains('active')) {
                // Après le recentrage équipements de loadPoints() (~800 ms)
                setTimeout(function () { _fitAnodesLayer(gisMap, group); }, 1500);
            }
        }
        console.log('[AnodesOptimization] ' + markers.length + ' position(s) d\'anode(s) sur la carte.');
        return true;
    }

    function _scheduleAnodesLayerRetry(attempt, fit) {
        if (_anodesLayerRetryTimer) clearTimeout(_anodesLayerRetryTimer);
        attempt = attempt || 0;
        if (attempt >= 8) return;
        _anodesLayerRetryTimer = setTimeout(function () {
            _anodesLayerRetryTimer = null;
            if (!_anodesOptPending) return;
            if (_applyAnodesLayer(_anodesOptPending, fit !== false)) return;
            _scheduleAnodesLayerRetry(attempt + 1, fit);
        }, 500 + attempt * 250);
    }

    document.addEventListener('cp:anodesOptimized', function (e) {
        var detail = e.detail || {};
        var anodes = detail.anodes || [];
        if (!anodes.length) { _anodesOptPending = null; return; }
        _anodesOptPending = { projectId: detail.projectId, mode: detail.mode, anodes: anodes };
        var carto = document.getElementById('module-cartography');
        var active = !!carto && carto.classList.contains('active');
        if (!_applyAnodesLayer(_anodesOptPending, active)) {
            _scheduleAnodesLayerRetry(0, active);
        }
    });

    // Ouverture du module Cartographie → (ré)appliquer la couche en attente
    // (la carte Leaflet n'est initialisée qu'à ce moment-là)
    document.addEventListener('moduleChanged', function (e) {
        if (!e.detail || e.detail.moduleId !== 'cartography') return;
        if (!_anodesOptPending) return;
        _scheduleAnodesLayerRetry(0, true);
    });

    // Changement de projet : ne jamais afficher les anodes d'un autre projet
    document.addEventListener('projectLoaded', function (e) {
        var pid = e.detail && e.detail.projectId;
        if (!_anodesOptPending || !pid) return;
        if (_anodesOptPending.projectId === pid) {
            _scheduleAnodesLayerRetry(0, true);
            return;
        }
        _anodesOptPending = null;
        var gisMap = _getGisMap();
        if (gisMap && window._anodesOptLayer) {
            try { gisMap.removeLayer(window._anodesOptLayer); } catch (_) {}
            window._anodesOptLayer = null;
        }
    });

})();

// ============================================================
// Exports / Scripts - Structure to match other optimization engines
// ============================================================
// CORRECTION (préexistant) : l'ancien bloc référençait l'identifiant brut
// « AnodesOptimizationEngine » HORS de l'IIFE → ReferenceError dans le
// sandbox vm des tests (pas de résolution d'identifiants sur window).
// En navigateur, window.* est déjà positionné par les IIFE ci-dessus.
const scripts = {
    // Core optimization engines
    AnodesOptimizationEngine: (typeof window !== 'undefined' && window.AnodesOptimizationEngine) || null,
    MixteOptimizationEngine: (typeof window !== 'undefined' && window.MixteOptimizationEngine) || null,
    // For compatibility with other modules that expect these to be available globally
};

// Expose engines globally for other modules to use
if (typeof window !== 'undefined') {
    window.AnodesOptimizationEngine = window.AnodesOptimizationEngine || null;
    window.MixteOptimizationEngine = window.MixteOptimizationEngine || null;
    window.ICCPOptimizationEngine = window.ICCPOptimizationEngine; // Already available
}
// FIN AnodesOptimizationEngine.js v1.1.0
