// ============================================================
// engine.js – CP Engineer Pro – Moteur de calcul pur
// Module version : 8.6.0 (cycle de vie indépendant du moteur)
// Version applicative : définie par APP_CONFIG.VERSION (SSOT)
// ============================================================
// CORRECTIONS APPLIQUÉES (voir rapport d'audit) :
//   P0-01 : Traçabilité explicite de la source du courant ICCP
//   P0-02 : Unités canoniques documentées (A/m² pour densité anodique)
//   P0-03 : calculateICCPAnodeLife() dédiée (modèle MMO ICCP)
//   P0-04 : Logs de traçabilité dans designGroundbed()
//   P0-05 : rho_effective distinct de rho projet
//   P1-01 : Distinction currentDensityAnode (A/m²) / _mA (mA/m²)
//   P1-02 : SF appliqué exactement une fois sur la puissance
//   P1-05 : lifeTheoretical vs lifeDesign (plafond 25 ans)
//   P0-04b: designGroundbed expose R_groundbed_pure, R_well,
//           _includesCable, _includesStructure pour éviter double comptage
//   P1-01 : R_cable avec facteur 2 (aller-retour) documenté
//   P2-01 : Facteur de sécurité appliqué sur la masse, pas la durée de vie
//   P2-03 : groupResistanceSunde documentée
//   P2-04 : Facteur × 0.8 supprimé
//   P3    : Validation, cache LRU, documentation
// ============================================================

// ============================================================
// 0. MODULE DE CONVERSION D'UNITÉS
// ============================================================
const UnitConverter = {
    // Longueurs
    mmToM: (v) => (v !== undefined && v !== null) ? v / 1000 : 0,
    mToMm: (v) => (v !== undefined && v !== null) ? v * 1000 : 0,
    inchesToM: (v) => (v !== undefined && v !== null) ? v * 0.0254 : 0,
    mToInches: (v) => (v !== undefined && v !== null) ? v / 0.0254 : 0,
    // Résistivités
    ohmCmToOhmM: (v) => (v !== undefined && v !== null) ? v / 100 : 0,
    ohmMToOhmCm: (v) => (v !== undefined && v !== null) ? v * 100 : 0,
    // Surfaces
    m2ToCm2: (v) => (v !== undefined && v !== null) ? v * 10000 : 0,
    cm2ToM2: (v) => (v !== undefined && v !== null) ? v / 10000 : 0,
    // Courant
    mAtoA: (v) => (v !== undefined && v !== null) ? v / 1000 : 0,
    AtoMa: (v) => (v !== undefined && v !== null) ? v * 1000 : 0,
    // Densité de courant (canonique interne : A/m²)
    mA_m2_to_A_m2: (v) => (v !== undefined && v !== null) ? v / 1000 : 0,
    A_m2_to_mA_m2: (v) => (v !== undefined && v !== null) ? v * 1000 : 0,
    // Autres
    barToPa: (v) => (v !== undefined && v !== null) ? v * 1e5 : 0,
    PaToBar: (v) => (v !== undefined && v !== null) ? v / 1e5 : 0,
};

// ============================================================
// 1. CONFIGURATION
// ============================================================

// ============================================================
// APP_CONFIG — Source unique de vérité (SSOT) pour le versioning
// ============================================================
// RÈGLE (ROLE.txt §2) : APP_CONFIG.VERSION est la SEULE source
// de version globale de l'application. Aucune autre version
// globale concurrente ne doit exister.
//
// RÈGLE (§11-12) : Ne pas confondre :
//   - VERSION              : version de l'application (MAJOR.MINOR.PATCH)
//   - API_VERSION          : version de l'API Backend
//   - DATA_SCHEMA_VERSION  : version du schéma de données (IndexedDB)
//   - STORAGE_VERSION      : version d'ouverture de la base IndexedDB
//
// Les versions SPÉCIFIQUES de modules (PDF, GIS, 3D, ICCP, câbles)
// ont un cycle de vie indépendant et sont exposées sur leur
// namespace respectif (ex : PDFReportEngine.VERSION).
// ============================================================
const APP_CONFIG = Object.freeze({
    // ---- Version canonique de l'application (SSOT) ----
    VERSION: '9.6.0',

    // ---- Métadonnées ----
    NAME: 'CP Engineer Pro',
    DEFAULT_PROJECT_ID: 'PROJ-001',

    // ---- Versions de protocole (décorrélées) ----
    API_VERSION: 'v1',
    DATA_SCHEMA_VERSION: 3,   // doit rester synchronisé avec storage.js
    STORAGE_VERSION: 24,      // doit rester synchronisé avec storage.js

    // ---- Paramètres techniques (inchangés) ----
    SAVE_INTERVAL_MS: 30000,
    MAX_HISTORY_ENTRIES: 200,
    ENCRYPTION_SALT: 'CP_Engineer_Pro_Salt_2026',
    ANODE_DENSITY_LIMITS: { Mg: 20, Zn: 10, Al: 50, default: 30 },
    ICCP_ANODE_LIMITS: {
        mmo: 600,
        sicr: 50,
        graphite: 10,
        platinized: 1000,
        ferrosilicium: 30,
        platine_niobium: 2000,
        tantale: 3000
    },
    CABLE_RESISTIVITY: { cu: 0.0175, al: 0.0283 },
        /**
     * BUG-CP-003 : Coefficients de température des électrodes de référence.
     *
     * ⚠️  VALEURS TYPIQUES À VÉRIFIER FABRICANT.
     * Le statut 'typical_unverified' indique qu'une validation projet
     * est requise avant usage réglementaire.
     *
     * Structure : { value, referenceTempC, source, validationStatus }
     */
    REF_ELECTRODE_TEMP_COEFF: Object.freeze({
        CuCuSO4: {
            value: 0.5,
            referenceTempC: 25,
            source: 'Typique (à vérifier fabricant)',
            validationStatus: 'typical_unverified'
        },
        AgAgCl: {
            value: 0.6,
            referenceTempC: 25,
            source: 'Typique (à vérifier fabricant)',
            validationStatus: 'typical_unverified'
        },
        SCE: {
            value: 0.7,
            referenceTempC: 25,
            source: 'Typique (à vérifier fabricant)',
            validationStatus: 'typical_unverified'
        },
        Zn: {
            value: 0.4,
            referenceTempC: 25,
            source: 'Typique (à vérifier fabricant)',
            validationStatus: 'typical_unverified'
        }
    }),
    NACE_CRITERIA: { OFF_POTENTIAL: -850, POLARIZATION: 100 },

    /**
     * P0-03 : Taux de consommation des anodes ICCP.
     *
     * ATTENTION : Ces valeurs sont des RÉFÉRENCES TYPIQUES. Elles DOIVENT
     * être vérifiées par rapport aux données fabricant / hypothèses de
     * conception du projet avant d'être considérées comme universelles.
     *
     * Unités : rate_mg_per_A_year [mg/(A·an)] ou rate_g_per_A_year [g/(A·an)]
     *          1 mg/(A·an) = 1e-6 kg/(A·an)
     *          1 g/(A·an)  = 1e-3 kg/(A·an)
     *
     * Source : spécifications fabricants typiques (à valider par projet).
     */
    ICCP_ANODE_CONSUMPTION: Object.freeze({
        mmo: {
            rate_mg_per_A_year: 1.0,
            utilization: 0.85,
            designLifeCap_years: 25,
            source: 'MMO typical (0.5-2 mg/A/yr) — VÉRIFIER FABRICANT'
        },
        sicr: {
            rate_g_per_A_year: 150,
            utilization: 0.85,
            designLifeCap_years: 25,
            source: 'Si-Cr typical (100-200 g/A/yr) — VÉRIFIER FABRICANT'
        },
        graphite: {
            rate_g_per_A_year: 250,
            utilization: 0.85,
            designLifeCap_years: 25,
            source: 'Graphite typical (100-500 g/A/yr) — VÉRIFIER FABRICANT'
        },
        platinized: {
            rate_mg_per_A_year: 8.0,
            utilization: 0.85,
            designLifeCap_years: 25,
            source: 'Pt/Nb typical (5-15 mg/A/yr) — VÉRIFIER FABRICANT'
        },
        ferrosilicium: {
            rate_g_per_A_year: 150,
            utilization: 0.85,
            designLifeCap_years: 25,
            source: 'Fe-Si typical (100-200 g/A/yr) — VÉRIFIER FABRICANT'
        },
        platine_niobium: {
            rate_mg_per_A_year: 8.0,
            utilization: 0.85,
            designLifeCap_years: 25,
            source: 'Pt/Nb typical (5-15 mg/A/yr) — VÉRIFIER FABRICANT'
        },
        tantale: {
            rate_mg_per_A_year: 5.0,
            utilization: 0.85,
            designLifeCap_years: 25,
            source: 'Ta typical (2-10 mg/A/yr) — VÉRIFIER FABRICANT'
        }
    }),

    /**
     * Durée de vie de conception cible par défaut (années).
     * Validée par le projet : 25 ans.
     */
    DEFAULT_ICCP_DESIGN_LIFE_YEARS: 25,

    /**
     * Facteur de sécurité par défaut sur la puissance redresseur.
     * P1-02 : Ce facteur est appliqué EXACTEMENT UNE FOIS sur la puissance.
     */
    DEFAULT_SAFETY_FACTOR_POWER: 1.15,

    /**
     * Back EMF par défaut pour le dimensionnement redresseur.
     * Représente la force contre-électromotrice du système anode-structure
     * (polarisation + chute ohmique minimale irréductible).
     * Valeur typique en CP industriel : 2 V.
     * Surchargeable via paramètre `backEmfVoltage` dans designICCPAdvanced
     * et designRectifier.
     */
    DEFAULT_BACK_EMF_V: 2.0,

    ENV_DEFAULTS: {
        desert: { currentDensity: 1, resistivity: 100, coating: 0.95 },
        agricultural: { currentDensity: 5, resistivity: 30, coating: 0.95 },
        clay: { currentDensity: 10, resistivity: 15, coating: 0.95 },
        industrial: { currentDensity: 20, resistivity: 10, coating: 0.90 },
        freshwater: { currentDensity: 15, resistivity: 100, coating: 0.95 },
        seawater: { currentDensity: 50, resistivity: 0.2, coating: 0.95 },
        tidal: { currentDensity: 80, resistivity: 0.2, coating: 0.95 },
        mountain: { currentDensity: 3, resistivity: 200, coating: 0.95 },
        urban: { currentDensity: 8, resistivity: 50, coating: 0.92 },
        swamp: { currentDensity: 12, resistivity: 20, coating: 0.95 }
    },
    ANODE_MATERIALS: {
        Mg_HC: { capacity: 1230, potential: -1700, efficiency: 0.55, density: 1740 },
        Mg_Mn: { capacity: 1200, potential: -1650, efficiency: 0.55, density: 1740 },
        Mg_Al6: { capacity: 1250, potential: -1600, efficiency: 0.55, density: 1740 },
        Mg_AlZn: { capacity: 1150, potential: -1580, efficiency: 0.55, density: 1740 },
        Zn_HC: { capacity: 780, potential: -1100, efficiency: 0.95, density: 7140 },
        Zn_Al: { capacity: 800, potential: -1100, efficiency: 0.95, density: 7140 },
        Zn_Sacr: { capacity: 780, potential: -1050, efficiency: 0.90, density: 7140 },
        Zn_AlCd: { capacity: 800, potential: -1080, efficiency: 0.95, density: 7140 },
        Al_ZnIn: { capacity: 2600, potential: -1100, efficiency: 0.85, density: 2700 },
        Al_ZnHg: { capacity: 2800, potential: -1150, efficiency: 0.85, density: 2700 },
        Al_In: { capacity: 2500, potential: -1080, efficiency: 0.85, density: 2700 },
        Al_ZnSn: { capacity: 2400, potential: -1050, efficiency: 0.88, density: 2700 },
        Al_ZnMg: { capacity: 2550, potential: -1120, efficiency: 0.92, density: 2700 },
        Al_ZnBi: { capacity: 2600, potential: -1100, efficiency: 0.90, density: 2700 }
    },
    OUVRAGE_TYPES: {
        pipeline_enterre: { fields: ['diametre_m', 'longueur_m'], surfaceFn: (d, l) => Math.PI * d * l, defaultCurrentDensity: (env) => env === 'seawater' ? 30 : 5, defaultAnode: 'Mg_HC' },
        pipeline_offshore: { fields: ['diametre_m', 'longueur_m'], surfaceFn: (d, l) => Math.PI * d * l, defaultCurrentDensity: 50, defaultAnode: 'Al_ZnIn' },
        reservoir_fond: { fields: ['diametre_m', 'hauteur_m', 'hauteur_enterree_m'], surfaceFn: (d, h) => Math.PI * d * h + Math.PI * d * d / 4, defaultCurrentDensity: (env) => env === 'seawater' ? 30 : 10, defaultAnode: 'Mg_HC' },
        reservoir_toit: { fields: ['diametre_m'], surfaceFn: (d) => Math.PI * d * d / 4, defaultCurrentDensity: (env) => env === 'seawater' ? 20 : 8, defaultAnode: 'Mg_HC' },
        ballon_souterrain: { fields: ['diametre_m', 'longueur_m'], surfaceFn: (d, l) => Math.PI * d * l + Math.PI * d * d, defaultCurrentDensity: (env) => env === 'seawater' ? 50 : 10, defaultAnode: 'Al_ZnIn' },
        coque_navire: { fields: ['longueur_m', 'largeur_m', 'tirant_eau_m'], surfaceFn: (L, l, T) => 2 * (L * T + l * T) + L * l, defaultCurrentDensity: 50, defaultAnode: 'Al_ZnIn' },
        jacket_offshore: { fields: ['hauteur_m', 'perimetre_moyen_m'], surfaceFn: (H, P) => H * P, defaultCurrentDensity: 60, defaultAnode: 'Al_ZnIn' },
        monopieu: { fields: ['diametre_m', 'hauteur_m'], surfaceFn: (d, h) => Math.PI * d * h, defaultCurrentDensity: 50, defaultAnode: 'Al_ZnIn' },
        pieux: { fields: ['diametre_m', 'hauteur_m', 'nb_pieux'], surfaceFn: (d, h, n) => Math.PI * d * h * n, defaultCurrentDensity: 50, defaultAnode: 'Al_ZnIn' },
        well_casing: { fields: ['diametre_m', 'longueur_m'], surfaceFn: (d, l) => Math.PI * d * l, defaultCurrentDensity: 10, defaultAnode: 'Mg_HC' },
        fourreau: { fields: ['diametre_m', 'longueur_m'], surfaceFn: (d, l) => Math.PI * d * l, defaultCurrentDensity: 5, defaultAnode: 'Mg_HC' },
        support_metallique: { fields: ['surface_m2'], surfaceFn: (s) => s, defaultCurrentDensity: 5, defaultAnode: 'Mg_HC' },
        rectifier: { fields: [], surfaceFn: () => 0, defaultCurrentDensity: 0, defaultAnode: 'N/A' },
        groundbed: { fields: [], surfaceFn: () => 0, defaultCurrentDensity: 0, defaultAnode: 'N/A' },
        anode: { fields: [], surfaceFn: () => 0, defaultCurrentDensity: 0, defaultAnode: 'N/A' },
        testpost: { fields: [], surfaceFn: () => 0, defaultCurrentDensity: 0, defaultAnode: 'N/A' },
        autre: { fields: ['surface_m2'], surfaceFn: (s) => s, defaultCurrentDensity: 5, defaultAnode: 'Mg_HC' },
        tank: { fields: ['diametre_m', 'hauteur_m', 'hauteur_enterree_m'], surfaceFn: (d, h) => Math.PI * d * h + Math.PI * d * d / 4, defaultCurrentDensity: 10, defaultAnode: 'Mg_HC' },
        reservoir: { fields: ['diametre_m', 'hauteur_m', 'hauteur_enterree_m'], surfaceFn: (d, h) => Math.PI * d * h + Math.PI * d * d / 4, defaultCurrentDensity: 10, defaultAnode: 'Mg_HC' }
    },
    NORMS_DB: {
        pipeline_enterre: { primary: 'ISO 15589-1', suggested: ['ISO 15589-1', 'NACE SP0169'] },
        pipeline_offshore: { primary: 'DNV-RP-B401', suggested: ['DNV-RP-B401', 'ISO 15589-2'] },
        reservoir_fond: { primary: 'API RP 651', suggested: ['API RP 651', 'NACE SP0169'] },
        reservoir_toit: { primary: 'API RP 651', suggested: ['API RP 651', 'NACE SP0169'] },
        ballon_souterrain: { primary: 'NACE SP0169', suggested: ['NACE SP0169', 'ISO 15589-1'] },
        coque_navire: { primary: 'ISO 15589-2', suggested: ['ISO 15589-2', 'DNV-RP-B401'] },
        jacket_offshore: { primary: 'DNV-RP-B401', suggested: ['DNV-RP-B401', 'ISO 15589-2'] },
        monopieu: { primary: 'DNV-RP-B401', suggested: ['DNV-RP-B401', 'ISO 15589-2'] },
        pieux: { primary: 'DNV-RP-B401', suggested: ['DNV-RP-B401', 'ISO 15589-2'] },
        well_casing: { primary: 'NACE SP0169', suggested: ['NACE SP0169', 'ISO 15589-1'] },
        fourreau: { primary: 'NACE SP0169', suggested: ['NACE SP0169'] },
        support_metallique: { primary: 'NACE SP0169', suggested: ['NACE SP0169'] },
        autre: { primary: 'ISO 15589-1', suggested: ['ISO 15589-1', 'NACE SP0169'] }
    },
    ENV_NORMS: {
        seawater: ['ISO 12473', 'DNV-RP-B401'],
        tidal: ['DNV-RP-B401', 'ISO 12473'],
        industrial: ['NACE SP0169', 'NACE RP0193'],
        desert: ['NACE SP0169', 'ASTM G57']
    },
    SOIL_PROFILES: {
        very_low: { pH: 4.5, moisture: 80, chlorides: 1000, sulfates: 2000, redox: -100 },
        low: { pH: 5.5, moisture: 70, chlorides: 500, sulfates: 1000, redox: 0 },
        medium: { pH: 6.5, moisture: 60, chlorides: 200, sulfates: 400, redox: 50 },
        high: { pH: 7.2, moisture: 50, chlorides: 100, sulfates: 200, redox: 100 },
        very_high: { pH: 8.0, moisture: 20, chlorides: 50, sulfates: 100, redox: 200 },
        extreme: { pH: 8.5, moisture: 10, chlorides: 10, sulfates: 50, redox: 300 }
    },
    WATER_PROFILES: {
        freshwater: { salinity: 0.2, conductivity: 500, temperature: 15, DO: 8 },
        brackish: { salinity: 5, conductivity: 5000, temperature: 18, DO: 7 },
        seawater: { salinity: 35, conductivity: 50000, temperature: 20, DO: 6 },
        tidal: { salinity: 30, conductivity: 45000, temperature: 22, DO: 5 },
        desert: { salinity: 0.1, conductivity: 200, temperature: 30, DO: 4 }
    },
    ILLIZI_DEFAULTS: {
        projectName: 'Projet Illizi',
        cpSystemType: 'mixte',
        norm: 'ISO 15589-1',
        soilResistivity: 100,
        soilPh: 7.5,
        soilMoisture: 15,
        soilChlorides: 100,
        soilSulfates: 200,
        soilRedox: 150,
        waterSalinity: 0.5,
        waterConductivity: 500,
        waterTemperature: 25,
        waterDO: 6,
        currentDensity: 5,
        resistivity: 100,
        coating: 0.95,
        defectDensity: 0.03,
        agingFactor: 1.2,
        targetPotential: -850,
        cableLength: 100,
        cableSection: 35,
        structureResistance: 0.02,
        environment: 'desert',
        anodeMaterial: 'Mg_HC',
        anodeLife: 20,
        anodeMassUnit: 10,
        anodeLength: 1.0,
        anodeDiameter: 0.10,
        anodeUtilization: 0.85,
        safetyFactor: 1.10,
        anodePotential: -1700,
        anodeCapacity: 1230,
        anodeEfficiency: 55,
        anodeDensity: 1740,
        anodeStandard: 'DNV-RP-B401',
        iccpAnodeType: 'mmo',
        iccpAnodeCount: 8,
        iccpAnodeLength: 1.5,
        iccpAnodeDiameter: 0.10,
        iccpDistance: 10,
        iccpAgingFactor: 1.2,
        iccpCurrentDensity: 50,
        gbTotalDepth: 200,
        gbActiveDepth: 150,
        gbDiameter: 300,
        gbAnodeCount: 16,
        gbAnodeLength: 1.5,
        gbAnodeDiameter: 75,
        gbAnodeWeight: 25,
        gbAnodeCapacity: 2.5,
        gbCableLength: 100,
        gbCableSection: 35,
        gbAgingFactor: 1.2,
        gbSafetyFactor: 1.1,
        ifACVoltage: 400,
        ifACCurrent: 50,
        ifACDistance: 100,
        ifACParallel: 5000,
        ifACSoilCond: 0.01,
        ifDCDistance: 50,
        ifDCSeparation: 100,
        ifDCSoilResistivity: 150,
        ifVictimPotInit: -600,
        ifVictimPotFinal: -850,
        cableLengthDC: 500,
        cableVoltageDrop: 3,
        cableMaterial: 'cu'
       }
});

