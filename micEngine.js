// ============================================================
// micEngine.js – CP Engineer Pro
// Moteur d'analyse de la corrosion microbiologiquement
// influencée (MIC) et des bactéries réductrices de sulfates (SRB)
// ============================================================
// RÉFÉRENCES NORMATIVES :
//   - NACE TM0106-2016 : "Detection, Testing, and Evaluation of
//                        Microbiologically Influenced Corrosion
//                        (MIC) on Internal Surfaces of Pipelines"
//   - NACE TM0212-2018 : "Detection, Testing, and Evaluation of
//                        Microbiologically Influenced Corrosion
//                        (MIC) on External Surfaces of Buried
//                        Pipelines"
// ============================================================
// EXPOSITION : window.MICEngine
// API        : MICEngine.analyzeSRB(params)
// VERSION    : 1.0.0 (cycle de vie indépendant)
// ============================================================

(function() {
    'use strict';

    if (typeof window === 'undefined') return;

    // ─── Garde d'idempotence ───
    if (window.MICEngine && window.MICEngine.__v1) {
        console.log('[MICEngine] Déjà chargé (v1) — ignoré.');
        return;
    }

    // ============================================================
    // 1. CONFIGURATION & SEUILS NORMATIFS
    // ============================================================
    // Grille de scoring 0-100 avec 9 critères pondérés (somme = 100).
    // Les seuils sont alignés sur NACE TM0212-2018 §7.3 (SRB en sol)
    // et NACE TM0106-2016 (MIC interne).
    // ============================================================
    const CONFIG = Object.freeze({

        // --- Poids des critères (somme = 100) ---
        WEIGHTS: {
            sulfates:      20,
            sulfides:      20,
            redox:         15,
            ph:            12,
            temperature:   10,
            humidity:       8,
            organicMatter:  7,
            nitrates:       5,
            chlorides:      3
        },

        // --- Seuils de scoring ---
        SULFATES_HIGH_PPM:     1000,
        SULFATES_MODERATE_PPM:  500,
        SULFIDES_HIGH_PPM:        1.0,
        SULFIDES_MODERATE_PPM:    0.1,
        REDOX_ANAEROBIC_MV:    -100,
        REDOX_INTERMEDIATE_MV:    0,
        PH_OPTIMAL_MIN:           6.0,
        PH_OPTIMAL_MAX:           8.0,
        TEMPERATURE_OPTIMAL_MIN: 20,
        TEMPERATURE_OPTIMAL_MAX: 40,
        HUMIDITY_HIGH_PCT:       80,
        HUMIDITY_MODERATE_PCT:   60,
        ORGANIC_MATTER_HIGH_PCT:   5.0,
        ORGANIC_MATTER_MOD_PCT:    2.0,
        NITRATES_HIGH_PPM:        50,
        NITRATES_MODERATE_PPM:    10,
        CHLORIDES_HIGH_PPM:     5000,
        CHLORIDES_MODERATE_PPM: 1000,

        // --- Classification (score 0-100) ---
        CLASS_LOW_MAX:      25,
        CLASS_MODERATE_MAX: 50,
        CLASS_HIGH_MAX:     75,

        // --- Potentiel de protection renforcée en présence de SRB ---
        SRB_TARGET_POTENTIAL_MV: -950.0,
        STANDARD_TARGET_POTENTIAL_MV: -850.0
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

    /**
     * Scoring par critère — retourne un nombre dans [0, weight].
     */
    function scoreSulfates(v) {
        const w = CONFIG.WEIGHTS.sulfates;
        if (v >= CONFIG.SULFATES_HIGH_PPM)     return w;
        if (v >= CONFIG.SULFATES_MODERATE_PPM) return w * 0.5;
        return 0;
    }
    function scoreSulfides(v) {
        const w = CONFIG.WEIGHTS.sulfides;
        if (v >= CONFIG.SULFIDES_HIGH_PPM)     return w;
        if (v >= CONFIG.SULFIDES_MODERATE_PPM) return w * 0.5;
        return 0;
    }
    function scoreRedox(v) {
        const w = CONFIG.WEIGHTS.redox;
        if (v <= CONFIG.REDOX_ANAEROBIC_MV)    return w;
        if (v <= CONFIG.REDOX_INTERMEDIATE_MV) return w * 0.5;
        return 0;
    }
    function scorePh(v) {
        const w = CONFIG.WEIGHTS.ph;
        if (v >= CONFIG.PH_OPTIMAL_MIN && v <= CONFIG.PH_OPTIMAL_MAX) return w;
        return w * 0.4;
    }
    function scoreTemperature(v) {
        const w = CONFIG.WEIGHTS.temperature;
        if (v >= CONFIG.TEMPERATURE_OPTIMAL_MIN &&
            v <= CONFIG.TEMPERATURE_OPTIMAL_MAX) return w;
        return w * 0.4;
    }
    function scoreHumidity(v) {
        const w = CONFIG.WEIGHTS.humidity;
        if (v >= CONFIG.HUMIDITY_HIGH_PCT)     return w;
        if (v >= CONFIG.HUMIDITY_MODERATE_PCT) return w * 0.5;
        return 0;
    }
    function scoreOrganicMatter(v) {
        const w = CONFIG.WEIGHTS.organicMatter;
        if (v >= CONFIG.ORGANIC_MATTER_HIGH_PCT) return w;
        if (v >= CONFIG.ORGANIC_MATTER_MOD_PCT)  return w * 0.5;
        return 0;
    }
    function scoreNitrates(v) {
        // Nitrates élevés → inhibent les SRB (score inversé)
        const w = CONFIG.WEIGHTS.nitrates;
        if (v >= CONFIG.NITRATES_HIGH_PPM)     return 0;
        if (v >= CONFIG.NITRATES_MODERATE_PPM) return w * 0.5;
        return w;
    }
    function scoreChlorides(v) {
        const w = CONFIG.WEIGHTS.chlorides;
        if (v >= CONFIG.CHLORIDES_HIGH_PPM)     return w;
        if (v >= CONFIG.CHLORIDES_MODERATE_PPM) return w * 0.5;
        return 0;
    }

    /**
     * Classification SRB en fonction du score total (0-100).
     */
    function classifyScore(score) {
        if (score <= CONFIG.CLASS_LOW_MAX)      return 'LOW';
        if (score <= CONFIG.CLASS_MODERATE_MAX) return 'MODERATE';
        if (score <= CONFIG.CLASS_HIGH_MAX)     return 'HIGH';
        return 'SEVERE';
    }

    /**
     * Construit le protocole de surveillance adapté au niveau SRB.
     */
    function buildMonitoringProtocol(score, level) {
        const base = {
            couponsRecommended: false,
            couponCount: 0,
            biocideRecommended: false,
            biocideType: null,
            samplingFrequency: null,
            notes: []
        };

        if (level === 'LOW') {
            base.samplingFrequency = 'Annuelle';
            base.notes.push('Surveillance standard NACE TM0212 §8.');
            return base;
        }

        if (level === 'MODERATE') {
            base.samplingFrequency = 'Semestrielle';
            base.couponsRecommended = true;
            base.couponCount = 2;
            base.notes.push('Coupons de corrosion recommandés (NACE TM0212 §7.4).');
            return base;
        }

        if (level === 'HIGH') {
            base.samplingFrequency = 'Trimestrielle';
            base.couponsRecommended = true;
            base.couponCount = 4;
            base.biocideRecommended = true;
            base.biocideType = 'Glutaraldéhyde (dosage à valider en laboratoire)';
            base.notes.push('Analyse microbiologique en laboratoire recommandée (NACE TM0106 §5).');
            return base;
        }

        // SEVERE
        base.samplingFrequency = 'Mensuelle';
        base.couponsRecommended = true;
        base.couponCount = 6;
        base.biocideRecommended = true;
        base.biocideType = 'Glutaraldéhyde ou THPS (dosage à valider en laboratoire)';
        base.notes.push('Traitement biocide immédiat à envisager.');
        base.notes.push('Réévaluation complète du système de protection cathodique.');
        return base;
    }

    // ============================================================
    // 3. MOTEUR PUBLIC
    // ============================================================
    const MICEngine = {

        __v1: true,
        VERSION: '1.0.0',

        /**
         * Analyse SRB / MIC sur la base de 9 paramètres
         * physico-chimiques du sol.
         *
         * @param {Object} params
         * @param {number} [params.sulfates]      Sulfates (ppm)
         * @param {number} [params.sulfides]      Sulfures (ppm)
         * @param {number} [params.redox]         Potentiel redox (mV)
         * @param {number} [params.ph]            pH (0-14)
         * @param {number} [params.temperature]   Température (°C)
         * @param {number} [params.humidity]      Humidité (%)
         * @param {number} [params.organicMatter] Matière organique (%)
         * @param {number} [params.nitrates]      Nitrates (ppm)
         * @param {number} [params.chlorides]     Chlorures (ppm)
         * @returns {Object} Résultat complet SRB
         */
        analyzeSRB: function(params) {
            const p = (params && typeof params === 'object') ? params : {};

            // ─── Extraction normalisée ───
            const sulfates      = safeNumber(p.sulfates, 0);
            const sulfides      = safeNumber(p.sulfides, 0);
            const redox         = safeNumber(p.redox, 0);
            const ph            = safeNumber(p.ph, 7);
            const temperature   = safeNumber(p.temperature, 20);
            const humidity      = safeNumber(p.humidity, 50);
            const organicMatter = safeNumber(p.organicMatter, 0);
            const nitrates      = safeNumber(p.nitrates, 0);
            const chlorides     = safeNumber(p.chlorides, 0);
            const requiredFields = [
                'sulfates', 'sulfides', 'redox', 'ph', 'temperature',
                'humidity', 'organicMatter', 'nitrates', 'chlorides'
            ];
            const assessmentStatus = requiredFields.every(field =>
                p[field] !== undefined && p[field] !== null && p[field] !== ''
            ) ? 'ASSESSABLE' : 'NOT_ASSESSABLE';

            // ─── Scoring par critère ───
            const scores = {
                sulfates:      scoreSulfates(sulfates),
                sulfides:      scoreSulfides(sulfides),
                redox:         scoreRedox(redox),
                ph:            scorePh(ph),
                temperature:   scoreTemperature(temperature),
                humidity:      scoreHumidity(humidity),
                organicMatter: scoreOrganicMatter(organicMatter),
                nitrates:      scoreNitrates(nitrates),
                chlorides:     scoreChlorides(chlorides)
            };

            // ─── Score total (0-100) ───
            const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
            const normalizedScore = Math.min(100, Math.max(0, totalScore));

            // ─── Classification ───
            const classification = classifyScore(normalizedScore);

            // ─── Potentiel cible recommandé ───
            // NACE TM0212 recommande une protection renforcée en
            // présence de SRB actifs (potentiel -950 mV vs Cu/CuSO₄).
            const targetPotential = (classification === 'HIGH' || classification === 'SEVERE')
                ? CONFIG.SRB_TARGET_POTENTIAL_MV
                : CONFIG.STANDARD_TARGET_POTENTIAL_MV;

            // ─── Protocole de surveillance ───
            const protocol = buildMonitoringProtocol(normalizedScore, classification);

            // ─── Retour structuré ───
            return {
                // Paramètres d'entrée normalisés
                inputs: {
                    sulfates:      sulfates,
                    sulfides:      sulfides,
                    redox:         redox,
                    ph:            ph,
                    temperature:   temperature,
                    humidity:      humidity,
                    organicMatter: organicMatter,
                    nitrates:      nitrates,
                    chlorides:     chlorides
                },

                // Scores détaillés (décomposition par critère)
                scores: scores,

                // Score total
                score: normalizedScore,
                maxScore: 100,
                scorePercent: normalizedScore,

                // Classification SRB
                classification: classification,
                level: classification,
                assessmentStatus: assessmentStatus,

                // Potentiel cible recommandé
                targetPotential: targetPotential,
                targetPotentialUnit: 'mV vs Cu/CuSO₄',

                // Protocole de surveillance
                monitoring: protocol,

                // Recommandations biocide
                biocide: {
                    recommended: protocol.biocideRecommended,
                    type: protocol.biocideType
                },

                // Traçabilité normative
                references: {
                    primary:   'NACE TM0212-2018',
                    secondary: 'NACE TM0106-2016',
                    section:   'NACE TM0212 §7.3'
                },

                // Unités
                units: {
                    sulfates:      'ppm',
                    sulfides:      'ppm',
                    redox:         'mV',
                    ph:            '-',
                    temperature:   '°C',
                    humidity:      '%',
                    organicMatter: '%',
                    nitrates:      'ppm',
                    chlorides:     'ppm'
                },

                // Métadonnées
                _engineVersion: this.VERSION,
                _computedAt: new Date().toISOString()
            };
        },

        // Exposition des seuils pour tests
        _CONFIG: CONFIG,

        // Exposition des fonctions internes (tests)
        _classifyScore: classifyScore,
        _buildMonitoringProtocol: buildMonitoringProtocol
    };

    // ============================================================
    // 4. EXPOSITION GLOBALE
    // ============================================================
    window.MICEngine = MICEngine;

    console.log('[MICEngine] v' + MICEngine.VERSION + ' chargé (NACE TM0106-2016 / NACE TM0212-2018).');
})();