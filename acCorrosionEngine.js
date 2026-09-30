// ============================================================
// acCorrosionEngine.js – CP Engineer Pro
// Moteur d'analyse de la corrosion par courant alternatif (AC)
// ============================================================
// RÉFÉRENCES NORMATIVES :
//   - EN 15280:2013     : "Evaluation of a.c. corrosion likelihood
//                          of buried pipelines"
//   - IEC 60479-1:2018  : "Effects of current on human beings
//                          and livestock – Part 1"
// ============================================================
// EXPOSITION : window.ACCorrosionEngine
// API        : ACCorrosionEngine.analyze(params)
// VERSION    : 1.0.0 (cycle de vie indépendant)
// ============================================================
// CAS DE RÉFÉRENCE TESTÉS :
//   1. J_AC=5,  J_DC=2  → ratio=2.5 → riskLevel=MODERATE
//   2. touchV=60        → touchZone=ZONE_4
//   3. J_AC=10, J_DC=5, touchV=40 → riskLevel=HIGH, touchZone=ZONE_3
// ============================================================

(function(root) {
    'use strict';

    // ─── Garde d'idempotence (évite un double chargement) ───
    if (root && root.ACCorrosionEngine && root.ACCorrosionEngine.__v1) {
        if (typeof console !== 'undefined' && console.log) {
            console.log('[ACCorrosionEngine] Déjà chargé (v1) — ignoré.');
        }
        return;
    }

    // ============================================================
    // 1. CONFIGURATION & SEUILS NORMATIFS
    // ============================================================
    const CONFIG = Object.freeze({
        // --- Seuils EN 15280 §6.3 : ratio J_AC / J_DC ---
        //   ratio < 1        → ACCEPTABLE
        //   1 ≤ ratio < 5    → MODERATE
        //   ratio ≥ 5        → HIGH
        RATIO_ACCEPTABLE_THRESHOLD: 1.0,
        RATIO_MODERATE_THRESHOLD:   5.0,

        // --- Seuils IEC 60479-1 §5 : tension de contact AC (V) ---
        //   Zone 1 : U_touch < 15 V          (sûre)
        //   Zone 2 : 15 ≤ U_touch < 30 V     (surveillance)
        //   Zone 3 : 30 ≤ U_touch < 50 V     (action requise)
        //   Zone 4 : U_touch ≥ 50 V          (dangereuse)
        TOUCH_ZONE_1_MAX: 15.0,
        TOUCH_ZONE_2_MAX: 30.0,
        TOUCH_ZONE_3_MAX: 50.0,

        // --- Seuils EN 15280 : densité de courant AC (A/m²) ---
        //   J_AC < 1       → ACCEPTABLE
        //   1 ≤ J_AC < 10  → MODERATE
        //   J_AC ≥ 10      → HIGH
        JAC_ACCEPTABLE_THRESHOLD: 1.0,
        JAC_MODERATE_THRESHOLD:   10.0,

        // --- Potentiel cible par défaut (mV vs Cu/CuSO₄) ---
        DEFAULT_TARGET_POTENTIAL_MV: -850.0
    });

    // ============================================================
    // 2. UTILITAIRES INTERNES
    // ============================================================
    function safeNumber(v, d) {
        const fallback = (d !== undefined) ? d : 0;
        if (v === undefined || v === null || v === '') return fallback;
        const n = parseFloat(String(v).trim().replace(',', '.'));
        return isNaN(n) ? fallback : n;
    }

        function classifyRatio(ratio) {
        if (!isFinite(ratio)) return 'HIGH';
        if (ratio < CONFIG.RATIO_ACCEPTABLE_THRESHOLD) return 'ACCEPTABLE';
        if (ratio < CONFIG.RATIO_MODERATE_THRESHOLD)   return 'MODERATE';
        return 'HIGH';
    }

    /**
     * F-05 : Gestion explicite du cas 0/0.
     * ------------------------------------------------------------
     * Si J_AC = 0 ET J_DC = 0, le ratio n'est PAS defini (N/A).
     * Il ne doit PAS etre converti en 0 (faux conforme) ni en FAIL
     * (faux non conforme).
     * ------------------------------------------------------------
     */
    function resolveRatioStatus(jAC, jDC) {
        const jac = Math.abs(safeNumber(jAC, 0));
        const jdc = Math.abs(safeNumber(jDC, 0));

        // Cas 1 : les deux densites sont nulles -> ratio NON DEFINI
        if (jac === 0 && jdc === 0) {
            return {
                ratio: null,
                ratioRaw: null,
                ratioLevel: 'NOT_ASSESSABLE',
                status: 'N/A',
                reason: 'J_AC = 0 et J_DC = 0 : le ratio J_AC/J_DC n\'est pas defini.',
                basis: 'NOT MEASURED'
            };
        }

        // Cas 2 : J_DC nul mais J_AC > 0 -> ratio infini (HIGH)
        if (jdc === 0 && jac > 0) {
            return {
                ratio: null,
                ratioRaw: Infinity,
                ratioLevel: 'HIGH',
                status: 'FAIL',
                reason: 'J_DC = 0 avec J_AC > 0 : risque de corrosion AC eleve (denominateur nul).',
                basis: 'COMPUTED_FROM_INPUT'
            };
        }

        // Cas 3 : J_DC > 0 -> ratio calculable
        const ratio = jac / jdc;
        return {
            ratio: ratio,
            ratioRaw: ratio,
            ratioLevel: classifyRatio(ratio),
            status: null,
            reason: null,
            basis: 'COMPUTED_FROM_INPUT'
        };
    }

    function classifyTouchZone(touchV) {
        const v = Math.abs(touchV);
        if (v < CONFIG.TOUCH_ZONE_1_MAX) return 'ZONE_1';
        if (v < CONFIG.TOUCH_ZONE_2_MAX) return 'ZONE_2';
        if (v < CONFIG.TOUCH_ZONE_3_MAX) return 'ZONE_3';
        return 'ZONE_4';
    }

    function classifyJAC(jAC) {
        const v = Math.abs(jAC);
        if (v < CONFIG.JAC_ACCEPTABLE_THRESHOLD) return 'ACCEPTABLE';
        if (v < CONFIG.JAC_MODERATE_THRESHOLD)   return 'MODERATE';
        return 'HIGH';
    }

    /**
     * Calcule le niveau global de risque par agrégation du pire
     * indicateur (ratio, tension de contact, densité AC).
     *
     * Rang de sévérité :
     *   0 = ACCEPTABLE / ZONE_1
     *   1 = MODERATE  / ZONE_2
     *   2 = HIGH      / ZONE_3
     *   3 = SEVERE    / ZONE_4
     */
        function computeGlobalLevel(ratioLevel, touchZone, jACLevel) {
        const SEVERITY = {
            'ACCEPTABLE': 0,
            'ZONE_1':     0,
            'MODERATE':   1,
            'ZONE_2':     1,
            'HIGH':       2,
            'ZONE_3':     2,
            'ZONE_4':     3,
            'SEVERE':     3
        };
        // F-05 : filtrer les niveaux non evaluables (NOT_ASSESSABLE /
        //        INDETERMINATE) — ils ne doivent PAS influencer le max.
        const validValues = [ratioLevel, touchZone, jACLevel]
            .map(function(level) { return SEVERITY[level]; })
            .filter(function(v) { return v !== undefined; });

        if (validValues.length === 0) {
            return 'NOT_ASSESSABLE';
        }

        const max = Math.max.apply(null, validValues);
        return ['LOW', 'MODERATE', 'HIGH', 'SEVERE'][max] || 'LOW';
    }

    /**
     * Construit la liste des recommandations de mitigation selon
     * EN 15280 §7 et IEC 60479-1.
     */
        function buildRecommendations(ratio, touchV, jAC) {
        const recs = [];
        // F-05 : si ratio non defini (0/0), afficher la raison.
        if (ratio === null || ratio === undefined) {
            recs.push('Ratio J_AC/J_DC non defini (J_AC = 0 et J_DC = 0). ' +
                      'Aucune conclusion sur le risque AC ne peut etre tiree ' +
                      'sans mesures de densite de courant.');
        } else if (isFinite(ratio) && ratio >= CONFIG.RATIO_MODERATE_THRESHOLD) {
            recs.push('Ratio J_AC/J_DC ≥ 5 — Risque élevé (EN 15280 §6.3). Renforcer la protection cathodique et envisager un drainage AC.');
        } else if (isFinite(ratio) && ratio >= CONFIG.RATIO_ACCEPTABLE_THRESHOLD) {
            recs.push('Ratio J_AC/J_DC entre 1 et 5 — Surveillance renforcée recommandée (EN 15280 §6.3).');
        }
        if (Math.abs(touchV) >= CONFIG.TOUCH_ZONE_3_MAX) {
            recs.push('Tension de contact ≥ 50 V (Zone 4 IEC 60479-1) — Mise à la terre de sécurité obligatoire et gradient control wire.');
        } else if (Math.abs(touchV) >= CONFIG.TOUCH_ZONE_2_MAX) {
            recs.push('Tension de contact 30–50 V (Zone 3 IEC 60479-1) — Gradient control wire recommandé, vérification du système de terre.');
        } else if (Math.abs(touchV) >= CONFIG.TOUCH_ZONE_1_MAX) {
            recs.push('Tension de contact 15–30 V (Zone 2 IEC 60479-1) — Surveillance périodique.');
        }
        if (Math.abs(jAC) >= CONFIG.JAC_MODERATE_THRESHOLD) {
            recs.push('Densité AC ≥ 10 A/m² — Drainage AC ou déchargeur DC obligatoire.');
        } else if (Math.abs(jAC) >= CONFIG.JAC_ACCEPTABLE_THRESHOLD) {
            recs.push('Densité AC entre 1 et 10 A/m² — Mise à la terre AC recommandée.');
        }
        if (recs.length === 0) {
            recs.push('Aucune mitigation AC requise — Situation conforme EN 15280.');
        }
        return recs;
    }

    // ============================================================
    // 3. MOTEUR PUBLIC
    // ============================================================
    const ACCorrosionEngine = {

        __v1: true,
        VERSION: '1.0.0',

        /**
         * Analyse complète de la corrosion AC.
         *
         * @param {Object} params
         * @param {number} [params.J_AC]              Densité de courant AC (A/m²)
         * @param {number} [params.J_DC]              Densité de courant DC (A/m²)
         * @param {number} [params.touchV]            Tension de contact AC (V)
         * @param {number} [params.targetPotential]   Potentiel cible (mV vs Cu/CuSO₄)
         * @returns {Object} Résultat d'analyse
         */
        analyze: function(params) {
            const p = (params && typeof params === 'object') ? params : {};

            // ─── Extraction normalisée ───
            const J_AC = safeNumber(p.J_AC, 0);
            const J_DC = safeNumber(p.J_DC, 0);
            const hasCurrentDensityMeasurements = [p.J_AC, p.J_DC]
                .every(value => value !== undefined && value !== null && value !== '');
            const touchValRaw = (p.touchV !== undefined && p.touchV !== null && p.touchV !== '')
                ? p.touchV
                : p.touchVoltage;
            const hasTouchMeasurement = touchValRaw !== undefined &&
                touchValRaw !== null &&
                touchValRaw !== '';
            const touchV = safeNumber(touchValRaw, 0);
            const targetPotential = safeNumber(
                p.targetPotential,
                CONFIG.DEFAULT_TARGET_POTENTIAL_MV
            );

                        // ─── Ratio J_AC / J_DC (EN 15280 §6.3) ───
            // F-05 : gestion explicite du cas 0/0 (NOT ASSESSABLE).
            const ratioResolution = resolveRatioStatus(J_AC, J_DC);
            const ratioDisplay = ratioResolution.ratio;
            const ratioRaw = ratioResolution.ratioRaw;
            const ratioLevel = ratioResolution.ratioLevel;
            const ratioStatus = ratioResolution.status;
            const ratioReason = ratioResolution.reason;
            const ratioBasis = ratioResolution.basis;

            // ─── Classification IEC 60479-1 ───
            const touchZone = classifyTouchZone(touchV);

            // ─── Classification densité AC (EN 15280) ───
            const jACLevel = classifyJAC(J_AC);

            // ─── Niveau global de risque ───
            // Une analyse sans toutes les mesures requises ne peut pas être
            // classée comme LOW sur la base des valeurs de repli à zéro.
            const riskLevel = (hasCurrentDensityMeasurements && hasTouchMeasurement)
                ? computeGlobalLevel(ratioLevel, touchZone, jACLevel)
                : 'NOT_ASSESSABLE';

            // ─── Conformité globale ───
            // Si le ratio est NOT_ASSESSABLE, on ne peut PAS declarer
            // la conformite globale — statut PARTIAL/INDETERMINATE.
            const ratioAssessable = (ratioLevel !== 'NOT_ASSESSABLE' && ratioLevel !== 'INDETERMINATE');
            const ratioOk = ratioAssessable
                ? (ratioRaw === null || ratioRaw < CONFIG.RATIO_MODERATE_THRESHOLD)
                : false;
            const touchOk = Math.abs(touchV) < CONFIG.TOUCH_ZONE_2_MAX;
            const jacOk = Math.abs(J_AC) < CONFIG.JAC_ACCEPTABLE_THRESHOLD;

            const isCompliant = ratioAssessable && ratioOk && touchOk && jacOk;
            const isAssessable = hasCurrentDensityMeasurements && hasTouchMeasurement;
            const isPartiallyAssessable = isAssessable && !ratioAssessable && (touchOk || jacOk);
            const dataWarnings = [];
            if (!hasCurrentDensityMeasurements) {
                dataWarnings.push('J_AC et J_DC doivent être fournis pour évaluer le ratio AC/DC.');
            }
            if (!hasTouchMeasurement) {
                dataWarnings.push('La tension de contact AC doit être mesurée ou explicitement estimée.');
            }

            // ─── Recommandations ───
            const recommendations = buildRecommendations(ratioRaw, touchV, J_AC);

            // ─── Retour structuré ───
            return {
                // Entrées normalisées
                J_AC: hasCurrentDensityMeasurements ? J_AC : null,
                J_DC: hasCurrentDensityMeasurements ? J_DC : null,
                touchV: hasTouchMeasurement ? touchV : null,
                targetPotential: targetPotential,

                // Indicateur EN 15280 §6.3
                ratio: ratioDisplay,
                ratioRaw: (ratioRaw !== null && isFinite(ratioRaw)) ? ratioRaw : null,
                ratioLevel: ratioLevel,
                ratioStatus: ratioStatus,
                ratioReason: ratioReason,
                ratioBasis: ratioBasis,

                // Classification IEC 60479-1
                touchZone: touchZone,

                // Classification densité AC
                jACLevel: jACLevel,

                // Niveau global
                riskLevel: riskLevel,
                isCompliant: isCompliant,
                isPartiallyAssessable: isPartiallyAssessable,
                assessmentStatus: isAssessable ? 'ASSESSABLE' : 'NOT_ASSESSABLE',
                dataQuality: {
                    hasCurrentDensityMeasurements: hasCurrentDensityMeasurements,
                    hasTouchMeasurement: hasTouchMeasurement,
                    warnings: dataWarnings
                },

                // Potentiel cible recommandé
                recommendedTargetPotential: targetPotential,

                // Mitigations
                recommendations: recommendations,

                // Traçabilité normative
                references: {
                    primary: 'EN 15280:2013',
                    secondary: 'IEC 60479-1:2018',
                    ratioSection: 'EN 15280 §6.3',
                    touchSection: 'IEC 60479-1 §5'
                },

                // Unités canoniques
                units: {
                    J_AC: 'A/m²',
                    J_DC: 'A/m²',
                    ratio: '-',
                    touchV: 'V',
                    targetPotential: 'mV'
                },

                // Métadonnées
                _engineVersion: this.VERSION,
                _computedAt: new Date().toISOString()
            };
        },

        // Exposition des seuils pour tests / traçabilité
        _CONFIG: CONFIG,

        // Exposition des fonctions de classification (tests)
        _classifyRatio: classifyRatio,
        _classifyTouchZone: classifyTouchZone,
        _classifyJAC: classifyJAC,
        _computeGlobalLevel: computeGlobalLevel
    };

    // ============================================================
    // 4. EXPOSITION GLOBALE & MODULAIRE (FIX-10 : Browser / Node.js / Worker)
    // ============================================================
    if (typeof window !== 'undefined') {
        window.ACCorrosionEngine = ACCorrosionEngine;
    }
    if (typeof root !== 'undefined' && root) {
        root.ACCorrosionEngine = ACCorrosionEngine;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ACCorrosionEngine;
    }

    if (typeof console !== 'undefined' && console.log) {
        console.log('[ACCorrosionEngine] v' + ACCorrosionEngine.VERSION + ' chargé (EN 15280:2013 / IEC 60479-1:2018).');
    }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);