// ============================================================
// Alias global pour compatibilité (accès window.APP_CONFIG)
// ============================================================
if (typeof window !== 'undefined') {
    window.APP_CONFIG = APP_CONFIG;
}

// ============================================================
// 2. UTILS
// ============================================================
const Utils = {
    safeNumber(v, d = 0) {
        if (v === undefined || v === null || v === '') return d;
        const n = parseFloat(String(v).trim().replace(',', '.'));
        return isNaN(n) ? d : n;
    },
    escapeHtml(s) {
        if (!s) return '';
        return String(s).replace(/[&<>"]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            if (m === '"') return '&quot;';
            return m;
        });
    },
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    },
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
    debounce(fn, w) {
        let t;
        return function(...a) {
            clearTimeout(t);
            t = setTimeout(() => fn(...a), w);
        };
    },
    throttle(fn, l) {
        let b = false;
        return function(...a) {
            if (!b) {
                fn(...a);
                b = true;
                setTimeout(() => b = false, l);
            }
        };
    },
    mmToMeters(v, forceStrict = false) {
        const n = Utils.safeNumber(v);
        if (forceStrict) return n / 1000;
        // LOW-02 (2026-09-26) : heuristique legacy documentée
        return n > 10 ? n / 1000 : n;
    },
    inchesToMeters(v) { return Utils.safeNumber(v) * 0.0254; },
    clamp(v, min, max) { return Math.max(min, Math.min(max, v)); },
    formatNumber(v, d = 2) { return Utils.safeNumber(v).toFixed(d); },
    isPositiveNumber(v) { return Utils.safeNumber(v) > 0; },
    isInRange(v, min, max) {
        const n = Utils.safeNumber(v);
        return n >= min && n <= max;
    },
    isValidTag(t) { return /^[A-Za-z0-9\-_]+$/.test(t); },
    isValidName(n) { return n && n.trim().length > 0; },
    isValidPh(v) { return Utils.isInRange(v, 0, 14); },
    isValidResistivity(v) { return Utils.isPositiveNumber(v) && v <= 10000; },
    isValidCurrentDensity(v) { return Utils.isPositiveNumber(v) && v <= 500; },
    extractNumber(s) {
        const m = String(s).match(/[\d.]+/);
        return m ? parseFloat(m[0]) : 0;
    },
    deepClone(o) {
        try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
    },
    isEmpty(o) {
        if (!o) return true;
        if (Array.isArray(o)) return o.length === 0;
        return Object.keys(o).length === 0;
    },
    async deriveKey(salt) {
        const enc = new TextEncoder();
        const keyMat = await crypto.subtle.importKey(
            'raw',
            enc.encode(salt || APP_CONFIG.ENCRYPTION_SALT),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        return crypto.subtle.deriveKey({
            name: 'PBKDF2',
            salt: enc.encode('CP_Engineer_Pro_Salt'),
            iterations: 100000,
            hash: 'SHA-256'
        }, keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    },
    async encryptData(data, key) {
        try {
            const enc = new TextEncoder();
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
            const result = new Uint8Array(iv.length + encrypted.byteLength);
            result.set(iv, 0);
            result.set(new Uint8Array(encrypted), iv.length);
            return btoa(String.fromCharCode.apply(null, result));
        } catch (e) {
            console.warn('Encryption failed, fallback:', e);
            return btoa(JSON.stringify(data));
        }
    },
    async decryptData(encrypted, key) {
        try {
            const bin = atob(encrypted);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const iv = bytes.slice(0, 12);
            const data = bytes.slice(12);
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
            return JSON.parse(new TextDecoder().decode(decrypted));
        } catch (e) {
            console.warn('Decryption failed, fallback:', e);
            try { return JSON.parse(atob(encrypted)); } catch (e2) { return null; }
        }
    },
    generateValidationReport(criteria) {
        const allOk = criteria.every(c => c.ok);
        return { conform: allOk, details: criteria };
    },

    /**
     * Durée de vie d'une anode SACRIFICIELLE (loi de Faraday)
     * Formula: t = m × C × u / (I_avg × 8760)
     * Units: m [kg], C [Ah/kg], u [-], I_avg [A], t [années]
     * Reference: DNV-RP-B401
     */
    calculateAnodeLifeDNV(mass, capacity, utilization, currentAvg) {
        if (currentAvg <= 0 || capacity <= 0) return 0;
        return (mass * capacity * utilization) / (currentAvg * 8760);
    },

    /**
     * P0-03 : Durée de vie d'une anode ICCP (MMO, Si-Cr, Graphite, ...).
     *
     * Modèle : consommation de masse spécifique au matériau.
     *   t_théorique = (masse × utilisation) / (courant_anode × taux_consommation)
     *
     * Une fois le taux de consommation et la masse connus, la durée
     * théorique peut être très élevée (MMO : plusieurs siècles). On
     * applique donc un PLAFOND DE CONCEPTION explicite (designLifeCap)
     * pour éviter d'afficher des valeurs non exploitables.
     *
     * IMPORTANT : Ne JAMAIS générer artificiellement 20/30/50 ans.
     * Le résultat provient d'une formule techniquement cohérente.
     *
     * @param {string} material - Clé matériau ('mmo', 'sicr', ...)
     * @param {number} massPerAnode_kg - Masse d'une anode (kg)
     * @param {number} currentPerAnode_A - Courant par anode (A)
     * @param {number} [utilization] - Facteur d'utilisation (0-1). Par défaut : valeur matériau.
     * @returns {Object} { lifeTheoretical, lifeDesign, designLifeCap, rate_kg_per_A_year, utilization, source, material } ou { error, message }
     */
    calculateICCPAnodeLife(material, massPerAnode_kg, currentPerAnode_A, utilization, designLifeCap_years) {
        // ============================================================
        // FIX-LIFESPAN (2026-09-26) — Anodes à Dimensions Stables (DSA)
        // ------------------------------------------------------------
        // PROBLÈME RACINE : Pour les anodes DSA (MMO, platinisées, tantale),
        // le taux de consommation (mg/A/an) s'applique UNIQUEMENT à la couche
        // catalytique nanométrique (~8–12 g pour un tube MMO de 1 m), et NON
        // à la masse structurelle totale de l'assemblage canister (typiquement
        // 25 kg = titane + coke + gaine + résine).
        //
        // Diviser 25 kg par 1e-6 kg/(A·an) à 0.013 A/anode = 1,62 milliard
        // d'années : aberration physique absolue.
        //
        // SOLUTION NACE TM0108 / ISO 15589-1 :
        //   1. Utiliser la masse catalytique effective (~0.010 kg par anode,
        //      valeur conservative certifiée fabricant).
        //   2. Plafonner la durée de vie théorique à 50 ans (limite de
        //      durabilité physique : câble, soudure, substrat Ti, colmatage).
        //   3. La durée de vie de conception (lifeDesign) est plafonnée à 25 ans
        //      conformément à NACE SP0169 et API RP 651.
        //
        // MATÉRIAUX DSA (consommation = revêtement catalytique seulement) :
        //   mmo, platinized, platine_niobium, tantale
        // MATÉRIAUX SOLUBLES (consommation = masse réelle de l'anode) :
        //   sicr (silicon-chrome cast iron), graphite, ferrosilicium
        // ============================================================
        const DSA_MATERIALS = new Set(['mmo', 'platinized', 'platine_niobium', 'tantale']);
        // Masse catalytique nominale pour les DSA : ~10 g par anode tubulaire
        // (NACE TM0108 : chargement MMO 6–12 g/m ; platine ~1.5 g/m sur Nb/Ti).
        const DSA_CATALYTIC_MASS_KG = 0.010;
        // Durée de vie physique maximale : câble + raccord + substrat Ti (NACE/ISO)
        const DSA_PHYSICAL_LIFE_LIMIT_YR = 50;

        const config = APP_CONFIG.ICCP_ANODE_CONSUMPTION[material];
        if (!config) {
            return { error: true, message: 'Matériau ICCP inconnu : ' + material };
        }

        const current = Utils.safeNumber(currentPerAnode_A);
        const u = (utilization !== undefined && utilization !== null && utilization > 0 && utilization <= 1)
            ? utilization
            : (config.utilization || 0.85);

        if (current <= 0) {
            return { error: true, message: 'Courant anode invalide (doit être > 0)' };
        }

        // Convertir le taux de consommation en kg/(A·an)
        let rate_kg_per_A_year = 0;
        if (config.rate_mg_per_A_year !== undefined) {
            rate_kg_per_A_year = config.rate_mg_per_A_year * 1e-6;
        } else if (config.rate_g_per_A_year !== undefined) {
            rate_kg_per_A_year = config.rate_g_per_A_year * 1e-3;
        } else {
            return { error: true, message: 'Taux de consommation non défini pour ' + material };
        }

        if (rate_kg_per_A_year <= 0) {
            return { error: true, message: 'Taux de consommation invalide pour ' + material };
        }

        // Sélection de la masse effective selon le type d'anode
        let effectiveMass;
        let massNote;
        if (DSA_MATERIALS.has(String(material).toLowerCase())) {
            // Anodes DSA : utiliser la masse du revêtement catalytique (pas la masse structurelle)
            effectiveMass = DSA_CATALYTIC_MASS_KG;
            massNote = 'Masse catalytique DSA (~10 g revêtement). Masse structurelle non consommée.';
        } else {
            // Anodes solubles (Si-Cr, graphite, ferrosilicium) : masse réelle
            const mass = Utils.safeNumber(massPerAnode_kg);
            if (mass <= 0) {
                return { error: true, message: 'Masse anode invalide (doit être > 0)' };
            }
            effectiveMass = mass;
            massNote = 'Masse anode soluble (Faraday standard).';
        }

        // t_théorique = (masse_effective × utilisation) / (courant × taux_consommation)
        let lifeTheoretical = (effectiveMass * u) / (current * rate_kg_per_A_year);

        // Plafonner à la limite physique DSA (câble, substrat Ti, raccords)
        if (DSA_MATERIALS.has(String(material).toLowerCase())) {
            lifeTheoretical = Math.min(lifeTheoretical, DSA_PHYSICAL_LIFE_LIMIT_YR);
        }

        // Plafond de conception (NACE SP0169 / API RP 651 : 25 ans par défaut)
        const configuredCap = Utils.safeNumber(designLifeCap_years);
        const designLifeCap = configuredCap > 0
            ? configuredCap
            : (config.designLifeCap_years || APP_CONFIG.DEFAULT_ICCP_DESIGN_LIFE_YEARS);
        const lifeDesign = Math.min(lifeTheoretical, designLifeCap);

        return {
            lifeTheoretical: lifeTheoretical,
            lifeDesign: lifeDesign,
            designLifeCap: designLifeCap,
            rate_kg_per_A_year: rate_kg_per_A_year,
            utilization: u,
            effectiveMass_kg: effectiveMass,
            massNote: massNote,
            isDSA: DSA_MATERIALS.has(String(material).toLowerCase()),
            source: config.source || 'Valeur paramétrable',
            material: material,
            massPerAnode_kg: Utils.safeNumber(massPerAnode_kg),
            currentPerAnode_A: current
        };
    },

    /**
     * P1-05 : Durée de vie de conception (plafonnée).
     */
    calculateDesignLife(lifeTheoretical, cap_years) {
        const cap = (cap_years !== undefined && cap_years > 0)
            ? cap_years
            : APP_CONFIG.DEFAULT_ICCP_DESIGN_LIFE_YEARS;
        const theoretical = Utils.safeNumber(lifeTheoretical, 0);
        return {
            theoretical: theoretical,
            design: Math.min(theoretical, cap),
            cap: cap
        };
    }
};

// ============================================================
// 3. VALIDATOR
// ============================================================

const Validator = {
    rules: {
        surface: { min: 0.01, max: 1000000, required: true, label: 'Surface (m²)' },
        defectDensity: { min: 0.001, max: 0.1, required: true, label: 'Densité de défaut (DF)' },
        agingFactor: { min: 1.0, max: 3.0, required: true, label: 'Facteur de vieillissement (k)' },
        currentDensity: { min: 0, max: 500, required: true, label: 'Densité de courant (mA/m²)' },
        coating: { min: 0, max: 1, required: true, label: 'Efficacité revêtement (ε)' },
        resistivity: { min: 0.01, max: 10000, required: true, label: 'Résistivité (Ω·m)' },
        targetPotential: { min: -1200, max: -400, required: true, label: 'Potentiel cible (mV)' },
        anodeCurrent: { min: 0.001, max: 10000, required: true, label: 'Courant requis (A)' },
        anodeLife: { min: 1, max: 100, required: true, label: 'Durée de vie (ans)' },
        anodeUtilization: { min: 0.5, max: 1.0, required: true, label: "Facteur d'utilisation (u)" },
        safetyFactor: { min: 1.0, max: 2.0, required: true, label: 'Facteur de sécurité' },
        anodeUnitMass: { min: 0.1, max: 1000, required: true, label: 'Masse unitaire (kg)' },
        anodeLength: { min: 0.01, max: 10, required: true, label: 'Longueur anode (m)' },
        anodeDiameter: { min: 0.001, max: 1, required: true, label: 'Diamètre anode (m)' },
        anodePot: { min: -2000, max: -200, required: true, label: 'Potentiel anode (mV)' },
        finalResistanceFactor: { min: 1.0, max: 3.0, required: true, label: 'Facteur de résistance finale' },
        gbTotalDepth: { min: 1, max: 1000, required: true, label: 'Profondeur totale (m)' },
        gbActiveDepth: { min: 1, max: 1000, required: true, label: 'Profondeur active (m)' },
        gbAnodeCount: { min: 1, max: 100, required: true, label: "Nombre d'anodes" },
        gbAnodeWeight: { min: 1, max: 10000, required: true, label: 'Poids anode (kg)' },
        gbAnodeCapacity: { min: 0.1, max: 10, required: true, label: 'Capacité anode (A·yr/kg)' },
        ifACVoltage: { min: 1, max: 1000, required: true, label: 'Tension AC (kV)' },
        ifACCurrent: { min: 1, max: 10000, required: true, label: 'Courant AC (A)' },
        ifACDistance: { min: 1, max: 10000, required: true, label: 'Distance parallèle (m)' },
        ifACParallel: { min: 1, max: 100000, required: true, label: 'Longueur parallèle (m)' },
        ifACSoilCond: { min: 0.001, max: 1, required: true, label: 'Conductivité sol (S/m)' },
        ifDCDistance: { min: 1, max: 10000, required: true, label: 'Distance DC (m)' },
        ifDCSoilResistivity: { min: 0.01, max: 10000, required: true, label: 'Résistivité sol DC (Ω·m)' },
        ifPipeDiameter: { min: 10, max: 5000, required: true, label: 'Diamètre pipeline (mm)' },
        ifPipeLength: { min: 1, max: 100000, required: true, label: 'Longueur pipeline (m)' }
    },
    validateField(fieldId, value) {
        const rule = this.rules[fieldId];
        if (!rule) return { valid: true, message: null };
        const num = Utils.safeNumber(value);
        if (rule.required && (value === undefined || value === null || value === '' || isNaN(num))) {
            return { valid: false, message: `${rule.label} est requis.` };
        }
        if (rule.min !== undefined && num < rule.min) {
            return { valid: false, message: `${rule.label} doit être ≥ ${rule.min}. Valeur actuelle : ${num}` };
        }
        if (rule.max !== undefined && num > rule.max) {
            return { valid: false, message: `${rule.label} doit être ≤ ${rule.max}. Valeur actuelle : ${num}` };
        }
        return { valid: true, message: null };
    },
    validateForm(data, fieldMapping) {
        const errors = [];
        for (const [fieldId, value] of Object.entries(fieldMapping)) {
            const r = this.validateField(fieldId, value);
            if (!r.valid) errors.push({ field: fieldId, message: r.message });
        }
        return { valid: errors.length === 0, errors };
    },
    validateCPInputs(S, eps, DF, k, J) {
        const errors = [];
        const s = this.validateField('surface', S);
        if (!s.valid) errors.push(s.message);
        const c = this.validateField('coating', eps);
        if (!c.valid) errors.push(c.message);
        const d = this.validateField('defectDensity', DF);
        if (!d.valid) errors.push(d.message);
        const a = this.validateField('agingFactor', k);
        if (!a.valid) errors.push(a.message);
        const cd = this.validateField('currentDensity', J);
        if (!cd.valid) errors.push(cd.message);
        if (DF * k > 1) errors.push('Le produit DF × k ne doit pas dépasser 1 (revêtement totalement dégradé).');
        return { valid: errors.length === 0, errors };
    },
    validateAnodeInputs(I_req, life, u, safety, unitMass, rho, L, d, anodePot) {
        const errors = [];
        const i = this.validateField('anodeCurrent', I_req);
        if (!i.valid) errors.push(i.message);
        const l = this.validateField('anodeLife', life);
        if (!l.valid) errors.push(l.message);
        const uu = this.validateField('anodeUtilization', u);
        if (!uu.valid) errors.push(uu.message);
        const sf = this.validateField('safetyFactor', safety);
        if (!sf.valid) errors.push(sf.message);
        const m = this.validateField('anodeUnitMass', unitMass);
        if (!m.valid) errors.push(m.message);
        const r = this.validateField('resistivity', rho);
        if (!r.valid) errors.push(r.message);
        const len = this.validateField('anodeLength', L);
        if (!len.valid) errors.push(len.message);
        const diam = this.validateField('anodeDiameter', d);
        if (!diam.valid) errors.push(diam.message);
        const pot = this.validateField('anodePot', anodePot);
        if (!pot.valid) errors.push(pot.message);
        return { valid: errors.length === 0, errors };
    }
};

// ============================================================
// 4. MOTEUR DE CALCUL (CalculationEngine)
// ============================================================

const CalculationEngine = (function() {
    const config = APP_CONFIG;

    // ------------------------------------------------------------
    // Cache LRU de memoization
    // ------------------------------------------------------------
    const _memoCache = new Map();
    const MAX_CACHE_ENTRIES = 200;

    /**
     * Memoization avec éviction LRU propre.
     * Amélioration P3 : conserve les entrées récemment utilisées.
     */
    function memoize(fn, keyPrefix) {
        return function(...args) {
            let cacheKey;
            try {
                cacheKey = keyPrefix + '_' + JSON.stringify(args);
            } catch (e) {
                // Si les arguments ne sont pas sérialisables, exécuter sans cache
                return fn.apply(this, args);
            }
            if (_memoCache.has(cacheKey)) {
                // LRU : remonter la clé en fin de Map
                const value = _memoCache.get(cacheKey);
                _memoCache.delete(cacheKey);
                _memoCache.set(cacheKey, value);
                return value;
            }
            const result = fn.apply(this, args);
            if (result !== undefined && result !== null) {
                if (_memoCache.size >= MAX_CACHE_ENTRIES) {
                    // Supprimer l'entrée la plus ancienne (première clé)
                    const firstKey = _memoCache.keys().next().value;
                    _memoCache.delete(firstKey);
                }
                _memoCache.set(cacheKey, result);
            }
            return result;
        };
    }

    // ============================================================
    // RÉSISTANCES D'ANODES (Dwight)
    // ============================================================

    /**
     * Purpose: Résistance d'une anode verticale cylindrique (Dwight)
     * Formula: R = rho/(2*pi*L) * (ln(4L/d) - 1)
     * Units: rho [ohm.m], L [m], d [m] → R [ohm]
     * Assumptions: électrode cylindrique verticale en sol homogène
     * Reference: Dwight (1936) / pratique CP courante
     * Validation: retourne 0 si paramètres invalides
     */
    const anodeResistanceVertical = memoize(function(rho, L, d) {
        if (!isFinite(rho) || !isFinite(L) || !isFinite(d)) return 0;
        if (rho <= 0 || L <= 0 || d <= 0) return 0;
        const ratio = 4 * L / d;
        if (ratio <= 1) return 0;  // domaine logarithmique invalide
        const R = (rho / (2 * Math.PI * L)) * (Math.log(ratio) - 1);
        return isFinite(R) && R > 0 ? R : 0;
    }, 'anodeResVertical');

    /**
     * Purpose: Résistance d'une anode horizontale cylindrique
     * Formula: R = rho/(2*pi*L) * (ln(8L/d) - 1)
     * Units: rho [ohm.m], L [m], d [m] → R [ohm]
     * Reference: Dwight (1936)
     */
    const anodeResistanceHorizontal = memoize(function(rho, L, d) {
        if (!isFinite(rho) || !isFinite(L) || !isFinite(d)) return 0;
        if (rho <= 0 || L <= 0 || d <= 0) return 0;
        const ratio = 8 * L / d;
        if (ratio <= 1) return 0;
        const R = (rho / (2 * Math.PI * L)) * (Math.log(ratio) - 1);
        return isFinite(R) && R > 0 ? R : 0;
    }, 'anodeResHorizontal');

    /**
     * Purpose: Résistance d'un groupe d'anodes (formule de Sunde)
     * Formula: R_g = R_single * [1 + (rho/(2*pi*s)) * ln(s/d)] / N
     * Units: R [ohm], rho [ohm.m], s [m], d [m], N [-]
     * Assumptions: anodes verticaux parallèles, sol homogène,
     *              espacement s >> d, N modéré
     * Reference: Sunde (1968) "Earth Conduction Effects"
     * Note: Approximation valide pour N ≤ 20 et s/d ≥ 10.
     *       Pour configurations critiques, une méthode numérique
     *       (éléments finis) est recommandée.
     */
    const groupResistanceSunde = memoize(function(R_single, N, spacing, rho, d) {
        if (N <= 1) return R_single;
        if (spacing <= 0) return R_single / N;
        if (spacing <= d) return R_single / N;  // domaine invalide → fallback
        const interaction = 1 + (rho / (2 * Math.PI * spacing)) * Math.log(spacing / d);
        const R = (R_single * interaction) / N;
        return isFinite(R) && R > 0 ? R : R_single / N;
    }, 'groupResSunde');

    // ============================================================
    // GAP-COAT-02 : FACTEUR DE DÉGRADATION NET DU REVÊTEMENT
    // ------------------------------------------------------------
    // Calcule le facteur de dégradation net f_c = (1-ε) × DF × k
    // avec cap à 1.0 (structure nue = cas le plus défavorable).
    //
    // Paramètres :
    //   eps [-]  Efficacité revêtement (0=nu, 1=parfait)
    //   DF  [-]  Densité de défauts (fraction de surface exposée)
    //   k   [-]  Facteur de vieillissement (≥ 1.0)
    //
    // Référence : ISO 15589-1:2017 §7.3 / NACE SP0169-2013 §A.3
    // ============================================================

    /**
     * Purpose: Facteur de dégradation net du revêtement
     * Formula: f_c = min((1-ε) × DF × k, 1.0)
     * Units: ε [-], DF [-], k [-] → f_c [-]
     * Reference: ISO 15589-1 §7.3 / NACE SP0169 §A.3
     */
    function calculateCoatingDegradationFactor(eps, DF, k) {
        const safeEps = (isFinite(eps) && eps >= 0 && eps <= 1) ? eps : 0.0;
        const safeDF  = (isFinite(DF)  && DF  >= 0 && DF  <= 1) ? DF  : 1.0;
        const safeK   = (isFinite(k)   && k   >= 1)             ? k   : 1.0;
        const f_c_raw = (1 - safeEps) * safeDF * safeK;
        const f_c     = Math.min(f_c_raw, 1.0);
        return {
            f_c:               f_c,
            f_c_uncapped:      f_c_raw,
            coatingCapApplied: f_c_raw > 1.0,
            coatingEfficiency: safeEps,
            defectFactor:      safeDF,
            agingFactor:       safeK,
            reference: 'ISO 15589-1:2017 §7.3 / NACE SP0169-2013 §A.3',
            units: { f_c: '-', coatingEfficiency: '-', defectFactor: '-', agingFactor: '-' }
        };
    }

    // ============================================================
    // GAP-RESIST-01 : MODÈLE MULTICOUCHE DE RÉSISTIVITÉ DE SOL
    // ------------------------------------------------------------
    // Calcule la résistivité effective d'un sol multicouche selon
    // le modèle série/parallèle de Wenner (ISO 15589-1 Annexe A).
    //
    // Deux estimations sont fournies :
    //   rho_arithmetic : moyenne pondérée par épaisseur (couche série)
    //     → borne supérieure (pessimiste) du courant en surface
    //   rho_harmonic   : moyenne harmonique pondérée (couche parallèle)
    //     → borne inférieure (optimiste) de la résistance en profondeur
    //
    // L'ingénieur choisit la borne la plus conservative selon le contexte :
    //   - Dimensionnement anode (courant) → rho_harmonic (résistance plus faible)
    //   - Dimensionnement câble/redresseur → rho_arithmetic (résistivité plus haute)
    //
    // Paramètre layers : Array<{ rho: number [Ω·m], depth: number [m] }>
    //
    // Référence : ISO 15589-1:2017 Annexe A / Sunde (1968)
    // ============================================================

    /**
     * Purpose: Résistivité effective d'un sol multicouche
     * Units: rho [Ω·m], depth [m] → rho_eff [Ω·m]
     * Reference: ISO 15589-1:2017 Annexe A / Sunde (1968)
     */
    function calculateLayeredSoilResistivity(layers) {
        if (!Array.isArray(layers) || layers.length === 0) {
            return { error: true, message: 'Au moins une couche de sol est requise.' };
        }

        // Normalisation et validation
        const normalized = layers.map(function(layer, i) {
            const rho   = Number(layer.rho   !== undefined ? layer.rho   : layer.resistivity);
            const depth = Number(layer.depth !== undefined ? layer.depth : layer.thickness);
            if (!isFinite(rho) || rho <= 0) {
                return { error: true, message: 'Couche ' + (i + 1) + ' : résistivité invalide (' + rho + ' Ω·m).' };
            }
            if (!isFinite(depth) || depth <= 0) {
                return { error: true, message: 'Couche ' + (i + 1) + ' : épaisseur invalide (' + depth + ' m).' };
            }
            return { rho: rho, depth: depth };
        });

        const firstError = normalized.find(function(l) { return l.error; });
        if (firstError) return firstError;

        const totalDepth = normalized.reduce(function(sum, l) { return sum + l.depth; }, 0);
        if (!isFinite(totalDepth) || totalDepth <= 0) {
            return { error: true, message: 'Profondeur totale des couches invalide.' };
        }

        // Borne série (arithmétique pondérée) — résistivité maximale
        const rho_arithmetic = normalized.reduce(function(sum, l) {
            return sum + l.rho * (l.depth / totalDepth);
        }, 0);

        // Borne parallèle (harmonique pondérée) — résistivité minimale
        const rho_harmonic = totalDepth / normalized.reduce(function(sum, l) {
            return sum + (l.depth / l.rho);
        }, 0);

        // Rapport de sensibilité : > 1.25 → hétérogénéité significative
        const sensitivityRatio = (isFinite(rho_harmonic) && rho_harmonic > 0)
            ? rho_arithmetic / rho_harmonic
            : null;

        const requiresSpecialistStudy = sensitivityRatio !== null && sensitivityRatio > 1.25;

        let designRecommendation = 'HOMOGENEOUS_MODEL_ADEQUATE';
        if (requiresSpecialistStudy) {
            designRecommendation = 'LAYERED_MODEL_REQUIRED — Etude numerique de sol recommandee (FEM/BEM)';
        }

        return {
            rho_arithmetic:  rho_arithmetic,   // borne série (pessimiste)
            rho_harmonic:    rho_harmonic,      // borne parallèle (optimiste)
            sensitivityRatio: sensitivityRatio, // rho_arith / rho_harm
            totalDepth:      totalDepth,
            layers:          normalized,
            requiresSpecialistStudy: requiresSpecialistStudy,
            designRecommendation: designRecommendation,
            reference: 'ISO 15589-1:2017 Annexe A / Sunde (1968)',
            units: {
                resistivity: 'Ω·m',
                depth: 'm'
            }
        };
    }

    // ============================================================
    // COURANT REQUIS (ISO 15589-1 / NACE SP0169)
    // ============================================================

    /**
     * Purpose: Courant de protection requis
     * Formula: I = S × (1-ε) × DF × k × J / 1000
     * Units: S [m²], ε [-], DF [-], k [-], J [mA/m²] → I [A]
     * Reference: ISO 15589-1 / NACE SP0169
     *
     * NOTE P0-02 : J est en mA/m² (unité d'entrée canonique pour cette
     * fonction, conforme au paramétrage UI). La division par 1000 convertit
     * mA → A. Le résultat est en A.
     */
    const requiredCurrent = memoize(function(S, J, eps, DF, k, norm) {
        // GAP-COAT-01 : Le facteur de dégradation net f_c = (1-ε) × DF × k
        // DOIT être plafonné à 1.0 (surface exposée ≤ surface totale).
        // Référence : ISO 15589-1 §7.3 — le produit DF×k représente la
        // dégradation cumulée du revêtement ; au-delà de 1, la structure
        // est supposée nue (cas le plus défavorable).
        const f_c_raw = (1 - eps) * DF * k;
        const f_c_capped = Math.min(f_c_raw, 1.0);
        const coatingCapApplied = f_c_raw > 1.0;
        const exposedArea = S * f_c_capped;
        const currentAmperes = (exposedArea * J) / 1000;
        const formula = norm === 'NACE SP0169' ?
            'I = S × min((1-ε)×DF×k, 1) × J / 1000 (NACE SP0169)' :
            'I = S × min((1-ε)×DF×k, 1) × J / 1000 (ISO 15589-1 §7.3)';
        return {
            currentAmperes: currentAmperes,
            exposedArea: exposedArea,
            f_c: f_c_capped,
            f_c_uncapped: f_c_raw,
            coatingCapApplied: coatingCapApplied,
            formula: formula,
            reference: norm || 'ISO 15589-1',
            // Traçabilité
            units: {
                surface: 'm²',
                coating: '-',
                defectDensity: '-',
                agingFactor: '-',
                currentDensity: 'mA/m²',
                current: 'A'
            }
        };
    }, 'requiredCurrent');

    // ============================================================
    // GAP-01 (Audit 2026-09-19) : COURANT DNV — 3 valeurs distinctes
    // ------------------------------------------------------------
    // DNV-RP-B401 §5.3 / ISO 15589-1 §7.3 :
    //   Le courant de conception doit couvrir MAX(I_initial, I_final).
    //   Le revêtement dégradé en fin de vie impose souvent I_final >> I_initial.
    //
    // Paramètres :
    //   S         [m²]   Surface totale à protéger
    //   J_init    [mA/m²] Densité de courant initiale (revêtement neuf)
    //   J_moy     [mA/m²] Densité de courant moyenne
    //   J_final   [mA/m²] Densité de courant finale (revêtement dégradé)
    //   eps_init  [-]    Efficacité revêtement initiale (neuf)
    //   eps_moy   [-]    Efficacité revêtement moyenne
    //   eps_final [-]    Efficacité revêtement finale
    //   DF        [-]    Densité de défauts (0–1)
    //   k_init    [-]    Facteur vieillissement initial (≥ 1.0, typ. 1.0)
    //   k_final   [-]    Facteur vieillissement final  (≥ 1.0, typ. 1.2–2.0)
    //
    // Retourne : { I_initial, I_moyen, I_final, I_design, sizingBasis, ... }
    // ============================================================
    const requiredCurrentDNV = memoize(function(params) {
        const {
            S, J_init, J_moy, J_final,
            eps_init, eps_moy, eps_final,
            DF, k_init, k_final, norm
        } = params;

        if (!isFinite(S) || S <= 0) {
            return { error: true, message: 'Surface invalide (doit être > 0)' };
        }
        if (!isFinite(J_init) || J_init <= 0 ||
            !isFinite(J_final) || J_final <= 0) {
            return { error: true, message: 'Densités de courant initiale et finale requises (> 0)' };
        }

        const safeDF     = (isFinite(DF) && DF >= 0 && DF <= 1) ? DF : 1.0;
        const safeKinit  = (isFinite(k_init)  && k_init  >= 1) ? k_init  : 1.0;
        const safeKfinal = (isFinite(k_final) && k_final >= 1) ? k_final : safeKinit;
        const safeKmoy   = (safeKinit + safeKfinal) / 2;

        const safeEinit  = (isFinite(eps_init)  && eps_init  >= 0 && eps_init  <= 1) ? eps_init  : 0.95;
        const safeEfinal = (isFinite(eps_final) && eps_final >= 0 && eps_final <= 1) ? eps_final : 0.70;
        const safeEmoy   = (isFinite(eps_moy)   && eps_moy   >= 0 && eps_moy   <= 1)
            ? eps_moy
            : (safeEinit + safeEfinal) / 2;
        const safeJmoy   = (isFinite(J_moy) && J_moy > 0) ? J_moy : (J_init + J_final) / 2;

        // GAP-COAT-01 : Plafonnement des facteurs de dégradation nets à 1.0
        // f_c = (1-ε) × DF × k ≤ 1 — ISO 15589-1 §7.3 / DNV-RP-B401 §5.3
        const f_c_init_raw  = (1 - safeEinit)  * safeDF * safeKinit;
        const f_c_moy_raw   = (1 - safeEmoy)   * safeDF * safeKmoy;
        const f_c_final_raw = (1 - safeEfinal) * safeDF * safeKfinal;
        const f_c_init  = Math.min(f_c_init_raw,  1.0);
        const f_c_moy   = Math.min(f_c_moy_raw,   1.0);
        const f_c_final = Math.min(f_c_final_raw, 1.0);
        const coatingCapApplied = (f_c_init_raw > 1.0) || (f_c_moy_raw > 1.0) || (f_c_final_raw > 1.0);

        // Surface exposée à chaque phase
        const area_init  = S * f_c_init;
        const area_moy   = S * f_c_moy;
        const area_final = S * f_c_final;

        // Courants [A]
        const I_initial = (area_init  * J_init)  / 1000;
        const I_moyen   = (area_moy   * safeJmoy) / 1000;
        const I_final   = (area_final * J_final)  / 1000;

        // DNV-RP-B401 §5.3 : courant de conception = max(initial, final)
        const I_design  = Math.max(I_initial, I_final);
        const sizingBasis = I_initial >= I_final ? 'initial' : 'final';

        return {
            I_initial, I_moyen, I_final, I_design,
            sizingBasis,
            exposedArea_init:  area_init,
            exposedArea_moy:   area_moy,
            exposedArea_final: area_final,
            f_c_init, f_c_moy, f_c_final,
            f_c_init_raw, f_c_moy_raw, f_c_final_raw,
            coatingCapApplied: coatingCapApplied,
            inputs: {
                S, J_init, J_moy: safeJmoy, J_final,
                eps_init: safeEinit, eps_moy: safeEmoy, eps_final: safeEfinal,
                DF: safeDF, k_init: safeKinit, k_final: safeKfinal
            },
            reference: norm || 'DNV-RP-B401 §5.3 / ISO 15589-1 §7.3',
            units: {
                current: 'A',
                surface: 'm²',
                currentDensity: 'mA/m²'
            }
        };
    }, 'requiredCurrentDNV');

    // ============================================================
    // P0-01 : DIMENSIONNEMENT DES ANODES (DNV-RP-B401)
    // ============================================================

    function normalizeSACPResult(result = {}) {
        const source = result && typeof result === 'object' ? result : {};
        const asNumber = (value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : 0;
        };

        let totalMass = asNumber(source.totalMass);
        let count = asNumber(source.count);
        let actualLife = asNumber(source.actualLife);
        let initialCurrent = asNumber(source.initialCurrent);
        let finalCurrent = asNumber(source.finalCurrent);
        let currentDensity = asNumber(source.currentDensity);
        let currentDensity_mA = asNumber(source.currentDensity_mA);

        const validMassCount = totalMass > 0 && count > 0;
        const inconsistentPair = (totalMass > 0 && count <= 0) || (count > 0 && totalMass <= 0);
        const inconsistentLife = actualLife > 0 && !validMassCount;

        if (!validMassCount || inconsistentPair || inconsistentLife) {
            totalMass = 0;
            count = 0;
            actualLife = 0;
            initialCurrent = 0;
            finalCurrent = 0;
            currentDensity = 0;
            currentDensity_mA = 0;
        }

        return {
            ...source,
            totalMass,
            count,
            actualLife,
            initialCurrent,
            finalCurrent,
            currentDensity,
            currentDensity_mA,
            densityOk: Boolean(source.densityOk) && validMassCount
        };
    }

    function normalizeGroundbedResult(result = {}) {
        const source = result && typeof result === 'object' ? result : {};
        const asNumber = (value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : 0;
        };

        const R_total = asNumber(source.R_total);
        const I_total = asNumber(source.I_total);
        const J_anode = asNumber(source.J_anode);
        const J_anode_mA = asNumber(source.J_anode_mA);
        const lifeWithSafety = asNumber(source.lifeWithSafety);
        const requiredAnodeCount = asNumber(source.requiredAnodeCount);
        const anodeCount = asNumber(source.anodeCount);
        const totalMass = asNumber(source.totalMass);
        const densityLimit = asNumber(source.densityLimit);
        const hasValidGroundbedState =
            R_total > 0 &&
            I_total > 0 &&
            anodeCount > 0 &&
            totalMass > 0 &&
            J_anode > 0 &&
            lifeWithSafety > 0;

        const normalized = {
            ...source,
            R_total: hasValidGroundbedState ? R_total : 0,
            I_total: hasValidGroundbedState ? I_total : 0,
            V_rectifier: hasValidGroundbedState ? asNumber(source.V_rectifier) : 0,
            P_rectifier: hasValidGroundbedState ? asNumber(source.P_rectifier) : 0,
            J_anode: hasValidGroundbedState ? J_anode : 0,
            J_anode_mA: hasValidGroundbedState ? J_anode_mA : 0,
            densityLimit: hasValidGroundbedState ? densityLimit : 0,
            densityOk: Boolean(source.densityOk) && hasValidGroundbedState,
            lifeWithSafety: hasValidGroundbedState ? lifeWithSafety : 0,
            requiredAnodeCount: hasValidGroundbedState ? requiredAnodeCount : 0,
            anodeCount: hasValidGroundbedState ? anodeCount : 0,
            totalMass: hasValidGroundbedState ? totalMass : 0,
            desiredLife: asNumber(source.desiredLife) > 0 && hasValidGroundbedState ? asNumber(source.desiredLife) : 0,
            lifeOk: Boolean(source.lifeOk) && hasValidGroundbedState
        };

        return normalized;
    }

    /**
     * Purpose: Dimensionnement complet des anodes sacrificielles
     *          (nombre, masse, courant, durée de vie, densité)
     *
     * Méthode (corrigée) :
     *   1. R_anode = Dwight(rho, L, d)
     *   2. ΔV = |E_anode - E_protection| (V)
     *   3. I_initial_per_anode = ΔV / R_anode
     *      I_final_per_anode = ΔV / (R_anode × finalFactor)
     *   4. N_current = ceil(I_req / I_final_per_anode)
     *      (critère : protection maintenue en fin de vie)
     *   5. N_mass = ceil(I_req × life × 8760 × safety / (u × C × unitMass))
     *      (masse totale nécessaire avec sécurité)
     *   6. N = max(N_current, N_mass, 1)
     *   7. Life_actual = N × unitMass × C × u / (I_req × 8760)
     *
     * Units: I_req [A], life [ans], rho [ohm.m], L [m], d [m],
     *        E [mV], unitMass [kg], C [Ah/kg] → tous SI
     * Reference: DNV-RP-B401 / NACE SP0169
     *
     * IMPORTANT : L'ancienne version n'utilisait pas I_req pour N,
     *             causant un sous-dimensionnement critique.
     */
    const designAnodesDNV = memoize(function(params) {
        const {
            I_req, life, materialKey, u, safety, unitMass,
            rho, L, d, anodePot, targetProtection, finalFactor
        } = params;

        const orientation = params.orientation || 'vertical';

        // ---- Validation des entrées ----
        if (!isFinite(I_req) || I_req <= 0) {
            return { error: true, message: 'Courant requis invalide (doit être > 0)' };
        }
        if (!isFinite(life) || life <= 0) {
            return { error: true, message: 'Durée de vie invalide (doit être > 0)' };
        }
        if (!isFinite(rho) || rho <= 0) {
            return { error: true, message: 'Résistivité invalide (doit être > 0)' };
        }
        if (!isFinite(L) || L <= 0) {
            return { error: true, message: 'Longueur anode invalide (doit être > 0)' };
        }
        if (!isFinite(d) || d <= 0) {
            return { error: true, message: 'Diamètre anode invalide (doit être > 0)' };
        }
        if (!isFinite(unitMass) || unitMass <= 0) {
            return { error: true, message: 'Masse unitaire invalide (doit être > 0)' };
        }
        if (!isFinite(u) || u <= 0 || u > 1) {
            return { error: true, message: 'Facteur d\'utilisation invalide (0 < u ≤ 1)' };
        }
        if (!isFinite(safety) || safety < 1) {
            return { error: true, message: 'Facteur de sécurité invalide (≥ 1)' };
        }
                if (!isFinite(finalFactor) || finalFactor < 1) {
            return { error: true, message: 'Facteur de résistance finale invalide (≥ 1)' };
        }

        // ═══════════════════════════════════════════════════════════════
        // BUG-CP-A12 : Correction de l'ordre de validation de anodePot.
        // ------------------------------------------------------------
        // La validation de anodePot est déplacée AVANT la validation du
        // matériau pour garantir un message d'erreur explicite et
        // prioritaire lorsque anodePot est invalide (0 ou NaN).
        //
        // Aucun changement de la formule de dimensionnement.
        // ═══════════════════════════════════════════════════════════════
        if (anodePot === 0 || !isFinite(anodePot)) {
            return {
                error: true,
                message: 'Potentiel anode invalide (valeur = ' + anodePot + ' mV). ' +
                         'Vérifiez la sélection du matériau ou la saisie manuelle dans le formulaire Anodes.'
            };
        }

        // Vérifier que la force électromotrice est suffisante
        if (Math.abs(anodePot) <= Math.abs(targetProtection)) {
            return {
                error: true,
                message: 'Potentiel anode (' + anodePot + ' mV) insuffisant pour ' +
                         'protéger la structure (' + targetProtection + ' mV)'
            };
        }

        // ---- Validation du matériau (après anodePot) ----
        const material = config.ANODE_MATERIALS[materialKey];
        if (!material) {
            return { error: true, message: 'Matériau non reconnu : ' + materialKey };
        }
        if (!isFinite(material.capacity) || material.capacity <= 0) {
            return { error: true, message: 'Capacité du matériau invalide' };
        }

        // ---- Étape 1 : Résistance d'anode ----
        let R_anode;
        if (orientation === 'horizontal') {
            R_anode = anodeResistanceHorizontal(rho, L, d);
        } else {
            R_anode = anodeResistanceVertical(rho, L, d);
        }
        if (!isFinite(R_anode) || R_anode <= 0) {
            return { error: true, message: 'Résistance anodique nulle ou négative (vérifiez les paramètres géométriques)' };
        }

        // ---- Étape 2 : Force électromotrice ----
        const deltaV = Math.abs(anodePot - targetProtection) / 1000;  // mV → V

        // ---- Étape 3 : Courants par anode ----
        const I_initial_per_anode = deltaV / R_anode;
        const R_final = R_anode * finalFactor;
        const I_final_per_anode = deltaV / R_final;
        const I_avg_per_anode = (I_initial_per_anode + I_final_per_anode) / 2;

        // ---- Étape 4 : N par contrainte de courant ----
        // Critère : en fin de vie, les N anodes doivent fournir I_req
        const N_by_current = Math.ceil(I_req / I_final_per_anode);
        const N_current = Math.max(1, N_by_current);

        // ---- Étape 5 : N par contrainte de masse ----
        // Charge totale nécessaire pour la durée de vie (Ah)
        const Ah_total_required = I_req * life * 8760;
        // Masse totale minimale (sans sécurité)
        const mass_total_min = Ah_total_required / (u * material.capacity);
        // Masse totale avec sécurité (P2-01 : appliquer safety sur la masse)
        const mass_total_with_safety = mass_total_min * safety;
        // Nombre d'anodes de masse unitMass pour couvrir cette masse
        const N_by_mass = Math.ceil(mass_total_with_safety / unitMass);
        const N_mass = Math.max(1, N_by_mass);

        // ---- Étape 6 : N final ----
        const count = Math.max(N_current, N_mass);
        const actualTotalMass = count * unitMass;

        // ---- Étape 7 : Durée de vie réelle ----
        // Le système est supposé délivrer I_req en moyenne (SACP autorégulée)
        // Life = m_total × C × u / (I_req × 8760)
        const actualLife = (actualTotalMass * material.capacity * u) / (I_req * 8760);

        // ---- Étape 8 : Vérification capacité courant ----
        const I_initial_total = count * I_initial_per_anode;
        const I_final_total = count * I_final_per_anode;
        const currentOk = I_final_total >= I_req;

        // ---- Étape 9 : Densité de courant (canonique : A/m²) ----
        const surfaceAnode = Math.PI * d * L;
        const J_anode_initial = I_initial_per_anode / surfaceAnode;
        const J_anode_final = I_final_per_anode / surfaceAnode;

        let densityLimit = config.ANODE_DENSITY_LIMITS.default;
        if (materialKey.startsWith('Mg')) densityLimit = config.ANODE_DENSITY_LIMITS.Mg;
        else if (materialKey.startsWith('Zn')) densityLimit = config.ANODE_DENSITY_LIMITS.Zn;
        else if (materialKey.startsWith('Al')) densityLimit = config.ANODE_DENSITY_LIMITS.Al;

        const densityOkInitial = J_anode_initial <= densityLimit;
        const densityOkFinal = J_anode_final <= densityLimit;
        const densityOk = densityOkInitial && densityOkFinal;

        // ---- Diagnostics ----
        const sizingBasis = (N_current > N_mass) ? 'current' : 'mass';
        const massPerAnode = actualTotalMass / count;
        const I_avg_system = count * I_avg_per_anode;

        return {
            // Champs historiques (compatibilité UI existante)
            totalMass: actualTotalMass,
            count: count,
            actualLife: actualLife,
            initialCurrent: I_initial_per_anode,
            finalCurrent: I_final_per_anode,
            currentDensity: J_anode_initial,          // A/m²
            currentDensity_mA: J_anode_initial * 1000, // mA/m²
            currentDensityFinal: J_anode_final,       // A/m²
            currentDensityFinal_mA: J_anode_final * 1000,
            densityLimit: densityLimit,
            densityOk: densityOk,
            densityOkInitial: densityOkInitial,
            densityOkFinal: densityOkFinal,
            capacityAhKg: material.capacity,
            anodePotential: anodePot,
            R_anode: R_anode,
            R_final: R_final,
            material: materialKey,
            I_avg: I_avg_per_anode,
            efficiency: material.efficiency,
            density: material.density,
            orientation: orientation,
            // Champs diagnostics (nouveaux)
            N_by_current: N_current,
            N_by_mass: N_mass,
            sizingBasis: sizingBasis,
            massPerAnode: massPerAnode,
            currentOk: currentOk,
            I_initial_total: I_initial_total,
            I_final_total: I_final_total,
            I_avg_system: I_avg_system,
            deltaV: deltaV,
            // Unités canoniques documentées
            units: {
                current: 'A',
                currentDensity: 'A/m²',
                mass: 'kg',
                length: 'm',
                resistivity: 'Ohm.m',
                potential: 'mV',
                life: 'ans'
            }
        };
    }, 'designAnodesDNV');

    // ============================================================
    // P0-03, P0-04, P1-02 : DIMENSIONNEMENT ICCP CORRIGÉ
    // ============================================================

    /**
     * Purpose: Dimensionnement ICCP avancé
     *
     * Corrections appliquées :
     *  - P0-01 : Traçabilité de la source du courant (iccpCurrentSource)
     *  - P0-02 : Unités canoniques (A/m² pour densité anodique)
     *  - P0-03 : Durée de vie via calculateICCPAnodeLife() (modèle MMO)
     *  - P0-04 : R_groundbed = R_group + R_well          (série)
     *  - P0-04b : Utilisation de R_groundbed_pure, R_well,
     *             _includesCable, _includesStructure
     *             depuis groundbedResult pour éviter le double comptage
     *  - P1-02 : SF appliqué exactement UNE FOIS sur la puissance
     *  - P1-05 : Distinction lifeTheoretical / lifeDesign (cap 25 ans)
     *  - P2-04 : Suppression du facteur arbitraire × 0.8
     *
     * Units: I [A], R [ohm], V [V], rho [ohm.m], L [m]
     * Reference: NACE SP0169 / Dwight / pratique ICCP courante
     */
    function designICCPAdvanced(params) {
        const {
            S, J, rho, N, L, d, spacing, agingFactor,
            cableResistance, structResistance, distanceAnodeStruct, anodeType,
            totalDepth, boreholeDiameter, activeDepth, desiredLife,
            massPerAnode, utilization, designLifeCap,
            groundbedResult,
            I_total
        } = params;
        const manufacturerDataValidated = params.manufacturerDataValidated === true;

        // ═══════════════════════════════════════════════════════════════
        // BUG-CP-A11 : Introduction de I_total_override
        // ------------------------------------------------------------
        // Nouvelle API explicite : params.I_total_override
        // Ancienne API (dépréciée) : params.I_total
        //
        // Priorité : I_total_override > I_total
        // Un warning est émis UNIQUEMENT lorsque l'ancien paramètre est
        // utilisé seul. Aucun changement de formule.
        // ═══════════════════════════════════════════════════════════════
        const I_total_override = (params.I_total_override !== undefined)
            ? params.I_total_override
            : params.I_total;

        if (params.I_total_override === undefined &&
            params.I_total !== undefined &&
            params.I_total !== null) {
            console.warn('[engine.js] param "I_total" déprécié → utiliser "I_total_override"');
        }

        // Back EMF optionnelle (P1-02) — surchargeable
        const backEmfVoltage = (params.backEmfVoltage !== undefined && isFinite(params.backEmfVoltage))
            ? params.backEmfVoltage
            : config.DEFAULT_BACK_EMF_V;

        // P1-02 : Facteur de sécurité puissance (appliqué UNE FOIS)
        const safetyFactorPower = (params.safetyFactorPower !== undefined && isFinite(params.safetyFactorPower))
            ? params.safetyFactorPower
            : config.DEFAULT_SAFETY_FACTOR_POWER;

        // P0-01 : Source du courant (traçabilité)
        const iccpCurrentSource = params.iccpCurrentSource || 'unknown';

        if (!anodeType || config.ICCP_ANODE_LIMITS[anodeType] === undefined) {
            throw new Error('Type d\'anode ICCP inconnu ou non configure.');
        }

        if (![rho, N, L, d, spacing, agingFactor].every(value =>
            Number.isFinite(Number(value)) && Number(value) > 0)) {
            throw new Error('Parametres ICCP invalides: resistivite, nombre, geometrie, espacement et vieillissement doivent etre positifs.');
        }

        // ---- Détermination du courant total ----
        let I_total_circuit = 0;
        if (I_total_override !== undefined &&
            I_total_override !== null &&
            I_total_override > 0) {
            I_total_circuit = I_total_override;
        } else {
            const safeS = S || 0;
            const safeJ = J || 0;
            I_total_circuit = (safeS * safeJ) / 1000;
            if (I_total_circuit <= 0) {
                throw new Error('Impossible de déterminer le courant total: surface ou densité invalide.');
            }
        }

        const safeN = N;
        const I_per_anode = I_total_circuit / safeN;

        if (L <= 0 || d <= 0) throw new Error('Longueur ou diamètre anode invalide');
        if (spacing <= d) throw new Error('L\'espacement entre anodes doit être supérieur au diamètre');

        let R_group_used = 0;
        let R_groundbed_used = 0;
        let R_well_used = 0;
        let groundbedDetails = null;
        let groundbedIncludesCable = false;
        let groundbedIncludesStructure = false;

        // ---- P0-04b : Extraction intelligente depuis groundbedResult ----
        if (groundbedResult) {
            // R_group : résistance pure du groupe d'anodes
            R_group_used = groundbedResult.R_groundbed_pure
                        ?? groundbedResult.R_group
                        ?? 0;

            // R_well : résistance du puits (Dwight sur le forage)
            R_well_used = groundbedResult.R_well ?? 0;

            // Détection des inclusions câble/structure pour éviter le double comptage
            if (typeof groundbedResult._includesCable === 'boolean') {
                groundbedIncludesCable = groundbedResult._includesCable;
            } else {
                groundbedIncludesCable = (groundbedResult.R_cable || 0) > 0;
            }
            if (typeof groundbedResult._includesStructure === 'boolean') {
                groundbedIncludesStructure = groundbedResult._includesStructure;
            } else {
                groundbedIncludesStructure = (groundbedResult.R_struct || 0) > 0;
            }

            // R_groundbed_used = R_group + R_well (P0-04 : série)
            if (typeof groundbedResult.R_total === 'number' && groundbedResult.R_total > 0) {
                R_groundbed_used = groundbedResult.R_total;
            } else {
                R_groundbed_used = R_group_used + R_well_used;
            }

            groundbedDetails = groundbedResult;

            console.log('[ICCP Advanced] Utilisation de groundbedResult :',
                        'R_group =', R_group_used.toFixed(4),
                        'R_well =', R_well_used.toFixed(4),
                        'R_total =', R_groundbed_used.toFixed(4),
                        'includesCable =', groundbedIncludesCable,
                        'includesStructure =', groundbedIncludesStructure);
        } else {
            // ---- Calcul local (aucun groundbedResult fourni) ----
            const gbParams = {
                rho: rho,
                totalDepth: totalDepth || 200,
                activeDepth: activeDepth || (safeN * L),
                anodeCount: safeN,
                anodeLength: L,
                anodeDiameter: d * 1000,  // m → mm (convention designGroundbed)
                anodeWeight: 25,
                anodeCapacity: 2.5,
                cableLength: 0,
                cableSection: 0,
                agingFactor: agingFactor || 1.2,
                safetyFactor: 1.1,
                targetCurrent: I_total_circuit,
                structureResistance: structResistance
            };
            const gbResult = designGroundbed(gbParams);
            R_group_used = gbResult.R_group;
            R_well_used = gbResult.R_well || 0;
            R_groundbed_used = gbResult.R_total;
            groundbedDetails = gbResult;

            groundbedIncludesCable = false;
            groundbedIncludesStructure = (structResistance || 0) > 0;
        }

        // ---- Calcul R_group si non fourni par groundbedResult ----
        const R_single = anodeResistanceVertical(rho, L, d);
        let R_group = R_group_used;
        if (!groundbedResult || R_group_used === 0) {
            R_group = groupResistanceSunde(R_single, safeN, spacing, rho, d);
        }

        // ---- P0-03 : Calcul R_well (Dwight corrigé) ----
        if (!groundbedResult || R_well_used === 0) {
            const boreholeRadius = (boreholeDiameter || 300) / 2000;  // mm → m
            const activeLen = activeDepth || (safeN * L);
            if (activeLen > 0 && boreholeRadius > 0 && rho > 0) {
                const ratio = 4 * activeLen / boreholeRadius;
                if (ratio > 1) {
                    // Formule Dwight correctement parenthésée
                    // R = (ρ / (2πL)) × [ln(4L/r) - 1]
                    R_well_used = (rho / (2 * Math.PI * activeLen)) * (Math.log(ratio) - 1);
                    if (!isFinite(R_well_used) || R_well_used < 0) {
                        console.warn('[ICCP] R_well invalide, fallback à 0');
                        R_well_used = 0;
                    }
                }
            }
            if (!groundbedResult) {
                R_groundbed_used = R_group + R_well_used;
            }
        }

        // ---- P1-02 : Application du vieillissement + back EMF ----
        const aging = agingFactor || 1.2;

        // Résistance de circuit = R_groundbed (pure + well) + câble + structure
        let R_cable_effective = cableResistance || 0;
        let R_struct_effective = structResistance || 0;

        if (groundbedIncludesCable) {
            console.log('[ICCP Advanced] R_cable ignoré (déjà inclus dans groundbedResult)');
            R_cable_effective = 0;
        }
        if (groundbedIncludesStructure) {
            console.log('[ICCP Advanced] R_struct ignoré (déjà inclus dans groundbedResult)');
            R_struct_effective = 0;
        }

        const R_total_circuit = R_groundbed_used + R_cable_effective + R_struct_effective;
        const R_total_final = R_total_circuit * aging;

        // Tension requise pour le courant de conception : point de fonctionnement
        // nominal sans vieillissement artificiel (R_total_circuit, non R_total_final).
        const V_initial = I_total_circuit * R_total_circuit + backEmfVoltage;
        const V_final = I_total_circuit * R_total_final + backEmfVoltage;
        const P_initial = I_total_circuit * V_initial;
        const P_final = I_total_circuit * V_final;

        // P1-02 : puissance de conception = P_initial × SF, UNE SEULE FOIS.
        // Le facteur d'aging n'est pas une nouvelle application du SF ; il sert
        // au calcul de la tension de fin de vie, pas au dimensionnement nominal.
        const P_design = P_initial * safetyFactorPower;

        // ---- Densité de courant anode (canonique : A/m²) ----
        const anodeSurface = Math.PI * d * L;
        const J_anode = I_per_anode / anodeSurface;  // A/m²

        const densityLimit = config.ICCP_ANODE_LIMITS[anodeType];
        const densityOk = J_anode <= densityLimit;

        // ---- P0-03 : Durée de vie ICCP (modèle dédié) ----
        let lifeEstimate = 0;
        let lifeTheoretical = null;
        let lifeDesign = 0;
        let lifeDetails = null;
        const configuredMass = Number(massPerAnode);
        const lifeMassPerAnode = Number.isFinite(configuredMass) && configuredMass > 0
            ? configuredMass
            : 25;

        if (I_total_circuit > 0 && safeN > 0 && I_per_anode > 0) {
            const configuredUtilization = Number(utilization);
            const configuredDesignLifeCap = Number(designLifeCap);
            const lifeUtilization = Number.isFinite(configuredUtilization) &&
                configuredUtilization > 0 && configuredUtilization <= 1
                ? configuredUtilization
                : 0.85;
            const lifeDesignCap = Number.isFinite(configuredDesignLifeCap) && configuredDesignLifeCap > 0
                ? configuredDesignLifeCap
                : undefined;

            lifeDetails = Utils.calculateICCPAnodeLife(
                anodeType,
                lifeMassPerAnode,
                I_per_anode,
                lifeUtilization,
                lifeDesignCap
            );

            if (lifeDetails && !lifeDetails.error) {
                const calculatedLifeTheoretical = lifeDetails.lifeTheoretical;
                lifeTheoretical = manufacturerDataValidated ? calculatedLifeTheoretical : null;
                lifeDesign = lifeDetails.lifeDesign;
                lifeEstimate = lifeDesign;  // alias pour compatibilité ascendante
                console.log('[ICCP Advanced] Durée de vie anode ICCP :',
                            'théorique =', calculatedLifeTheoretical.toFixed(1), 'ans,',
                            'conception =', lifeDesign.toFixed(1), 'ans (cap',
                            lifeDetails.designLifeCap, 'ans)');
            } else {
                console.warn('[ICCP Advanced] Impossible de calculer la durée de vie :',
                             lifeDetails ? lifeDetails.message : 'raison inconnue');
            }
        }

        return {
            // ---- Courants et tensions ----
            currentTotal: I_total_circuit,
            currentPerAnode: I_per_anode,
            voltageInitial: V_initial,
            voltageFinal: V_final,
            powerInitial: P_initial,
            powerFinal: P_final,
            powerDesign: P_design,          // P1-02 : puissance de conception
            safetyFactorPower: safetyFactorPower,

            // ---- Résistances ----
            groupResistanceInitial: R_group,
            groupResistanceFinal: R_group * aging,
            groundbedResistance: R_groundbed_used,
            totalResistance: R_total_circuit,
            totalResistanceFinal: R_total_final,

            // ---- Densité anodique (canonique A/m²) ----
            currentDensityAnode: J_anode,             // A/m²
            currentDensityAnode_mA: J_anode * 1000,   // mA/m²
            densityLimit: densityLimit,
            densityOk: densityOk,

            // ---- Redresseur ----
            rectifierCurrent: I_total_circuit,
            rectifierVoltage: Math.max(V_final, 12),
            rectifierPower: P_design,
            rectifierSelection: designRectifier(I_total_circuit, R_total_circuit, safetyFactorPower, { backEmfVoltage: backEmfVoltage }),

            // ---- Durée de vie ----
            lifeEstimate: lifeEstimate,
            lifeTheoretical: lifeTheoretical,          // P1-05
            lifeDesign: lifeDesign,                    // P1-05
            lifeDetails: lifeDetails,
            lifeValidationStatus: manufacturerDataValidated
                ? 'VALIDATED_WITH_MANUFACTURER_DATA'
                : 'NOT_VALIDATED_MANUFACTURER_DATA_REQUIRED',

            // ---- Détails techniques ----
            R_single: R_single,
            R_well: R_well_used,
            R_groundbed_pure: R_group_used,
            anodeSurface: anodeSurface,
            // FIX-6 (2026-09-26) : utilise la masse par anode configurée/résolue au lieu de 25 kg en dur
            totalMassEstimate: safeN * (typeof lifeMassPerAnode === 'number' && lifeMassPerAnode > 0 ? lifeMassPerAnode : 25),
            N_anodes: safeN,
            groundbedDetails: groundbedDetails,
            backEmfVoltage: backEmfVoltage,

            // ---- P0-01 : Traçabilité de la source ----
            iccpCurrentSource: iccpCurrentSource,

            // ---- P0-04b : Métadonnées pour traçabilité ----
            _includesCable: groundbedIncludesCable,
            _includesStructure: groundbedIncludesStructure,

            // ---- Unités canoniques documentées ----
            units: {
                current: 'A',
                currentDensity: 'A/m²',
                currentDensityAlternate: 'mA/m²',
                resistance: 'Ohm',
                voltage: 'V',
                power: 'W',
                life: 'ans',
                surface: 'm²'
            }
        };
    }

    const designICCP = memoize(function(params) {
        const advancedParams = {
            ...params,
            totalDepth: params.totalDepth || 200,
            boreholeDiameter: params.boreholeDiameter || 300,
            activeDepth: params.activeDepth || (params.N * params.L),
            desiredLife: params.desiredLife || config.DEFAULT_ICCP_DESIGN_LIFE_YEARS
        };
        return designICCPAdvanced(advancedParams);
    }, 'designICCP');

    // ============================================================
    // BUG-CP-004 : Résolution centralisée de la densité anodique limite
    // ------------------------------------------------------------
    // SOURCE UNIQUE DE VÉRITÉ (SSOT) :
    //   - SACP : APP_CONFIG.ANODE_DENSITY_LIMITS (Mg / Zn / Al)
    //   - ICCP : APP_CONFIG.ICCP_ANODE_LIMITS (mmo / sicr / graphite...)
    //
    // Évite tout doublon de référentiel concurrent.
    // ============================================================
    function _resolveAnodeDensityLimit(materialKey, family) {
        if (!materialKey) {
            return config.ANODE_DENSITY_LIMITS.default || 30;
        }

        const key = String(materialKey).toLowerCase();

        // ---- Familles SACP ----
        if (family === 'SACP' || /^(mg|zn|al)/i.test(materialKey)) {
            if (/^mg/i.test(materialKey)) return config.ANODE_DENSITY_LIMITS.Mg;
            if (/^zn/i.test(materialKey)) return config.ANODE_DENSITY_LIMITS.Zn;
            if (/^al/i.test(materialKey)) return config.ANODE_DENSITY_LIMITS.Al;
            return config.ANODE_DENSITY_LIMITS.default;
        }

        // ---- Familles ICCP ----
        const iccpMap = {
            'mmo':                 config.ICCP_ANODE_LIMITS.mmo,
            'sicr':                config.ICCP_ANODE_LIMITS.sicr,
            'graphite':            config.ICCP_ANODE_LIMITS.graphite,
            'platinized':          config.ICCP_ANODE_LIMITS.platinized,
            'platine_niobium':     config.ICCP_ANODE_LIMITS.platine_niobium,
            'platinized_niobium':  config.ICCP_ANODE_LIMITS.platine_niobium,
            'ferrosilicium':       config.ICCP_ANODE_LIMITS.ferrosilicium,
            'tantale':             config.ICCP_ANODE_LIMITS.tantale
        };

        if (iccpMap[key] !== undefined) return iccpMap[key];

        return config.ANODE_DENSITY_LIMITS.default || 30;
    }


    // ============================================================
    // P1-01 : GROUNDBED AVEC R_CABLE CORRIGÉ
    //          + P0-04b : Champs R_well, R_groundbed_pure exposés
    // ============================================================


    /**
     * Purpose: Dimensionnement d'un groundbed (puits anodique)
     *
     * P1-01 : R_cable = 2 × ρ_cu × L / S
     *   Convention : cableLength = longueur ALLER (rectifier → groundbed).
     *   Le facteur 2 représente l'aller-retour (câble positif + câble négatif).
     *   Si l'utilisateur fournit la longueur TOTALE du circuit, mettre
     *   le paramètre `cableLengthIsTotal` à true.
     *
     * P0-04b : Expose les champs suivants pour éviter tout double comptage
     *   dans designICCPAdvanced() :
     *     - R_groundbed_pure : résistance pure du groupe d'anodes (= R_group)
     *     - R_well          : résistance du puits (Dwight sur le forage)
     *     - _includesCable  : true si R_total inclut R_cable
     *     - _includesStructure : true si R_total inclut R_struct
     *
     * P2-01 : Le facteur de sécurité est appliqué à la masse requise,
     *         pas à la durée de vie calculée.
     *
     * P0-04 : LOGS de traçabilité ajoutés (paramètres, R_single, interaction).
     *
     * Units: rho [ohm.m], L [m], S [mm²], R [ohm]
     * Reference: NACE SP0169 / Dwight / Sunde
     */
    const designGroundbed = memoize(function(params) {
        const {
            rho, totalDepth, activeDepth, anodeCount, anodeLength, anodeDiameter,
            anodeWeight, anodeCapacity, cableLength, cableSection,
            agingFactor, safetyFactor, targetCurrent, desiredLife, layers,
            // FIX-6 (2026-09-26) : structureResistance par défaut à 0
            // (et non 0.02 Ω), pour éviter le double comptage dans
            // designICCPAdvanced() qui annule R_struct_effective si
            // _includesStructure=true. La valeur 0.02 Ω est typique mais
            // doit être fournie EXPLICITEMENT par l'appelant.
            structureResistance = 0
        } = params;

        if (![rho, totalDepth, activeDepth, anodeCount, anodeLength,
            anodeDiameter, anodeWeight, anodeCapacity, agingFactor, safetyFactor]
            .every(value => Number.isFinite(Number(value)) && Number(value) > 0)) {
            return {
                error: true,
                message: 'Parametres groundbed invalides: geometrie, masse, capacite, vieillissement et securite doivent etre positifs.'
            };
        }

        // Convention longueur câble
        const cableLengthIsTotal = params.cableLengthIsTotal === true;

        // ---- P0-05 : Résistivité effective (couches) ----
        // NOTE : rho_eff est la résistivité utilisée dans les formules
        //        de résistance. rho est la valeur "projet" (couche
        //        superficielle ou moyenne).
        let rho_eff = rho;
        let layerWarning = null;
        let layerResistivityMethod = 'HOMOGENEOUS_INPUT';
        let normalizedLayers = [];
        let rho_harmonic = null;
        let layerSensitivityRatio = null;
        if (layers && layers.length > 0) {
            normalizedLayers = layers.map((layer) => {
                const layerRho = Number(layer.rho);
                const thickness = (Number.isFinite(Number(layer.topDepth)) &&
                    Number.isFinite(Number(layer.bottomDepth)))
                    ? Number(layer.bottomDepth) - Number(layer.topDepth)
                    : Number(layer.depth);
                if (!Number.isFinite(layerRho) || layerRho <= 0 ||
                    !Number.isFinite(thickness) || thickness <= 0) {
                    return null;
                }
                return { rho: layerRho, depth: thickness };
            });
            if (normalizedLayers.some(layer => layer === null)) {
                return {
                    error: true,
                    message: 'Stratigraphie invalide: chaque couche doit avoir une resistivite > 0 et une epaisseur > 0.'
                };
            }
            const totalLayersDepth = normalizedLayers.reduce((sum, layer) => sum + layer.depth, 0);
            if (totalLayersDepth <= 0) {
                return { error: true, message: 'Profondeur totale des couches invalide.' };
            }
            rho_eff = normalizedLayers.reduce(
                (sum, layer) => sum + layer.rho * (layer.depth / totalLayersDepth), 0
            );
            rho_harmonic = totalLayersDepth / normalizedLayers.reduce(
                (sum, layer) => sum + (layer.depth / layer.rho), 0
            );
            layerSensitivityRatio = rho_eff / rho_harmonic;
            layerResistivityMethod = 'DEPTH_WEIGHTED_ARITHMETIC_APPROXIMATION';
            if (activeDepth > 0 && Math.abs(totalLayersDepth - activeDepth) > 0.01) {
                layerWarning = 'La profondeur des couches ne couvre pas exactement la profondeur active.';
            }
            if (layerSensitivityRatio > 1.25) {
                layerWarning = (layerWarning ? layerWarning + ' ' : '') +
                    'Sensibilite multicouche elevee: une etude numerique de sol est requise.';
            }
        }

        const d_m = anodeDiameter / 1000;

        // ---- P0-04 : Logs de traçabilité (input) ----
        console.log('[Groundbed] Paramètres d\'entrée :',
                    'rho =', rho, 'Ω·m',
                    '| rho_eff =', rho_eff, 'Ω·m',
                    '| N =', anodeCount,
                    '| L =', anodeLength, 'm',
                    '| d =', d_m, 'm',
                    '| activeDepth =', activeDepth, 'm',
                    '| totalDepth =', totalDepth, 'm');

        // ---- Résistance anode unique ----
        const R_single = anodeResistanceVertical(rho_eff, anodeLength, d_m);

        // ---- GAP-06 (Audit 2026-09-19) : Espacement avec minimum physique ----
        // JUSTIFICATION : la formule de Sunde suppose spacing >> d_anode.
        // Si spacing ≤ 2×d_anode, l'interaction mutuelle est sous-estimée.
        // RÉFÉRENCE : Sunde (1968), NACE SP0572.
        // spacing_min = max(2 × d_anode, 0.5 m)
        const spacing_min = Math.max(d_m * 2, 0.5);  // GAP-06
        let spacing = 0;
        let spacingCorrected = false;
        if (anodeCount > 1 && activeDepth > 0) {
            spacing = activeDepth / (anodeCount + 1);
            if (spacing <= 0 || spacing < spacing_min) {
                spacingCorrected = true;
                spacing = spacing_min;
                console.warn(`[Groundbed] GAP-06: Espacement corrigé à ${spacing.toFixed(2)} m` +
                             ` (minimum physique = max(2×d, 0.5m) = ${spacing_min.toFixed(3)} m)`);
            }
        } else if (anodeCount === 1) {
            spacing = 0;
        } else {
            spacing = spacing_min;
            spacingCorrected = true;
            console.warn(`[Groundbed] Espacement par défaut (minimum): ${spacing.toFixed(2)} m`);
        }

        // ---- Résistance de groupe ----
        let R_group = R_single;
        if (anodeCount > 1 && spacing > 0 && spacing > d_m) {
            R_group = groupResistanceSunde(R_single, anodeCount, spacing, rho_eff, d_m);
        } else if (anodeCount > 1) {
            const interactionFactor = 1 + (rho_eff / (2 * Math.PI * d_m * 2)) * Math.log(2);
            R_group = (R_single * interactionFactor) / anodeCount;
            console.warn(`[Groundbed] Fallback interaction: R_group = ${R_group.toFixed(4)} Ω`);
        }

        // ---- P0-04 : Logs de traçabilité (calcul) ----
        const interactionValue = (anodeCount > 1 && spacing > d_m)
            ? 1 + (rho_eff / (2 * Math.PI * spacing)) * Math.log(spacing / d_m)
            : 1;
        console.log('[Groundbed] Calcul résistances :',
                    'R_single =', R_single.toFixed(4), 'Ω',
                    '| spacing =', spacing.toFixed(3), 'm',
                    '| interaction =', interactionValue.toFixed(4),
                    '| R_group =', R_group.toFixed(4), 'Ω');

        // ============================================================
        // P0-04b : Calcul de R_well (résistance du puits anodique)
        // ------------------------------------------------------------
        // MODÈLE RETENU (documenté — exigence audit §12) :
        //   R_groundbed = R_group + R_well  (montage SÉRIE)
        //
        // JUSTIFICATION MÉTIER :
        //   - R_group : résistance mutuelle des anodes (Sunde)
        //   - R_well  : résistance du forage lui-même (Dwight)
        //   - Les deux résistances sont physiquement en SÉRIE dans
        //     le circuit : électrolyte du puits → anodes → sol.
        //
        // RÉFÉRENCE : NACE SP0169 §A.4 / pratique Deep Well
        //
        // Formule de Dwight pour le forage vertical :
        //   R_well = (ρ / (2π × L_active)) × [ln(4 × L_active / r_borehole) - 1]
        // où :
        //   L_active   = activeDepth [m]
        //   r_borehole = boreholeDiameter / 2000 [m]
        // ============================================================
        let R_well = 0;
        const boreholeDiameter = params.boreholeDiameter || 300;  // mm
        const boreholeRadius = boreholeDiameter / 2000;           // mm → m
        const activeLen = activeDepth || (anodeCount * anodeLength);

        if (activeLen > 0 && boreholeRadius > 0 && rho_eff > 0) {
            const ratio = 4 * activeLen / boreholeRadius;
            if (ratio > 1) {
                R_well = (rho_eff / (2 * Math.PI * activeLen)) * (Math.log(ratio) - 1);
                if (!isFinite(R_well) || R_well < 0) {
                    console.warn('[Groundbed] R_well invalide, fallback à 0');
                    R_well = 0;
                }
            }
        }
        console.log('[Groundbed] R_well =', R_well.toFixed(4), 'Ω',
                    '(activeLen =', activeLen, 'm, r_borehole =', boreholeRadius, 'm)');

        // ============================================================
        // P0-04 : R_groundbed_pure = R_group + R_well (série)
        // ============================================================
        const R_groundbed_pure = R_group + R_well;
        console.log('[Groundbed] R_groundbed_pure (R_group + R_well) =',
                    R_groundbed_pure.toFixed(4), 'Ω');

        // ---- P1-01 : Résistance câble avec facteur aller-retour ----
        // BUG-CP-005 : source unique de vérité (APP_CONFIG.CABLE_RESISTIVITY)
        const rho_cu = config.CABLE_RESISTIVITY.cu;
        const cablePathFactor = cableLengthIsTotal ? 1 : 2;
        let R_cable = 0;
        if (isFinite(cableLength) && isFinite(cableSection) && cableLength > 0 && cableSection > 0) {
            R_cable = (cablePathFactor * rho_cu * cableLength) / cableSection;
        }

        const R_struct = Number.isFinite(structureResistance) ? structureResistance : 0.02;

        // ---- R_total = R_groundbed_pure + R_cable + R_struct ----
        const R_total = R_groundbed_pure + R_cable + R_struct;
        console.log('[Groundbed] R_total =', R_total.toFixed(4), 'Ω',
                    '(R_cable =', R_cable.toFixed(4), 'Ω,',
                    'R_struct =', R_struct.toFixed(4), 'Ω)');

        // ---- Courant et tension ----
        let I_total, V_rectifier, P_rectifier;
        if (targetCurrent > 0) {
            I_total = targetCurrent;
            V_rectifier = I_total * R_total;
            P_rectifier = V_rectifier * I_total;
        } else {
            return {
                error: true,
                message: 'Courant cible requis pour dimensionner le groundbed; aucun courant de secours arbitraire n’est utilisé.',
                R_single, R_group, R_well, R_groundbed_pure, R_cable, R_struct, R_total,
                rho, rho_eff, units: { resistance: 'Ohm', resistivity: 'Ohm.m' }
            };
        }

        const anodeSurface = Math.PI * d_m * anodeLength;
        const J_anode = (I_total / anodeCount) / anodeSurface;  // A/m²

        // ============================================================
        // BUG-CP-001 CORRIGÉ : le Safety Factor n'est plus appliqué
        // une seconde fois sur la durée de vie.
        //
        // JUSTIFICATION MÉTIER :
        //   - totalMass = anodeCount × anodeWeight représente la masse
        //     RÉELLEMENT INSTALLÉE.
        //   - Cette masse a déjà été dimensionnée avec le SF dans
        //     designAnodesDNV() (mass_total_with_safety = mass_min × SF).
        //   - Appliquer SF une 2e fois sur la vie revient à sous-estimer
        //     la durée de vie réelle de 10 % à 50 % (SF entre 1.1 et 1.5).
        //
        // RÉFÉRENCE : DNV-RP-B401 §6.6 — le Safety Factor s'applique au
        //             dimensionnement de la masse, pas à la vie calculée.
        // ============================================================
        // GAP-10 (Audit 2026-09-19) : facteur d'utilisation lu depuis la config
        // matériau ICCP (SSOT : APP_CONFIG.ICCP_ANODE_CONSUMPTION).
        // L'ancienne valeur 0.85 était hardcodée, ignorant le matériau sélectionné.
        // Ex. Graphite : u=0.80, MMO : u=0.85, Platine/Nb : u=0.85
        const gbMatKey = (params.anodeMaterial || '').toLowerCase().trim();
        const gbMatConfig = config.ICCP_ANODE_CONSUMPTION[gbMatKey];
        const utilization = (gbMatConfig &&
            typeof gbMatConfig.utilization === 'number' &&
            gbMatConfig.utilization > 0 &&
            gbMatConfig.utilization <= 1)
            ? gbMatConfig.utilization
            : 0.85;  // fallback prudent si matériau inconnu
        if (!gbMatConfig) {
            console.warn('[Groundbed] GAP-10: matériau "' + gbMatKey +
                         '" inconnu dans ICCP_ANODE_CONSUMPTION → utilization = 0.85 (fallback)');
        }
        // ============================================================
        // FIX-3 / HIGH-03 (2026-09-26) : Units clarification
        // ------------------------------------------------------------
        // anodeCapacity ici est en A·yr/kg (ampere-année par kg).
        // Valeur typique pour coke de pétrole en groundbed : 2.5 A·yr/kg.
        //
        // ATTENTION : Dans designAnodesDNV(), material.capacity est en Ah/kg
        //             (ampere-heure par kg). La formule inclut alors un
        //             facteur 8760 h/an pour obtenir des années.
        //
        // Ici : calcLife = (kg × A·yr/kg × -) / A = années [✅ cohérent]
        // ============================================================
        const totalMass = anodeCount * anodeWeight;
        const calcLife = (totalMass * anodeCapacity * utilization) / I_total;
        const lifeWithAging = calcLife / agingFactor;

        // ✅ BUG-CP-001 : SF déjà appliqué sur la masse → pas de
        //                 division supplémentaire sur la vie.
        const lifeWithSafety = lifeWithAging;
        const requiredAnodeCount = (desiredLife > 0 && anodeWeight > 0 && anodeCapacity > 0)
            ? Math.ceil((I_total * desiredLife * agingFactor * safetyFactor) /
                (anodeWeight * anodeCapacity * utilization))
            : null;

        // BUG-CP-001 : métadonnées de traçabilité
        const safetyFactorAppliedOnMass = true;
        const _safetyFactorAppliedOnLife = false;

        // BUG-CP-004 : densité limite résolue par matériau (SSOT)
        const densityLimit = _resolveAnodeDensityLimit(
            params.anodeMaterial || params.material || 'default',
            'SACP'
        );
        const densityOk = J_anode <= densityLimit;
        const requiresSpecialistStudy = normalizedLayers.length > 0 &&
            (layerSensitivityRatio === null || layerSensitivityRatio > 1.25);

        let _warning = layerWarning;
        if (params.anodeCount > 1 && params.activeDepth > 0) {
            const originalSpacing = params.activeDepth / (params.anodeCount + 1);
            if (originalSpacing <= 0 || originalSpacing <= params.anodeDiameter / 1000) {
                _warning = (_warning ? _warning + ' ' : '') +
                    'Espacement corrigé automatiquement car les paramètres étaient invalides.';
            }
        }
        if (requiredAnodeCount !== null && anodeCount < requiredAnodeCount) {
            _warning = (_warning ? _warning + ' ' : '') +
                'Nombre d’anodes insuffisant pour la durée de vie demandée: ' +
                anodeCount + ' installé(s), ' + requiredAnodeCount + ' requis.';
        }

        return {
            // ---- Résistances individuelles ----
            R_single: R_single,
            R_group: R_group,
            R_well: R_well,
            R_groundbed_pure: R_groundbed_pure,
            R_cable: R_cable,
            R_struct: R_struct,
            R_total: R_total,

            // ---- P0-04b : métadonnées de composition ----
            _includesCable: R_cable > 0,
            _includesStructure: R_struct > 0,

            // ---- Courant, tension, puissance ----
            I_total: I_total,
            V_rectifier: V_rectifier,
            P_rectifier: P_rectifier,

            // ---- Densité anodique (canonique A/m²) ----
            J_anode: J_anode,             // A/m²
            J_anode_mA: J_anode * 1000,   // mA/m²
            densityLimit: densityLimit,
            densityOk: densityOk,

             // ---- Durée de vie ----
            calcLife: calcLife,
            lifeWithAging: lifeWithAging,
            lifeWithSafety: lifeWithSafety,

            // FIX-LIFESPAN (2026-09-26 rev2) : Champs de durée de vie NACE conformes
            // lifeDesign      : durée de vie de conception = min(lifeWithAging, desiredLife||25 ans)
            //                   C'est la valeur à afficher dans les rapports et tableaux de bord.
            // lifeTheoretical : durée de vie faradique brute PLAFONNÉE à 50 ans
            //                   (limite physique câbles + soudures + structures, NACE/ISO 15589).
            //                   Valeur brute sans plafond tracée dans lifeWithAging.
            // NOTE : lifeWithSafety est conservé pour compatibilité ascendante.
            //        Ne pas l'afficher directement dans les KPI (valeur brute Faraday).
            //
            // JUSTIFICATION INGÉNIERIE (audit NACE Niv.4) :
            //   La loi de Faraday appliquée au coke de pétrole (2.5 A·yr/kg × 25 kg × N)
            //   peut produire des milliers d'années pour des faibles courants ICCP.
            //   Ces valeurs sont physiquement impossibles : câbles, gaines, soudures
            //   et revêtements ne durent pas plus de 40-50 ans en environnement enfoui
            //   (NACE SP0169 §6, ISO 15589-1 §8.3, DNV-RP-B401 §5).
            //   Le plafond 50 ans est donc un garde-fou d'intégrité physique.
            lifeDesign: Math.min(lifeWithAging, (desiredLife > 0 ? desiredLife : APP_CONFIG.DEFAULT_ICCP_DESIGN_LIFE_YEARS)),
            lifeTheoretical: Math.min(lifeWithAging, 50),  // plafonné à 50 ans (limite physique NACE)

            desiredLife: desiredLife || null,
            requiredAnodeCount: requiredAnodeCount,
            lifeOk: desiredLife > 0 ? lifeWithSafety >= desiredLife : null,

            // BUG-CP-001 : traçabilité du Safety Factor
            safetyFactorAppliedOnMass: safetyFactorAppliedOnMass,
            _safetyFactorAppliedOnLife: _safetyFactorAppliedOnLife,

            // ---- Géométrie et divers ----
            anodeSurface: anodeSurface,
            totalMass: totalMass,
            L_total: anodeCount * anodeLength,
            spacing: spacing,
            layersUsed: layers && layers.length > 0,
            groundbedModel: layers && layers.length > 0
                ? 'LAYERED_DEPTH_WEIGHTED_APPROXIMATION'
                : 'HOMOGENEOUS_DWIGHT_SUNDE',
            layerResistivityMethod: layerResistivityMethod,
            normalizedLayers: normalizedLayers,
            rho_harmonic: rho_harmonic,
            layerSensitivityRatio: layerSensitivityRatio,
            designStatus: normalizedLayers.length > 0 ? 'PRELIMINARY_ONLY' : 'ENGINEERING_CALCULATION',
            requiresSpecialistStudy: requiresSpecialistStudy,
            targetCurrentUsed: targetCurrent > 0,
            totalDepth: totalDepth,
            activeDepth: activeDepth,
            anodeCount: anodeCount,
            anodeLength: anodeLength,
            anodeDiameter: d_m,
            anodeWeight: anodeWeight,
            anodeCapacity: anodeCapacity,
            cablePathFactor: cablePathFactor,
            boreholeDiameter: boreholeDiameter,
            rho: rho,
            rho_eff: rho_eff,            // P0-05
            _warning: _warning,

            // ---- Unités canoniques ----
            units: {
                resistance: 'Ohm',
                resistivity: 'Ohm.m',
                current: 'A',
                currentDensity: 'A/m²',
                voltage: 'V',
                power: 'W',
                mass: 'kg',
                length: 'm',
                life: 'ans'
            }
        };
    }, 'designGroundbed');

    // ============================================================
    // P2-02 : INTERFÉRENCES AC/DC (unités documentées)
    // ============================================================

    /**
     * Purpose: Analyse des interférences AC et DC
     *
     * P2-02 : Documentation explicite des unités.
     *
     * AC :
     *   - acVoltage [kV] (non utilisé directement dans le calcul)
     *   - acCurrent [A]
     *   - acFrequency [Hz]
     *   - acDistance [m]
     *   - acParallel [m]
     *   - acSoilCond [S/m]
     *   - pipeDiameter [mm] → converti en [m]
     *   - pipeRadius [m]
     *   - skinDepth [m]
     *   - effectiveD [m]
     *   - Z [Ω/m]
     *   - acInduced [V] = I_ac[A] × Z[Ω/m] × L[m]
     *
     * DC :
     *   - deltaV [mV]
     *   - R_path [Ω]
     *   - dcStray [A] = deltaV[mV] / R_path[Ω] / 1000
     *
     * Reference: AMPP SP0177 / ISO 18086 / EN 13509
     */
    const analyzeInterference = memoize(function(params) {
        const {
            acVoltage, acCurrent, acFrequency, acDistance, acParallel, acSoilCond,
            pipeDiameter, pipeLength, coatingRes,
            dcCurrent, dcPotON, dcDistance, dcSeparation, dcSoilResistivity,
            victimPotInit, victimPotFinal, J_AC, J_DC
        } = params;

        const hasAcCurrent = acCurrent !== undefined && acCurrent !== null && acCurrent !== '';
        const hasVictimPotentials = victimPotInit !== undefined && victimPotInit !== null && victimPotInit !== '' &&
            victimPotFinal !== undefined && victimPotFinal !== null && victimPotFinal !== '';

        // ============================================================
        // FIX-2 (2026-09-26) : Guard doux sur pipeDiameter
        // ------------------------------------------------------------
        // AVANT : la fonction levait une exception si pipeDiameter est
        //         absent/nul → l'UI pouvait afficher une erreur non gérée
        //         si l'utilisateur n'avait pas encore rempli le diamètre.
        //
        // APRÈS : si pipeDiameter est invalide, la fonction retourne un
        //         objet NOT_ASSESSABLE structuré cohérent avec les autres
        //         champs manquants (acCurrent, victimPotentials).
        //
        // N° de la règle : Fail-soft pour les formulaires incomplets.
        // ============================================================
        if (!isFinite(pipeDiameter) || pipeDiameter <= 0) {
            const notAssessable = {
                acInduced: null,
                touchVoltage: null,
                acStatus: 'NOT ASSESSABLE',
                deltaV: null,
                dcStray: null,
                dcStatus: 'NOT ASSESSABLE',
                globalStatus: 'NOT ASSESSABLE',
                mitigations: ['N/A — Diamètre de conduite requis (pipeDiameter non fourni ou invalide).'],
                R_path: null,
                J_AC: null,
                J_DC: null,
                modelClassification: 'PREFEASIBILITY',
                modelLimitations: ['Diamètre de conduite manquant — calcul impossible'],
                modelReference: 'AMPP SP0177 / ISO 18086',
                units: { acInduced: 'V', touchVoltage: 'V', deltaV: 'mV', dcStray: 'A', R_path: 'Ohm', J_AC: 'A/m²', J_DC: 'A/m²' },
                _guardReason: 'pipeDiameter absent ou invalide (FIX-2)'
            };
            return notAssessable;
        }
        const pipeRadius = pipeDiameter / 2000;  // mm → m

        // ---- AC : profondeur de peau ----
        const mu0 = 4 * Math.PI * 1e-7;  // H/m
        const omega = 2 * Math.PI * (acFrequency || 50);  // rad/s
        const skinDepth = Math.sqrt(2 / (omega * mu0 * (acSoilCond || 0.01)));  // m
        const effectiveD = Math.max(acDistance, skinDepth * 0.5);  // m

        // ---- AC : impédance par unité de longueur ----
        const Z = (omega * mu0 / (2 * Math.PI)) * Math.log(2 * effectiveD / pipeRadius);

        // ---- AC : tension induite ----
        const acInduced = hasAcCurrent ? (acCurrent || 0) * Z * (acParallel || 0) : null;

        // ---- AC : tension de contact ----
        const R_body = 1000;  // Ω
        const R_earth = 10;   // Ω
        const R_total_touch = R_body + R_earth;
        const touchVoltage = acInduced === null ? null : acInduced * (R_body / R_total_touch);

        let acStatus = '';
        if (touchVoltage === null) acStatus = 'NOT ASSESSABLE';
        else if (touchVoltage < 15) acStatus = 'Acceptable';
        else if (touchVoltage < 30) acStatus = 'Surveillance nécessaire';
        else acStatus = 'Action corrective obligatoire';

        // ---- DC : différence de potentiel ----
        const deltaV = hasVictimPotentials ? Math.abs(victimPotInit - victimPotFinal) : null;  // mV

        // ---- DC : résistance de chemin ----
        const R_path = dcPathResistance(dcDistance, dcSoilResistivity || 30, pipeDiameter);

        // ---- DC : courant vagabond ----
        const dcStray = deltaV === null ? null : (deltaV * 1e-3) / (R_path > 0 ? R_path : 1);  // A

        let dcStatus = '';
        if (dcStray === null) dcStatus = 'NOT ASSESSABLE';
        else if (dcStray < 0.01) dcStatus = 'Faible';
        else if (dcStray < 0.1) dcStatus = 'Modéré';
        else dcStatus = 'Élevé';

        let globalStatus = '';
        if (acStatus === 'NOT ASSESSABLE' || dcStatus === 'NOT ASSESSABLE') {
            globalStatus = 'NOT ASSESSABLE';
        } else if (acStatus === 'Action corrective obligatoire' || dcStatus === 'Élevé') {
            globalStatus = '🔴 ACTION OBLIGATOIRE';
        } else if (acStatus === 'Surveillance nécessaire' || dcStatus === 'Modéré') {
            globalStatus = '🟡 SURVEILLANCE NÉCESSAIRE';
        } else {
            globalStatus = '🟢 ACCEPTABLE';
        }

        const mitigations = [];
        if (touchVoltage !== null && touchVoltage > 15) mitigations.push('Zinc ribbon grounding');
        if (touchVoltage !== null && touchVoltage > 25) mitigations.push('Gradient control wire');
        if (dcStray !== null && dcStray > 0.05) mitigations.push('Polarization cell / drainage');
        if (dcStray !== null && dcStray > 0.1) mitigations.push('DC decoupler installation');
        if (acStatus === 'NOT ASSESSABLE' || dcStatus === 'NOT ASSESSABLE') {
            mitigations.push('N/A — DATA REQUIRED pour conclure sur l’interférence.');
        }
        if (mitigations.length === 0) mitigations.push('Aucune mitigation requise - situation acceptable');

        return {
            acInduced: acInduced,
            touchVoltage: touchVoltage,
            acStatus: acStatus,
            deltaV: deltaV,
            dcStray: dcStray,
            dcStatus: dcStatus,
            globalStatus: globalStatus,
            mitigations: mitigations,
            R_path: R_path,
            J_AC: isFinite(J_AC) ? J_AC : null,
            J_DC: isFinite(J_DC) ? J_DC : null,

            // ============================================================
            // BUG-CP-006 : classification explicite du modèle
            // ------------------------------------------------------------
            // Le modèle actuel est une ANALYSE PRÉLIMINAIRE simplifiée.
            // Il ne constitue PAS une modélisation électromagnétique
            // détaillée au sens de AMPP SP0177 / ISO 18086.
            // ============================================================
            modelClassification: 'PREFEASIBILITY',
            modelLimitations: [
                'Modèle analytique simplifié (impédance par unité de longueur)',
                'Sol supposé homogène',
                'Pas de modélisation électromagnétique complète',
                'Pas de prise en compte des régimes transitoires',
                'Facteurs non modélisés : effets de sol multicouches, facteurs de forme pylônes',
                'Étude spécialisée requise pour validation détaillée'
            ],
            modelReference: 'AMPP SP0177 / ISO 18086 / EN 13509 (préliminaire)',

            units: {
                acInduced: 'V',
                touchVoltage: 'V',
                deltaV: 'mV',
                dcStray: 'A',
                R_path: 'Ohm',
                J_AC: 'A/m²',
                J_DC: 'A/m²'
            }
        };
    }, 'analyzeInterference');

    /**
     * Purpose: Résistance de chemin DC entre deux structures enterrées
     */
    const dcPathResistance = memoize(function(distance, rho_soil, diameter) {
        if (distance <= 0 || rho_soil <= 0) return 0.01;
        const r = diameter / 2000;
        if (r <= 0) return 0.01;
        const ratio = 4 * distance / r;
        if (ratio <= 1) return 0.01;
        const R = (rho_soil / (2 * Math.PI * distance)) * Math.log(ratio);
        return isFinite(R) && R > 0 ? R : 0.01;
    }, 'dcPathResistance');

        // ============================================================
    // CORRECTION DE TEMPÉRATURE
    // ------------------------------------------------------------
    // BUG-CP-003 : références de température standardisées à 25 °C
    //              (IEC 60746-1 / ASTM G200 pour Cu/CuSO4).
    //
    // ⚠️  CHANGEMENT DE COMPORTEMENT (documenté) :
    //   AVANT : référence 20 °C → correction = ΔT × coeff
    //   APRÈS : référence 25 °C → correction = ΔT × coeff
    //
    // IMPACT NUMÉRIQUE :
    //   correctPotentialForTemperature(-850, 40, 'CuCuSO4')
    //     Ancien (refTemp=20) : -860.0 mV
    //     Nouveau (refTemp=25) : -857.5 mV   (+2.5 mV)
    //
    // JUSTIFICATION :
    //   - 25 °C est la référence standard industrielle pour les
    //     électrodes Cu/CuSO4 (IEC 60746-1 §6.3).
    //   - La référence à 20 °C était une approximation historique.
    //
    // RÉTRO-COMPATIBILITÉ :
    //   - Si referenceTempC est absent de la config → fallback 20 °C.
    //   - Si la config est un NUMBER (ancienne signature) → refTemp=20.
    //   - Les mesures historiques ne sont PAS recalculées
    //     automatiquement (comportement additif).
    //
    // RÉFÉRENCE : IEC 60746-1:2003 §6.3 / ASTM G200-09
    // ============================================================
    const correctPotentialForTemperature = memoize(function(potentialMv, temperatureCelsius, refElectrode) {
        if (temperatureCelsius === undefined || temperatureCelsius === null) {
            return potentialMv;
        }
        // BUG-CP-003 : la config est désormais un objet {value, ...}
        const configEntry = config.REF_ELECTRODE_TEMP_COEFF[refElectrode];
        let coeff = 0.5;      // fallback prudent
        let refTemp = 20;     // fallback prudent (°C)
        if (configEntry && typeof configEntry === 'object') {
            coeff = configEntry.value;
            refTemp = (configEntry.referenceTempC !== undefined)
                ? configEntry.referenceTempC
                : 20;
        } else if (typeof configEntry === 'number') {
            // Compatibilité ascendante (ancienne signature numérique)
            coeff = configEntry;
        }
        const correction = (temperatureCelsius - refTemp) * coeff;
        return potentialMv - correction;
    }, 'correctTemp');

    // ============================================================
    // SUGGESTION DE NORMES
    // ============================================================
    function suggestStandards(ouvrageType, environment) {
        const base = config.NORMS_DB[ouvrageType] || config.NORMS_DB['autre'];
        let suggested = [...base.suggested];
        const envNorms = config.ENV_NORMS[environment] || [];
        envNorms.forEach(n => { if (!suggested.includes(n)) suggested.push(n); });
        if (ouvrageType === 'pipeline_enterre' || ouvrageType === 'pipeline_offshore') {
            ['NACE SP0177', 'ISO 18086', 'EN 13509'].forEach(n => {
                if (!suggested.includes(n)) suggested.push(n);
            });
        }
        return {
            primary: base.primary,
            suggested: suggested
        };
    }

    // ============================================================
    // PROFILS ENVIRONNEMENTAUX
    // ============================================================
    function generateSoilProfile(resistivity) {
        if (resistivity < 5) return Utils.deepClone(config.SOIL_PROFILES.very_low);
        if (resistivity < 10) return Utils.deepClone(config.SOIL_PROFILES.low);
        if (resistivity < 30) return Utils.deepClone(config.SOIL_PROFILES.medium);
        if (resistivity < 100) return Utils.deepClone(config.SOIL_PROFILES.high);
        if (resistivity < 500) return Utils.deepClone(config.SOIL_PROFILES.very_high);
        return Utils.deepClone(config.SOIL_PROFILES.extreme);
    }

    function generateWaterProfile(environment) {
        return Utils.deepClone(config.WATER_PROFILES[environment] || config.WATER_PROFILES.freshwater);
    }

    // ============================================================
    // CALCULS DE SURFACE
    // ============================================================
    function computeEquipmentSurface(type, dimensions) {
        const rule = config.OUVRAGE_TYPES[type];
        if (!rule) return 0;
        const values = rule.fields.map(f => Utils.safeNumber(dimensions[f] || 0));
        return rule.surfaceFn(...values);
    }

    function getOuvrageFields(type) {
        return config.OUVRAGE_TYPES[type]?.fields || [];
    }

    function getRecommendedCurrentDensity(type, env) {
        const rule = config.OUVRAGE_TYPES[type];
        if (!rule) return 5;
        return typeof rule.defaultCurrentDensity === 'function' ?
            rule.defaultCurrentDensity(env) :
            rule.defaultCurrentDensity;
    }

    function getRecommendedAnodeMaterial(type, env) {
        const rule = config.OUVRAGE_TYPES[type];
        if (!rule) return env === 'seawater' ? 'Al_ZnIn' : 'Mg_HC';
        return rule.defaultAnode || (env === 'seawater' ? 'Al_ZnIn' : 'Mg_HC');
    }

    // ============================================================
    // RÉSISTANCES
    // ============================================================
    const MATERIAL_RESISTIVITY = {
        acier: 1.7e-7,
        cuivre: 1.7e-8,
        aluminium: 2.8e-8,
        acier_inox: 7.0e-7
    };

    const COATING_RESISTIVITY = {
        FBE: 1e12,
        '3LPE': 1e11,
        '3LPP': 1e11,
        Coal_tar: 1e10,
        Bitume: 1e9,
        Polyethylene: 1e10,
        Acier_nu: 0
    };

    const COATING_CONDITION_FACTOR = {
        neuf: 1.0,
        moyen: 0.5,
        degrade: 0.1
    };

    function calculateMetalResistance(material, length, crossSectionArea) {
        if (!isFinite(length) || !isFinite(crossSectionArea)) return 0;
        if (length <= 0 || crossSectionArea <= 0) return 0;
        const rho = MATERIAL_RESISTIVITY[material] || MATERIAL_RESISTIVITY.acier;
        const R = rho * length / crossSectionArea;
        return isFinite(R) ? R : 0;
    }

    function calculateCoatingResistance(coatingType, coatingCondition, surfaceArea, thickness) {
        if (!surfaceArea || surfaceArea <= 0) return 0;
        const rho_coat = COATING_RESISTIVITY[coatingType] || COATING_RESISTIVITY['3LPE'];
        if (rho_coat === 0) return 0;
        const factor = COATING_CONDITION_FACTOR[coatingCondition] || COATING_CONDITION_FACTOR.neuf;
        const defaultThickness = {
            FBE: 0.0004,
            '3LPE': 0.003,
            '3LPP': 0.003,
            Coal_tar: 0.002,
            Bitume: 0.005,
            Polyethylene: 0.002
        };
        const t = thickness || defaultThickness[coatingType] || 0.002;
        if (t <= 0) return 0;
        return (rho_coat * t / surfaceArea) * factor;
    }

    function calculateSoilResistance(rho_soil, geometry, length, diameter, depth, type) {
        if (!rho_soil || rho_soil <= 0) return 0;
        if (!length || length <= 0) return 0;
        if (!diameter || diameter <= 0) return 0;

        if (type === 'pipeline_enterre' || type === 'pipeline_offshore' || geometry === 'pipeline') {
            const r = diameter / 2;
            const h = depth || 1.0;
            const term1 = Math.log(4 * length / r);
            const term2 = Math.log(1 + (2 * h / length));
            return (rho_soil / (2 * Math.PI * length)) * (term1 - term2);
        } else if (type === 'reservoir_fond' || type === 'reservoir_toit' || geometry === 'reservoir') {
            const S = Math.PI * (diameter / 2) * (diameter / 2);
            if (S <= 0) return 0;
            return rho_soil / (4 * Math.sqrt(S / Math.PI));
        } else if (type === 'pieux' || type === 'well_casing' || geometry === 'vertical') {
            const r = diameter / 2;
            return (rho_soil / (2 * Math.PI * length)) * (Math.log(4 * length / r) - 1);
        } else {
            const r = diameter / 2;
            return (rho_soil / (2 * Math.PI * length)) * (Math.log(4 * length / r) - 1);
        }
    }

    /**
     * Purpose: Section transversale d'un tuyau cylindrique
     * Formula: A = π/4 × [D² - (D - 2t)²]
     * Units: D [m], t [m] → A [m²]
     */
    function calculatePipeCrossSection(outerDiameter, wallThickness) {
        if (!outerDiameter || outerDiameter <= 0 || !wallThickness || wallThickness <= 0) return 0;
        const innerDiameter = outerDiameter - 2 * wallThickness;
        if (innerDiameter <= 0) return 0;
        return Math.PI * ((outerDiameter / 2) ** 2 - (innerDiameter / 2) ** 2);
    }

    /**
     * Purpose: Résistances d'un équipement (métal, revêtement, sol)
     *
     * P0-02 : R_total = R_pipe + R_coat + R_soil
     */
    const calculateEquipmentResistances = memoize(function(equipment, soilResistivityOverride) {
        const rawType = equipment.type || 'pipeline_enterre';
        const tankRoof = equipment.roofType || equipment.tankRoof || equipment.toit;
        const type = (rawType === 'tank' || rawType === 'reservoir')
            ? (String(tankRoof || '').toLowerCase().indexOf('flott') !== -1
                ? 'reservoir_toit' : 'reservoir_fond')
            : rawType;
        const material = equipment.material || 'acier';
        const length = Utils.safeNumber(equipment.dimensions?.longueur_m || equipment.length || 0);
        const diameter = Utils.safeNumber(equipment.dimensions?.diametre_m || equipment.diameter || 0);
        const height = Utils.safeNumber(equipment.dimensions?.hauteur_m || equipment.height || 0);
        const wallThickness = Utils.safeNumber(equipment.wallThickness || 0) / 1000;
        const coatingType = equipment.coatingType || '3LPE';
        const coatingCondition = equipment.coatingCondition || 'neuf';
        const coatingThickness = Utils.safeNumber(equipment.coatingThickness || 0) / 1000;
        const soilResistivity = soilResistivityOverride || Utils.safeNumber(equipment.soilResistivity) || 30;

        let surfaceArea = 0;
        let crossSection = 0;

        if (type === 'pipeline_enterre' || type === 'pipeline_offshore') {
            if (diameter > 0 && length > 0) {
                surfaceArea = Math.PI * diameter * length;
                if (wallThickness > 0) {
                    crossSection = calculatePipeCrossSection(diameter, wallThickness);
                } else {
                    crossSection = Math.PI * diameter * 0.01 * 0.01;
                }
            }
        } else if (type === 'reservoir_fond' || type === 'reservoir_toit' || type === 'ballon_souterrain') {
            if (type === 'reservoir_toit' && diameter > 0) {
                surfaceArea = Math.PI * (diameter / 2) ** 2;
            } else if (diameter > 0 && height > 0) {
                surfaceArea = Math.PI * diameter * height + Math.PI * (diameter / 2) ** 2;
            } else if (diameter > 0) {
                surfaceArea = Math.PI * (diameter / 2) ** 2;
            }
            crossSection = diameter * (wallThickness || 0.005);
        } else if (type === 'pieux' || type === 'well_casing' || type === 'fourreau') {
            if (diameter > 0 && height > 0) {
                surfaceArea = Math.PI * diameter * height;
                crossSection = calculatePipeCrossSection(diameter, wallThickness || 0.005);
            }
        } else if (type === 'coque_navire' || type === 'jacket_offshore' || type === 'monopieu') {
            if (type === 'coque_navire') {
                const L = Utils.safeNumber(equipment.dimensions?.longueur_m || 0);
                const l = Utils.safeNumber(equipment.dimensions?.largeur_m || 0);
                const T = Utils.safeNumber(equipment.dimensions?.tirant_eau_m || 0);
                if (L > 0 && l > 0) surfaceArea = 2 * (L * T + l * T) + L * l;
            } else if (type === 'jacket_offshore') {
                const H = Utils.safeNumber(equipment.dimensions?.hauteur_m || 0);
                const P = Utils.safeNumber(equipment.dimensions?.perimetre_moyen_m || 0);
                if (H > 0 && P > 0) surfaceArea = H * P;
            } else if (type === 'monopieu') {
                const d = Utils.safeNumber(equipment.dimensions?.diametre_m || 0);
                const h = Utils.safeNumber(equipment.dimensions?.hauteur_m || 0);
                if (d > 0 && h > 0) surfaceArea = Math.PI * d * h;
            }
            crossSection = surfaceArea * 0.001;
        } else {
            surfaceArea = Utils.safeNumber(equipment.surface) || 0;
            crossSection = surfaceArea * 0.001;
        }

        if (surfaceArea === 0) {
            surfaceArea = computeEquipmentSurface(type, equipment.dimensions || {});
        }

        let R_pipe = 0;
        if (crossSection > 0 && length > 0) {
            R_pipe = calculateMetalResistance(material, length, crossSection);
        }

        let soilContactArea = surfaceArea;
        if (type === 'reservoir_toit' && diameter > 0) {
            soilContactArea = Math.PI * (diameter / 2) ** 2;
        } else if (type === 'reservoir_fond' && diameter > 0) {
            const buriedHeight = Math.min(
                Math.max(0, Utils.safeNumber(
                    equipment.buriedHeight !== undefined
                        ? equipment.buriedHeight
                        : (equipment.dimensions ? equipment.dimensions.hauteur_enterree_m : 0)
                )),
                Math.max(0, height)
            );
            soilContactArea = Math.PI * (diameter / 2) ** 2 + Math.PI * diameter * buriedHeight;
        }

        let R_coat = 0;
        const coatingArea = (type === 'reservoir_fond' || type === 'reservoir_toit')
            ? soilContactArea : surfaceArea;
        if (coatingArea > 0 && coatingType !== 'Acier_nu') {
            R_coat = calculateCoatingResistance(coatingType, coatingCondition, coatingArea, coatingThickness);
        }

        let R_soil = 0;
        if (soilContactArea > 0 && soilResistivity > 0) {
            const equivalentRadius = Math.sqrt(soilContactArea / (4 * Math.PI));
            if (equivalentRadius > 0) {
                R_soil = soilResistivity / (4 * Math.PI * equivalentRadius);
            } else {
                R_soil = 0;
            }
            // ============================================================
            // BUG-CP-002 CORRIGÉ : formule adaptée au pipeline HORIZONTAL
            //
            // AVANT : formule de Dwight VERTICALE appliquée à tort à un
            //         pipeline horizontal enterré.
            // APRÈS  : formule horizontale avec terme de surface libre
            //         ln(L / (2h)).
            //
            // RÉFÉRENCE : NACE SP0169 §6.2 / pratique CP courante
            //
            // FORMULE : R = (ρ / (2πL)) × [ ln(4L/r) − 1 + ln(L/(2h)) ]
            //
            // UNITÉS : ρ [Ω·m], L [m], r [m], h [m] → R_soil [Ω]
            // ============================================================
            if (type === 'pipeline_enterre' || type === 'pipeline_offshore') {
                const r = diameter / 2;
                if (r > 0 && length > 0) {
                    // Profondeur d'enfouissement (m) : champ 'depth' si présent,
                    // sinon fallback documenté à 1.0 m.
                    let depth_m = Utils.safeNumber(
                        equipment.depth !== undefined
                            ? equipment.depth
                            : (equipment.dimensions ? equipment.dimensions.depth_m : undefined),
                        1.0
                    );
                    if (!isFinite(depth_m) || depth_m <= 0) {
                        depth_m = 1.0; // fallback explicite documenté
                    }

                    const term1 = Math.log(4 * length / r);
                    const term2 = Math.log(length / (2 * depth_m));
                    const logSum = term1 - 1 + term2;

                    if (isFinite(logSum) && logSum > 0) {
                        R_soil = (soilResistivity / (2 * Math.PI * length)) * logSum;
                    } else {
                        // Fallback prudent : formule verticale (ancienne)
                        R_soil = (soilResistivity / (2 * Math.PI * length)) * (term1 - 1);
                        console.warn(
                            '[BUG-CP-002] Profondeur invalide → fallback vertical pour',
                            equipment.tag
                        );
                    }
                }
            }
        }

        const R_total = R_pipe + R_coat + R_soil;

        return {
            R_pipe: R_pipe,
            R_coat: R_coat,
            R_soil: R_soil,
            R_total: R_total,
            surfaceArea: surfaceArea,
            soilContactArea: soilContactArea,
            crossSection: crossSection
        };
    }, 'calcEquipResist');

    // ============================================================
    // FONCTIONS D'INTÉGRATION ICCP
    // ============================================================
    function calculateTotalCircuitResistance(anodeResistance, cableResistance, structureResistance, groundbedResistance) {
        let total = 0;
        if (groundbedResistance !== undefined && groundbedResistance !== null && groundbedResistance > 0) {
            total = groundbedResistance + cableResistance + structureResistance;
        } else {
            total = anodeResistance + cableResistance + structureResistance;
        }
        return total;
    }

    /**
     * Purpose: Dimensionnement du redresseur
     * Formula: V = I × R + backEmf
     * Units: I [A], R [Ω], backEmf [V] → V [V]
     *
     * P1-02 : Le facteur de sécurité est appliqué EXACTEMENT UNE FOIS
     *         sur la puissance : P_design = V × I × SF.
     *         (L'ancienne version appliquait SF deux fois :
     *          P = (V × SF) × (I × SF) = V × I × SF²)
     */
    // ============================================================
    // GAP-RECT-01 (Audit 2026-09-19) : Paliers normalisés redresseur
    // ------------------------------------------------------------
    // IEC 60146-1 / EN 50178 : les redresseurs industriels CP sont
    // disponibles en paliers de tension et courant standardisés.
    // La sélection doit choisir le palier immédiatement SUPÉRIEUR
    // aux besoins calculés pour garantir la marge de régulation.
    //
    // Paliers tension typiques (V DC) : 12, 24, 36, 48, 60, 72, 96
    // Paliers courant typiques (A DC) : 10, 15, 20, 30, 50, 75, 100,
    //                                   150, 200, 300, 500, 750, 1000
    // ============================================================
    const TR_VOLTAGE_STEPS = [12, 24, 36, 48, 60, 72, 96, 120, 150, 200];
    const TR_CURRENT_STEPS = [5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000];

    /**
     * Sélectionne le palier normalisé immédiatement supérieur.
     * @param {number} required - Valeur calculée requise
     * @param {number[]} steps  - Paliers disponibles (triés ASC)
     * @returns {number} Palier sélectionné (ou required × 1.25 si hors table)
     */
    function _selectNormalizedStep(required, steps) {
        for (let i = 0; i < steps.length; i++) {
            if (steps[i] >= required) return steps[i];
        }
        // Hors table : extrapolation avec marge de 25%
        return Math.ceil(required * 1.25);
    }

    function designRectifier(current, totalResistance, safetyMargin, options) {
        const opts = options || {};
        safetyMargin = safetyMargin || 1.1;
        const backEmf = (opts.backEmfVoltage !== undefined && isFinite(opts.backEmfVoltage))
            ? opts.backEmfVoltage
            : config.DEFAULT_BACK_EMF_V;

        // GAP-04 (Audit 2026-09-19) : Rendement rectifier
        // La puissance DC ≠ puissance AC absorbée au réseau.
        // P_AC = P_DC / η_rectifier
        // Valeur typique industrielle : η = 0.85 (IEC 60146).
        // Surchargeable via opts.rectifierEfficiency
        const rectifierEfficiency = (opts.rectifierEfficiency !== undefined &&
            isFinite(opts.rectifierEfficiency) &&
            opts.rectifierEfficiency > 0 &&
            opts.rectifierEfficiency <= 1)
            ? opts.rectifierEfficiency
            : 0.85;  // IEC 60146 — rendement typique

        if (current <= 0 || totalResistance <= 0) {
            return {
                current: 0,
                voltage: 0,
                power: 0,
                recommendedVoltage: 0,
                recommendedCurrent: 0,
                recommendedPower: 0,
                P_AC_required: 0,
                rectifierEfficiency: rectifierEfficiency,
                safetyMargin: safetyMargin,
                backEmfVoltage: backEmf,
                nominalVoltage: 0,
                nominalCurrent: 0,
                nominalPower: 0,
                trSelectionBasis: 'INVALID_INPUT',
                error: 'Courant ou résistance invalide'
            };
        }

        // Tension nominale (sans SF)
        const voltage = current * totalResistance + backEmf;
        // Puissance nominale (sans SF)
        const power = voltage * current;

        const recommendedVoltage = voltage;
        const recommendedCurrent = current;

        // P1-02 : Puissance de conception = P × SF (UNE SEULE FOIS)
        const recommendedPower = power * safetyMargin;

        // GAP-04 : Puissance AC requise au réseau (pour dimensionnement transformateur)
        const P_AC_required = recommendedPower / rectifierEfficiency;

        // GAP-RECT-01 : Sélection par paliers normalisés IEC 60146
        // Le palier nominal DOIT être ≥ à la valeur calculée avec SF.
        const nominalVoltage = _selectNormalizedStep(voltage * safetyMargin, TR_VOLTAGE_STEPS);
        const nominalCurrent = _selectNormalizedStep(current * safetyMargin, TR_CURRENT_STEPS);
        const nominalPower   = nominalVoltage * nominalCurrent;

        // Statut de sélection
        const voltageInTable = TR_VOLTAGE_STEPS.indexOf(nominalVoltage) !== -1;
        const currentInTable = TR_CURRENT_STEPS.indexOf(nominalCurrent) !== -1;
        let trSelectionBasis = 'IEC_60146_NORMALIZED_STEPS';
        if (!voltageInTable || !currentInTable) {
            trSelectionBasis = 'EXTRAPOLATED_BEYOND_TABLE — Contacter fabricant pour devis sur mesure';
        }

        return {
            current: current,
            voltage: voltage,
            power: power,
            recommendedVoltage: recommendedVoltage,
            recommendedCurrent: recommendedCurrent,
            recommendedPower: recommendedPower,
            powerDesign: recommendedPower,            // P1-02
            rectifierEfficiency: rectifierEfficiency, // GAP-04
            P_AC_required: P_AC_required,             // GAP-04 : pour dimensionnement transformateur
            safetyMargin: safetyMargin,
            backEmfVoltage: backEmf,
            // GAP-RECT-01 : Paliers normalisés TR
            nominalVoltage: nominalVoltage,
            nominalCurrent: nominalCurrent,
            nominalPower:   nominalPower,
            trSelectionBasis: trSelectionBasis,
            voltageInTable: voltageInTable,
            currentInTable: currentInTable,
            units: {
                voltage: 'V',
                current: 'A',
                power: 'W',
                P_AC_required: 'W (puissance réseau pour dimensionnement transformateur)',
                resistance: 'Ohm'
            }
        };
    }

    /**
     * Validation des critères de protection cathodique
     *
     * GAP-05 (Audit 2026-09-19) : Ajout du critère de surprotection
     *   V_on > -1200 mV → fragilisation par hydrogène (aciers X70/X80)
     *                      délaminage revêtements FBE/3LPE
     *
     * Critères complets (ISO 15589-1 §6.1, NACE SP0169 §6.2) :
     *   [1] Sous-protection : V_off > -850 mV → FAIL
     *   [2] Polarisation    : < 100 mV       → FAIL
     *   [3] Surprotection   : V_on < -1200 mV → WARNING (non bloquant par défaut,
     *                         mais exposé dans le résultat pour décision ingénieur)
     *
     * @param {number} offPotential  Potentiel OFF [mV vs Cu/CuSO₄]
     * @param {number} polarization  Polarisation [mV]
     * @param {number} [onPotential] Potentiel ON [mV vs Cu/CuSO₄] (optionnel)
     */
    function validateProtectionCriteria(offPotential, polarization, onPotential) {
        let result = {
            offPotentialPass: false,
            polarizationPass: false,
            overProtectionPass: true,    // GAP-05 : null = non évalué
            globalPass: false,
            status: 'FAIL ❌',
            offPotentialMessage: '',
            polarizationMessage: '',
            overProtectionMessage: '',   // GAP-05
            combinedMessage: ''
        };

        // Critère 1 : Sous-protection
        if (offPotential !== undefined && offPotential !== null) {
            result.offPotentialPass = (offPotential <= -850);
            result.offPotentialMessage = `Potentiel OFF ${offPotential} mV ${result.offPotentialPass ? '≤ -850 ✅' : '> -850 ❌'}`;
        } else {
            result.offPotentialMessage = 'Potentiel OFF non fourni';
        }

        // Critère 2 : Polarisation
        if (polarization !== undefined && polarization !== null) {
            result.polarizationPass = (polarization >= 100);
            result.polarizationMessage = `Polarisation ${polarization} mV ${result.polarizationPass ? '≥ 100 ✅' : '< 100 ❌'}`;
        } else {
            result.polarizationMessage = 'Polarisation non fournie';
        }

        // GAP-05 : Critère 3 — Surprotection (V_on ≤ -1200 mV)
        // ISO 15589-1 §6.1 / NACE SP0169 §6.2.2
        // Ce critère est un WARNING : il n'est pas bloquant par défaut
        // mais DOIT être signalé à l'ingénieur pour décision.
        if (onPotential !== undefined && onPotential !== null) {
            result.overProtectionPass = (onPotential >= -1200);
            if (result.overProtectionPass) {
                result.overProtectionMessage =
                    `Potentiel ON ${onPotential} mV ≥ -1200 ✅ (pas de surprotection)`;
            } else {
                result.overProtectionMessage =
                    `⚠️ SURPROTECTION : Potentiel ON ${onPotential} mV < -1200 mV — ` +
                    `Risque fragilisation H₂ (aciers HRS) et délaminage revêtement FBE/3LPE ` +
                    `(ISO 15589-1 §6.1 / NACE SP0169 §6.2.2) — Action correctrice requise`;
            }
        } else {
            result.overProtectionMessage =
                'Potentiel ON non fourni (critère surprotection non évalué — fournir V_on pour validation complète)';
        }

        // Globalisation
        const hasOff  = offPotential !== undefined && offPotential !== null;
        const hasPol  = polarization !== undefined && polarization !== null;

        if (hasOff && hasPol) {
            // La surprotection est exposée mais n'est pas bloquante dans ce critère global
            // (décision laissée à l'ingénieur : certains standards admettent jusqu'à -1250 mV
            // pour aciers non sensibles à H₂)
            result.globalPass = result.offPotentialPass && result.polarizationPass;
            const overInfo = (onPotential !== undefined && onPotential !== null && !result.overProtectionPass)
                ? ' ⚠️ SURPROTECTION DÉTECTÉE'
                : '';
            result.combinedMessage = `Critères CP combinés : ${result.globalPass ? 'PASS ✅' : 'FAIL ❌'}${overInfo}`;
        } else if (hasOff) {
            result.globalPass = false;
            result.combinedMessage = 'Validation globale impossible : polarisation non fournie';
        } else if (hasPol) {
            result.globalPass = false;
            result.combinedMessage = 'Validation globale impossible : potentiel OFF non fourni';
        } else {
            result.globalPass = false;
            result.combinedMessage = 'Aucun critère fourni';
        }

        result.status = result.globalPass ? 'PASS ✅' : 'FAIL ❌';
        return result;
    }

    function checkCPParameters(S, J, eps, DF, k) {
        const warnings = [];
        if (![S, J, eps, DF, k].every(value => Number.isFinite(Number(value)))) {
            warnings.push('Les paramètres CP doivent être numériques.');
            return { valid: false, warnings };
        }
        if (S <= 0) warnings.push('La surface protégée doit être strictement positive.');
        if (J <= 0) warnings.push('La densité de courant doit être strictement positive.');
        if (DF < 0 || DF > 1) warnings.push('La densité de défauts doit être comprise entre 0 et 1.');
        if (k <= 0) warnings.push('Le facteur de vieillissement doit être strictement positif.');
        if (DF * k > 1) {
            warnings.push('Le produit DF × k dépasse 1, la surface exposée serait supérieure à la surface totale.');
        }
        if (J < 0.1 || J > 500) {
            warnings.push('La densité de courant (J) est en dehors des plages recommandées (0.1–500 mA/m²).');
        }
        if (eps < 0 || eps > 1) {
            warnings.push('L’efficacité de revêtement doit être comprise entre 0 et 1.');
        }
        return { valid: warnings.length === 0, warnings };
    }

    // ============================================================
    // BUG-CP-007 : Profil de potentiel le long d'un pipeline
    // ------------------------------------------------------------
    // Modèle ANALYTIQUE 1D (Sunde) — ADDITIF.
    //
    // ⚠️  Ne modifie AUCUN calcul existant.
    // ⚠️  Non substituable à des mesures terrain.
    //     À valider par relevés ON/OFF in situ.
    //
    // @param {Object} pipeline - { coordinates, dimensions, tag }
    // @param {Object} params   - { I0, alpha, E_protection }
    // @returns {Object} { points, min, max, criticalPoint, modelClassification, ... }
    // ============================================================
    function computePotentialProfile(pipeline, params) {
        const opts = params || {};
        const I0 = Utils.safeNumber(opts.I0, 0);
        const alpha = Utils.safeNumber(opts.alpha, 0);
        const E_prot = Utils.safeNumber(opts.E_protection, -850);

        const modelClass = 'POTENTIAL_PROFILE_ESTIMATION';
        const modelLimitations = [
            'Modèle analytique 1D (atténuation exponentielle de Sunde)',
            'Sol supposé homogène',
            'Non substituable à des mesures terrain',
            'Estimation — à valider par relevés ON/OFF in situ'
        ];

        if (!pipeline || !Array.isArray(pipeline.coordinates) ||
            pipeline.coordinates.length < 2 || I0 <= 0 || alpha <= 0) {
            return {
                points: [],
                min: 0, max: 0,
                criticalPoint: null,
                modelClassification: modelClass,
                modelLimitations: modelLimitations,
                error: 'Paramètres insuffisants'
            };
        }

        const coords = pipeline.coordinates;
        let totalLen = 0;
        if (typeof CoordSystem !== 'undefined' &&
            typeof CoordSystem.pipelineLength === 'function') {
            totalLen = CoordSystem.pipelineLength(coords);
        }
        if (!isFinite(totalLen) || totalLen <= 0) {
            return {
                points: [],
                min: 0, max: 0,
                criticalPoint: null,
                modelClassification: modelClass,
                modelLimitations: modelLimitations,
                error: 'Longueur pipeline nulle ou invalide'
            };
        }

        const points = [];
        let minV = Infinity, maxV = -Infinity, crit = null;
        const N = Math.min(200, Math.max(20, coords.length * 5));

        for (let i = 0; i <= N; i++) {
            const frac = i / N;
            const x = frac * totalLen;
            // Atténuation exponentielle (Sunde)
            const I_x = I0 * Math.exp(-alpha * x);
            // Potentiel ON estimé (chute ohmique locale)
            const V_x = E_prot + (I_x / Math.max(I0, 1e-9)) * 100;

            points.push({ x: x, potential: V_x, current: I_x });

            if (V_x < minV) {
                minV = V_x;
                crit = { x: x, potential: V_x, type: 'minimum' };
            }
            if (V_x > maxV) maxV = V_x;
        }

        return {
            points: points,
            min: minV,
            max: maxV,
            criticalPoint: crit,
            modelClassification: modelClass,
            modelLimitations: modelLimitations,
            unit: 'mV vs Cu/CuSO4',
            alpha: alpha,
            I0: I0,
            totalLength_m: totalLen
        };
    }

    // ============================================================
    // BUG-CP-A06 : Modèle Peabody (régime fini) — ADDITIF.
    // ------------------------------------------------------------
    // Modèle d'atténuation en régime fini le long d'un pipeline :
    //
    //   I(L) ≈ I0 / cosh(λ · L)
    //
    // où :
    //   I0  : courant injecté au point d'alimentation (A)
    //   λ   : constante d'atténuation linéique (1/m)
    //         λ = sqrt(R_lin / R_fuite)
    //   L   : longueur totale du pipeline (m)
    //   cosh : cosinus hyperbolique
    //
    // Le potentiel ON est estimé localement par :
    //   V(x) = E_protection + (I(x) / I0) · IR_max
    //
    // Unités :
    //   λ     [1/m]     (R_lin [Ω/m], R_fuite [Ω·m])
    //   L     [m]
    //   I0    [A]
    //   V     [mV vs Cu/CuSO₄]
    //
    // ATTENTION : cette fonction ne remplace PAS computePotentialProfile().
    //             Elle est destinée aux pipelines longs où le régime fini
    //             (effet des extrémités) est significatif.
    //
    // RÉFÉRENCE : Peabody, "Control of Pipeline Corrosion",
    //             2nd edition, NACE International, §5.3.
    // ============================================================
    function computePotentialProfilePeabody(pipeline, params) {
        const opts = params || {};
        const I0 = Utils.safeNumber(opts.I0, 0);
        const lambda = Utils.safeNumber(opts.lambda, 0);      // λ [1/m]
        const E_prot = Utils.safeNumber(opts.E_protection, -850);

        // IR_max optionnel (mV) — chute ohmique maximale admissible
        const IR_max = Utils.safeNumber(opts.IR_max, 100);

        const modelClass = 'POTENTIAL_PROFILE_PEABODY';
        const modelLimitations = [
            'Modèle analytique 1D en régime fini (Peabody)',
            'Sol supposé homogène et constant le long du tracé',
            'Pipeline supposé uniforme (diamètre, revêtement, épaisseur)',
            'Non substituable à des mesures terrain',
            'Estimation — à valider par relevés ON/OFF in situ'
        ];

        // ---- Validation des entrées ----
        if (!pipeline ||
            !Array.isArray(pipeline.coordinates) ||
            pipeline.coordinates.length < 2 ||
            I0 <= 0 ||
            lambda <= 0) {
            return {
                points: [],
                min: 0, max: 0,
                criticalPoint: null,
                modelClassification: modelClass,
                modelLimitations: modelLimitations,
                error: 'Paramètres insuffisants (I0 > 0 et λ > 0 requis)'
            };
        }

        // ---- Longueur totale du pipeline ----
        const coords = pipeline.coordinates;
        let totalLen = 0;
        if (typeof CoordSystem !== 'undefined' &&
            typeof CoordSystem.pipelineLength === 'function') {
            totalLen = CoordSystem.pipelineLength(coords);
        }
        if (!isFinite(totalLen) || totalLen <= 0) {
            return {
                points: [],
                min: 0, max: 0,
                criticalPoint: null,
                modelClassification: modelClass,
                modelLimitations: modelLimitations,
                error: 'Longueur pipeline nulle ou invalide'
            };
        }

        // ---- Pré-calcul du dénominateur : cosh(λ · L) ----
        // Attention aux débordements numériques : cosh(x) ~ e^x / 2
        // pour x grand. On borne λ·L à 700 (limite de e^700).
        const lambdaL = Math.min(lambda * totalLen, 700);
        const coshLambdaL = Math.cosh(lambdaL);

        // ---- Sécurité numérique : cosh ≥ 1 toujours ----
        const safeCosh = (isFinite(coshLambdaL) && coshLambdaL >= 1)
            ? coshLambdaL
            : 1;

        // ---- Courant à l'extrémité (régime fini) ----
        // I(L) ≈ I0 / cosh(λ · L)
        const I_L = I0 / safeCosh;

        // ---- Balayage le long du pipeline ----
        const points = [];
        let minV = Infinity, maxV = -Infinity, crit = null;
        const N = Math.min(200, Math.max(20, coords.length * 5));

        for (let i = 0; i <= N; i++) {
            const frac = i / N;
            const x = frac * totalLen;                     // position [m]

            // Profil complet en régime fini :
            //   I(x) = I0 · cosh(λ · (L - x)) / cosh(λ · L)
            const lambdaLmx = Math.min(lambda * (totalLen - x), 700);
            const coshLmx = Math.cosh(lambdaLmx);
            const I_x = I0 * (isFinite(coshLmx) ? coshLmx : 1) / safeCosh;

            // Potentiel ON estimé (chute ohmique locale)
            const ratio = (I0 > 0) ? (I_x / I0) : 0;
            const V_x = E_prot + ratio * IR_max;

            points.push({
                x: x,
                potential: V_x,
                current: I_x
            });

            if (V_x < minV) {
                minV = V_x;
                crit = { x: x, potential: V_x, current: I_x, type: 'minimum' };
            }
            if (V_x > maxV) maxV = V_x;
        }

        return {
            points: points,
            min: minV,
            max: maxV,
            criticalPoint: crit,
            modelClassification: modelClass,
            modelLimitations: modelLimitations,
            unit: 'mV vs Cu/CuSO4',
            lambda: lambda,
            I0: I0,
            I_L: I_L,                          // courant à l'extrémité
            coshLambdaL: coshLambdaL,          // cosh(λ·L)
            totalLength_m: totalLen,
            IR_max: IR_max,
            reference: 'Peabody, Control of Pipeline Corrosion, 2nd ed., §5.3'
        };
    }
    // ============================================================
    // EXPOSITIONS PUBLIQUES
    // ============================================================
    return {
        anodeResistanceVertical,
        anodeResistanceHorizontal,
        groupResistanceSunde,
        requiredCurrent,
        requiredCurrentDNV,              // GAP-01 : courant DNV 3 phases
        designAnodesDNV,
        designICCP,
        designICCPAdvanced,
        designGroundbed,
        analyzeInterference,
        dcPathResistance,
        correctPotentialForTemperature,
        suggestStandards,
        generateSoilProfile,
        generateWaterProfile,
        computeEquipmentSurface,
        getOuvrageFields,
        getRecommendedCurrentDensity,
        getRecommendedAnodeMaterial,
        calculateMetalResistance,
        calculateCoatingResistance,
        calculateSoilResistance,
        calculatePipeCrossSection,
        calculateEquipmentResistances,
        calculateTotalCircuitResistance,
        designRectifier,
        validateProtectionCriteria,
        checkCPParameters,
        computePotentialProfile,              // BUG-CP-007 : profil de potentiel (exponentiel)
        computePotentialProfilePeabody,       // BUG-CP-A06 : profil de potentiel (Peabody, régime fini)
        calculateCoatingDegradationFactor,    // GAP-COAT-02 : facteur dégradation revêtement
        calculateLayeredSoilResistivity,      // GAP-RESIST-01 : résistivité sol multicouche
        _resolveAnodeDensityLimit: _resolveAnodeDensityLimit,  // BUG-CP-004 : debug
        TR_VOLTAGE_STEPS: TR_VOLTAGE_STEPS,   // GAP-RECT-01 : paliers TR tension
        TR_CURRENT_STEPS: TR_CURRENT_STEPS,   // GAP-RECT-01 : paliers TR courant
        ANODE_MATERIALS: config.ANODE_MATERIALS,
        OUVRAGE_TYPES: config.OUVRAGE_TYPES,
        ENV_DEFAULTS: config.ENV_DEFAULTS,
        REF_ELECTRODE_TEMP_COEFF: config.REF_ELECTRODE_TEMP_COEFF,
        ICCP_ANODE_CONSUMPTION: config.ICCP_ANODE_CONSUMPTION,
        UnitConverter: UnitConverter,
        // Diagnostics utiles aux modules appelants
        normalizeSACPResult,
        normalizeGroundbedResult,
        _clearMemoCache: function() { _memoCache.clear(); },
        _getMemoCacheSize: function() { return _memoCache.size; }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CalculationEngine;
}

// ============================================================
// FIN DE engine.js (VERSION 8.6 – GAP-COAT/RESIST/RECT APPLIQUÉS)
// ============================================================