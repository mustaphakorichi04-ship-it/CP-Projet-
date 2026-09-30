// ============================================================
// cp-worker.js
// Worker pour les calculs CP – Exécute le moteur de calcul en arrière-plan
// Version 8.6 – AUDIT FIX-1/FIX-4/FIX-9 (2026-09-26)
// ============================================================
// CORRECTIONS v8.6 (2026-09-26) :
//   FIX-1 : checkCPParameters déplacé AVANT requiredCurrent (HIGH-01)
//            → empêche tout calcul avec des paramètres invalides
//   FIX-4 : RHO_CU défini APRÈS importScripts (MEDIUM-01)
//            → APP_CONFIG.CABLE_RESISTIVITY.cu est désormais réellement lu
//   FIX-9 : WORKER_VERSION alignée sur engine.js 8.6.0
//
// CORRECTIONS PROPAGÉES DEPUIS engine.js v8.5 :
//   P0-02 : Unités canoniques (A/m² pour densité anodique)
//           → le worker relaie J_anode_mA, currentDensity_mA, units
//   P0-03 : Durée de vie ICCP (calculateICCPAnodeLife)
//           → le worker relaie lifeTheoretical, lifeDesign, lifeDetails
//   P0-04 : Traçabilité R_group
//           → le worker relaie R_groundbed_pure, R_well, rho_eff
//   P1-01 : Cohérence R_cable (facteur 2 aller-retour) pour le case 'cp'
//   P1-02 : Facteur de sécurité puissance (UNE SEULE FOIS)
//           → le worker relaie powerDesign, safetyFactorPower
//   P1-05 : Distinction lifeTheoretical / lifeDesign (cap 25 ans)
//
// Le worker ne réimplémente AUCUNE formule métier : il délègue à
// CalculationEngine (engine.js). Il conserve uniquement la logique
// locale du case 'cp' (R_cable) qui doit rester cohérente avec
// cp-controller.js v8.9.
//
// Dépend de : engine.js (chargé via importScripts)
// ============================================================

// ============================================================
// CONSTANTES
// ============================================================
// NOTE : Le worker ne peut pas accéder à APP_CONFIG (pas de window).
// La version applicative est fournie par le thread principal via
// event.data.appVersion (voir handler onmessage ci-dessous).
// FIX-9 (2026-09-26) : version alignée sur engine.js 8.6.0
const WORKER_VERSION = '8.6.0';  // aligné avec engine.js (module version)

// ============================================================
// OPTIM : Cache des résultats pour éviter les recalculs redondants
// ============================================================
const resultCache = new Map();
const MAX_CACHE_SIZE = 100;

/**
 * Génère une clé de cache à partir du type et des paramètres.
 * @param {string} type - Type de calcul ('cp', 'anodes', 'iccp', 'groundbed', 'interference')
 * @param {Object} params - Paramètres du calcul
 * @returns {string} Clé de cache
 */
function getCacheKey(type, params) {
    try {
        return type + '_' + JSON.stringify(params);
    } catch (e) {
        // En cas d'échec de sérialisation (objets circulaires),
        // on utilise une clé alternative unique (pas de cache hit possible)
        return type + '_' + Date.now() + '_' + Math.random();
    }
}

/**
 * Nettoie le cache (éviter une croissance infinie).
 * Supprime la moitié des entrées les plus anciennes.
 */
function pruneCache() {
    if (resultCache.size > MAX_CACHE_SIZE) {
        const keys = Array.from(resultCache.keys());
        const toDelete = keys.slice(0, Math.floor(keys.length / 2));
        toDelete.forEach(key => resultCache.delete(key));
    }
}

// ============================================================
// Importe le moteur de calcul (doit être dans le même dossier)
// ============================================================
try {
    if (typeof CalculationEngine === 'undefined') {
        importScripts('engine.js');
        if (typeof CalculationEngine === 'undefined') {
            throw new Error('CalculationEngine non défini après importScripts');
        }
    }
    console.log('[Worker] Moteur de calcul chargé avec succès (engine.js v8.6)');
} catch (error) {
    console.error('[Worker] Erreur lors du chargement de engine.js:', error);
    self.postMessage({
        id: 'error',
        error: 'Impossible de charger le moteur de calcul: ' + error.message
    });
    // Le worker restera inactif mais ne se ferme pas pour permettre une reprise
}

// ============================================================
// FIX-4 (2026-09-26) : RHO_CU défini APRÈS importScripts
// ------------------------------------------------------------
// AVANT : RHO_CU était défini avant importScripts → APP_CONFIG
//         n'existait pas encore → le fallback 0.0175 était TOUJOURS
//         utilisé, jamais APP_CONFIG.CABLE_RESISTIVITY.cu (SSOT cassée).
// APRÈS : RHO_CU est défini ici, après importScripts → APP_CONFIG
//         est maintenant disponible et lu en priorité.
// VALEUR : 0.0175 Ω·mm²/m (résistivité cuivre à 20°C, IEC 60228)
// ============================================================
const RHO_CU = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.CABLE_RESISTIVITY)
    ? APP_CONFIG.CABLE_RESISTIVITY.cu
    : 0.0175;

// ============================================================
// Gestionnaire de messages
// ============================================================
self.onmessage = function(event) {
    const { id, type, params, appVersion } = event.data;

    // Stocker la version applicative pour diagnostic
    if (appVersion && typeof appVersion === 'string') {
        self._appVersion = appVersion;
    }

    // Vérification de base
    if (!id) {
        self.postMessage({
            id: 'error',
            error: 'Message sans ID'
        });
        return;
    }

    // --------------------------------------------------------
    // P1-15 : Gestion de l'invalidation du cache
    // --------------------------------------------------------
    if (type === 'clearCache') {
        resultCache.clear();
        console.log('[Worker] Cache vidé');
        self.postMessage({ id, result: 'cacheCleared' });
        return;
    }

    // --------------------------------------------------------
    // Gestion du ping pour vérifier la disponibilité
    // --------------------------------------------------------
    if (type === 'ping') {
        self.postMessage({ id, result: 'pong' });
        return;
    }

    // --------------------------------------------------------
    // Vérifier que le moteur est disponible
    // --------------------------------------------------------
    if (typeof CalculationEngine === 'undefined') {
        self.postMessage({
            id: id,
            error: 'Moteur de calcul non disponible'
        });
        return;
    }

    // --------------------------------------------------------
    // OPTIM : Vérifier si le résultat est en cache
    // --------------------------------------------------------
    const cacheKey = getCacheKey(type, params);
    if (resultCache.has(cacheKey)) {
        const cachedResult = resultCache.get(cacheKey);
        self.postMessage({ id, result: cachedResult });
        return;
    }

    try {
        let result;

        // ============================================================
        // Réplique EXACTE de la logique de cp-controller.js v8.9
        // (mêmes formules, mêmes constantes, mêmes unités)
        // ============================================================
        switch (type) {

            // ----------------------------------------------------
            // Case 'cp' : Calcul CP complet (courant requis + résistances)
            // ----------------------------------------------------
            case 'cp': {
                // ============================================================
                // FIX-1 (2026-09-26) : Validation des paramètres AVANT le calcul
                // ------------------------------------------------------------
                // AVANT : checkCPParameters était appelé APRÈS requiredCurrent
                //         → des résultats avec paramètres invalides pouvaient
                //           être calculés (et potentiellement mis en cache)
                //           avant que l'erreur ne soit levée.
                // APRÈS : checkCPParameters est appelé EN PREMIER → si les
                //         paramètres sont invalides, aucun calcul n'est effectué.
                // RÉFÉRENCE : Principe de garde précoce (fail-fast)
                // ============================================================
                if (typeof CalculationEngine.checkCPParameters === 'function') {
                    const parameterCheck = CalculationEngine.checkCPParameters(
                        params.S, params.J, params.eps, params.DF, params.k
                    );
                    if (!parameterCheck.valid) {
                        throw new Error('Paramètres CP invalides : ' + parameterCheck.warnings.join(' '));
                    }
                }

                // 1. Courant requis (délégué à engine.js v8.6)
                const cpResult = CalculationEngine.requiredCurrent(
                    params.S,
                    params.J,
                    params.eps,
                    params.DF,
                    params.k,
                    params.norm
                );

                // 2. Résistance d'anode (Dwight, délégué à engine.js)
                const rho = params.rho;
                const anodeLength = params.anodeLength;
                const anodeDiameter = params.anodeDiameter;
                let R_anode = 0;
                if (rho > 0 && anodeLength > 0 && anodeDiameter > 0) {
                    R_anode = CalculationEngine.anodeResistanceVertical(
                        rho, anodeLength, anodeDiameter
                    );
                }

                // ============================================================
                // P1-01 (AUDIT-FIX) : R_cable avec facteur aller-retour
                // ------------------------------------------------------------
                // Le circuit CP comprend un câble positif (vers l'anode)
                // ET un câble négatif (retour structure).
                // La résistance totale du circuit doit donc inclure les deux
                // longueurs, même si L_cable ne représente que la longueur aller.
                // Convention identique à :
                //   - engine.js v8.5 → designGroundbed()
                //   - cp-controller.js v8.9 → calculateCP() / calculateICCP()
                // ============================================================
                const L_cable = params.L_cable;
                const S_cable = params.S_cable;
                let R_cable = 0;
                if (L_cable > 0 && S_cable > 0) {
                    R_cable = (2 * RHO_CU * L_cable) / S_cable;
                }

                // 3. Résistance de structure (paramètre utilisateur)
                const R_struct = params.R_struct;

                // 4. Résistance totale du circuit
                const R_total = R_anode + R_cable + R_struct;

                // 5. IR drop = I × R_total
                const irDropVolts = cpResult.currentAmperes * R_total;

                // 6. Potentiel ON requis = potentiel OFF cible - IR drop
                const targetOffMv = params.targetOffMv || -850;
                const requiredOnMv = targetOffMv - (irDropVolts * 1000);

                result = {
                    // Champs historiques (compatibilité ascendante)
                    ...cpResult,
                    R_anode,
                    R_cable,
                    R_struct,
                    R_total,
                    irDropVolts,
                    requiredOnMv,

                    // P0-02 : Unités canoniques (propagées depuis engine.js)
                    units: cpResult.units || {
                        surface: 'm²',
                        coating: '-',
                        defectDensity: '-',
                        agingFactor: '-',
                        currentDensity: 'mA/m²',
                        current: 'A',
                        resistance: 'Ohm'
                    },

                    // P0-01 : Traçabilité de la source
                    cpCurrentSource: 'requiredCurrent'
                };
                break;
            }

            // ----------------------------------------------------
            // Case 'anodes' : Dimensionnement SACP
            // ----------------------------------------------------
            case 'anodes': {
                if (typeof CalculationEngine.designAnodesDNV !== 'function') {
                    throw new Error('designAnodesDNV non disponible dans CalculationEngine');
                }
                // engine.js v8.5 : designAnodesDNV expose désormais :
                //   - currentDensity (A/m²)
                //   - currentDensity_mA (mA/m²)
                //   - currentDensityFinal (A/m²)
                //   - currentDensityFinal_mA (mA/m²)
                //   - units
                // Le worker relaie simplement le résultat tel quel.
                result = CalculationEngine.designAnodesDNV(params);
                break;
            }

            // ----------------------------------------------------
            // Case 'iccp' : Dimensionnement ICCP
            // ----------------------------------------------------
            case 'iccp': {
                if (typeof CalculationEngine.designICCP !== 'function') {
                    throw new Error('designICCP non disponible dans CalculationEngine');
                }
                // engine.js v8.5 : designICCP expose désormais :
                //   - currentDensityAnode (A/m²)
                //   - currentDensityAnode_mA (mA/m²)
                //   - lifeTheoretical, lifeDesign, lifeDetails
                //   - powerDesign, safetyFactorPower
                //   - iccpCurrentSource
                //   - units
                // Paramètres optionnels acceptés :
                //   - safetyFactorPower (défaut 1.15)
                //   - iccpCurrentSource ('manual', 'cp_calculated', 'equipment_total')
                //   - backEmfVoltage (défaut 2.0 V)
                // Le worker relaie simplement le résultat tel quel.
                result = CalculationEngine.designICCP(params);
                break;
            }

            // ----------------------------------------------------
            // Case 'groundbed' : Dimensionnement groundbed
            // ----------------------------------------------------
            case 'groundbed': {
                if (typeof CalculationEngine.designGroundbed !== 'function') {
                    throw new Error('designGroundbed non disponible dans CalculationEngine');
                }
                // engine.js v8.5 : designGroundbed expose désormais :
                //   - R_groundbed_pure (R_group + R_well)
                //   - R_well (Dwight sur le forage)
                //   - _includesCable, _includesStructure
                //   - J_anode (A/m²) + J_anode_mA (mA/m²)
                //   - rho_eff (résistivité effective après couches)
                //   - units
                // Le worker relaie simplement le résultat tel quel.
                result = CalculationEngine.designGroundbed(params);
                break;
            }

            // ----------------------------------------------------
            // Case 'interference' : Analyse AC/DC
            // ----------------------------------------------------
            case 'interference': {
                if (typeof CalculationEngine.analyzeInterference !== 'function') {
                    throw new Error('analyzeInterference non disponible dans CalculationEngine');
                }
                // engine.js v8.5 : analyzeInterference expose désormais
                // un objet `units` documenté (V, mV, A, Ohm).
                // Le worker relaie simplement le résultat tel quel.
                result = CalculationEngine.analyzeInterference(params);
                break;
            }

            // ----------------------------------------------------
            // Type inconnu
            // ----------------------------------------------------
            default:
                throw new Error('Type de calcul inconnu : ' + type);
        }

        // --------------------------------------------------------
        // OPTIM : Mettre en cache le résultat
        // (FIX-1 : la validation CP a déjà eu lieu en tête du case 'cp')
        // --------------------------------------------------------

        if (result !== undefined && result !== null) {
            if (resultCache.size < MAX_CACHE_SIZE) {
                resultCache.set(cacheKey, result);
            } else {
                pruneCache();
                if (resultCache.size < MAX_CACHE_SIZE) {
                    resultCache.set(cacheKey, result);
                }
            }
        }

        // Renvoyer le résultat au thread principal
        self.postMessage({ id, result });

    } catch (error) {
        // Renvoyer l'erreur au thread principal avec l'ID pour traçabilité
        self.postMessage({
            id: id || 'error',
            error: error.message,
            stack: error.stack
        });
    }
};

// ============================================================
// Gestionnaire d'erreurs non capturées
// ============================================================
self.onerror = function(error) {
    console.error('[Worker] Erreur non capturée:', error);
    self.postMessage({
        id: 'error',
        error: 'Erreur non capturée dans le worker: ' + (error.message || String(error))
    });
};

// ============================================================
// OPTIM : Nettoyer le cache périodiquement (toutes les 10 minutes)
// ============================================================
setInterval(() => {
    pruneCache();
}, 600000);

// ============================================================
// FIN DE cp-worker.js (VERSION 8.6 – FIX-1/FIX-4/FIX-9 APPLIQUÉS)
// ============================================================