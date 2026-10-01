// ============================================================
// ui.js – CP Engineer Pro – Module de rendu DOM et gestion des événements
// Module UI. Version applicative : APP_CONFIG.VERSION (engine.js).
// ============================================================
// CORRECTIONS APPLIQUÉES (v9.3) :
//   ✅ INTÉGRATION iccp-cable-sync-patch.js v1.1
//      → Ajout méthode UI.syncCableCurrentFromICCP()
//      → Appel automatique dans displayICCPResults() (fin de fonction)
//      → Astuce intelligente #cableCurrentHint dans calculateCableSection()
//
//   ✅ INTÉGRATION tp-length-sync-patch.js v3.0
//      → generateTestPostsFromUI() réécrite (chargement IndexedDB + km/m)
//      → refreshPipelinesAndLength() intégré dans populateTestPostsSelectors()
//      → Interception submit via data-sync-guard (évite double traitement)
//
//   ✅ INTÉGRATION data-sync-patch.js v1.0 (partie systèmes CP)
//      → Auto-sélection du système CP préféré (DataResolver.getPreferredSystem)
//      → Suppression du monkey-patching (logique intégrée nativement)
//
// CORRECTIONS v9.2 (conservées) :
//   ✅ CORRECTION 9 (ROLE.txt) : Figure 1 = courant système
//      (priorité en cascade : ICCP > CP > getSystemTotalCurrent)
//   P0-02 : Densité anodique (A/m² et mA/m² séparés)
//   P1-01 : currentDensityAnode_mA (mA/m²)
//   P1-02 : powerDesign (SF appliqué UNE fois)
//   P1-04 : state.anodes.count préservé
//   P1-05 : lifeDesign / lifeTheoretical (cap 25 ans)
//   P0-01 : Indicateur visuel de la source du courant ICCP
// ============================================================

const UI = (function() {
    'use strict';

    let _renderSystemsPending = false;
    let _domCache = {};
    let _systemClickHandler = null;
    let _projectLoadedTimeout = null;

    const EQUIP_PAGE_SIZE = 50;
    let _equipCurrentPage = 1;
    let _equipFilteredData = [];
    let _equipFilterProject = '';
    let _defaultsApplied = false;

    // v9.3 : anti-race condition pour la synchro Test Posts
    let _tpUpdateToken = 0;

    const TYPES_NO_DIMENSIONS = ['rectifier', 'groundbed', 'anode', 'testpost'];
    // BUG-CP-005 : source unique de vérité (APP_CONFIG.CABLE_RESISTIVITY)
    const RHO_CU = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.CABLE_RESISTIVITY)
        ? APP_CONFIG.CABLE_RESISTIVITY.cu
        : 0.0175;

    function getCanonicalEquipmentSurface(equipment) {
        if (typeof CalculationEngine !== 'undefined' &&
            typeof CalculationEngine.getOuvrageFields === 'function' &&
            typeof CalculationEngine.computeEquipmentSurface === 'function') {
            const fields = CalculationEngine.getOuvrageFields(equipment && equipment.type);
            const calculated = fields.length > 0
                ? CalculationEngine.computeEquipmentSurface(
                    equipment.type,
                    (equipment && equipment.dimensions) || {}
                )
                : 0;
            if (calculated > 0) return calculated;
        }
        return Utils.safeNumber(equipment && equipment.surface, 0);
    }

    // ============================================================
    // Debounce générique
    // ============================================================
    function debounce(fn, delay) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    function throttle(fn, limit) {
        let inThrottle = false;
        return function(...args) {
            if (!inThrottle) {
                fn.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    // ============================================================
    // Auto-calcul longueur PIPELINE ENTERRÉ depuis GPS
    // ============================================================
    let _autoLengthDebounced = null;
    function getAutoLengthDebounced() {
        if (!_autoLengthDebounced) {
            _autoLengthDebounced = debounce(() => {
                try { autoComputeBuriedPipelineLength(true, false); } catch (_) {}
            }, 400);
        }
        return _autoLengthDebounced;
    }

    function autoComputeBuriedPipelineLength(silent, force) {
        try {
            const typeEl = getDomElement('equipType');
            if (!typeEl || typeEl.value !== 'pipeline_enterre') return null;

            const lengthSelect = getDomElement('dim_longueur_m');
            if (!lengthSelect) return null;
            const lengthManual = getDomElement('dim_longueur_m_manual');

            if (!force) {
                const hasSelectValue = lengthSelect.value &&
                                       lengthSelect.value !== '' &&
                                       lengthSelect.value !== 'manual';
                const hasManualValue = lengthSelect.value === 'manual' &&
                                       lengthManual &&
                                       lengthManual.value &&
                                       parseFloat(lengthManual.value) > 0;
                if (hasSelectValue || hasManualValue) return null;
            }

            const container = getDomElement('equipWaypointsContainer');
            if (!container) return null;
            const points = [];
            container.querySelectorAll('.waypoint-row').forEach(row => {
                const lat = parseFloat(row.querySelector('.equip-wp-lat')?.value);
                const lon = parseFloat(row.querySelector('.equip-wp-lon')?.value);
                const alt = parseFloat(row.querySelector('.equip-wp-alt')?.value);
                if (!isNaN(lat) && !isNaN(lon) &&
                    lat >= -90 && lat <= 90 &&
                    lon >= -180 && lon <= 180) {
                    points.push({ lat, lon, alt: isNaN(alt) ? 0 : alt });
                }
            });
            if (points.length < 2) return null;

            let lengthM = 0;
            if (typeof CoordSystem !== 'undefined' &&
                typeof CoordSystem.pipelineLength === 'function') {
                lengthM = CoordSystem.pipelineLength(points);
            } else if (typeof GeoUtils !== 'undefined') {
                if (typeof GeoUtils.pathLength === 'function') {
                    lengthM = GeoUtils.pathLength(points);
                } else if (typeof GeoUtils.distanceHaversine === 'function') {
                    for (let i = 0; i < points.length - 1; i++) {
                        lengthM += GeoUtils.distanceHaversine(
                            points[i].lat, points[i].lon,
                            points[i + 1].lat, points[i + 1].lon
                        );
                    }
                }
            }
            if (!lengthM || lengthM <= 0 || !isFinite(lengthM)) return null;

            const rounded = Math.round(lengthM * 10) / 10;

            let matched = false;
            for (const opt of lengthSelect.options) {
                if (opt.value === 'manual') continue;
                const v = parseFloat(opt.value);
                if (!isNaN(v) && Math.abs(v - rounded) <= 5) {
                    lengthSelect.value = opt.value;
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                lengthSelect.value = 'manual';
                if (lengthManual) {
                    lengthManual.value = rounded.toFixed(1);
                    lengthManual.style.display = 'block';
                }
            }

            computeEquipSurface();

            if (!silent) {
                showToast(
                    `📏 Longueur pipeline calculée depuis GPS : ${rounded.toFixed(1)} m`,
                    'success'
                );
            }
            return rounded;

        } catch (err) {
            console.warn('[UI] autoComputeBuriedPipelineLength ignorée:', err);
            return null;
        }
    }

    document.addEventListener('click', function(e) {
        const btn = e.target && e.target.closest && e.target.closest('.recalc-length-from-gps');
        if (!btn) return;
        e.preventDefault();
        autoComputeBuriedPipelineLength(false, true);
    });

    function getDomElement(id) {
        const cached = _domCache[id];
        if (!cached || !document.body.contains(cached)) {
            _domCache[id] = document.getElementById(id);
        }
        return _domCache[id];
    }

    // ============================================================
    // API CENTRALISÉE D'INVALIDATION DU CACHE DOM
    // ------------------------------------------------------------
    // ROLE.txt §14/§18 : ne plus disperser `delete _domCache[id]`
    // dans le code. Toute invalidation doit passer par ces 3 fonctions.
    // ============================================================

    /**
     * Invalide une liste d'IDs du cache DOM.
     * @param {string[]} ids
     */
    function invalidateDomElements(ids) {
        if (!Array.isArray(ids)) return;
        for (let i = 0; i < ids.length; i++) {
            delete _domCache[ids[i]];
        }
    }

    /**
     * Invalide tous les IDs des éléments actuellement présents
     * dans un conteneur (ou futurs, si on connaît la liste des IDs
     * attendus après remplacement).
     *
     * @param {HTMLElement} container
     * @param {string[]} [expectedIds] - IDs attendus après remplacement
     */
    function invalidateDomCacheContainer(container, expectedIds) {
        if (!container) return;
        // 1. Invalider les IDs des enfants actuels (avant innerHTML)
        container.querySelectorAll('[id]').forEach(el => {
            if (el.id) delete _domCache[el.id];
        });
        // 2. Invalider les IDs attendus (après innerHTML)
        if (Array.isArray(expectedIds)) {
            invalidateDomElements(expectedIds);
        }
    }

    /**
     * Vide entièrement le cache DOM.
     * À utiliser avec parcimonie (ex : changement de projet).
     */
    function clearDomCache() {
        _domCache = {};
    }

    // ============================================================
    // setSelectValue / getFieldValue / propagateField
    // ============================================================
    function setSelectValue(selectId, value) {
        const element = getDomElement(selectId);
        if (!element) return;
        if (element.tagName !== 'SELECT') {
            element.value = value;
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        const select = element;
        if (value === undefined || value === null || isNaN(parseFloat(value))) {
            for (let opt of select.options) {
                const num = parseFloat(opt.value);
                if (!isNaN(num) && num > 0) {
                    select.value = opt.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    return;
                }
            }
            return;
        }
        let found = false;
        const numValue = parseFloat(value);
        for (let opt of select.options) {
            if (Math.abs(parseFloat(opt.value) - numValue) < 0.001) {
                select.value = opt.value;
                found = true;
                break;
            }
        }
        if (!found) {
            const newOption = document.createElement('option');
            newOption.value = numValue;
            newOption.textContent = numValue.toFixed(1) + ' (calculé)';
            select.appendChild(newOption);
            select.value = numValue;
        }
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function getFieldValue(selectId, manualId) {
        const select = getDomElement(selectId);
        if (!select) return 0;

        if (select.value === 'manual') {
            const manual = getDomElement(manualId);
            if (manual && manual.value !== '' && manual.value !== undefined) {
                const v = Utils.safeNumber(manual.value, NaN);
                if (!isNaN(v)) return v;
            }
            return 0;
        }

        const v = Utils.safeNumber(select.value, NaN);
        return isNaN(v) ? 0 : v;
    }

    function propagateField(selectId, manualId, value) {
        setSelectValue(selectId, value);
    }

    // ============================================================
    // v9.3 : Synchronisation du courant câble DC depuis ICCP
    //        (Intégration iccp-cable-sync-patch.js v1.1)
    // ============================================================
    /**
     * Écrit un courant ICCP dans le champ #cableCurrent.
     *
     * @param {number} currentAmps - Courant en A (>0 sinon no-op)
     * @param {string} [source='ICCP'] - Libellé de la source
     * @param {Object} [opts]
     * @param {boolean} [opts.silent=false] - Si true, pas de toast
     * @param {boolean} [opts.respectManual=false] - Si true, respecte une saisie manuelle
     * @returns {boolean} true si la synchro a réussi
     */
    function syncCableCurrentFromICCP(currentAmps, source, opts) {
        opts = opts || {};

        const value = (typeof currentAmps === 'number' && isFinite(currentAmps))
            ? currentAmps
            : parseFloat(currentAmps);

        if (!isFinite(value) || value <= 0) return false;

        const cableCurrentInput = document.getElementById('cableCurrent');
        if (!cableCurrentInput) {
            console.warn('[UI] syncCableCurrentFromICCP: #cableCurrent introuvable.');
            return false;
        }

        if (opts.respectManual === true) {
            const isAuto = cableCurrentInput.classList.contains('field-auto-calculated');
            const currentVal = parseFloat(cableCurrentInput.value);
            const isManualOverride = !isAuto
                                  && cableCurrentInput.value !== ''
                                  && isFinite(currentVal)
                                  && currentVal > 0
                                  && Math.abs(currentVal - value) > 1e-6;
            if (isManualOverride) return false;
        }

        cableCurrentInput.value = value.toFixed(3);
        cableCurrentInput.title =
            'Auto (' + (source || 'ICCP') + ') : I_total = ' +
            value.toFixed(3) + ' A';
        cableCurrentInput.classList.add('field-auto-calculated');

        const linkBtn = document.getElementById('linkCableCurrentToICCP');
        if (linkBtn) {
            linkBtn.classList.add('linked');
            linkBtn.setAttribute('aria-pressed', 'true');
            linkBtn.title = 'Lié au courant ICCP (auto)';
        }

        if (window.AppState && window.AppState.currentLinkState) {
            window.AppState.currentLinkState.cable = true;
        }

        if (!opts.silent) {
            showToast(
                '✅ Courant câble synchronisé : ' + value.toFixed(3) + ' A (' + (source || 'ICCP') + ')',
                'info'
            );
        }
        return true;
    }

    /**
     * Synchronise la longueur de câble totale depuis l'optimisation ICCP / SIG
     * vers le champ "Longueur câbles" du module Calcul CP.
     * Met à jour le flag cableLengthIsTotal pour éviter le double comptage du facteur 2.
     *
     * @param {number|string} lengthMeters Longueur totale en mètres (+10% marge incluse)
     * @param {Object} [opts] { silent: boolean }
     * @returns {boolean}
     */
    function syncCableLengthFromICCP(lengthMeters, opts) {
        opts = opts || {};
        const lengthValue = parseFloat(lengthMeters);
        if (!isFinite(lengthValue) || lengthValue <= 0) return false;

        const cableLengthSelect = document.getElementById('cableLength');
        const cableLengthManual = document.getElementById('cableLengthManual');
        const badge = document.getElementById('cableLengthSyncBadge');

        if (cableLengthSelect) {
            let found = false;
            for (let opt of cableLengthSelect.options) {
                if (Math.abs(parseFloat(opt.value) - lengthValue) < 0.1) {
                    cableLengthSelect.value = opt.value;
                    found = true;
                    break;
                }
            }
            if (!found) {
                let calcOpt = Array.from(cableLengthSelect.options).find(o => Math.abs(parseFloat(o.value) - lengthValue) < 0.1);
                if (!calcOpt) {
                    calcOpt = document.createElement('option');
                    calcOpt.value = lengthValue;
                    calcOpt.textContent = lengthValue.toFixed(0) + ' (SIG +10%)';
                    cableLengthSelect.appendChild(calcOpt);
                }
                cableLengthSelect.value = lengthValue;
                if (cableLengthManual) cableLengthManual.style.display = 'none';
            }
            cableLengthSelect.dataset.isTotal = 'true';
            cableLengthSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (badge) {
            badge.textContent = 'boucle SIG ' + lengthValue.toFixed(0) + ' m';
            badge.style.display = 'inline';
            badge.title = 'Longueur totale aller-retour (TR→GB + TR→Structure +10%) issue de l\'optimisation SIG';
        }

        if (typeof ProjectManager !== 'undefined') {
            const shared = ProjectManager.getSharedParams();
            if (shared) {
                shared.cableLength = lengthValue;
                shared.cableLengthIsTotal = true;
                const activeSys = ProjectManager.getActiveSystem();
                if (activeSys) {
                    const iccpParams = ProjectManager.loadSystemParams(activeSys.id, 'iccp') || {};
                    iccpParams.L_cable = lengthValue;
                    iccpParams.cableLengthIsTotal = true;
                    ProjectManager.saveSystemParams(activeSys.id, 'iccp', iccpParams);
                }
                ProjectManager.saveCurrentProject();
            }
        }

        if (!opts.silent && typeof showToast === 'function') {
            showToast(`✅ Longueur câble CP synchronisée : ${lengthValue.toFixed(0)} m (boucle complète SIG)`, 'info');
        }
        return true;
    }

    // ============================================================
    // updateSyncBadges / toggleSharedLock / updateDerivedFields
    // ============================================================
    function updateSyncBadges() {
        const shared = ProjectManager.getSharedParams();
        const lock = shared.lock || {};
        const fields = [
            { id: 'iccpResistivitySelect', badgeId: 'iccpResistivityBadge', locked: lock.soilResistivity },
            { id: 'gbSoilResistivity', badgeId: 'gbSoilResistivityBadge', locked: lock.soilResistivity },
            { id: 'iccpSurface', badgeId: 'iccpSurfaceBadge', locked: lock.protectedSurface },
            { id: 'gbCableLength', badgeId: 'gbCableLengthBadge', locked: lock.cableLength },
            { id: 'gbCableSection', badgeId: 'gbCableSectionBadge', locked: lock.cableSection }
        ];
        fields.forEach(f => {
            const badge = getDomElement(f.badgeId);
            if (badge) {
                if (f.locked !== false) {
                    badge.textContent = 'synchro';
                    badge.className = 'source-badge auto';
                } else {
                    badge.textContent = 'manuel';
                    badge.className = 'source-badge manual';
                }
            }
        });
    }

    function toggleSharedLock(key) {
        const shared = ProjectManager.getSharedParams();
        if (!shared.lock) shared.lock = {};
        shared.lock[key] = !shared.lock[key];
        ProjectManager.saveCurrentProject();
        if (window.CPController && typeof window.CPController.syncSharedParams === 'function') {
            window.CPController.syncSharedParams();
        }
        updateSyncBadges();
        showToast(`Verrouillage ${key} ${shared.lock[key] ? 'activé' : 'désactivé'}`, 'info');
    }

    function updateDerivedFields() {
        const state = ProjectManager.getState();
        const iccp = state.iccp;
        const gbResults = state.groundbed?.results;
        if (iccp.current > 0 && iccp.groundbedParams && iccp.groundbedParams.anodeCount) {
            const N = iccp.groundbedParams.anodeCount || 1;
            const I_per_anode = iccp.current / N;
            const el = getDomElement('resCurrentPerAnode');
            if (el) el.innerText = I_per_anode.toFixed(3);
        }
        if (iccp.current > 0 && iccp.voltage > 0) {
            const P = iccp.powerDesign || (iccp.current * iccp.voltage);
            const el = getDomElement('rectPower');
            if (el) el.innerText = P.toFixed(0) + ' W';
        }
        if (gbResults && gbResults.R_total) {
            const el = getDomElement('resGroundbedResistance');
            if (el) el.innerText = gbResults.R_total.toFixed(4);
        }
    }

    // ============================================================
    // validateSystem
    // ============================================================
    function validateSystem() {
        const state = ProjectManager.getState();
        const cpCurrent = state.cp.current || 0;
        const iccpCurrent = state.iccp.current || 0;
        const iccpVoltage = state.iccp.voltage || 0;
        const gbResults = state.groundbed?.results;
        const gbResistance = gbResults ? gbResults.R_total : 0;
        const rectifierVoltage = state.iccp.rectifierVoltage || 0;

        let chainResult = { globalPass: false, checks: [], status: 'FAIL ❌' };
        if (cpCurrent > 0 && iccpCurrent > 0 && gbResistance > 0) {
            const checks = [];
            const currentOk = (iccpCurrent >= cpCurrent * 0.95);
            checks.push({ name: 'Courant ICCP ≥ CP', ok: currentOk, message: `ICCP ${iccpCurrent.toFixed(2)} A vs CP ${cpCurrent.toFixed(2)} A` });
            const voltageOk = (rectifierVoltage > 0 && rectifierVoltage >= iccpVoltage);
            checks.push({ name: 'Tension redresseur ≥ tension requise', ok: voltageOk, message: `Redresseur ${rectifierVoltage.toFixed(1)} V vs requise ${iccpVoltage.toFixed(1)} V` });
            const gbOk = (gbResistance > 0);
            checks.push({ name: 'Résistance groundbed valide', ok: gbOk, message: `R = ${gbResistance.toFixed(4)} Ω` });
            const allOk = checks.every(c => c.ok);
            chainResult = { globalPass: allOk, checks: checks, status: allOk ? 'PASS ✅' : 'FAIL ❌' };
        } else {
            chainResult = {
                globalPass: false,
                checks: [
                    { name: 'Courant CP', ok: cpCurrent > 0, message: cpCurrent > 0 ? `${cpCurrent.toFixed(2)} A` : 'Non calculé' },
                    { name: 'Courant ICCP', ok: iccpCurrent > 0, message: iccpCurrent > 0 ? `${iccpCurrent.toFixed(2)} A` : 'Non calculé' },
                    { name: 'Résistance groundbed', ok: gbResistance > 0, message: gbResistance > 0 ? `${gbResistance.toFixed(4)} Ω` : 'Non calculé' }
                ],
                status: 'INCOMPLET'
            };
        }

        const measurements = state.fieldMeasurements || [];
        const offMeasurements = measurements
            .filter(m => m.potOFF !== undefined && Number.isFinite(Number(m.potOFF)))
            .map(m => Number(m.potOFF));
        const polarizationValues = measurements
            .filter(m => m.potOFF !== undefined && m.potON !== undefined)
            .map(m => Math.abs(Number(m.potOFF) - Number(m.potON)));
        let avgPolarization = 0;
        if (polarizationValues.length > 0) {
            avgPolarization = polarizationValues.reduce((a, b) => a + b, 0) / polarizationValues.length;
        }
        const offPotential = offMeasurements.length > 0
            ? offMeasurements.reduce((a, b) => a + b, 0) / offMeasurements.length
            : null;
        let naceResult = { offPotentialPass: false, globalPass: false };
        if (typeof CalculationEngine !== 'undefined') {
            naceResult = CalculationEngine.validateProtectionCriteria(offPotential, avgPolarization);
        }
               const globalPass = chainResult.globalPass && naceResult.globalPass;
        const statusText = globalPass ? '✅ PASS' : (chainResult.status === 'INCOMPLET' ? '⚠️ INCOMPLET' : '❌ FAIL');

        // ============================================================
        // ✅ CORRECTION : Calcul et affichage du score de confiance
        // ------------------------------------------------------------
        // Le score = pourcentage de critères satisfaits parmi :
        //   - les vérifications de chaîne ICCP (chainResult.checks)
        //   - les critères NACE (potentiel OFF + polarisation)
        // ============================================================
        const allChecks = [];
        (chainResult.checks || []).forEach(c => allChecks.push(!!c.ok));
        if (naceResult && typeof naceResult.offPotentialPass === 'boolean') {
            allChecks.push(naceResult.offPotentialPass);
        }
        if (naceResult && typeof naceResult.polarizationPass === 'boolean') {
            allChecks.push(naceResult.polarizationPass);
        }
        const passedCount = allChecks.filter(v => v === true).length;
        const totalChecks = allChecks.length;
        const confidencePct = totalChecks > 0
            ? Math.round((passedCount / totalChecks) * 100)
            : 0;

        const confidenceEl = document.getElementById('confidenceScore');
        if (confidenceEl) {
            confidenceEl.textContent = confidencePct + ' %';
            // Classes visuelles (facultatif, voir CSS ci-dessous)
            confidenceEl.className = 'confidence-score ' +
                (confidencePct >= 80 ? 'high'
                 : confidencePct >= 50 ? 'medium'
                 : 'low');
            confidenceEl.title = passedCount + ' / ' + totalChecks +
                ' critères satisfaits';
        }

        const badge = getDomElement('validationSystemBadge');
        if (badge) {
            badge.innerText = statusText;
            badge.className = `badge ${globalPass ? 'success' : (chainResult.status === 'INCOMPLET' ? 'warning' : 'danger')}`;
        }
        const tbody = getDomElement('validationTableBody');
        if (tbody) {
            let html = '';
            chainResult.checks.forEach(c => {
                html += `<tr><td>${c.name}</td><td><span class="badge ${c.ok ? 'success' : 'danger'}">${c.ok ? '✅ OK' : '❌ NOK'}</span></td><td>${c.message}</td></tr>`;
            });
            // Critère 1 : Potentiel OFF
            html += `<tr><td>Potentiel OFF ${offPotential === null ? 'non mesuré' : offPotential.toFixed(0) + ' mV'}</td><td><span class="badge ${naceResult.offPotentialPass ? 'success' : 'danger'}">${naceResult.offPotentialPass ? '✅' : '❌'}</span></td><td>${naceResult.offPotentialMessage || ''}</td></tr>`;
            // Critère 2 : Polarisation
            html += `<tr><td>Polarisation (moyenne terrain)</td><td><span class="badge ${avgPolarization >= 100 ? 'success' : 'warning'}">${avgPolarization.toFixed(0)} mV</span></td><td>${avgPolarization >= 100 ? '✅ ≥ 100 mV' : '⚠️ < 100 mV'}</td></tr>`;
            // GAP-05 : Critère 3 — Surprotection V_on (ISO 15589-1 §6.1)
            const onMeasurements = measurements
                .filter(m => m.potON !== undefined && Number.isFinite(Number(m.potON)))
                .map(m => Number(m.potON));
            const avgOnPotential = onMeasurements.length > 0
                ? onMeasurements.reduce((a, b) => a + b, 0) / onMeasurements.length
                : null;
            if (avgOnPotential !== null) {
                const overProtOk = avgOnPotential >= -1200;
                html += `<tr style="${!overProtOk ? 'background:rgba(245,158,11,0.12);' : ''}">` +
                    `<td>Surprotection — Potentiel ON (moyenne terrain)</td>` +
                    `<td><span class="badge ${overProtOk ? 'success' : 'warning'}">${avgOnPotential.toFixed(0)} mV</span></td>` +
                    `<td>${overProtOk
                        ? '✅ ≥ -1200 mV (pas de surprotection)'
                        : '⚠️ < -1200 mV — SURPROTECTION : risque fragilisation H₂ / délaminage revêtement (ISO 15589-1 §6.1)'}</td></tr>`;
            } else {
                html += `<tr><td>Surprotection — Potentiel ON</td><td><span class="badge info">—</span></td><td style="color:var(--text-muted);font-style:italic;">Potentiel ON non mesuré — fournir V_on pour évaluation complète (GAP-05)</td></tr>`;
            }
            tbody.innerHTML = html;
        }

        return { globalPass, chain: chainResult, nace: naceResult, confidence: confidencePct };
    }

    function performValidation() {
        return validateSystem();
    }

    // ============================================================
    // updateDashboardKPIs
    // ============================================================
    function updateDashboardKPIs() {
        try {
            const state = ProjectManager.getState();
            const projectId = ProjectManager.getCurrentProjectId();
            const activeSystem = ProjectManager.getActiveSystem();
            const sysId = activeSystem ? activeSystem.id : null;

            const sanitizeAnodeSnapshot = (snapshot) => {
                if (typeof CalculationEngine !== 'undefined' && typeof CalculationEngine.normalizeSACPResult === 'function') {
                    return CalculationEngine.normalizeSACPResult(snapshot || {});
                }
                const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
                const totalMass = Number(source.totalMass) || 0;
                const count = Number(source.count) || 0;
                const actualLife = Number(source.actualLife) || 0;
                const valid = totalMass > 0 && count > 0;
                return {
                    ...source,
                    totalMass: valid ? totalMass : 0,
                    count: valid ? count : 0,
                    actualLife: valid ? actualLife : 0
                };
            };

            let iccpCurrent = 0, iccpVoltage = 0;
            let sacpMass = 0, sacpCount = 0, sacpLife = 0;
            let cpCurrent = 0;

            if (sysId) {
                const sysIccp   = ProjectManager.loadSystemResults(sysId, 'iccp')   || {};
                const sysAnodes = sanitizeAnodeSnapshot(ProjectManager.loadSystemResults(sysId, 'anodes') || {});
                const sysCP     = ProjectManager.loadSystemResults(sysId, 'cp')     || {};
                iccpCurrent = sysIccp.current || 0;
                iccpVoltage = sysIccp.voltage || 0;
                sacpMass    = sysAnodes.totalMass || 0;
                sacpCount   = sysAnodes.count || 0;
                sacpLife    = sysAnodes.actualLife || 0;
                cpCurrent   = sysCP.current || 0;
            }

            const normalizedStateAnodes = sanitizeAnodeSnapshot(state.anodes || {});
            if (iccpCurrent === 0) iccpCurrent = (state.iccp   && state.iccp.current)   || 0;
            if (iccpVoltage === 0) iccpVoltage = (state.iccp   && state.iccp.voltage)   || 0;
            if (sacpMass    === 0) sacpMass    = normalizedStateAnodes.totalMass || 0;
            if (sacpCount   === 0) sacpCount   = normalizedStateAnodes.count || 0;
            if (sacpLife    === 0) sacpLife    = normalizedStateAnodes.actualLife || 0;
            if (cpCurrent   === 0) cpCurrent   = (state.cp     && state.cp.current)     || 0;

            const requiredCurrent = iccpCurrent || cpCurrent || 0;
            const elCurrent = getDomElement('kpiCurrent');
            if (elCurrent) elCurrent.innerText = requiredCurrent > 0
                ? requiredCurrent.toFixed(2) : '—';

            const gbResultsKpi = (state.groundbed && state.groundbed.results) || {};
            const gbMass = (typeof gbResultsKpi.totalMass === 'number') ? gbResultsKpi.totalMass : 0;
            // FIX-LIFESPAN (2026-09-26) : Utiliser lifeDesign (plafonné NACE ≤25 ans)
            // et NON lifeWithSafety qui est la valeur faradique brute non plafonnée
            // (peut atteindre des millénaires sous faible courant → aberration affichage).
            const gbLife = (typeof gbResultsKpi.lifeDesign === 'number' && gbResultsKpi.lifeDesign > 0)
                ? gbResultsKpi.lifeDesign
                : ((typeof gbResultsKpi.lifeWithSafety === 'number') ? gbResultsKpi.lifeWithSafety : 0);

            const massToShow = (gbMass > 0) ? gbMass : sacpMass;
            const lifeToShow = (gbLife > 0) ? gbLife : sacpLife;

            const elMass = getDomElement('kpiMass');
            if (elMass) elMass.innerText = massToShow > 0
                ? massToShow.toFixed(1) : '—';

            const elLife = getDomElement('kpiLife');
            if (elLife) elLife.innerText = lifeToShow > 0
                ? lifeToShow.toFixed(1) : '—';

            const elNace = getDomElement('kpiCompliance');
            if (elNace) {
                const offPot = (state.cp && state.cp.requiredOnPotential)
                            || (state.project && state.project.targetPotential)
                            || -850;
                elNace.innerText = offPot <= -850 ? 'OK' : 'NOK';
                elNace.style.color = offPot <= -850
                    ? 'var(--accent-green)' : 'var(--accent-red)';
            }

            const elEquipCurr = getDomElement('kpiEquipmentTotal');
            if (elEquipCurr) {
                const total = (window.CPController &&
                    typeof window.CPController.getTotalEquipmentCurrent === 'function')
                    ? window.CPController.getTotalEquipmentCurrent() : 0;
                elEquipCurr.innerText = total > 0 ? total.toFixed(3) : '—';
            }

            const elEqCount = getDomElement('equipCountStatus');
            if (elEqCount) {
                const eqs = state.equipments.filter(eq => eq.projectId === projectId && isIndividualCPEquipment(eq));
                const calculated = eqs.filter(eq => eq.cpData && eq.cpData.calculated).length;
                const included   = eqs.filter(eq => eq.included !== false).length;
                elEqCount.innerText = calculated + ' / ' + included;
            }

            const elProt = getDomElement('protectionStatus');
            if (elProt) {
                const configuredType = String(state.project?.cpSystemType || 'mixte').toLowerCase();
                const typeLabels = { iccp: 'ICCP', anodes: 'SACP', mixte: 'Mixte' };
                const txt = typeLabels[configuredType] || typeLabels.mixte;
                const cls = configuredType === 'anodes' ? 'partial' : 'protected';
                elProt.innerText = txt;
                elProt.className = 'kpi-value ' + cls;
            }

            validateSystem();

            const totalSurface = state.equipments
                .filter(eq => eq.projectId === projectId && eq.included !== false)
                .reduce((s, eq) => s + getCanonicalEquipmentSurface(eq), 0);

            const elSumSurface = getDomElement('sumSurface');
            if (elSumSurface) elSumSurface.innerText = totalSurface > 0
                ? totalSurface.toFixed(1) : '—';

            const elSumRes = getDomElement('sumResistivity');
            if (elSumRes) {
                const rho = (state.project && state.project.shared && state.project.shared.soilResistivity)
                         || (state.project && state.project.resistivity) || 0;
                elSumRes.innerText = rho > 0 ? rho.toFixed(1) : '—';
            }

            const elSumJ = getDomElement('sumCurrentDensity');
            if (elSumJ) {
                const J = (state.project && state.project.currentDensity) || 0;
                elSumJ.innerText = J > 0 ? J.toFixed(1) : '—';
            }

            const elSumType = getDomElement('sumCPType');
            if (elSumType) {
                elSumType.innerText = ((state.project && state.project.cpSystemType) || 'mixte').toUpperCase();
            }

            const elCons = getDomElement('consistencyStatus');
            const elConsBadge = getDomElement('consistencyBadge');
            if (elCons && elConsBadge) {
                const ratio = (iccpCurrent > 0 && cpCurrent > 0)
                    ? Math.min(iccpCurrent, cpCurrent) / Math.max(iccpCurrent, cpCurrent) : 0;
                if (ratio >= 0.95) {
                    elCons.innerText = 'Cohérent';
                    elConsBadge.className = 'badge success';
                    elConsBadge.innerText = '✅';
                } else if (ratio > 0) {
                    elCons.innerText = 'Écart ' + (ratio * 100).toFixed(0) + '%';
                    elConsBadge.className = 'badge warning';
                    elConsBadge.innerText = '⚠️';
                } else {
                    elCons.innerText = '—';
                    elConsBadge.className = 'badge info';
                    elConsBadge.innerText = '—';
                }
            }

            const elOnPot = getDomElement('estimatedOnPotential');
            const elOnBadge = getDomElement('offPotentialBadge');
            if (elOnPot) {
                const onPot = (state.cp && state.cp.requiredOnPotential) || 0;
                elOnPot.innerText = onPot !== 0 ? onPot.toFixed(0) : '—';
                if (elOnBadge) {
                    elOnBadge.className = onPot <= -850 ? 'badge success' : 'badge warning';
                    elOnBadge.innerText = onPot <= -850 ? 'OK' : 'À vérifier';
                }
            }

            const elEqCountTable = getDomElement('equipCountStatusTable');
            if (elEqCountTable) {
                const eqs = state.equipments.filter(eq => eq.projectId === projectId && isIndividualCPEquipment(eq));
                const calculated = eqs.filter(eq => eq.cpData && eq.cpData.calculated).length;
                elEqCountTable.innerText = calculated + ' / ' + eqs.length;
            }

            // ============================================================
            // KPI RECTIFIER — lire depuis system.rectifiers[] du système actif
            // ============================================================
            (function updateRectifierKPIs() {
                try {
                    // Récupérer le rectifier TR-OPTIMAL ou le premier actif
                    const rectifiers = (activeSystem && activeSystem.rectifiers) || [];
                    const rect = rectifiers.find(r => r.id === 'TR-OPTIMAL' || r.name === 'TR-OPTIMAL')
                               || rectifiers.find(r => r.status === 'on')
                               || rectifiers[0]
                               || null;

                    // Données nominales (catalogue TR)
                    const nomCurrent  = rect ? (Number(rect.nominalCurrent)  || Number(rect.current)  || 0) : 0;
                    const nomVoltage  = rect ? (Number(rect.nominalVoltage)  || Number(rect.voltage)  || 0) : 0;
                    const nomPower    = rect ? (Number(rect.nominalPower)    || Number(rect.power)    || 0) : 0;

                    // Données opérationnelles (calculées par le moteur ICCP)
                    const opCurrent   = iccpCurrent   || cpCurrent || 0;
                    const opVoltage   = (state.iccp && (state.iccp.rectifierVoltage || state.iccp.voltageFinal || state.iccp.voltage)) || 0;
                    const opPower     = (state.iccp && (state.iccp.rectifierPower   || state.iccp.powerDesign  || state.iccp.power))  || 0;

                    // Taux de charge courant (vs nominal)
                    const loadRateCurrent = (nomCurrent > 0 && opCurrent > 0) ? (opCurrent / nomCurrent * 100) : 0;
                    const loadRateVoltage = (nomVoltage > 0 && opVoltage > 0) ? (opVoltage / nomVoltage * 100) : 0;
                    const loadRateOverall = Math.max(loadRateCurrent, loadRateVoltage);

                    // Statut du badge section
                    const rectStatus = getDomElement('kpiRectifierStatus');
                    if (rectStatus) {
                        if (rect && (nomCurrent > 0 || opCurrent > 0)) {
                            rectStatus.textContent = loadRateOverall > 90 ? '⚠ Surchargé' : '✓ Actif';
                            rectStatus.className = 'kpi-section-badge' + (loadRateOverall > 90 ? ' warn' : ' active');
                        } else {
                            rectStatus.textContent = 'Non défini';
                            rectStatus.className = 'kpi-section-badge';
                        }
                    }

                    // Courant nominal
                    const elRectNomI = getDomElement('kpiRectNominalCurrent');
                    if (elRectNomI) elRectNomI.innerText = nomCurrent > 0 ? nomCurrent.toFixed(1) : '—';

                    // Tension nominale
                    const elRectNomV = getDomElement('kpiRectNominalVoltage');
                    if (elRectNomV) elRectNomV.innerText = nomVoltage > 0 ? nomVoltage.toFixed(1) : '—';

                    // Puissance nominale
                    const elRectNomP = getDomElement('kpiRectNominalPower');
                    if (elRectNomP) {
                        const pW = nomPower > 1000 ? (nomPower / 1000).toFixed(2) + ' kW' : (nomPower > 0 ? nomPower.toFixed(0) + ' W' : '—');
                        elRectNomP.innerText = nomPower > 0 ? nomPower.toFixed(0) : '—';
                    }

                    // Courant opérationnel
                    const elRectOpI = getDomElement('kpiRectCurrent');
                    if (elRectOpI) elRectOpI.innerText = opCurrent > 0 ? opCurrent.toFixed(2) : '—';

                    // Tension opérationnelle
                    const elRectOpV = getDomElement('kpiRectVoltage');
                    if (elRectOpV) elRectOpV.innerText = opVoltage > 0 ? opVoltage.toFixed(1) : '—';

                    // Puissance absorbée
                    const elRectOpP = getDomElement('kpiRectPower');
                    if (elRectOpP) elRectOpP.innerText = opPower > 0 ? opPower.toFixed(0) : '—';

                    // GAP-04 : Puissance AC requise au réseau (transformateur)
                    // P_AC = P_DC / η_rectifier (IEC 60146, η ≈ 0.85 par défaut)
                    const elRectPAC = getDomElement('kpiRectPowerAC');
                    if (elRectPAC) {
                        const P_AC = (state.iccp && state.iccp.P_AC_required)
                            ? state.iccp.P_AC_required
                            : (opPower > 0 ? opPower / 0.85 : 0);
                        if (P_AC > 0) {
                            elRectPAC.innerText = P_AC > 1000
                                ? (P_AC / 1000).toFixed(2) + ' kW'
                                : P_AC.toFixed(0) + ' W';
                            elRectPAC.title = 'Puissance AC réseau = P_DC / η (η=0.85, IEC 60146)';
                        } else {
                            elRectPAC.innerText = '—';
                        }
                    }

                    // Taux de charge global
                    const elRectLoad = getDomElement('kpiRectLoadRate');
                    if (elRectLoad) {
                        if (loadRateOverall > 0) {
                            elRectLoad.innerText = loadRateOverall.toFixed(1);
                            elRectLoad.style.color = loadRateOverall > 90 ? 'var(--accent-red)' : loadRateOverall > 70 ? '#f59e0b' : 'var(--accent-green)';
                        } else {
                            elRectLoad.innerText = '—';
                            elRectLoad.style.color = '';
                        }
                    }

                    // Informations techniques du catalogue TR
                    const tc = (rect && rect.technicalCharacteristics) || {};
                    const elRectModel = getDomElement('kpiRectModel');
                    if (elRectModel) {
                        const mfr = rect ? (rect.manufacturer || '') : '';
                        const mdl = rect ? (rect.model || rect.name || '') : '';
                        elRectModel.innerText = mfr && mdl ? `${mfr} — ${mdl}` : (mdl || mfr || '—');
                    }
                    const elRectTech = getDomElement('kpiRectTechnology');
                    if (elRectTech) elRectTech.innerText = tc.technology || '—';

                    const elRectReg = getDomElement('kpiRectRegulation');
                    if (elRectReg) elRectReg.innerText = tc.regulation || '—';

                    const elRectSupply = getDomElement('kpiRectSupply');
                    if (elRectSupply) {
                        const sup = tc.supplyVoltage ? tc.supplyVoltage + 'V' : '';
                        const phases = tc.phases ? tc.phases : '';
                        const hz = tc.frequencyHz ? tc.frequencyHz + 'Hz' : '';
                        const parts = [sup, phases, hz].filter(Boolean);
                        elRectSupply.innerText = parts.length ? parts.join(' / ') : '—';
                    }

                    const elRectIP = getDomElement('kpiRectIP');
                    if (elRectIP) elRectIP.innerText = tc.enclosureProtection || '—';

                    const elRectCool = getDomElement('kpiRectCooling');
                    if (elRectCool) elRectCool.innerText = tc.cooling || '—';

                } catch (e) {
                    console.warn('[UI] KPI Rectifier erreur:', e.message);
                }
            })();

            // ============================================================
            // KPI GROUND BED (Puits Anodique)
            // ============================================================
            (function updateGroundbedKPIs() {
                try {
                    // Source canonique des résultats groundbed
                    const gbRes = (state.groundbed && state.groundbed.results) || {};
                    // Paramètres depuis les groundbeds sauvegardés
                    const gbList = state.groundbeds || [];
                    const primaryGB = gbList.find(g => g.name && g.name.toLowerCase().indexOf('optimal') !== -1) || gbList[0];
                    const gbParams = (primaryGB && primaryGB.parameters) || {};

                    // Statut du badge
                    const gbStatusEl = getDomElement('kpiGroundbedStatus');
                    if (gbStatusEl) {
                        const hasData = gbRes.R_total > 0 || gbRes.I_total > 0;
                        if (hasData) {
                            const lifeOk = (gbRes.lifeDesign || gbRes.lifeWithSafety || 0) >= 10;
                            gbStatusEl.textContent = lifeOk ? '✓ Calculé' : '⚠ Durée faible';
                            gbStatusEl.className = 'kpi-section-badge' + (lifeOk ? ' active' : ' warn');
                        } else {
                            gbStatusEl.textContent = 'Non calculé';
                            gbStatusEl.className = 'kpi-section-badge';
                        }
                    }

                    // --- Résistances ---
                    const elRtotal = getDomElement('kpiGbRtotal');
                    if (elRtotal) elRtotal.innerText = gbRes.R_total > 0 ? Number(gbRes.R_total).toFixed(4) : '—';

                    const elRwell = getDomElement('kpiGbRwell');
                    if (elRwell) elRwell.innerText = typeof gbRes.R_well === 'number' && gbRes.R_well > 0
                        ? gbRes.R_well.toFixed(4) : '—';

                    const elRpure = getDomElement('kpiGbRpure');
                    if (elRpure) elRpure.innerText = typeof gbRes.R_groundbed_pure === 'number' && gbRes.R_groundbed_pure > 0
                        ? gbRes.R_groundbed_pure.toFixed(4) : '—';

                    // --- Courant et Tension ---
                    const elItotal = getDomElement('kpiGbItotal');
                    if (elItotal) elItotal.innerText = gbRes.I_total > 0 ? Number(gbRes.I_total).toFixed(3) : '—';

                    const elVrect = getDomElement('kpiGbVrectifier');
                    if (elVrect) elVrect.innerText = gbRes.V_rectifier > 0 ? Number(gbRes.V_rectifier).toFixed(1) : '—';

                    // --- Durées de vie ---
                    const lifeDesign = gbRes.lifeDesign || gbRes.lifeWithSafety || 0;
                    const lifeTheory = gbRes.lifeTheoretical || 0;

                    const elLifeD = getDomElement('kpiGbLifeDesign');
                    if (elLifeD) {
                        elLifeD.innerText = lifeDesign > 0 ? Number(lifeDesign).toFixed(1) : '—';
                        elLifeD.style.color = lifeDesign >= 20 ? 'var(--accent-green)'
                            : lifeDesign >= 10 ? '#f59e0b' : (lifeDesign > 0 ? 'var(--accent-red)' : '');
                    }
                    const elLifeT = getDomElement('kpiGbLifeTheoretical');
                    if (elLifeT) elLifeT.innerText = lifeTheory > 0 ? Number(lifeTheory).toFixed(1) : '—';

                    // --- Nombre d'anodes ---
                    const anodeCount = gbRes.anodeCount || gbParams.anodeCount || 0;
                    const elAnodeCount = getDomElement('kpiGbAnodeCount');
                    if (elAnodeCount) elAnodeCount.innerText = anodeCount > 0 ? String(anodeCount) : '—';

                    // --- Masse totale des anodes ---
                    const totalMass = gbRes.totalMass || (anodeCount > 0 && gbParams.anodeWeight
                        ? anodeCount * Number(gbParams.anodeWeight) : 0);
                    const elGbMass = getDomElement('kpiGbTotalMass');
                    if (elGbMass) elGbMass.innerText = totalMass > 0 ? Number(totalMass).toFixed(1) : '—';

                    // --- Densité de courant anodes ---
                    const elJanode = getDomElement('kpiGbCurrentDensity');
                    if (elJanode) {
                        const Janode = gbRes.J_anode || 0;
                        elJanode.innerText = Janode > 0 ? Number(Janode).toFixed(2) : '—';
                    }

                    // --- Informations physiques ---
                    // Type d'anode
                    const anodeTypeLabels = { mmo: 'MMO (Mixed Metal Oxide)', 'high-si-cr': 'Haut-Si/Cr', graphite: 'Graphite', platinized: 'Platinisé', carbonpoly: 'Carbone/Polymère' };
                    const anodeTypeRaw = gbRes.anodeType || gbParams.anodeType || '';
                    const elAnodeType = getDomElement('kpiGbAnodeType');
                    if (elAnodeType) elAnodeType.innerText = anodeTypeRaw
                        ? ('⚡ ' + (anodeTypeLabels[anodeTypeRaw] || anodeTypeRaw.toUpperCase())) : '—';

                    // Profondeur totale du forage
                    const depth = gbRes.totalDepth || gbParams.totalDepth || 0;
                    const elDepth = getDomElement('kpiGbDepth');
                    if (elDepth) elDepth.innerText = depth > 0 ? ('↕ ' + Number(depth).toFixed(0) + ' m') : '—';

                    // Résistivité locale groundbed
                    const rhoGB = gbRes.rhoGroundbed || gbRes.rho_eff || gbParams.rhoGroundbed || gbParams.rho || 0;
                    const elRho = getDomElement('kpiGbRho');
                    if (elRho) elRho.innerText = rhoGB > 0 ? ('ρ = ' + Number(rhoGB).toFixed(1) + ' Ω·m') : '—';

                    // Masse unitaire par anode
                    const anodeWeight = gbParams.anodeWeight || 0;
                    const elAnodeW = getDomElement('kpiGbAnodeWeight');
                    if (elAnodeW) elAnodeW.innerText = anodeWeight > 0 ? Number(anodeWeight).toFixed(1) + ' kg/u' : '—';

                    // Capacité électrochimique (Ah/kg)
                    const cap = gbParams.anodeCapacity || 0;
                    const elCap = getDomElement('kpiGbAnodeCapacity');
                    if (elCap) elCap.innerText = cap > 0 ? Number(cap).toFixed(2) + ' Ah/kg' : '—';

                    // Facteur de vieillissement
                    const aging = gbParams.agingFactor || gbRes.agingFactor || 0;
                    const elAging = getDomElement('kpiGbAgingFactor');
                    if (elAging) elAging.innerText = aging > 0 ? '× ' + Number(aging).toFixed(2) : '—';

                } catch (e) {
                    console.warn('[UI] KPI Groundbed erreur:', e.message);
                }
            })();

        } catch (err) {
            console.warn('[UI] updateDashboardKPIs erreur:', err);
        }
    }

    // ============================================================
    // Toasts
    // ============================================================
    const _toastQueue = [];
    let _toastActive = false;

    function showToast(message, type = 'info') {
        const container = getDomElement('toastContainer');
        if (!container) return;
        _toastQueue.push({ message, type });
        processToastQueue();
    }

    function processToastQueue() {
        if (_toastActive || _toastQueue.length === 0) return;
        _toastActive = true;
        const { message, type } = _toastQueue.shift();
        const container = getDomElement('toastContainer');
        if (!container) {
            _toastActive = false;
            return;
        }
        if (container.children.length >= 5) {
            container.removeChild(container.firstChild);
        }
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'polite');
        const icon = type === 'success' ? 'fa-check-circle' :
                     type === 'warning' ? 'fa-exclamation-triangle' :
                     'fa-info-circle';
        toast.innerHTML = `<i class="fas ${icon}" aria-hidden="true"></i> ${Utils.escapeHtml(message)}`;
        container.appendChild(toast);
        setTimeout(() => {
            if (toast.parentNode) toast.remove();
            _toastActive = false;
            processToastQueue();
        }, 4000);
    }

    function setFieldSource(fieldId, source) {
        const el = getDomElement(fieldId);
        if (!el) return;
        el.classList.remove('field-auto-calculated', 'field-manual', 'field-mode-transition');
        if (source === 'auto') {
            el.classList.add('field-auto-calculated', 'field-mode-transition');
            el.readOnly = true;
            el.style.cursor = 'default';
            el.setAttribute('aria-readonly', 'true');
            el.style.userSelect = 'text';
        } else if (source === 'manual') {
            el.classList.add('field-manual', 'field-mode-transition');
            el.readOnly = false;
            el.style.cursor = 'text';
            el.removeAttribute('aria-readonly');
        }
        const badge = el.parentElement?.querySelector('.source-badge');
        if (badge) { badge.className = `source-badge ${source}`; badge.textContent = source === 'auto' ? 'calculé' : 'manuel'; }
    }

    function toggleLink(linkName, btn, source, target, isResultToManual = false) {
        const state = AppState.currentLinkState;
        state[linkName] = !state[linkName];
        btn.classList.toggle('linked', state[linkName]);
        btn.setAttribute('aria-pressed', state[linkName] ? 'true' : 'false');
        if (state[linkName]) {
            let sourceVal = (source.value !== undefined) ? source.value : source.innerText;
            if (sourceVal === undefined || sourceVal === null) return;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
                target.value = sourceVal;
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                target.innerText = sourceVal;
            }
        }
    }

    function toggleGndLink(linkName, btn, source, target) {
        const state = AppState.gndLinkState;
        state[linkName] = !state[linkName];
        btn.classList.toggle('linked', state[linkName]);
        btn.setAttribute('aria-pressed', state[linkName] ? 'true' : 'false');
        if (state[linkName]) {
            let sourceVal = (source.value !== undefined) ? source.value : source.innerText;
            if (sourceVal === undefined || sourceVal === null) return;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
                target.value = sourceVal;
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                target.innerText = sourceVal;
            }
        }
    }

    function toggleIfLink(linkName, btn, source, target) {
        const state = AppState.ifLinkState;
        state[linkName] = !state[linkName];
        btn.classList.toggle('linked', state[linkName]);
        btn.setAttribute('aria-pressed', state[linkName] ? 'true' : 'false');
        if (state[linkName]) {
            let sourceVal = (source.value !== undefined) ? source.value : source.innerText;
            if (sourceVal === undefined || sourceVal === null) return;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
                target.value = sourceVal;
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                target.innerText = sourceVal;
            }
        }
    }

    function updateSaveStatus(status, message) {
        const indicator = getDomElement('saveIndicator');
        const timeEl = getDomElement('lastSaveTime');
        if (!indicator) return;
        indicator.classList.remove('saved', 'saving', 'error');
        if (status === 'saved') {
            indicator.classList.add('saved');
            indicator.setAttribute('aria-label', 'Sauvegarde réussie');
            if (timeEl) timeEl.textContent = 'Dernière sauvegarde : ' + new Date().toLocaleTimeString();
        } else if (status === 'saving') {
            indicator.classList.add('saving');
            indicator.setAttribute('aria-label', 'Sauvegarde en cours...');
            if (timeEl) timeEl.textContent = 'Sauvegarde en cours...';
        } else if (status === 'error') {
            indicator.classList.add('error');
            indicator.setAttribute('aria-label', 'Erreur de sauvegarde');
            if (timeEl) timeEl.textContent = '⚠️ Erreur sauvegarde';
            showToast('❌ Échec de la sauvegarde', 'error');
        }
    }

    // ============================================================
    // displayCPResults
    // ============================================================
    function displayCPResults(results) {
        if (!results) {
            console.warn('displayCPResults: Aucun résultat à afficher');
            return;
        }

        const placeholder = getDomElement('cpCalcPlaceholder');
        const resultsContent = getDomElement('cpCalcResultsContent');
        const resCurrent = getDomElement('resCurrent');
        const resIRDrop = getDomElement('resIRDrop');
        const resResistance = getDomElement('resResistance');
        const resEffectiveArea = getDomElement('resEffectiveArea');
        const tableBody = getDomElement('cpCalcTableBody');
        const refEl = getDomElement('cpCalcRef');

        const updates = [
            () => { if (placeholder) placeholder.classList.add('hidden'); },
            () => { if (resultsContent) resultsContent.classList.remove('hidden'); },
            () => { if (resCurrent) resCurrent.innerText = (results.current || 0).toFixed(3); },
            () => { if (resIRDrop) resIRDrop.innerText = (results.irDrop || 0).toFixed(3); },
            () => { if (resResistance) resResistance.innerText = (results.R_total || 0).toFixed(4); },
            () => { if (resEffectiveArea) resEffectiveArea.innerText = (results.exposedArea || 0).toFixed(2); },
            () => { if (refEl) refEl.innerText = results.norm || 'ISO 15589-1 / NACE SP0169'; }
        ];

        if (window.requestAnimationFrame) {
            requestAnimationFrame(() => updates.forEach(fn => fn()));
        } else {
            updates.forEach(fn => fn());
        }

        if (tableBody) {
            let html = '';
            const rows = [
                { label: 'Courant de protection', value: (results.current || 0).toFixed(3), unit: 'A', formula: 'I = S × (1-ε) × DF × k × J / 1000' },
                { label: 'Surface exposée (défauts)', value: (results.exposedArea || 0).toFixed(2), unit: 'm²', formula: 'S_exp = S × (1-ε) × DF × k' },
                { label: 'Résistance d\'anode (Dwight)', value: (results.R_anode || 0).toFixed(4), unit: 'Ω', formula: 'R = ρ/(2πL) × [ln(4L/d) - 1]' },
                { label: 'Résistance des câbles', value: (results.R_cable || 0).toFixed(4), unit: 'Ω', formula: 'R = 2 × ρ_cu × L / S (aller-retour)' },
                { label: 'Résistance de structure', value: (results.R_struct || 0).toFixed(4), unit: 'Ω', formula: 'Paramètre utilisateur' },
                { label: 'Résistance totale du circuit', value: (results.R_total || 0).toFixed(4), unit: 'Ω', formula: 'R_total = R_anode + R_cable + R_struct' },
                { label: 'IR Drop', value: (results.irDrop || 0).toFixed(3), unit: 'V', formula: 'IR = I × R_total' },
                { label: 'Potentiel ON requis', value: (results.requiredOnMv || 0).toFixed(0), unit: 'mV vs Cu/CuSO₄', formula: 'V_ON = V_OFF_cible - IR' }
            ];
            rows.forEach(row => {
                html += `<tr>
                    <td>${row.label}</td>
                    <td>${row.value}</td>
                    <td>${row.unit}</td>
                    <td style="font-size:0.75rem; color:var(--text-muted);">${row.formula}</td>
                </tr>`;
            });
            tableBody.innerHTML = html;
        }
    }

    // ============================================================
    // displayRectifierResults
    // ============================================================
    function displayRectifierResults(rectifier) {
        if (!rectifier) {
            console.warn('displayRectifierResults: Aucun résultat de redresseur à afficher');
            return;
        }
        const currentEl = getDomElement('rectCurrent');
        const tensionEl = getDomElement('rectTension');
        const powerEl = getDomElement('rectPower');
        const kpiCurrent = getDomElement('kpiCurrent');

        const requirements = rectifier.calculatedRequirements || {};
        const selected = rectifier.transformerRectifierSelection?.selected || null;
        const currentVal = selected?.nominalCurrent || 0;
        const tensionVal = selected?.nominalVoltage || 0;
        const powerVal = selected?.nominalPower || 0;
        const statusEl = getDomElement('rectifierSelectionStatus');
        const modelEl = getDomElement('rectifierSelectedModel');
        const detailsEl = getDomElement('rectifierSelectedDetails');
        const traceEl = getDomElement('rectifierSelectionTrace');
        const selectionStatus = rectifier.transformerRectifierSelection?.status || 'NO_SELECTION';

        if (currentEl) currentEl.innerText = currentVal.toFixed(1) + ' A';
        if (tensionEl) tensionEl.innerText = tensionVal.toFixed(1) + ' V';
        if (powerEl) powerEl.innerText = powerVal.toFixed(0) + ' W';
        if (statusEl) statusEl.innerText = selectionStatus === 'COMPATIBLE'
            ? 'Compatible avec le besoin calculé' : 'TR non sélectionné';
        if (modelEl) modelEl.innerText = selected
            ? `${selected.manufacturer} ${selected.model}`.trim()
            : 'Catalogue à compléter / valider';
        if (detailsEl) detailsEl.innerText = selected
            ? [selected.supplyVoltage, selected.phases ? `${selected.phases} phases` : null,
                selected.frequencyHz ? `${selected.frequencyHz} Hz` : null,
                selected.technology, selected.regulation, selected.cooling,
                selected.enclosureProtection].filter(Boolean).join(' | ')
            : '—';
        if (traceEl) traceEl.innerText = rectifier.transformerRectifierSelection?.trace ||
            `Besoin : ${Number(requirements.current || 0).toFixed(2)} A / ` +
            `${Number(requirements.voltage || 0).toFixed(1)} V / ` +
            `${Number(requirements.power || 0).toFixed(0)} W`;
        if (traceEl && requirements.currentSourceLabel) {
            traceEl.innerText = `Courant ICCP : ${requirements.currentSourceLabel}. ` + traceEl.innerText;
        }
        if (traceEl && !selected) {
            const rejected = rectifier.transformerRectifierSelection?.rejectedCandidates || [];
            const maxVoltage = rejected.reduce((max, item) => Math.max(max, Number(item.nominalVoltage) || 0), 0);
            const reason = maxVoltage > 0 && maxVoltage < Number(requirements.voltage || 0)
                ? ` Tension insuffisante dans le catalogue : maximum ${maxVoltage.toFixed(0)} V pour ${Number(requirements.voltage).toFixed(1)} V requis.`
                : '';
            traceEl.innerText += reason;
        }
        if (kpiCurrent && requirements.current) {
            kpiCurrent.innerText = Number(requirements.current).toFixed(2);
        }
    }

    // ============================================================
    // Rendu des systèmes
    // ============================================================
    function renderSystems() {
        const container = getDomElement('systemsContainer');
        if (!container) return;
        if (_systemClickHandler) {
            container.removeEventListener('click', _systemClickHandler);
            _systemClickHandler = null;
        }
        const systems = ProjectManager.getSystems();
        if (systems.length === 0) {
            container.innerHTML = '<div class="info-message" role="status" aria-live="polite">Aucun système défini. Ajoutez un système pour suivre les redresseurs et les équipements associés.</div>';
            return;
        }

        const fragment = document.createDocumentFragment();
        const cardCache = new Map();

        systems.forEach(sys => {
            const equipments = ProjectManager.getSystemEquipment(sys.id);
            const totalCurrent = ProjectManager.getSystemTotalCurrent(sys.id);
            const typeLabel = sys.type === 'iccp' ? 'ICCP' : (sys.type === 'anodes' ? 'Anodes' : 'Mixte');
            const isActive = (sys.id === ProjectManager.getCurrentSystemId());

            let card = cardCache.get(sys.id);
            if (card && card._version === sys.updatedAt) {
                fragment.appendChild(card.cloneNode(true));
                return;
            }

            card = document.createElement('div');
            card.className = 'system-card';
            if (isActive) { card.style.borderColor = 'var(--accent-cyan)'; }
            card.dataset.systemId = sys.id;
            card.setAttribute('role', 'article');
            card.setAttribute('aria-label', `Système ${sys.name}`);

            const header = document.createElement('div');
            header.className = 'system-card-header';
            const nameSpan = document.createElement('span');
            let gbInfo = '';
            if (sys.type === 'iccp' && sys.groundbedId) {
                const gb = ProjectManager.getGroundbedById(sys.groundbedId);
                gbInfo = ` - Puits: ${gb ? gb.name : '?'}`;
            }
            nameSpan.innerHTML = `<h4><i class="fas fa-microchip" aria-hidden="true"></i> ${Utils.escapeHtml(sys.name)} ${isActive ? ' <span class="badge success">Actif</span>' : ''}${gbInfo}</h4>`;
            header.appendChild(nameSpan);
            const div = document.createElement('div');
            div.innerHTML = `
                <span class="badge info">${typeLabel}</span>
                <span class="badge ${totalCurrent > 0 ? 'success' : 'warning'}">${totalCurrent.toFixed(2)} A</span>
                <button class="btn btn-sm btn-primary" data-action="set-active" data-id="${sys.id}" title="Définir comme système actif" aria-label="Définir ${sys.name} comme système actif"><i class="fas fa-check" aria-hidden="true"></i></button>
                <button class="btn btn-sm btn-danger" data-action="delete-system" data-id="${sys.id}" title="Supprimer le système" aria-label="Supprimer le système ${sys.name}"><i class="fas fa-trash" aria-hidden="true"></i></button>
            `;
            header.appendChild(div);
            card.appendChild(header);

            const equipList = document.createElement('div');
            equipList.className = 'system-equip-list';
            equipList.innerHTML = `<strong>Équipements associés :</strong> ${equipments.length > 0 ? equipments.map(eq => `<span class="equip-tag">${Utils.escapeHtml(eq.tag)}</span>`).join(', ') : 'Aucun'}`;
            card.appendChild(equipList);

            const actions = document.createElement('div');
            actions.className = 'system-actions';
            actions.innerHTML = `<button class="btn btn-sm btn-info" data-action="add-rectifier" data-system-id="${sys.id}" aria-label="Ajouter un redresseur au système ${sys.name}"><i class="fas fa-plus" aria-hidden="true"></i> Ajouter redresseur</button>`;
            card.appendChild(actions);

            if (sys.rectifiers && sys.rectifiers.length > 0) {
                const rectTitle = document.createElement('div');
                rectTitle.style.marginTop = '0.5rem';
                rectTitle.innerHTML = '<strong>Redresseurs :</strong>';
                card.appendChild(rectTitle);
                sys.rectifiers.forEach(r => {
                    const rectItem = document.createElement('div');
                    rectItem.className = 'rectifier-item';
                    rectItem.dataset.rectifierId = r.id;
                    rectItem.setAttribute('role', 'listitem');
                    rectItem.innerHTML = `
                        <span class="rectifier-name">${Utils.escapeHtml(r.name)}</span>
                        ${r.model ? `<span class="rectifier-model">${Utils.escapeHtml(r.manufacturer ? r.manufacturer + ' - ' + r.model : r.model)}</span>` : ''}
                        <span class="rectifier-status ${r.status}">${r.status === 'on' ? '🟢 Marche' : r.status === 'off' ? '🔴 Arrêt' : '🟡 Alarme'}</span>
                        <div class="rectifier-params">
                            <span>${Utils.safeNumber(r.current).toFixed(1)} A</span>
                            <span>${Utils.safeNumber(r.voltage).toFixed(1)} V</span>
                            <span>${Utils.safeNumber(r.power).toFixed(0)} W</span>
                        </div>
                        ${r.technicalCharacteristics ? `<div class="rectifier-technical-details">${Utils.escapeHtml([
                            r.technicalCharacteristics.supplyVoltage,
                            r.technicalCharacteristics.phases ? `${r.technicalCharacteristics.phases} phases` : null,
                            r.technicalCharacteristics.frequencyHz ? `${r.technicalCharacteristics.frequencyHz} Hz` : null,
                            r.technicalCharacteristics.technology,
                            r.technicalCharacteristics.regulation,
                            r.technicalCharacteristics.cooling,
                            r.technicalCharacteristics.enclosureProtection
                        ].filter(Boolean).join(' | '))}</div>` : ''}
                        <button class="btn btn-sm btn-secondary" data-action="rectifier-status" data-system-id="${sys.id}" data-rectifier-id="${r.id}" data-status="on" title="Mettre en marche" aria-label="Mettre en marche ${r.name}">▶</button>
                        <button class="btn btn-sm btn-secondary" data-action="rectifier-status" data-system-id="${sys.id}" data-rectifier-id="${r.id}" data-status="off" title="Arrêter" aria-label="Arrêter ${r.name}">⏹</button>
                        <button class="btn btn-sm btn-secondary" data-action="rectifier-status" data-system-id="${sys.id}" data-rectifier-id="${r.id}" data-status="alarm" title="Alarme" aria-label="Déclencher l'alarme sur ${r.name}">⚠</button>
                        <button class="btn btn-sm btn-danger" data-action="delete-rectifier" data-system-id="${sys.id}" data-rectifier-id="${r.id}" title="Supprimer" aria-label="Supprimer le redresseur ${r.name}"><i class="fas fa-trash" aria-hidden="true"></i></button>
                    `;
                    card.appendChild(rectItem);
                });
            }

            card._version = sys.updatedAt;
            cardCache.set(sys.id, card);
            fragment.appendChild(card);
        });

        container.innerHTML = '';
        container.appendChild(fragment);

        _systemClickHandler = handleSystemContainerClick;
        container.addEventListener('click', _systemClickHandler);
    }

    function handleSystemContainerClick(e) {
        const target = e.target.closest('button[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        const systemId = target.dataset.id || target.dataset.systemId;
        const rectifierId = target.dataset.rectifierId;
        const status = target.dataset.status;

        switch (action) {
            case 'delete-system':
                ProjectManager.deleteSystem(systemId);
                renderSystems();
                populateAllSystemSelectors();
                if (window.CPController && typeof window.CPController.updateDashboard === 'function') {
                    window.CPController.updateDashboard();
                }
                break;
            case 'set-active':
                ProjectManager.setCurrentSystemId(systemId);
                populateAllSystemSelectors();
                renderSystems();
                if (window.CPController && typeof window.CPController.updateDashboard === 'function') {
                    window.CPController.updateDashboard();
                }
                showToast('Système actif changé', 'info');
                break;
            case 'add-rectifier':
                addRectifierFromUI(systemId);
                break;
            case 'rectifier-status':
                ProjectManager.updateRectifierStatus(systemId, rectifierId, status);
                renderSystems();
                break;
            case 'delete-rectifier':
                ProjectManager.deleteRectifier(systemId, rectifierId);
                renderSystems();
                break;
        }
    }

    function addRectifierFromUI(systemId) {
        const sys = ProjectManager.getSystem(systemId);
        const name = prompt('Nom du redresseur :', 'Redresseur ' + ((sys?.rectifiers?.length || 0) + 1));
        if (name === null) return;
        const current = prompt('Courant de sortie (A) :', '0');
        const voltage = prompt('Tension (V) :', '0');
        const power = Utils.safeNumber(current) * Utils.safeNumber(voltage);
        ProjectManager.addRectifier(systemId, name || 'Redresseur', 'off', current, voltage, power);
        renderSystems();
        showToast(`Redresseur ${Utils.escapeHtml(name)} ajouté`, 'success');
    }

    // ============================================================
    // populateAllSystemSelectors
    // ============================================================
    function populateAllSystemSelectors() {
        const selectors = [
            'dashSystemSelector',
            'cpSystemSelector',
            'anodesSystemSelector',
            'iccpSystemSelector',
            'measSystemSelector',
            'gbSystemSelector',
            'ifSystemSelector',
            'historySystemSelector',
            'vis3dSystemSelector'
        ];
        const systems = ProjectManager.getSystems();
        const activeId = ProjectManager.getCurrentSystemId();

        selectors.forEach(id => {
            const sel = getDomElement(id);
            if (!sel) return;
            if (id === 'historySystemSelector' && !sel) {
                const container = document.querySelector('.history-filters');
                if (container) {
                    const newSel = document.createElement('select');
                    newSel.id = 'historySystemSelector';
                    newSel.className = 'tech-form';
                    container.appendChild(newSel);
                }
                return;
            }
            const currentVal = sel.value;
            sel.innerHTML = '';
            if (systems.length === 0) { sel.innerHTML = '<option value="">-- Aucun système --</option>'; return; }
            systems.forEach(sys => {
                const opt = document.createElement('option');
                opt.value = sys.id;
                opt.textContent = sys.name + ' (' + (sys.type || 'mixte') + ')';
                sel.appendChild(opt);
            });
            if (currentVal && systems.find(s => s.id === currentVal)) { sel.value = currentVal; }
            else if (activeId && systems.find(s => s.id === activeId)) { sel.value = activeId; }
            else if (systems.length > 0) { sel.value = systems[0].id; }
        });

        const module3d = getDomElement('module-visualisation3d');
        if (module3d && module3d.classList.contains('active')) {
            const sysId = getDomElement('vis3dSystemSelector')?.value;
        }
    }

    // ============================================================
    // populateVis3dSystemSelector
    // ============================================================
    function populateVis3dSystemSelector() {
        const sel = getDomElement('vis3dSystemSelector');
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = '';

        const optAll = document.createElement('option');
        optAll.value = '';
        optAll.textContent = '-- Tous les équipements --';
        sel.appendChild(optAll);

        const systems = ProjectManager.getSystems();
        if (systems.length === 0) {
        } else {
            systems.forEach(sys => {
                const opt = document.createElement('option');
                opt.value = sys.id;
                opt.textContent = sys.name + ' (' + (sys.type || 'mixte') + ')';
                sel.appendChild(opt);
            });
        }

        if (currentVal && systems.find(s => s.id === currentVal)) {
            sel.value = currentVal;
        } else if (ProjectManager.getCurrentSystemId() && systems.find(s => s.id === ProjectManager.getCurrentSystemId())) {
            sel.value = ProjectManager.getCurrentSystemId();
        } else {
            sel.value = '';
        }

        if (window.Gis3D && typeof window.Gis3D.setSystemFilter === 'function') {
            window.Gis3D.setSystemFilter(sel.value || null);
        }
        if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
            window.Gis3D.loadData();
        }
    }

    // ============================================================
    // Groundbed UI
    // ============================================================
    function renderGroundbedList() {
        const container = getDomElement('groundbedListContainer');
        if (!container) return;
        const groundbeds = ProjectManager.getGroundbeds();
        if (groundbeds.length === 0) {
            container.innerHTML = '<div class="info-message" role="status" aria-live="polite">Aucun puits anodique défini. Créez-en un pour commencer.</div>';
            return;
        }

        const fragment = document.createDocumentFragment();
        groundbeds.forEach(gb => {
            const params = gb.parameters || {};
            const results = gb.results || {};
            const card = document.createElement('div');
            card.className = 'groundbed-card';
            card.dataset.id = gb.id;
            card.setAttribute('role', 'listitem');
            card.setAttribute('aria-label', `Puits ${Utils.escapeHtml(gb.name)}`);

            card.innerHTML = `
                <div class="gb-header">
                    <span class="gb-name">${Utils.escapeHtml(gb.name)}</span>
                    <span class="gb-version">v${gb.version}</span>
                </div>
                <div class="gb-details">
                    <span>Prof. ${params.totalDepth || '—'} m</span>
                    <span>Rés. ${results.R_total ? results.R_total.toFixed(3) : '—'} Ω</span>
                    <span>I ${results.I_total ? results.I_total.toFixed(2) : '—'} A</span>
                    <span>Vie ${(results.lifeDesign || (results.lifeWithSafety ? Math.min(results.lifeWithSafety, 25) : 0) || 0).toFixed(1)} ans</span>
                </div>
                <div class="gb-actions">
                    <button class="btn btn-sm btn-info" data-action="edit-groundbed" data-id="${gb.id}" aria-label="Éditer le puits ${Utils.escapeHtml(gb.name)}">Éditer</button>
                    <button class="btn btn-sm btn-success" data-action="select-groundbed" data-id="${gb.id}" aria-label="Sélectionner le puits ${Utils.escapeHtml(gb.name)}">Sélectionner</button>
                    <button class="btn btn-sm btn-danger" data-action="delete-groundbed" data-id="${gb.id}" aria-label="Supprimer le puits ${Utils.escapeHtml(gb.name)}">Supprimer</button>
                </div>
            `;
            fragment.appendChild(card);
        });
        container.innerHTML = '';
        container.appendChild(fragment);

        container.querySelectorAll('[data-action="edit-groundbed"]').forEach(btn => {
            btn.addEventListener('click', () => openGroundbedForm(btn.dataset.id));
        });
        container.querySelectorAll('[data-action="delete-groundbed"]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (confirm('Supprimer ce puits ?')) {
                    ProjectManager.deleteGroundbed(btn.dataset.id);
                    renderGroundbedList();
                    populateICCPGroundbedSelectors();
                    showToast('Puits supprimé', 'warning');
                }
            });
        });
        container.querySelectorAll('[data-action="select-groundbed"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const sysId = ProjectManager.getCurrentSystemId();
                if (sysId) {
                    const sys = ProjectManager.getSystem(sysId);
                    if (sys && sys.type === 'iccp') {
                        sys.groundbedId = btn.dataset.id;
                        ProjectManager.saveCurrentProject();
                        populateICCPGroundbedSelectors();
                        showToast('Puits associé au système actif', 'success');
                    } else {
                        showToast('Le système actif n\'est pas de type ICCP', 'warning');
                    }
                } else {
                    showToast('Aucun système actif', 'warning');
                }
            });
        });
    }

    function openGroundbedForm(groundbedId) {
        const formCard = getDomElement('gbFormCard');
        const title = getDomElement('gbFormTitle');
        const editIdField = getDomElement('gbEditId');
        const nameField = getDomElement('gbName');
        if (!formCard) return;
        formCard.style.display = 'block';
        if (groundbedId) {
            const gb = ProjectManager.getGroundbedById(groundbedId);
            if (!gb) { showToast('Puits introuvable', 'error'); return; }
            title.innerText = 'Éditer le puits';
            editIdField.value = gb.id;
            nameField.value = gb.name;
            const params = gb.parameters || {};
            setSelectValue('gbSoilResistivity', params.rho);
            setSelectValue('gbTotalDepth', params.totalDepth);
            if (params.diameter) {
                setSelectValue('gbDiameter', params.diameter * 1000);
            }
            setSelectValue('gbActiveDepth', params.activeDepth);
            setSelectValue('gbAnodeCount', params.anodeCount);
            setSelectValue('gbAnodeLength', params.anodeLength);
            if (params.anodeDiameter) {
                let diam = params.anodeDiameter;
                if (diam > 10000) {
                    console.warn('[UI] Diamètre anode corrompu détecté (' + diam + '), réinitialisé à 75 mm');
                    diam = 75;
                }
                setSelectValue('gbAnodeDiameter', diam);
            }
            setSelectValue('gbAnodeWeight', params.anodeWeight);
            setSelectValue('gbAnodeCapacity', params.anodeCapacity);
            setSelectValue('gbCableLength', params.cableLength);
            setSelectValue('gbCableSection', params.cableSection);
            setSelectValue('gbAgingFactor', params.agingFactor);
            setSelectValue('gbSafetyFactor', params.safetyFactor);
            setSelectValue('gbTargetCurrent', params.targetCurrent);

            // BUG-CP-004 : restaurer le matériau d'anode sélectionné
            //              (si le champ existe et si params.anodeMaterial est défini)
            if (params.anodeMaterial) {
                const anodeMatEl = getDomElement('gbAnodeMaterial');
                if (anodeMatEl) {
                    // Vérifie que l'option existe avant d'affecter
                    const hasOpt = Array.from(anodeMatEl.options)
                        .some(o => o.value === params.anodeMaterial);
                    if (hasOpt) {
                        anodeMatEl.value = params.anodeMaterial;
                    }
                }
            }
            if (params.layers && params.layers.length > 0) {
                getDomElement('gbSoilLayers').value = params.layers.join(', ');
            }
            if (gb.results && gb.results.R_total) {
                displayGroundbedResults(gb.results, params.totalDepth, params.activeDepth, params.anodeCount, params.anodeLength);
                getDomElement('gbResultsCard').style.display = 'block';
            }
        } else {
            title.innerText = 'Créer un puits';
            editIdField.value = '';
            nameField.value = 'Puits anodique ' + (ProjectManager.getGroundbeds().length + 1);
            document.querySelectorAll('#groundbedForm input, #groundbedForm select').forEach(el => {
                if (el.id && el.id !== 'gbName' && el.id !== 'gbEditId') {
                    if (el.type === 'number' || el.type === 'text') el.value = '';
                    else if (el.tagName === 'SELECT') el.selectedIndex = 0;
                }
            });
            getDomElement('gbResultsCard').style.display = 'none';
        }
        formCard.scrollIntoView({ behavior: 'smooth' });
    }

    function populateICCPGroundbedSelectors() {
        const select = getDomElement('iccpGroundbedSelector');
        if (!select) return;
        const currentVal = select.value;
        select.innerHTML = '<option value="">-- Aucun --</option>';
        const groundbeds = ProjectManager.getGroundbeds();
        groundbeds.forEach(gb => {
            const opt = document.createElement('option');
            opt.value = gb.id;
            opt.textContent = `${gb.name} (v${gb.version})`;
            select.appendChild(opt);
        });
        const activeSys = ProjectManager.getActiveSystem();
        if (activeSys && activeSys.type === 'iccp' && activeSys.groundbedId) {
            if (groundbeds.find(g => g.id === activeSys.groundbedId)) {
                select.value = activeSys.groundbedId;
            }
        } else if (currentVal && groundbeds.find(g => g.id === currentVal)) {
            select.value = currentVal;
        }
    }

    // ============================================================
    // Équipements – pagination, refresh
    // ============================================================
    function isIndividualCPEquipment(equipment) {
        if (!equipment) return false;
        return !['groundbed', 'rectifier', 'anode', 'testpost'].includes(
            String(equipment.type || '').toLowerCase()
        );
    }

    function getEquipmentDiameterDisplay(equipment) {
        if (!equipment) return '—';
        const type = String(equipment.type || '').toLowerCase();
        const diameterMeters = Number(equipment.dimensions?.diametre_m);
        if (!Number.isFinite(diameterMeters) || diameterMeters <= 0) return '—';

        // 1. Pipelines : affichage toujours en pouces arrondi proprement (ex: 12", 10", 24" au lieu de 12.01")
        if (['pipeline_enterre', 'pipeline_offshore', 'pipeline'].includes(type)) {
            const rawInches = diameterMeters / 0.0254;
            const nearestInt = Math.round(rawInches);
            // Si la valeur est très proche d'un entier nominal (écart < 0.03"), afficher l'entier exact
            if (Math.abs(rawInches - nearestInt) < 0.03) {
                return `${nearestInt}"`;
            }
            // Sinon afficher avec au maximum 2 décimales sans zéros inutiles
            const formatted = parseFloat(rawInches.toFixed(2));
            return `${formatted}"`;
        }

        // 2. Réservoirs / Tanks : affichage toujours en millimètres (ex: 20 000 mm)
        if (['reservoir_fond', 'reservoir_toit', 'ballon_souterrain', 'tank', 'reservoir'].includes(type)) {
            const mm = Math.round(diameterMeters * 1000);
            return `${mm.toLocaleString('fr-FR')} mm`;
        }

        // Autres équipements disposant d'un diamètre
        const mm = Math.round(diameterMeters * 1000);
        return `${mm.toLocaleString('fr-FR')} mm`;
    }

    function getPipelineDiameterInches(equipment) {
        return getEquipmentDiameterDisplay(equipment);
    }

    function refreshEquipmentList(resetFilter) {
        if (resetFilter) _equipCurrentPage = 1;
        refreshEquipmentListUI(resetFilter);
    }

    async function refreshEquipmentListUI(resetFilter) {
        const filterProj = getDomElement('filterEquipProject')?.value || '';

        if (resetFilter) {
            _equipFilterProject = '';
            const filterSelect = getDomElement('filterEquipProject');
            if (filterSelect) filterSelect.value = '__all__';
        } else {
            _equipFilterProject = (filterProj === '__all__' || filterProj === '') ? '' : filterProj;
        }

        let eqs = ProjectManager.getState().equipments;
        if (_equipFilterProject && _equipFilterProject !== '__all__' && _equipFilterProject !== '') {
            eqs = eqs.filter(e => e.projectId === _equipFilterProject);
            console.log('[UI] Filtrage par projet:', _equipFilterProject, eqs.length);
        } else {
            console.log('[UI] Affichage de tous les équipements:', eqs.length);
        }
        _equipFilteredData = eqs;

        const tbody = getDomElement('equipmentsTableBody');
        if (!tbody) return;

        const totalItems = _equipFilteredData.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / EQUIP_PAGE_SIZE));
        if (_equipCurrentPage > totalPages) _equipCurrentPage = totalPages;
        if (_equipCurrentPage < 1) _equipCurrentPage = 1;

        const startIdx = (_equipCurrentPage - 1) * EQUIP_PAGE_SIZE;
        const endIdx = Math.min(startIdx + EQUIP_PAGE_SIZE, totalItems);
        const pageItems = _equipFilteredData.slice(startIdx, endIdx);

        const fragment = document.createDocumentFragment();
        let totalSurface = 0;
        let totalIncluded = 0;
        const systems = ProjectManager.getSystems();

        pageItems.forEach(eq => {
            const tr = document.createElement('tr');
            const isIndividualCP = isIndividualCPEquipment(eq);
            const currentVal = (isIndividualCP && eq.cpData && eq.cpData.calculated && eq.cpData.results && typeof eq.cpData.results.currentAmperes === 'number')
                ? eq.cpData.results.currentAmperes.toFixed(3)
                : '-';
            const statusBadge = !isIndividualCP
                ? '<span class="badge">Composant système</span>'
                : (eq.cpData && eq.cpData.calculated)
                    ? '<span class="badge success">Calculé</span>'
                    : '<span class="badge info">Non calculé</span>';
            const system = systems.find(s => s.id === eq.systemId);
            const systemName = system ? system.name : '-';
            const actions = `<div class="actions-cell">
                ${isIndividualCP ? `<button class="btn btn-sm btn-primary calc-equip-cp" data-id="${eq.id}" title="Calculer CP pour cet équipement" aria-label="Calculer CP pour ${Utils.escapeHtml(eq.tag)}"><i class="fas fa-calculator" aria-hidden="true"></i></button>` : ''}
                <button type="button" class="btn btn-sm btn-info equip-edit-btn" data-id="${eq.id}" title="Modifier cet équipement" aria-label="Modifier ${Utils.escapeHtml(eq.tag)}"><i class="fas fa-edit" aria-hidden="true"></i> Modifier</button>
                <button class="btn btn-sm btn-danger delete-equip" data-id="${eq.id}" title="Supprimer" aria-label="Supprimer ${Utils.escapeHtml(eq.tag)}"><i class="fas fa-trash" aria-hidden="true"></i></button>
            </div>`;
            const includedCheck = `<input class="equip-include" data-id="${eq.id}" type="checkbox" ${eq.included !== false ? 'checked' : ''} aria-label="Inclure ${Utils.escapeHtml(eq.tag)} dans les calculs">`;
            tr.innerHTML = `
                <td>${includedCheck}</td>
                <td>${Utils.escapeHtml(eq.tag)}</td>
                <td>${Utils.escapeHtml(eq.type)}</td>
                <td>${getEquipmentDiameterDisplay(eq)}</td>
                <td>${eq.surface || '-'}</td>
                <td>${Utils.escapeHtml(eq.projectId || '-')}</td>
                <td>${Utils.escapeHtml(systemName)}</td>
                <td>${currentVal}</td>
                <td>${statusBadge}</td>
                <td>${actions}</td>
            `;
            const btnCalc = tr.querySelector('.calc-equip-cp');
            if (btnCalc) { btnCalc.addEventListener('click', (e) => { e.stopPropagation(); const id = btnCalc.dataset.id; calculateEquipmentCP(id); }); }
            const btnEdit = tr.querySelector('.equip-edit-btn');
            if (btnEdit) { btnEdit.addEventListener('click', (e) => { e.stopPropagation(); const id = btnEdit.dataset.id; editEquipment(id); }); }
            const btnDel = tr.querySelector('.delete-equip');
            if (btnDel) { btnDel.addEventListener('click', (e) => { e.stopPropagation(); const id = btnDel.dataset.id; deleteEquipment(id); }); }
            const chk = tr.querySelector('.equip-include');
            if (chk) {
                chk.addEventListener('change', function() {
                    const eqId = this.dataset.id;
                    const eqFound = ProjectManager.getState().equipments.find(e => e.id === eqId);
                    if (eqFound) {
                        eqFound.included = this.checked;
                        StorageManager.saveEquipment(eqFound);
                        if (window.CPController) {
                            if (typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
                            if (typeof window.CPController.updateAnodeCurrentSource === 'function') window.CPController.updateAnodeCurrentSource();
                            if (typeof window.CPController.updateICCPCurrentSource === 'function') window.CPController.updateICCPCurrentSource();
                            if (typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
                        }
                        showToast(`Équipement ${Utils.escapeHtml(eqFound.tag)} ${this.checked ? 'inclus' : 'exclu'}`, 'info');
                    }
                });
            }
            fragment.appendChild(tr);
            const canonicalSurface = getCanonicalEquipmentSurface(eq);
            totalSurface += canonicalSurface;
            if (eq.included !== false) totalIncluded += canonicalSurface;
        });
        tbody.innerHTML = '';
        tbody.appendChild(fragment);

        const sumDisplay = getDomElement('sumEquipSurfaceDisplay');
        if (sumDisplay) sumDisplay.innerText = `Surface cumulée: ${totalSurface.toFixed(1)} m² (inclus: ${totalIncluded.toFixed(1)} m²)`;

        updatePaginationControls(totalItems, totalPages);

        const filterSelect = getDomElement('filterEquipProject');
        if (filterSelect) {
            const currentVal = resetFilter ? '__all__' : _equipFilterProject || '__all__';
            filterSelect.innerHTML = '<option value="__all__">Tous les projets</option>';
            ProjectManager.getProjectsList().forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = `${p.id} - ${p.name}`;
                filterSelect.appendChild(opt);
            });
            if (currentVal === '__all__' || currentVal === '') {
                filterSelect.value = '__all__';
            } else if (ProjectManager.getProjectsList().some(p => p.id === currentVal)) {
                filterSelect.value = currentVal;
            } else {
                filterSelect.value = '__all__';
            }
            _equipFilterProject = (filterSelect.value === '__all__' || filterSelect.value === '') ? '' : filterSelect.value;
        }

        refreshEquipmentListInCP();
        if (window.CPController) {
            if (typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
            if (typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
            if (typeof window.CPController.refreshMapPointsTable === 'function') window.CPController.refreshMapPointsTable();
        }
        populateCPEquipmentSelector();
    }

    function updatePaginationControls(totalItems, totalPages) {
        const container = getDomElement('equipPaginationContainer');
        if (!container) {
            const tableContainer = document.querySelector('.table-container');
            if (tableContainer) {
                const paginationDiv = document.createElement('div');
                paginationDiv.id = 'equipPaginationContainer';
                paginationDiv.className = 'pagination-container';
                paginationDiv.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-top:0.5rem; padding:0.5rem; flex-wrap:wrap; gap:0.5rem;';
                tableContainer.after(paginationDiv);
            }
        }
        const pagContainer = getDomElement('equipPaginationContainer');
        if (!pagContainer) return;
        if (totalItems === 0) {
            pagContainer.innerHTML = `<span style="color:var(--text-muted);">Aucun équipement</span>`;
            return;
        }
        const start = (_equipCurrentPage - 1) * EQUIP_PAGE_SIZE + 1;
        const end = Math.min(_equipCurrentPage * EQUIP_PAGE_SIZE, totalItems);
        pagContainer.innerHTML = `
            <span style="color:var(--text-secondary); font-size:0.85rem;">
                Affichage ${start} - ${end} sur ${totalItems} équipements
            </span>
            <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
                <button class="btn btn-sm btn-secondary equip-prev-page touch-target" ${_equipCurrentPage <= 1 ? 'disabled' : ''} aria-label="Page précédente">
                    <i class="fas fa-chevron-left" aria-hidden="true"></i>
                </button>
                <span style="font-size:0.85rem; color:var(--text-secondary);">
                    Page ${_equipCurrentPage} / ${totalPages}
                </span>
                <button class="btn btn-sm btn-secondary equip-next-page touch-target" ${_equipCurrentPage >= totalPages ? 'disabled' : ''} aria-label="Page suivante">
                    <i class="fas fa-chevron-right" aria-hidden="true"></i>
                </button>
            </div>
        `;
        const prevBtn = pagContainer.querySelector('.equip-prev-page');
        const nextBtn = pagContainer.querySelector('.equip-next-page');
        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                if (_equipCurrentPage > 1) {
                    _equipCurrentPage--;
                    refreshEquipmentListUI();
                }
            });
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                if (_equipCurrentPage < totalPages) {
                    _equipCurrentPage++;
                    refreshEquipmentListUI();
                }
            });
        }
    }

    function refreshEquipmentListInCP() {
        const container = getDomElement('equipmentListContent');
        if (!container) return;
        const projectEquipments = ProjectManager.getState().equipments.filter(eq => eq.projectId === ProjectManager.getCurrentProjectId());
        if (projectEquipments.length === 0) { container.innerHTML = '<div class="info-message" role="status"><i class="fas fa-info-circle" aria-hidden="true"></i> Aucun équipement pour ce projet. Ajoutez-en dans l\'onglet "Équipements".</div>'; return; }
        let html = '<ul role="list">';
        projectEquipments.forEach(eq => { const included = eq.included !== false ? '✅' : '🚫';
            const surface = getCanonicalEquipmentSurface(eq);
            const surfaceLabel = surface > 0 ? `<span class="equipment-surface">${surface.toFixed(1)} m²</span>` : '';
            html += `<li role="listitem"><span class="equipment-tag">${Utils.escapeHtml(eq.tag)}</span> ${surfaceLabel} ${included}</li>`; });
        html += '</ul>';
        container.innerHTML = html;
    }

    function refreshEquipmentProjectDropdown() {
        const equipProjectSelect = getDomElement('equipProjectId');
        if (!equipProjectSelect) return;
        equipProjectSelect.innerHTML = '<option value="">-- Sélectionner un projet --</option>';
        for (const proj of ProjectManager.getProjectsList()) { const option = document.createElement('option');
            option.value = proj.id;
            option.textContent = `${proj.id} - ${proj.name}`;
            equipProjectSelect.appendChild(option); }
        if (ProjectManager.getCurrentProjectId()) equipProjectSelect.value = ProjectManager.getCurrentProjectId();
        populateSystemDropdown();
    }

    function populateSystemDropdown() {
        const select = getDomElement('equipSystemId');
        if (!select) return;
        const currentVal = select.value;
        select.innerHTML = '<option value="">Aucun</option>';
        const systems = ProjectManager.getSystems();
        systems.forEach(sys => { const opt = document.createElement('option');
            opt.value = sys.id;
            opt.textContent = `${sys.name} (${sys.type})`;
            select.appendChild(opt); });
        if (currentVal && ProjectManager.getSystem(currentVal)) select.value = currentVal;
    }

    function populateCPEquipmentSelector() {
        const sel = getDomElement('cpEquipmentSelector');
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">-- Aucun (mode libre) --</option>';
        const eqs = ProjectManager.getState().equipments.filter(eq => eq.projectId === ProjectManager.getCurrentProjectId());
        eqs.forEach(eq => { const opt = document.createElement('option');
            opt.value = eq.id;
            opt.textContent = `${eq.tag} (${eq.type}) - ${eq.surface || 0} m²`;
            sel.appendChild(opt); });
        if (currentVal && eqs.find(e => e.id === currentVal)) sel.value = currentVal;
    }

    // ============================================================
    // Multi-points GPS
    // ============================================================
    function addEquipWaypointRow(lat, lon, alt, showRemove) {
        const container = getDomElement('equipWaypointsContainer');
        if (!container) return;

        const latVal = (lat !== undefined && lat !== null && !isNaN(parseFloat(lat))) ? parseFloat(lat) : '';
        const lonVal = (lon !== undefined && lon !== null && !isNaN(parseFloat(lon))) ? parseFloat(lon) : '';
        const altVal = (alt !== undefined && alt !== null && !isNaN(parseFloat(alt))) ? parseFloat(alt) : '';

        const row = document.createElement('div');
        row.className = 'waypoint-row';
        row.style.cssText = 'display:flex; gap:0.3rem; align-items:center; margin-bottom:0.3rem;';
        row.innerHTML = `
            <input type="number" step="0.000001" placeholder="Latitude" class="equip-wp-lat" value="${latVal}" style="flex:1; min-width:60px;" min="-90" max="90">
            <input type="number" step="0.000001" placeholder="Longitude" class="equip-wp-lon" value="${lonVal}" style="flex:1; min-width:60px;" min="-180" max="180">
            <input type="number" step="0.1" placeholder="Altitude" class="equip-wp-alt" value="${altVal}" style="flex:0.8; min-width:50px;">
            <button type="button" class="btn btn-sm btn-danger remove-wp-btn" style="${showRemove ? '' : 'display:none;'}"><i class="fas fa-trash"></i></button>
        `;
        container.appendChild(row);
        const removeBtn = row.querySelector('.remove-wp-btn');
        if (removeBtn) {
            removeBtn.addEventListener('click', function() {
                if (container.children.length > 1) {
                    row.remove();
                    updateEquipRemoveButtons();
                }
            });
        }

        const autoLenHandler = getAutoLengthDebounced();
        const latInput = row.querySelector('.equip-wp-lat');
        const lonInput = row.querySelector('.equip-wp-lon');
        if (latInput) latInput.addEventListener('input', autoLenHandler);
        if (lonInput) lonInput.addEventListener('input', autoLenHandler);

        updateEquipRemoveButtons();
    }

    function updateEquipRemoveButtons() {
        const container = getDomElement('equipWaypointsContainer');
        if (!container) return;
        const rows = container.querySelectorAll('.waypoint-row');
        rows.forEach((row) => {
            const btn = row.querySelector('.remove-wp-btn');
            if (btn) {
                btn.style.display = (rows.length > 1) ? '' : 'none';
            }
        });
    }

    function collectEquipWaypoints() {
        const container = getDomElement('equipWaypointsContainer');
        if (!container) return [];
        const rows = container.querySelectorAll('.waypoint-row');
        const waypoints = [];
        rows.forEach(row => {
            const lat = parseFloat(row.querySelector('.equip-wp-lat').value);
            const lon = parseFloat(row.querySelector('.equip-wp-lon').value);
            const alt = parseFloat(row.querySelector('.equip-wp-alt').value);
            if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                waypoints.push({ lat, lon, alt: isNaN(alt) ? null : alt });
            }
        });
        return waypoints;
    }

    function isEquipmentDuplicate(tag, projectId, excludeId) {
        if (!tag || !projectId) return false;
        const normalizedTag = tag.trim().toLowerCase();
        const state = ProjectManager.getState();
        return state.equipments.some(eq =>
            eq.projectId === projectId &&
            eq.tag && eq.tag.toLowerCase() === normalizedTag &&
            (excludeId ? eq.id !== excludeId : true)
        );
    }

    // ============================================================
    // editEquipment
    // ============================================================
    function activateEquipmentFormTab() {
        const formPanel = getDomElement('equip-form-panel');
        if (!formPanel) return;
        const tabsGroup = formPanel.closest('[data-tabs]');
        const formTab = tabsGroup?.querySelector('[data-tab-target="equip-form-panel"]');
        if (formTab) {
            formTab.click();
        } else {
            formPanel.classList.add('active');
            formPanel.hidden = false;
        }
    }

    function editEquipment(equipId) {
        const eq = ProjectManager.getState().equipments.find(e => e.id === equipId);
        if (!eq) { showToast('Équipement introuvable', 'error'); return; }

        activateEquipmentFormTab();

        getDomElement('editEquipId').value = eq.id;
        getDomElement('equipTag').value = eq.tag;
        getDomElement('equipType').value = eq.type;
        getDomElement('equipProjectId').value = eq.projectId;
        getDomElement('equipIncluded').checked = eq.included !== false;
        getDomElement('equipSystemId').value = eq.systemId || '';
        getDomElement('equipMaterial').value = eq.material || 'acier';
        getDomElement('equipWallThickness').value = eq.wallThickness || 8.0;
        getDomElement('equipCoatingType').value = eq.coatingType || '3LPE';
        getDomElement('equipCoatingCondition').value = eq.coatingCondition || 'neuf';
        getDomElement('equipCoatingThickness').value = eq.coatingThickness || 0;
        getDomElement('equipSoilResistivity').value = eq.soilResistivity || '';

        const container = getDomElement('equipWaypointsContainer');
        if (container) {
            container.innerHTML = '';
            if (eq.coordinates) {
                let points = [];
                if (Array.isArray(eq.coordinates)) {
                    points = eq.coordinates;
                } else if (eq.coordinates.lat !== undefined) {
                    points = [eq.coordinates];
                }
                if (points.length > 0) {
                    points.forEach((p, idx) => {
                        addEquipWaypointRow(p.lat, p.lon, p.alt, idx > 0);
                    });
                } else {
                    addEquipWaypointRow('', '', null, false);
                }
            } else {
                addEquipWaypointRow('', '', null, false);
            }
        }

        if (eq.dimensions) {
            const type = eq.type;
            getDomElement('equipType').value = type;
            updateEquipDimensionsFields();
            const fields = CalculationEngine.getOuvrageFields(type);
            fields.forEach(f => {
                if (eq.dimensions[f] !== undefined) {
                    setSelectValue(`dim_${f}`, eq.dimensions[f]);
                } else {
                    setSelectValue(`dim_${f}`, '');
                }
            });
            computeEquipSurface();
        } else {
            const type = eq.type;
            getDomElement('equipType').value = type;
            updateEquipDimensionsFields();
        }

        const surfaceAuto = getDomElement('equipSurfaceAuto');
        if (surfaceAuto && eq.surface !== undefined) {
            surfaceAuto.value = eq.surface;
        }

        const submitBtn = getDomElement('equipSubmitBtn');
        submitBtn.innerHTML = '<i class="fas fa-save" aria-hidden="true"></i> Mettre à jour';

        const cancelBtn = getDomElement('cancelEditBtn');
        cancelBtn.style.display = 'inline-flex';

        AppState.editMode = true;
        AppState.editingEquipId = eq.id;

        const form = getDomElement('equipmentForm');
        form.classList.add('edit-mode-highlight');
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });

        showToast(`Édition de l'équipement ${Utils.escapeHtml(eq.tag)}`, 'info');
    }

    function cancelEdit() {
        resetEquipmentForm();
        AppState.editMode = false;
        AppState.editingEquipId = null;

        const submitBtn = getDomElement('equipSubmitBtn');
        submitBtn.innerHTML = '<i class="fas fa-save" aria-hidden="true"></i> Ajouter équipement';

        const cancelBtn = getDomElement('cancelEditBtn');
        cancelBtn.style.display = 'none';

        const form = getDomElement('equipmentForm');
        form.classList.remove('edit-mode-highlight');

        showToast('Édition annulée', 'info');
    }

    function resetEquipmentForm() {
        getDomElement('equipTag').value = '';
        getDomElement('equipType').value = 'pipeline_enterre';
        getDomElement('equipProjectId').value = ProjectManager.getCurrentProjectId() || '';
        getDomElement('equipIncluded').checked = true;
        getDomElement('equipSystemId').value = '';
        getDomElement('equipSurfaceAuto').value = '';
        getDomElement('editEquipId').value = '';
        getDomElement('equipMaterial').value = 'acier';
        getDomElement('equipWallThickness').value = 8.0;
        getDomElement('equipCoatingType').value = '3LPE';
        getDomElement('equipCoatingCondition').value = 'neuf';
        getDomElement('equipCoatingThickness').value = 0;
        getDomElement('equipSoilResistivity').value = '';

        const container = getDomElement('equipWaypointsContainer');
        if (container) {
            container.innerHTML = '';
            addEquipWaypointRow('', '', null, false);
        }

        document.querySelectorAll('#equipDimensionsContainer .dimension-select').forEach(s => s.value = '');
        document.querySelectorAll('#equipDimensionsContainer .manual-input').forEach(inp => inp.value = '');
        computeEquipSurface();
    }

    async function deleteEquipment(equipId) {
        if (!confirm('Supprimer cet équipement ?')) return;
        const projectId = ProjectManager.getCurrentProjectId();
        try {
            if (window.CPController && typeof window.CPController.deleteEquipment === 'function') {
                await window.CPController.deleteEquipment(equipId);
            } else {
                console.warn('CPController.deleteEquipment non disponible');
                return;
            }
            if (window.requestIdleCallback) {
                requestIdleCallback(async () => {
                    const freshEquipments = await StorageManager.loadEquipmentsForProject(projectId, true);
                    if (freshEquipments) {
                        ProjectManager.getState().equipments = freshEquipments;
                        refreshEquipmentListUI(true);
                    }
                });
            } else {
                const freshEquipments = await StorageManager.loadEquipmentsForProject(projectId, true);
                if (freshEquipments) {
                    ProjectManager.getState().equipments = freshEquipments;
                    refreshEquipmentListUI(true);
                }
            }
            refreshAssetDropdownForFieldMeas();
            refreshFieldMeasurementsTable();
            populatePipelineSelects();
            renderSystems();
            if (window.CPController) {
                if (typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
                if (typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
                if (typeof window.CPController.updateAnodeCurrentSource === 'function') window.CPController.updateAnodeCurrentSource();
                if (typeof window.CPController.updateICCPCurrentSource === 'function') window.CPController.updateICCPCurrentSource();
            }
            showToast('Équipement supprimé avec succès', 'success');
        } catch (error) {
            console.error('[UI] Erreur suppression:', error);
            showToast('❌ Erreur lors de la suppression : ' + error.message, 'error');
            try {
                const freshEquipments = await StorageManager.loadEquipmentsForProject(projectId, true);
                if (freshEquipments) {
                    ProjectManager.getState().equipments = freshEquipments;
                    refreshEquipmentListUI(true);
                }
            } catch (e) {
                Logger.warn('[UI] Échec récupération:', e);
            }
        }
    }

    async function addEquipment(tag, type, surface, projectId, dimensions = {}, included = true, systemId = null, coordinates = null) {
        if (!tag) { showToast('Tag requis', 'error'); return; }
        if (!projectId) { showToast('Veuillez associer un projet', 'error'); return; }
        if (isEquipmentDuplicate(tag, projectId)) {
            showToast(`❌ Un équipement avec le tag "${Utils.escapeHtml(tag)}" existe déjà dans ce projet.`, 'error');
            return;
        }

        let surfaceValue = 0;
        const isNoDim = TYPES_NO_DIMENSIONS.includes(type);
        if (isNoDim) {
            surfaceValue = Utils.safeNumber(surface, 0);
        } else {
            if (surface === undefined || surface === null || surface <= 0) {
                showToast('Veuillez sélectionner les dimensions pour calculer la surface', 'warning');
                return;
            }
            surfaceValue = surface;
        }

        const equipmentData = {
            id: Utils.generateId(),
            tag: tag.trim(),
            type: type,
            surface: surfaceValue,
            projectId: projectId,
            dimensions: dimensions || {},
            included: included,
            systemId: systemId || null,
            coordinates: coordinates || null,
            material: getDomElement('equipMaterial').value || 'acier',
            wallThickness: Utils.safeNumber(getDomElement('equipWallThickness').value, 8.0),
            coatingType: getDomElement('equipCoatingType').value || '3LPE',
            coatingCondition: getDomElement('equipCoatingCondition').value || 'neuf',
            coatingThickness: Utils.safeNumber(getDomElement('equipCoatingThickness').value, 0),
            soilResistivity: Utils.safeNumber(getDomElement('equipSoilResistivity').value, 0),
            cpData: { parameters: {}, results: {}, calculated: false, lastCalculationDate: null }
        };

        const surfaceInput = getDomElement('equipSurfaceAuto');
        if (surfaceInput && !surfaceInput.hasAttribute('readonly')) {
            equipmentData.surfaceMode = 'manual';
        } else {
            equipmentData.surfaceMode = 'auto';
        }

        try {
            const result = ProjectManager.addEquipmentDirect(equipmentData);
            await ProjectManager.saveCurrentProject();

            _equipFilteredData = ProjectManager.getState().equipments;

            refreshEquipmentListUI(true);
            refreshAssetDropdownForFieldMeas();
            populatePipelineSelects();
            renderSystems();
            resetEquipmentForm();

            if (window.CPController) {
                if (typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
                if (typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
            }

            showToast(`Équipement ${Utils.escapeHtml(tag)} ajouté avec succès`, 'success');
            return equipmentData;
        } catch (error) {
            console.error('[UI] Erreur ajout:', error);
            showToast('❌ Erreur lors de l\'ajout : ' + error.message, 'error');
            throw error;
        }
    }

    async function updateEquipment(equipId, tag, type, surface, projectId, dimensions = {}, included = true, systemId = null, coordinates = null) {
        if (!tag) { showToast('Tag requis', 'error'); return; }
        if (!projectId) { showToast('Veuillez associer un projet', 'error'); return; }

        const equipment = ProjectManager.getState().equipments.find(e => e.id === equipId);
        if (!equipment) {
            showToast('Équipement introuvable', 'error');
            return;
        }

        if (tag.trim().toLowerCase() !== equipment.tag.trim().toLowerCase()) {
            if (isEquipmentDuplicate(tag, projectId, equipId)) {
                showToast(`❌ Un équipement avec le tag "${Utils.escapeHtml(tag)}" existe déjà dans ce projet.`, 'error');
                return;
            }
        }

        let surfaceValue = 0;
        const isNoDim = TYPES_NO_DIMENSIONS.includes(type);
        if (isNoDim) {
            surfaceValue = Utils.safeNumber(surface, 0);
        } else {
            if (surface === undefined || surface === null || surface <= 0) {
                showToast('Veuillez sélectionner les dimensions pour calculer la surface', 'warning');
                return;
            }
            surfaceValue = surface;
        }

        equipment.tag = tag.trim();
        equipment.type = type;
        equipment.surface = surfaceValue;
        equipment.projectId = projectId;
        equipment.dimensions = dimensions || {};
        equipment.included = included !== false;
        equipment.systemId = systemId || null;
        equipment.coordinates = coordinates || null;
        equipment.material = getDomElement('equipMaterial').value || 'acier';
        equipment.wallThickness = Utils.safeNumber(getDomElement('equipWallThickness').value, 8.0);
        equipment.coatingType = getDomElement('equipCoatingType').value || '3LPE';
        equipment.coatingCondition = getDomElement('equipCoatingCondition').value || 'neuf';
        equipment.coatingThickness = Utils.safeNumber(getDomElement('equipCoatingThickness').value, 0);
        equipment.soilResistivity = Utils.safeNumber(getDomElement('equipSoilResistivity').value, 0);

        const surfaceInput = getDomElement('equipSurfaceAuto');
        if (surfaceInput && !surfaceInput.hasAttribute('readonly')) {
            equipment.surfaceMode = 'manual';
        } else {
            equipment.surfaceMode = 'auto';
        }

        try {
            await StorageManager.saveEquipment(equipment);

            const existingIndex = ProjectManager.getState().equipments.findIndex(e => e.id === equipId);
            if (existingIndex !== -1) {
                ProjectManager.getState().equipments[existingIndex] = equipment;
            } else {
                ProjectManager.getState().equipments.push(equipment);
            }

            await ProjectManager.saveCurrentProject();

            ProjectManager.invalidateSurfaceCache();
            ProjectManager.invalidateSystemCurrentCache();

            const freshEquipments = await StorageManager.loadEquipmentsForProject(projectId, true);
            if (freshEquipments) {
                ProjectManager.getState().equipments = freshEquipments;
            }

            _equipFilteredData = ProjectManager.getState().equipments;

            refreshEquipmentListUI(true);
            refreshAssetDropdownForFieldMeas();
            populatePipelineSelects();
            renderSystems();

            cancelEdit();

            if (window.CPController) {
                if (typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
                if (typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
            }

            showToast(`✅ Équipement ${Utils.escapeHtml(tag)} mis à jour avec succès`, 'success');
            return equipment;

        } catch (error) {
            console.error('[UI] Erreur mise à jour:', error);
            showToast('❌ Erreur lors de la mise à jour : ' + error.message, 'error');
            throw error;
        }
    }

    // ============================================================
    // calculateEquipmentCP — délégation à CPController (SSOT)
    // ------------------------------------------------------------
    // ROLE.txt §4 : la logique métier a été déplacée dans
    // cp-controller.js (CPController.calculateEquipmentCP).
    // ui.js n'a plus AUCUNE formule métier CP.
    // ============================================================
    function calculateEquipmentCP(equipId) {
        // Délégation directe à CPController (SSOT métier)
        if (window.CPController &&
            typeof window.CPController.calculateEquipmentCP === 'function') {
            return window.CPController.calculateEquipmentCP(equipId);
        }
        // Fallback défensif (ne devrait jamais arriver si ordre de
        // chargement respecté : cp-controller.js avant ui.js)
        return _calculateEquipmentCPFallback(equipId);
    }

    // ============================================================
    // _calculateEquipmentCPFallback — DÉPRÉCIÉ (fallback ultime)
    // ------------------------------------------------------------
    // Conservé UNIQUEMENT pour la défense en profondeur si
    // CPController n'expose pas la méthode calculateEquipmentCP.
    // Ce cas ne doit PAS se produire dans l'architecture normale.
    // ============================================================
    function _calculateEquipmentCPFallback(equipId) {
        // ═══════════════════════════════════════════════════════════════
        // BUG-CP-A08 : Le fallback n'est plus silencieux.
        // ------------------------------------------------------------
        // 1. Journalisation technique dans la console
        // 2. Utilisation du ErrorManager centralisé (si disponible)
        // 3. Fallback toast si ErrorManager indisponible
        // 4. Retour null — jamais de calcul silencieux
        // ═══════════════════════════════════════════════════════════════
        const err = new Error('CPController.calculateEquipmentCP indisponible');
        console.error('[UI] UI-CP-001 : ' + err.message + ' (equipId=' + equipId + ')');

        if (window.ErrorManager && typeof window.ErrorManager.show === 'function') {
            window.ErrorManager.show({
                type: 'error',
                title: 'Calcul CP indisponible',
                message: 'Le module de calcul CP par équipement n\'est pas chargé. ' +
                         'Vérifiez l\'ordre de chargement de cp-controller.js.',
                details: {
                    module: 'ui.js',
                    function: '_calculateEquipmentCPFallback',
                    parameter: 'equipId',
                    value: equipId,
                    technical: err.message
                },
                code: 'UI-CP-001',
                _originalError: err
            });
        } else if (typeof showToast === 'function') {
            showToast('❌ Erreur UI-CP-001 : Module de calcul CP indisponible.', 'error');
        }
        return null;
    }

    function calculateAllEquipmentCP() {
        const eqs = ProjectManager.getState().equipments.filter(eq =>
            eq.projectId === ProjectManager.getCurrentProjectId() &&
            Utils.safeNumber(eq.surface) > 0
        );
        if (eqs.length === 0) {
            showToast('Aucun équipement avec surface > 0 dans ce projet', 'warning');
            return;
        }
        showToast(`Calcul en cours pour ${eqs.length} équipements...`, 'info');
        let processed = 0;
        let errors = 0;
        const total = eqs.length;

        function processBatch(deadline) {
            const batchSize = 5;
            let count = 0;
            while (processed < total && (deadline.timeRemaining() > 0 || count < 2)) {
                const eq = eqs[processed];
                try {
                    // ═══════════════════════════════════════════════════════
                    // BUG-CP-A08 : appel corrigé.
                    // AVANT : _calculateEquipmentCPFallback(eq.id)
                    //         → aucun calcul réel, seuls des warnings.
                    // APRÈS : calculateEquipmentCP(eq.id)
                    //         → délègue à CPController.calculateEquipmentCP
                    //           (SSOT métier).
                    // ═══════════════════════════════════════════════════════
                    calculateEquipmentCP(eq.id);
                } catch (err) {
                    console.error(`Erreur pour ${eq.tag}:`, err);
                    errors++;
                }
                processed++;
                count++;
                if (processed % 5 === 0 || processed === total) {
                    const progress = Math.round((processed / total) * 100);
                    showToast(`Progression : ${progress}% (${processed}/${total})`, 'info');
                }
            }
            if (processed < total) {
                if (window.requestIdleCallback) {
                    requestIdleCallback(processBatch);
                } else {
                    setTimeout(() => processBatch({ timeRemaining: () => 0 }), 10);
                }
            } else {
                const msg = `Calcul terminé pour ${total} équipements. ${errors > 0 ? `Erreurs: ${errors}` : 'Aucune erreur.'}`;
                showToast(msg, errors > 0 ? 'warning' : 'success');
                ProjectManager.addHistoryEntry('cp', 'Calcul CP tous équipements', `${total} équipements, ${errors} erreurs`);
            }
        }

        if (window.requestIdleCallback) {
            requestIdleCallback(processBatch);
        } else {
            setTimeout(() => processBatch({ timeRemaining: () => 0 }), 10);
        }
    }

    // ============================================================
    // populateGroundbedProjectSelect / populateInterferenceProjectSelect / populatePipelineSelects
    // ============================================================
    function populateGroundbedProjectSelect() {
        const sel = getDomElement('gbProjectSelect');
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">-- Sélectionner un projet --</option>';
        for (const proj of ProjectManager.getProjectsList()) { const opt = document.createElement('option');
            opt.value = proj.id;
            opt.textContent = `${proj.id} - ${proj.name}`;
            sel.appendChild(opt); }
        const currentProjectId = ProjectManager.getCurrentProjectId();
        if (currentProjectId && ProjectManager.getProjectsList().find(p => p.id === currentProjectId)) { sel.value = currentProjectId; }
        else if (currentVal && ProjectManager.getProjectsList().find(p => p.id === currentVal)) { sel.value = currentVal; }
        populatePipelineSelects();
        populateGroundbedEquipmentList();
    }

    function populateGroundbedEquipmentList() {
        const container = getDomElement('gbEquipmentList');
        if (!container) return;
        const projectId = getDomElement('gbProjectSelect')?.value;
        let equipments = ProjectManager.getState().equipments.filter(eq => eq.projectId === projectId &&
            isResistiveEquipment(eq));
        if (!projectId) {
            const currentProj = ProjectManager.getCurrentProjectId();
            equipments = ProjectManager.getState().equipments.filter(eq => eq.projectId === currentProj &&
                isResistiveEquipment(eq));
        }
        if (equipments.length === 0) { container.innerHTML = '<div class="info-message" style="margin:0; font-size:0.8rem;">Aucun équipement métallique disponible dans le projet sélectionné.</div>'; return; }
        const selectedIds = container.dataset.selected ? JSON.parse(container.dataset.selected) : [];
        let html = '';
        equipments.forEach(eq => {
            const checked = selectedIds.includes(eq.id) ? 'checked' : '';
            html += `<div class="equipment-check-item">
                <input type="checkbox" data-equip-id="${eq.id}" ${checked} aria-label="Sélectionner ${Utils.escapeHtml(eq.tag)}">
                <label>${Utils.escapeHtml(eq.tag)} <span class="equipment-type">(${Utils.escapeHtml(eq.type)})</span></label>
                <span class="equip-surface">${getCanonicalEquipmentSurface(eq).toFixed(1)} m²</span>
            </div>`;
        });
        container.innerHTML = html;
        container.querySelectorAll('input[type="checkbox"]').forEach(chk => { chk.addEventListener('change', function() { updateGroundbedTargetCurrent(); }); });
        updateGroundbedTargetCurrent();
    }

    function updateGroundbedTargetCurrent() {
        const container = getDomElement('gbEquipmentList');
        if (!container) return;
        const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
        let totalSurface = 0;
        const selectedIds = [];
        checkboxes.forEach(chk => {
            const eqId = chk.dataset.equipId;
            selectedIds.push(eqId);
            const eq = ProjectManager.getState().equipments.find(e => e.id === eqId);
            if (eq) totalSurface += getCanonicalEquipmentSurface(eq);
        });
        container.dataset.selected = JSON.stringify(selectedIds);
        const targetInput = getDomElement('gbTargetCurrent');
        const activeSys = ProjectManager.getActiveSystem();
        if (activeSys) {
            const gbParams = ProjectManager.loadSystemParams(activeSys.id, 'groundbed') || {};
            gbParams.selectedPipelineIds = selectedIds;
            ProjectManager.saveSystemParams(activeSys.id, 'groundbed', gbParams);
        }

        // Use the central CP/ICCP priority resolver after the selection is saved.
        // The surface-density value remains only the final fallback.
        if (window.CPController && typeof window.CPController.syncGroundbedTargetCurrent === 'function') {
            window.CPController.syncGroundbedTargetCurrent();
        } else if (targetInput) {
            const J = getFieldValue('cpCurrentDensitySelect', 'cpCurrentDensityManual');
            const current = (totalSurface * J) / 1000;
            targetInput.value = current > 0 ? current.toFixed(3) : '';
        }
    }

    function populateInterferenceProjectSelect() {
        const sel = getDomElement('ifProjectSelect');
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">-- Sélectionner un projet --</option>';
        for (const proj of ProjectManager.getProjectsList()) { const opt = document.createElement('option');
            opt.value = proj.id;
            opt.textContent = `${proj.id} - ${proj.name}`;
            sel.appendChild(opt); }
        if (ProjectManager.getCurrentProjectId() && ProjectManager.getProjectsList().find(p => p.id === ProjectManager.getCurrentProjectId())) { sel.value = ProjectManager.getCurrentProjectId(); }
        else if (currentVal && ProjectManager.getProjectsList().find(p => p.id === currentVal)) { sel.value = currentVal; }
        populatePipelineSelects();
    }

    function populatePipelineSelects() {
        const gbProj = getDomElement('gbProjectSelect')?.value;
        const gbPipeSel = getDomElement('gbPipelineSelect');
        if (gbPipeSel) {
            const currentVal = gbPipeSel.value;
            gbPipeSel.innerHTML = '<option value="">-- Sélectionner un pipeline (équipement) --</option>';
            if (gbProj) {
                const eqs = ProjectManager.getState().equipments.filter(eq => eq.projectId === gbProj && (eq.type === 'pipeline_enterre' || eq.type === 'pipeline_offshore' || eq.type === 'well_casing'));
                eqs.forEach(eq => { const opt = document.createElement('option');
                    opt.value = eq.id;
                    opt.textContent = `${eq.tag} (${eq.type}) - ${eq.surface || 0} m²`;
                    gbPipeSel.appendChild(opt); });
            }
            if (currentVal && gbPipeSel.querySelector(`option[value="${currentVal}"]`)) gbPipeSel.value = currentVal;
        }
        const ifProj = getDomElement('ifProjectSelect')?.value;
        const ifPipeSel = getDomElement('ifPipelineSelect');
        if (ifPipeSel) {
            const currentVal = ifPipeSel.value;
            ifPipeSel.innerHTML = '<option value="">-- Sélectionner un pipeline (équipement) --</option>';
            if (ifProj) {
                const eqs = ProjectManager.getState().equipments.filter(eq => eq.projectId === ifProj && (eq.type === 'pipeline_enterre' || eq.type === 'pipeline_offshore' || eq.type === 'well_casing'));
                eqs.forEach(eq => { const opt = document.createElement('option');
                    opt.value = eq.id;
                    opt.textContent = `${eq.tag} (${eq.type}) - ${eq.surface || 0} m²`;
                    ifPipeSel.appendChild(opt); });
            }
            if (currentVal && ifPipeSel.querySelector(`option[value="${currentVal}"]`)) ifPipeSel.value = currentVal;
        }
    }

    function loadInterferenceFromEquipment(equipId) {
        if (!equipId) return;
        const eq = ProjectManager.getState().equipments.find(e => e.id === equipId);
        if (!eq) return;
        const dims = eq.dimensions || {};
        let diam_m = dims.diametre_m || 0;
        let length_m = dims.longueur_m || 0;
        if (diam_m > 0 && length_m > 0) {
            const diamMM = diam_m * 1000;
            setSelectValue('ifPipeDiameter', diamMM);
            setSelectValue('ifPipeLength', length_m);
            showToast(`Paramètres du pipeline ${Utils.escapeHtml(eq.tag)} chargés`, 'info');
        } else { showToast(`Dimensions non disponibles pour ${Utils.escapeHtml(eq.tag)}`, 'warning'); }
    }

    function refreshAssetDropdownForFieldMeas() {
        const select = getDomElement('fmAssetId');
        if (!select) return;
        select.innerHTML = '<option value="">-- Sélectionner un équipement --</option>';
        const activeEqs = ProjectManager.getState().equipments.filter(eq => eq.projectId === ProjectManager.getCurrentProjectId() && eq.included !== false);
        activeEqs.forEach(eq => { const opt = document.createElement('option');
            opt.value = eq.id;
            opt.textContent = `${eq.tag} (${eq.type})`;
            select.appendChild(opt); });
    }

    function refreshFieldMeasurementsTable() {
        const tbody = getDomElement('fieldMeasTableBody');
        if (!tbody) return;
        tbody.innerHTML = '';
        const measurements = [...ProjectManager.getState().fieldMeasurements].sort((a, b) => new Date(b.date) - new Date(a.date));
        const fragment = document.createDocumentFragment();
        measurements.forEach(m => {
            const tr = document.createElement('tr');
            const sys = ProjectManager.getSystem(m.systemId);
            const sysName = sys ? sys.name : '-';
            tr.innerHTML = `
                <td>${Utils.escapeHtml(m.date)}</td>
                <td>${Utils.escapeHtml(m.assetTag)}</td>
                <td>${Utils.escapeHtml(sysName)}</td>
                <td>${m.potON ?? '-'}</td>
                <td>${m.potOFF}</td>
                <td>${m.polarization}</td>
                <td><span class="badge ${m.compliant ? 'success' : 'danger'}">${m.compliant ? '✅ Oui' : '❌ Non'}</span></td>
                <td>${Utils.escapeHtml(m.operator || '-')}</td>
                <td><button class="btn-danger btn-sm" data-id="${m.id}" aria-label="Supprimer la mesure du ${Utils.escapeHtml(m.date)}"><i class="fas fa-trash" aria-hidden="true"></i></button></td>
            `;
            const btn = tr.querySelector('button');
            btn.addEventListener('click', () => deleteFieldMeasurement(m.id));
            fragment.appendChild(tr);
        });
        tbody.appendChild(fragment);
    }

    async function addFieldMeasurement(assetId, assetTag, date, potON, potOFF, operator, temperature, refElectrode) {
        if (!assetId) { showToast('Sélectionnez un équipement', 'error'); return; }
        if (!date) { showToast('Date requise', 'error'); return; }
        if (potOFF === undefined || potOFF === null) { showToast('Potentiel OFF obligatoire', 'error'); return; }
        const onVal = Utils.safeNumber(potON);
        let offVal = Utils.safeNumber(potOFF);
        const temp = temperature !== undefined && temperature !== null && temperature !== '' ? Utils.safeNumber(temperature) : 20;
        const ref = refElectrode || 'CuCuSO4';
        if (temp !== 20) {
            const originalOff = offVal;
            offVal = CalculationEngine.correctPotentialForTemperature(offVal, temp, ref);
            showToast(`Potentiel OFF corrigé de la température (${ref}): ${originalOff} → ${offVal.toFixed(1)} mV`, 'info');
        }
        const polarization = Math.abs(onVal - offVal);
        const compliant = (offVal <= -850) || (polarization >= 100);
        const newId = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
        const activeSys = ProjectManager.getActiveSystem();
        const systemId = activeSys ? activeSys.id : null;
        const measurement = { id: newId, assetId, assetTag, date, potON: onVal, potOFF: offVal, polarization, compliant, operator: operator || '', temperature: temp, refElectrode: ref, projectId: ProjectManager.getCurrentProjectId(), systemId: systemId };
        await StorageManager.saveFieldMeasurement(measurement);
        ProjectManager.getState().fieldMeasurements.push(measurement);
        if (systemId) {
            const sys = ProjectManager.getSystem(systemId);
            if (sys) {
                if (!sys.results.monitoring) sys.results.monitoring = [];
                sys.results.monitoring.push({ id: newId, date, potON: onVal, potOFF: offVal, polarization, compliant, assetTag, operator: operator || '', temperature: temp, refElectrode: ref });
                ProjectManager.saveCurrentProject();
            }
        }
        refreshFieldMeasurementsTable();
        showToast(`Mesure enregistrée - ${compliant ? 'Conforme NACE' : 'Non conforme'}`, compliant ? 'success' : 'warning');
        try { await ProjectManager.saveCurrentProject(); } catch (err) { console.error('Erreur sauvegarde après ajout mesure:', err);
            showToast('Erreur lors de la sauvegarde de la mesure', 'error'); }
        if (window.CPController && typeof window.CPController.updateDashboardChartsData === 'function') window.CPController.updateDashboardChartsData();
        ProjectManager.addHistoryEntry('fieldmeas', `Mesure terrain ${assetTag}`, `${offVal} mV OFF, ${compliant ? 'Conforme' : 'Non conforme'}`, systemId);
    }

    async function deleteFieldMeasurement(measId) {
        if (!confirm('Supprimer cette mesure terrain ?')) return;
        try { await StorageManager.deleteFieldMeasurement(measId); } catch (err) { showToast('Erreur lors de la suppression de la mesure', 'error'); return; }
        ProjectManager.getState().fieldMeasurements = ProjectManager.getState().fieldMeasurements.filter(m => m.id !== measId);
        refreshFieldMeasurementsTable();
        showToast('Mesure supprimée', 'warning');
        try { await ProjectManager.saveCurrentProject(); } catch (err) { console.error('Erreur sauvegarde après suppression mesure:', err);
            showToast('Erreur lors de la sauvegarde après suppression', 'error'); }
        if (window.CPController && typeof window.CPController.updateDashboardChartsData === 'function') window.CPController.updateDashboardChartsData();
    }

    // ============================================================
    // Historique
    // ============================================================
    function refreshHistoryTable() {
        const tbody = getDomElement('historyTableBody');
        if (!tbody) return;
        const filter = getDomElement('historyFilterModule')?.value || 'all';
        const sysFilter = getDomElement('historySystemSelector')?.value || '';
        tbody.innerHTML = '';
        let items = ProjectManager.getState().history;
        if (filter !== 'all') { items = items.filter(h => h.module === filter); }
        if (sysFilter) { items = items.filter(h => h.systemId === sysFilter); }
        if (items.length === 0) { tbody.innerHTML = '<tr><td colspan="6">Aucun historique disponible</td></tr>'; return; }
        const fragment = document.createDocumentFragment();
        items.forEach(h => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${Utils.escapeHtml(new Date(h.timestamp).toLocaleString())}</td>
                <td><span class="badge info">${Utils.escapeHtml(h.module)}</span></td>
                <td>${Utils.escapeHtml(h.projectName || '')}</td>
                <td>${Utils.escapeHtml(h.systemName || '')}</td>
                <td>${Utils.escapeHtml(h.action)}</td>
                <td>${Utils.escapeHtml(h.result || '')}</td>
            `;
            fragment.appendChild(tr);
        });
        tbody.appendChild(fragment);
    }

    function loadHistory() {
        StorageManager.loadHistory()
            .then(data => {
                if (data && data.length > 0) {
                    ProjectManager.getState().history = data;
                }
                refreshHistoryTable();
            })
            .catch(err => {
                console.warn('[UI] Erreur lors du chargement de l\'historique:', err);
                ProjectManager.getState().history = [];
                refreshHistoryTable();
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('⚠️ Erreur lors du chargement de l\'historique. Historique réinitialisé.', 'warning');
                }
            });
    }

    function clearHistory() {
        if (!confirm('Effacer tout l\'historique ?')) return;
        ProjectManager.getState().history = [];
        StorageManager.saveHistory([]);
        refreshHistoryTable();
        showToast('Historique effacé', 'warning');
        try { ProjectManager.saveCurrentProject(); } catch (err) { console.error('Erreur sauvegarde après effacement historique:', err);
            showToast('Erreur lors de la sauvegarde après effacement', 'error'); }
    }

    // ============================================================
    // drawGroundbedVisual
    // ============================================================
    function drawGroundbedVisual(totalDepth, activeDepth, anodeCount, anodeLength, spacing) {
        const canvas = getDomElement('gbChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        const w = rect.width;
        const h = rect.height;
        const margin = 40;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(10, 14, 23, 0.5)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Schéma du puits anodique', w / 2, 18);
        const wellX = w / 2;
        const wellTop = margin + 10;
        const wellBottom = h - margin - 10;
        const wellWidth = 20;
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, wellTop);
        ctx.lineTo(w, wellTop);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Surface', 5, wellTop - 4);
        const leftX = wellX - wellWidth / 2;
        const rightX = wellX + wellWidth / 2;
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(leftX, wellTop);
        ctx.lineTo(leftX, wellBottom);
        ctx.moveTo(rightX, wellTop);
        ctx.lineTo(rightX, wellBottom);
        ctx.stroke();
        const activeTop = wellBottom - (activeDepth / totalDepth) * (wellBottom - wellTop);
        const activeGrad = ctx.createLinearGradient(wellX - wellWidth, activeTop, wellX + wellWidth, wellBottom);
        activeGrad.addColorStop(0, 'rgba(6, 182, 212, 0.2)');
        activeGrad.addColorStop(1, 'rgba(6, 182, 212, 0.6)');
        ctx.fillStyle = activeGrad;
        ctx.fillRect(leftX, activeTop, wellWidth, wellBottom - activeTop);
        const anodeSpacing = (wellBottom - activeTop) / (anodeCount + 1);
        const anodeHeight = Math.min(anodeSpacing * 0.6, 20);
        const anodeWidth = wellWidth * 0.5;
        for (let i = 0; i < anodeCount; i++) {
            const y = activeTop + (i + 1) * anodeSpacing - anodeHeight / 2;
            const grad = ctx.createLinearGradient(wellX - anodeWidth, y, wellX + anodeWidth, y + anodeHeight);
            grad.addColorStop(0, '#06b6d4');
            grad.addColorStop(0.5, '#3b82f6');
            grad.addColorStop(1, '#06b6d4');
            ctx.fillStyle = grad;
            ctx.shadowColor = '#06b6d4';
            ctx.shadowBlur = 8;
            ctx.fillRect(wellX - anodeWidth / 2, y, anodeWidth, anodeHeight);
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#e2e8f0';
            ctx.font = '8px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`A${i + 1}`, wellX, y + anodeHeight / 2 + 3);
        }
        ctx.fillStyle = '#94a3b8';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('0 m', rightX + 8, wellTop + 4);
        ctx.fillText(`${totalDepth} m`, rightX + 8, wellBottom + 4);
        ctx.fillText(`${Math.round(activeDepth)} m (actif)`, rightX + 8, activeTop + 4);
    }

    // ============================================================
    // Corrosivité
    // ============================================================
    function updateCorrosivity() {
        const resistivity = getFieldValue('envSoilResistivity', 'envSoilResistivityManual');
        const ph = getFieldValue('envSoilPh', 'envSoilPhManual');
        const chlorides = getFieldValue('envSoilChlorides', 'envSoilChloridesManual');
        const sulfates = getFieldValue('envSoilSulfates', 'envSoilSulfatesManual');
        const redox = getFieldValue('envSoilRedox', 'envSoilRedoxManual');

        getDomElement('corroResistivityValue').innerText = resistivity.toFixed(1);
        getDomElement('corroPhValue').innerText = ph.toFixed(1);
        getDomElement('corroChloridesValue').innerText = chlorides.toFixed(0);
        getDomElement('corroSulfatesValue').innerText = sulfates.toFixed(0);
        getDomElement('corroRedoxValue').innerText = redox.toFixed(0);

        let level = 'Faible';
        if (resistivity < 10) level = 'Très forte';
        else if (resistivity < 30) level = 'Forte';
        else if (resistivity < 100) level = 'Moyenne';
        getDomElement('corrosiviteLevel').innerText = level;

        let recommendation = 'Évaluation basée sur la résistivité uniquement.';
        if (resistivity < 10) {
            recommendation = '🔴 Corrosivité très forte. Protection cathodique obligatoire. Utiliser un revêtement haute performance.';
        } else if (resistivity < 30) {
            recommendation = '🟠 Corrosivité forte. Protection cathodique recommandée. Vérifier la qualité du revêtement.';
        } else if (resistivity < 100) {
            recommendation = '🟡 Corrosivité moyenne. Surveillance périodique conseillée.';
        } else {
            recommendation = '🟢 Corrosivité faible. Protection cathodique généralement non requise.';
        }
        getDomElement('corroRecommendation').innerText = recommendation;
    }

    // ============================================================
    // suggestStandards
    // ============================================================
    function suggestStandards() {
        const ouvrageType = getDomElement('ouvrageType')?.value || 'pipeline_enterre';
        const environment = getDomElement('cpEnvironment')?.value || 'desert';
        if (typeof CalculationEngine === 'undefined') {
            showToast('Moteur de calcul non disponible', 'error');
            return;
        }
        const result = CalculationEngine.suggestStandards(ouvrageType, environment);
        if (!result) return;
        document.querySelectorAll('.std-checkbox').forEach(cb => cb.checked = false);
        const allNorms = [result.primary, ...result.suggested];
        document.querySelectorAll('.std-checkbox').forEach(cb => {
            if (allNorms.includes(cb.value)) {
                cb.checked = true;
            }
        });
        const normSelect = getDomElement('cpNorm');
        if (normSelect) normSelect.value = result.primary;
        showToast(`Normes suggérées : ${allNorms.join(', ')}`, 'info');
    }

    // ============================================================
    // initDashboardCharts
    // ============================================================
    function initDashboardCharts() {
        if (typeof Chart === 'undefined') {
            console.warn('[UI] Chart.js not loaded. Dashboard charts skipped.');
            return;
        }
        const chartNames = ['dashboardChart1', 'dashboardChart2', 'dashboardChart3', 'dashboardChart4'];
        chartNames.forEach(name => {
            const instance = window[name];
            if (instance) {
                if (typeof instance.destroy === 'function') {
                    instance.destroy();
                    window[name] = null;
                } else {
                    console.warn(`[UI] ${name} is not a Chart instance, clearing reference.`);
                    window[name] = null;
                }
            }
        });
        const ctx1 = getDomElement('dashboardChart1')?.getContext('2d');
        const ctx2 = getDomElement('dashboardChart2')?.getContext('2d');
        const ctx3 = getDomElement('dashboardChart3')?.getContext('2d');
        const ctx4 = getDomElement('dashboardChart4')?.getContext('2d');
        if (!ctx1 || !ctx2 || !ctx3 || !ctx4) {
            console.warn('[UI] One or more chart canvas contexts missing. Charts not initialized.');
            return;
        }
        window.dashboardChart1 = new Chart(ctx1, {
            type: 'bar',
            data: { labels: [], datasets: [{ label: 'Courant (A)', data: [], backgroundColor: '#06b6d4' }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 450 },
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#8ea0b7' } },
                    y: { beginAtZero: true, grid: { color: 'rgba(142, 160, 183, 0.12)' }, ticks: { color: '#8ea0b7' } }
                }
            }
        });
        window.dashboardChart2 = new Chart(ctx2, {
            type: 'pie',
            data: { labels: ['Durée écoulée', 'Reste'], datasets: [{ data: [0, 100], backgroundColor: ['#06b6d4', '#1e293b'] }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 450 },
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#a9b7c9', usePointStyle: true, padding: 18 } }
                }
            }
        });
        window.dashboardChart3 = new Chart(ctx3, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'Potentiel OFF (mV)', data: [], borderColor: '#06b6d4', tension: 0.2 }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 450 },
                interaction: { intersect: false, mode: 'index' },
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#8ea0b7', maxTicksLimit: 8 } },
                    y: { grid: { color: 'rgba(142, 160, 183, 0.12)' }, ticks: { color: '#8ea0b7' } }
                },
                elements: { point: { radius: 2, hoverRadius: 5 }, line: { borderWidth: 2 } }
            }
        });
        window.dashboardChart4 = new Chart(ctx4, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'Courant (A)', data: [], borderColor: '#f59e0b', tension: 0.2 }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 450 },
                interaction: { intersect: false, mode: 'index' },
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#8ea0b7', maxTicksLimit: 8 } },
                    y: { beginAtZero: true, grid: { color: 'rgba(142, 160, 183, 0.12)' }, ticks: { color: '#8ea0b7' } }
                },
                elements: { point: { radius: 2, hoverRadius: 5 }, line: { borderWidth: 2 } }
            }
        });
        refreshDashboardChartTheme();
        if (window.CPController) {
            const debouncedUpdate = debounce(() => {
                if (typeof window.CPController.updateDashboardChartsData === 'function') window.CPController.updateDashboardChartsData();
                if (typeof window.CPController.updatePotentialChart === 'function') window.CPController.updatePotentialChart();
            }, 300);
            window.CPController.updateDashboardChartsData = debouncedUpdate;
            window.CPController.updatePotentialChart = debouncedUpdate;
            window.CPController.updateDashboardChartsData();
            window.CPController.updatePotentialChart();
        }
    }

    // ============================================================
    // updateEquipTypeOptions
    // ============================================================
    function updateEquipTypeOptions() {
        const selects = document.querySelectorAll('.equip-type-select, .equip-type-sync');
        const types = [
            'pipeline_enterre', 'pipeline_offshore', 'reservoir_fond', 'reservoir_toit',
            'ballon_souterrain', 'coque_navire', 'jacket_offshore', 'monopieu',
            'pieux', 'well_casing', 'fourreau', 'support_metallique',
            'rectifier', 'groundbed', 'anode', 'testpost',
            'autre'
        ];
        const labels = {
            pipeline_enterre: 'Pipeline enterré (acier)',
            pipeline_offshore: 'Pipeline offshore (acier revêtu)',
            reservoir_fond: 'Réservoir - fond et parois (enterré ou semi-enterré)',
            reservoir_toit: 'Réservoir - toit flottant (fond seul)',
            ballon_souterrain: 'Ballon souterrain (fonds bombés) - cuve horizontale',
            coque_navire: 'Coque de navire',
            jacket_offshore: 'Jacket offshore',
            monopieu: 'Monopieu (éolien offshore)',
            pieux: 'Pieux (acier)',
            well_casing: 'Well casing',
            fourreau: 'Fourreau',
            support_metallique: 'Support métallique',
            rectifier: 'Transformateur-redresseur (ICCP)',
            groundbed: 'Puits anodique (groundbed)',
            anode: 'Anode sacrificielle (ponctuelle)',
            testpost: 'Poste de test / point de mesure',
            autre: 'Autre (surface à définir)'
        };
        selects.forEach(sel => {
            const currentVal = sel.value;
            sel.innerHTML = '';
            types.forEach(t => { const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = labels[t] || t;
                sel.appendChild(opt); });
            if (currentVal && types.includes(currentVal)) sel.value = currentVal;
        });
    }

    // ============================================================
    // updateEquipDimensionsFields
    // ============================================================
    function updateEquipDimensionsFields() {
        const type = getDomElement('equipType').value;
        const container = getDomElement('equipDimensionsContainer');
        if (!container) return;

        if (TYPES_NO_DIMENSIONS.includes(type)) {
            container.innerHTML = '<div class="info-message"><i class="fas fa-info-circle"></i> Aucune dimension requise pour ce type d\'équipement. La surface est définie à 0 par défaut.</div>';
            computeEquipSurface();
            return;
        }

        const fields = CalculationEngine.getOuvrageFields(type);
        let html = '<div class="dimensions-group"><strong>Dimensions</strong>';
        fields.forEach(f => {
            let label = '', unit = '';
            if (f === 'diametre_m') { label = 'Diamètre'; unit = 'mm'; }
            else if (f === 'longueur_m') { label = 'Longueur'; unit = 'm'; }
            else if (f === 'hauteur_m') { label = 'Hauteur'; unit = 'm'; }
            else if (f === 'hauteur_enterree_m') { label = 'Hauteur enterrée'; unit = 'm'; }
            else if (f === 'largeur_m') { label = 'Largeur'; unit = 'm'; }
            else if (f === 'tirant_eau_m') { label = 'Tirant d\'eau'; unit = 'm'; }
            else if (f === 'perimetre_moyen_m') { label = 'Périmètre moyen'; unit = 'm'; }
            else if (f === 'surface_m2') { label = 'Surface'; unit = 'm²'; }
            else if (f === 'nb_pieux') { label = 'Nombre de pieux'; unit = ''; }
            else return;
            html += `<div class="form-group"><label>${label}</label><div class="dimension-row">`;
            html += `<div class="input-with-unit"><select id="dim_${f}" class="tech-form dimension-select std-select">`;
            if (f === 'diametre_m') {
                for (let v = 50; v <= 500; v += 50) html += `<option value="${v}">${v} mm</option>`;
                for (let v = 600; v <= 1200; v += 100) html += `<option value="${v}">${v} mm</option>`;
                html += `<option value="1500">1500 mm</option><option value="2000">2000 mm</option>`;
                html += `<option value="manual">Autre valeur</option>`;
            } else if (f === 'hauteur_enterree_m') {
                html += `<option value="0" selected>0 m (hors-sol)</option><option value="0.5">0.5 m</option><option value="1">1 m</option><option value="2">2 m</option><option value="3">3 m</option><option value="5">5 m</option><option value="10">10 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'longueur_m' || f === 'hauteur_m') {
                html += `<option value="1">1 m</option><option value="5">5 m</option><option value="10">10 m</option><option value="20">20 m</option><option value="50">50 m</option><option value="100" selected>100 m</option><option value="200">200 m</option><option value="500">500 m</option><option value="1000">1000 m</option><option value="5000">5000 m</option><option value="10000">10000 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'largeur_m') {
                html += `<option value="1">1 m</option><option value="2">2 m</option><option value="5">5 m</option><option value="10" selected>10 m</option><option value="20">20 m</option><option value="50">50 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'tirant_eau_m') {
                html += `<option value="1">1 m</option><option value="2">2 m</option><option value="3">3 m</option><option value="5">5 m</option><option value="10" selected>10 m</option><option value="15">15 m</option><option value="20">20 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'perimetre_moyen_m') {
                html += `<option value="2">2 m</option><option value="5">5 m</option><option value="10" selected>10 m</option><option value="20">20 m</option><option value="50">50 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'surface_m2') {
                html += `<option value="1">1 m²</option><option value="5">5 m²</option><option value="10">10 m²</option><option value="50">50 m²</option><option value="100" selected>100 m²</option><option value="500">500 m²</option><option value="1000">1000 m²</option><option value="5000">5000 m²</option><option value="10000">10000 m²</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'nb_pieux') {
                html += `<option value="1">1</option><option value="2">2</option><option value="4" selected>4</option><option value="6">6</option><option value="8">8</option><option value="10">10</option><option value="20">20</option><option value="manual">Autre valeur</option>`;
            }
            html += `</select><span class="unit">${unit}</span></div>`;
            if (f === 'diametre_m') {
                const inchesId = `dim_${f}_inches`;
                html += `<div class="input-with-unit"><select id="${inchesId}" class="tech-form inch-select"><option value="">Pouces</option>`;
                for (let i = 1; i <= 80; i++) html += `<option value="${i}">${i}"</option>`;
                html += `</select><span class="unit">pouces</span></div>`;
            }
            html += `</div><input type="number" id="dim_${f}_manual" class="tech-form manual-input" step="${f === 'nb_pieux' ? '1' : '0.01'}" min="0" style="display:none;" placeholder="Valeur en ${unit}"></div>`;

            if (type === 'pipeline_enterre' && f === 'longueur_m') {
                html += `<button type="button" class="btn btn-sm btn-info recalc-length-from-gps" title="Recalculer la longueur depuis les coordonnées GPS" style="margin-left:0.3rem;"><i class="fas fa-map-marked-alt"></i> GPS</button>`;
            }
        });
        html += '</div>';

        // ROLE.txt §15 : invalider le cache AVANT remplacement
        // (récupère les IDs des anciens enfants) PUIS après
        // (au cas où les nouveaux IDs seraient déjà connus).
        invalidateDomCacheContainer(container, fields.map(f => `dim_${f}`));
        container.innerHTML = html;

        document.querySelectorAll('.dimension-select').forEach(sel => {
            const manualId = sel.id + '_manual';
            const manual = getDomElement(manualId);
            if (manual) {
                const toggle = () => manual.style.display = sel.value === 'manual' ? 'block' : 'none';
                sel.addEventListener('change', toggle);
                toggle();
                manual.addEventListener('input', computeEquipSurface);
            }
            sel.addEventListener('change', () => computeEquipSurface());
        });
        document.querySelectorAll('.inch-select').forEach(inp => inp.addEventListener('change', function() {
            const inchesVal = Utils.safeNumber(this.value);
            if (inchesVal === 0) return;
            const mainId = this.id.replace('_inches', '');
            const mainSelect = getDomElement(mainId);
            if (!mainSelect) return;
            const converted = inchesVal * 25.4;
            let optionFound = false;
            for (let opt of mainSelect.options) {
                if (Math.abs(Utils.safeNumber(opt.value) - converted) < 0.1) { mainSelect.value = opt.value; optionFound = true; break; }
            }
            if (!optionFound) { mainSelect.value = 'manual'; const manualInput = getDomElement(mainId + '_manual'); if (manualInput) manualInput.value = converted.toFixed(0); }
            computeEquipSurface();
        }));
        computeEquipSurface();
    }

    function computeEquipSurface() {
        const type = getDomElement('equipType').value;

        if (TYPES_NO_DIMENSIONS.includes(type)) {
            const autoField = getDomElement('equipSurfaceAuto');
            if (autoField) autoField.value = '0';
            return 0;
        }

        const fields = CalculationEngine.getOuvrageFields(type);
        const values = fields.map(f => {
            const select = getDomElement(`dim_${f}`);
            if (!select) return 0;
            let val = 0;
            if (select.value === 'manual') { const manual = getDomElement(`dim_${f}_manual`); val = Utils.safeNumber(manual?.value, 0); }
            else val = Utils.safeNumber(select.value, 0);
            if (f === 'diametre_m' && val > 10) { val = val / 1000; }
            return val;
        });
        const surface = CalculationEngine.computeEquipmentSurface(type, values.reduce((acc, val, idx) => { acc[fields[idx]] = val; return acc; }, {}));
        const autoField = getDomElement('equipSurfaceAuto');
        if (autoField) autoField.value = surface.toFixed(2);
        return surface;
    }

    function updateDimensionsFields() {
        const type = getDomElement('ouvrageType').value;
        const container = getDomElement('dimensionsContainer');
        const specificContainer = getDomElement('specificDataContainer');
        if (!container) return;
        const fields = CalculationEngine.getOuvrageFields(type);
        let html = '<div class="dimensions-group"><strong>Dimensions principales</strong>';
        fields.forEach(f => {
            let label = '', unit = '';
            if (f === 'diametre_m') { label = 'Diamètre'; unit = 'm'; }
            else if (f === 'longueur_m') { label = 'Longueur'; unit = 'm'; }
            else if (f === 'hauteur_m') { label = 'Hauteur'; unit = 'm'; }
            else if (f === 'hauteur_enterree_m') { label = 'Hauteur enterrée'; unit = 'm'; }
            else if (f === 'largeur_m') { label = 'Largeur'; unit = 'm'; }
            else if (f === 'tirant_eau_m') { label = 'Tirant d\'eau'; unit = 'm'; }
            else if (f === 'perimetre_moyen_m') { label = 'Périmètre moyen'; unit = 'm'; }
            else if (f === 'surface_m2') { label = 'Surface'; unit = 'm²'; }
            else if (f === 'nb_pieux') { label = 'Nombre de pieux'; unit = ''; }
            else return;
            html += `<div class="form-group"><label>${label}</label><div class="dimension-row">`;
            html += `<div class="input-with-unit"><select id="dim_${f}" class="tech-form dimension-select std-select">`;
            if (f === 'diametre_m') {
                for (let v = 0.1; v <= 2.0; v += 0.1) html += `<option value="${v}">${v} m</option>`;
                html += `<option value="manual">Autre valeur</option>`;
            } else if (f === 'hauteur_enterree_m') {
                html += `<option value="0" selected>0 m (hors-sol)</option><option value="0.5">0.5 m</option><option value="1">1 m</option><option value="2">2 m</option><option value="3">3 m</option><option value="5">5 m</option><option value="10">10 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'longueur_m' || f === 'hauteur_m') {
                html += `<option value="1">1 m</option><option value="5">5 m</option><option value="10">10 m</option><option value="20">20 m</option><option value="50">50 m</option><option value="100" selected>100 m</option><option value="200">200 m</option><option value="500">500 m</option><option value="1000">1000 m</option><option value="5000">5000 m</option><option value="10000">10000 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'largeur_m') {
                html += `<option value="1">1 m</option><option value="2">2 m</option><option value="5">5 m</option><option value="10" selected>10 m</option><option value="20">20 m</option><option value="50">50 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'tirant_eau_m') {
                html += `<option value="1">1 m</option><option value="2">2 m</option><option value="3">3 m</option><option value="5">5 m</option><option value="10" selected>10 m</option><option value="15">15 m</option><option value="20">20 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'perimetre_moyen_m') {
                html += `<option value="2">2 m</option><option value="5">5 m</option><option value="10" selected>10 m</option><option value="20">20 m</option><option value="50">50 m</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'surface_m2') {
                html += `<option value="1">1 m²</option><option value="5">5 m²</option><option value="10">10 m²</option><option value="50">50 m²</option><option value="100" selected>100 m²</option><option value="500">500 m²</option><option value="1000">1000 m²</option><option value="5000">5000 m²</option><option value="10000">10000 m²</option><option value="manual">Autre valeur</option>`;
            } else if (f === 'nb_pieux') {
                html += `<option value="1">1</option><option value="2">2</option><option value="4" selected>4</option><option value="6">6</option><option value="8">8</option><option value="10">10</option><option value="20">20</option><option value="manual">Autre valeur</option>`;
            }
            html += `</select><span class="unit">${unit}</span></div>`;
            if (f === 'diametre_m') {
                const inchesId = `dim_${f}_inches`;
                html += `<div class="input-with-unit"><select id="${inchesId}" class="tech-form inch-select"><option value="">Pouces</option>`;
                for (let i = 1; i <= 80; i++) html += `<option value="${i}">${i}"</option>`;
                html += `</select><span class="unit">pouces</span></div>`;
            }
            html += `</div><input type="number" id="dim_${f}_manual" class="tech-form manual-input" step="${f === 'nb_pieux' ? '1' : '0.01'}" min="0" style="display:none;" placeholder="Valeur en ${unit}"></div>`;
        });
        html += '</div>';

        // ROLE.txt §15 : invalidation centralisée
        invalidateDomCacheContainer(container, fields.map(f => `dim_${f}`));
        container.innerHTML = html;

        document.querySelectorAll('.dimension-select').forEach(sel => {
            const manualId = sel.id + '_manual';
            const manual = getDomElement(manualId);
            if (manual) {
                const toggle = () => manual.style.display = sel.value === 'manual' ? 'block' : 'none';
                sel.addEventListener('change', toggle);
                toggle();
            }
            sel.addEventListener('change', () => {
                if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
            });
        });
        document.querySelectorAll('.inch-select').forEach(inp => inp.addEventListener('change', function() {
            const inchesVal = Utils.safeNumber(this.value);
            if (inchesVal === 0) return;
            const mainId = this.id.replace('_inches', '');
            const mainSelect = getDomElement(mainId);
            if (!mainSelect) return;
            const converted = inchesVal * 0.0254;
            let optionFound = false;
            for (let opt of mainSelect.options) {
                if (Math.abs(Utils.safeNumber(opt.value) - converted) < 0.001) { mainSelect.value = opt.value; optionFound = true; break; }
            }
            if (!optionFound) { mainSelect.value = 'manual'; const manualInput = getDomElement(mainId + '_manual'); if (manualInput) manualInput.value = converted.toFixed(4); }
            if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
        }));
        let specificHtml = '';
        if (type === 'pipeline_enterre' || type === 'pipeline_offshore') {
            specificHtml = `<div class="dimensions-group"><strong>Données spécifiques pipeline</strong><div class="form-group"><label>Épaisseur (mm)</label><select id="spec_epaisseur" class="tech-form std-select"><option value="3">3 mm</option><option value="4">4 mm</option><option value="5">5 mm</option><option value="6">6 mm</option><option value="7">7 mm</option><option value="8" selected>8 mm</option><option value="10">10 mm</option><option value="12">12 mm</option><option value="15">15 mm</option><option value="20">20 mm</option><option value="manual">Autre valeur</option></select><input type="number" step="0.1" id="spec_epaisseur_manual" class="tech-form manual-input" style="display:none;" placeholder="mm"></div><div class="form-group"><label>Nuance acier</label><select id="spec_nuance" class="tech-form"><option value="X42">X42</option><option value="X52" selected>X52</option><option value="X60">X60</option><option value="X65">X65</option><option value="X70">X70</option><option value="X80">X80</option><option value="API 5L B">API 5L B</option><option value="manual">Autre nuance</option></select><input type="text" id="spec_nuance_manual" class="tech-form manual-input" style="display:none;" placeholder="Nuance"></div><div class="form-group"><label>Revêtement externe</label><select id="spec_revetement" class="tech-form"><option value="FBE">FBE (fusion bonded epoxy)</option><option value="3LPE">3LPE</option><option value="3LPP">3LPP</option><option value="Coal tar">Coal tar epoxy</option><option value="Bitume">Bitume</option><option value="Polyethylene">Polyéthylène extrudé</option><option value="Acier nu">Acier nu</option><option value="manual">Autre</option></select><input type="text" id="spec_revetement_manual" class="tech-form manual-input" style="display:none;" placeholder="Revêtement"></div><div class="form-group"><label>Température d'exploitation (°C)</label><select id="spec_temperature" class="tech-form std-select"><option value="-20">-20 °C</option><option value="0">0 °C</option><option value="20" selected>20 °C</option><option value="40">40 °C</option><option value="60">60 °C</option><option value="80">80 °C</option><option value="100">100 °C</option><option value="120">120 °C</option><option value="150">150 °C</option><option value="manual">Autre valeur</option></select><input type="number" step="1" id="spec_temperature_manual" class="tech-form manual-input" style="display:none;" placeholder="°C"></div><div class="form-group"><label>Pression (bar)</label><select id="spec_pression" class="tech-form std-select"><option value="1">1 bar</option><option value="5">5 bar</option><option value="10">10 bar</option><option value="20">20 bar</option><option value="50" selected>50 bar</option><option value="100">100 bar</option><option value="200">200 bar</option><option value="manual">Autre valeur</option></select><input type="number" step="1" id="spec_pression_manual" class="tech-form manual-input" style="display:none;" placeholder="bar"></div></div>`;
        } else if (type === 'reservoir_fond' || type === 'reservoir_toit' || type === 'ballon_souterrain' || type === 'tank' || type === 'reservoir') {
            const isFloatingTank = type === 'reservoir_toit' || (type === 'tank' && String(getDomElement('equipRoofType')?.value || '').toLowerCase().includes('flott'));
            specificHtml = `<div class="dimensions-group"><i class="fas fa-info-circle" aria-hidden="true"></i> <strong>Surface de contact avec le sol</strong><p style="font-size:0.8rem; margin-top:0.3rem;">${isFloatingTank ? 'Réservoir à toit flottant : seul le fond circulaire posé sur le sol est pris en compte. Calcul = π × d²/4.' : 'Réservoir semi-enterré : fond circulaire + surface latérale de la hauteur enterrée. Renseignez Hauteur enterrée; calcul = π × d²/4 + π × d × h_enterrée.'}</p></div>`;
        } else if (type === 'pieux' || type === 'well_casing' || type === 'fourreau' || type === 'support_metallique') {
            specificHtml = `<div class="dimensions-group"><strong>Données complémentaires</strong><div class="form-group"><label>Épaisseur (mm)</label><select id="spec_epaisseur" class="tech-form std-select"><option value="5">5 mm</option><option value="8">8 mm</option><option value="10" selected>10 mm</option><option value="12">12 mm</option><option value="15">15 mm</option><option value="20">20 mm</option><option value="manual">Autre valeur</option></select><input type="number" step="0.1" id="spec_epaisseur_manual" class="tech-form manual-input" style="display:none;" placeholder="mm"></div><div class="form-group"><label>Nuance acier</label><select id="spec_nuance" class="tech-form"><option value="S235">S235</option><option value="S355" selected>S355</option><option value="API 5L X52">API 5L X52</option><option value="manual">Autre nuance</option></select><input type="text" id="spec_nuance_manual" class="tech-form manual-input" style="display:none;" placeholder="Nuance"></div><div class="form-group"><label>Revêtement</label><select id="spec_revetement" class="tech-form"><option value="Galvanisé">Galvanisé</option><option value="Epoxy">Epoxy</option><option value="PE">Polyéthylène</option><option value="Acier nu" selected>Acier nu</option><option value="manual">Autre</option></select><input type="text" id="spec_revetement_manual" class="tech-form manual-input" style="display:none;" placeholder="Revêtement"></div></div>`;
        }
        if (specificContainer) specificContainer.innerHTML = specificHtml;
        document.querySelectorAll('.std-select').forEach(select => {
            const manualId = select.id + '_manual';
            const manual = getDomElement(manualId);
            if (manual) {
                const toggle = () => manual.style.display = select.value === 'manual' ? 'block' : 'none';
                select.addEventListener('change', toggle);
                toggle();
            }
        });
        if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();

        if (type === 'pipeline_enterre') {
            autoComputeBuriedPipelineLength(true, false);
        }
    }

    function autoFillFromEnvironment() {
        const env = getDomElement('cpEnvironment').value;
        const def = APP_CONFIG.ENV_DEFAULTS[env];
        if (!def) return;
        const setSel = (id, val) => { let s = getDomElement(id); if (s && s.value !== 'manual') s.value = val; };
        setSel('cpCurrentDensitySelect', def.currentDensity);
        setSel('cpResistivitySelect', def.resistivity);
        setSel('cpCoatingSelect', def.coating);
        setSel('iccpCurrentDensitySelect', def.currentDensity);
        setSel('iccpResistivitySelect', def.resistivity);
    }

    // ============================================================
    // v9.3 : Test Posts — Intégration tp-length-sync-patch v3.0
    // ============================================================

    /**
     * Charge les pipelines depuis IndexedDB (force refresh).
     * Wrapper autour de DataResolver si disponible.
     */
    async function loadPipelinesForTestPosts(projectId) {
        if (!projectId || projectId === '__all__') return [];

        // Déléguer à DataResolver si disponible
        if (window.DataResolver &&
            typeof window.DataResolver.loadPipelinesFromIndexedDB === 'function') {
            try {
                return await window.DataResolver.loadPipelinesFromIndexedDB(projectId);
            } catch (e) {
                console.warn('[UI] DataResolver.loadPipelinesFromIndexedDB erreur:', e.message);
            }
        }

        // Fallback : chargement direct
        if (typeof StorageManager !== 'undefined') {
            try {
                const equipments = await StorageManager.loadEquipmentsForProject(projectId, true);
                if (Array.isArray(equipments)) {
                    return equipments.filter(eq =>
                        eq && (eq.type === 'pipeline_enterre' || eq.type === 'pipeline_offshore')
                    );
                }
            } catch (e) {
                console.warn('[UI] StorageManager erreur:', e.message);
            }
        }
        return [];
    }

    /**
     * Calcule la longueur en mètres d'un pipeline (via DataResolver ou fallback).
     */
    function getPipelineLengthMForTestPosts(pipeline) {
        if (!pipeline) return 0;

        // Déléguer à DataResolver
        if (window.DataResolver &&
            typeof window.DataResolver.getPipelineLengthM === 'function') {
            return window.DataResolver.getPipelineLengthM(pipeline);
        }

        // Fallback
        if (pipeline.dimensions && pipeline.dimensions.longueur_m) {
            const n = parseFloat(pipeline.dimensions.longueur_m);
            if (!isNaN(n) && n > 0) return n;
        }
        const coords = pipeline.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
            try {
                if (typeof CoordSystem !== 'undefined' && CoordSystem.pipelineLength) {
                    return CoordSystem.pipelineLength(coords) || 0;
                }
                if (typeof GeoUtils !== 'undefined' && GeoUtils.pathLength) {
                    return GeoUtils.pathLength(coords) || 0;
                }
            } catch (e) {}
        }
        return 0;
    }

    /**
     * v9.3 : Reconstruit la liste des pipelines et met à jour tpTotalLength.
     * Anti-race condition via _tpUpdateToken.
     */
    async function refreshPipelinesAndLength(silent) {
        const myToken = ++_tpUpdateToken;

        const projSel = document.getElementById('tpProject');
        const pipeSel = document.getElementById('tpPipeline');
        const lengthInput = document.getElementById('tpTotalLength');

        if (!projSel || !pipeSel || !lengthInput) return;

        const projectId = projSel.value;
        if (!projectId) return;

        const pipelines = await loadPipelinesForTestPosts(projectId);

        if (myToken !== _tpUpdateToken) return;

        const currentVal = pipeSel.value;
        pipeSel.innerHTML = '<option value="">-- Tous les pipelines --</option>';

        pipelines.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            const lenM = getPipelineLengthMForTestPosts(p);
            const lenKm = lenM / 1000;
            opt.textContent = p.tag + (lenKm > 0 ? ' (' + lenKm.toFixed(2) + ' km)' : '');
            pipeSel.appendChild(opt);
        });

        if (currentVal && pipelines.find(p => p.id === currentVal)) {
            pipeSel.value = currentVal;
        }

        const selectedPipelineId = pipeSel.value;
        let totalM = 0;

        if (selectedPipelineId) {
            const p = pipelines.find(e => e.id === selectedPipelineId);
            if (p) totalM = getPipelineLengthMForTestPosts(p);
        } else {
            pipelines.forEach(p => { totalM += getPipelineLengthMForTestPosts(p); });
        }

        if (totalM > 0) {
            const lengthKm = totalM / 1000;
            const rounded = Math.round(lengthKm * 1000) / 1000;
            lengthInput.value = rounded.toString();
            lengthInput.title = 'Auto : ' + rounded + ' km (' + totalM.toFixed(0) + ' m)';
            lengthInput.style.borderColor = 'var(--accent-cyan, #06b6d4)';
            lengthInput.style.background = 'rgba(6, 182, 212, 0.08)';
        } else {
            lengthInput.value = '';
            lengthInput.title = 'Aucune longueur disponible';
            lengthInput.style.borderColor = '';
            lengthInput.style.background = '';
        }

        if (!silent) {
            if (pipelines.length > 0) {
                console.log('[UI] ' + pipelines.length + ' pipeline(s) chargé(s) pour ' + projectId);
            } else {
                console.warn('[UI] Aucun pipeline trouvé pour ' + projectId);
                showToast('⚠️ Aucun pipeline dans le projet ' + projectId, 'warning');
            }
        }
    }

    // ============================================================
    // Postes de test — version v9.3
    // ============================================================
    function populateTestPostsSelectors() {
        const projSel = getDomElement('tpProject');
        const pipeSel = getDomElement('tpPipeline');
        if (!projSel) return;
        projSel.innerHTML = '<option value="">-- Sélectionner --</option>';
        ProjectManager.getProjectsList().forEach(p => { const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.id} - ${p.name}`;
            projSel.appendChild(opt); });

        // v9.3 : délégation unique via installTestPostsDelegation
        installTestPostsDelegation();

        // v9.3 : mise à jour initiale
        setTimeout(() => {
            const projVal = projSel.value;
            if (projVal) {
                refreshPipelinesAndLength(true);
            }
        }, 120);
    }

    /**
     * v9.3 : Installation de la délégation événements sur le formulaire testPosts.
     * Une seule installation par formulaire (flag _tpSyncV3Installed).
     */
    function installTestPostsDelegation() {
        const form = getDomElement('testPostsForm');
        if (!form || form._tpSyncV3Installed) return;
        form._tpSyncV3Installed = true;

        // 1. Interception submit en capture phase
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            generatePostsCorrected();
        }, true);

        // 2. Délégation change sur les selects
        form.addEventListener('change', function(e) {
            const id = e.target && e.target.id;
            if (id === 'tpProject') {
                setTimeout(() => refreshPipelinesAndLength(false), 100);
            } else if (id === 'tpPipeline') {
                setTimeout(() => refreshPipelinesAndLength(true), 100);
            }
        });

        console.log('[UI v9.3] Délégation Test Posts installée.');
    }

    /**
     * v9.3 : Génération des postes de test (version corrigée).
     * Fusion de tp-length-sync-patch.js v3.0 generatePostsCorrected().
     */
    async function generatePostsCorrected() {
        const projectId = document.getElementById('tpProject')?.value;
        const pipelineId = document.getElementById('tpPipeline')?.value;

        // Conversion km → m
        let totalLengthM = (parseFloat(document.getElementById('tpTotalLength')?.value) || 0) * 1000;

        const spacingEl = document.getElementById('tpSpacing');
        const spacingManualEl = document.getElementById('tpSpacingManual');
        const spacingVal = (spacingEl && spacingEl.value === 'manual')
            ? parseFloat(spacingManualEl?.value || 0)
            : parseFloat(spacingEl?.value || 0);
        let spacingM = spacingVal * 1000;

        if (!projectId) { showToast('Veuillez sélectionner un projet.', 'warning'); return; }
        if (totalLengthM <= 0) { showToast('Longueur totale invalide.', 'warning'); return; }
        if (spacingM <= 0) { showToast('Espacement invalide.', 'warning'); return; }

        // Chargement des pipelines depuis IndexedDB
        const allPipelines = await loadPipelinesForTestPosts(projectId);

        let equipments = allPipelines;
        if (pipelineId) {
            equipments = equipments.filter(eq => eq.id === pipelineId);
        }

        const posts = [];

        // Cas 1 : Aucun pipeline → virtuel
        if (equipments.length === 0) {
            const count = Math.floor(totalLengthM / spacingM) + 1;
            for (let i = 0; i < count; i++) {
                posts.push({
                    id: Utils.generateId(),
                    name: 'TP-' + String(i + 1).padStart(3, '0'),
                    distance: i * spacingM,
                    lat: null, lon: null,
                    equipment: 'Pipeline virtuel'
                });
            }
            renderPosts(posts);
            showToast(posts.length + ' postes générés (virtuels).', 'success');
            return;
        }

        let accumulated = 0;

        for (let eq of equipments) {
            const lengthM = getPipelineLengthMForTestPosts(eq);
            if (lengthM <= 0) continue;

            const coords = eq.coordinates;
            if (!coords) continue;

            let latlngs = [];
            if (Array.isArray(coords)) {
                latlngs = coords.map(c => ({ lat: c.lat, lon: c.lon }));
            } else if (coords.lat !== undefined) {
                latlngs = [{ lat: coords.lat, lon: coords.lon }];
            }
            if (latlngs.length === 0) continue;

            // Cas 2 : Un seul point GPS
            if (latlngs.length === 1) {
                const p = latlngs[0];
                const count = Math.floor(lengthM / spacingM) + 1;
                for (let i = 0; i < count; i++) {
                    posts.push({
                        id: Utils.generateId(),
                        name: 'TP-' + String(posts.length + 1).padStart(3, '0'),
                        distance: accumulated + i * spacingM,
                        lat: p.lat, lon: p.lon,
                        equipment: eq.tag
                    });
                }
                accumulated += lengthM;
                continue;
            }

            // Cas 3 : Multi-points GPS
            const segmentLengths = [];
            let totalLen = 0;
            for (let i = 0; i < latlngs.length - 1; i++) {
                const d = (typeof GeoUtils !== 'undefined' && GeoUtils.distanceHaversine)
                    ? GeoUtils.distanceHaversine(
                        latlngs[i].lat, latlngs[i].lon,
                        latlngs[i+1].lat, latlngs[i+1].lon
                    )
                    : 0;
                segmentLengths.push(d);
                totalLen += d;
            }

            if (totalLen === 0) {
                const count = Math.floor(lengthM / spacingM) + 1;
                for (let i = 0; i < count; i++) {
                    const idx = Math.min(i, latlngs.length - 1);
                    posts.push({
                        id: Utils.generateId(),
                        name: 'TP-' + String(posts.length + 1).padStart(3, '0'),
                        distance: accumulated + i * spacingM,
                        lat: latlngs[idx].lat, lon: latlngs[idx].lon,
                        equipment: eq.tag
                    });
                }
                accumulated += lengthM;
                continue;
            }

            // Point de départ
            posts.push({
                id: Utils.generateId(),
                name: 'TP-' + String(posts.length + 1).padStart(3, '0'),
                distance: accumulated,
                lat: latlngs[0].lat, lon: latlngs[0].lon,
                equipment: eq.tag
            });

            let currentDist = spacingM;
            while (currentDist < lengthM) {
                let distToGo = currentDist - accumulated;
                let found = false;
                let cumul = 0;
                for (let i = 0; i < segmentLengths.length; i++) {
                    if (distToGo <= cumul + segmentLengths[i]) {
                        const frac = (distToGo - cumul) / segmentLengths[i];
                        const lat = latlngs[i].lat + (latlngs[i+1].lat - latlngs[i].lat) * frac;
                        const lon = latlngs[i].lon + (latlngs[i+1].lon - latlngs[i].lon) * frac;
                        posts.push({
                            id: Utils.generateId(),
                            name: 'TP-' + String(posts.length + 1).padStart(3, '0'),
                            distance: currentDist,
                            lat: lat, lon: lon,
                            equipment: eq.tag
                        });
                        found = true;
                        break;
                    }
                    cumul += segmentLengths[i];
                }
                if (!found) {
                    const last = latlngs[latlngs.length - 1];
                    posts.push({
                        id: Utils.generateId(),
                        name: 'TP-' + String(posts.length + 1).padStart(3, '0'),
                        distance: currentDist,
                        lat: last.lat, lon: last.lon,
                        equipment: eq.tag
                    });
                }
                currentDist += spacingM;
            }
            accumulated += lengthM;
        }

        // Fallback
        if (posts.length === 0) {
            const count = Math.floor(totalLengthM / spacingM) + 1;
            for (let i = 0; i < count; i++) {
                posts.push({
                    id: Utils.generateId(),
                    name: 'TP-' + String(i + 1).padStart(3, '0'),
                    distance: i * spacingM,
                    lat: null, lon: null,
                    equipment: 'Aucun pipeline'
                });
            }
        }

        renderPosts(posts);
        showToast(posts.length + ' postes de test générés.', 'success');
    }

    function renderPosts(posts) {
        const container = getDomElement('testPostsResult');
        if (!container) return;

        if (posts.length === 0) {
            container.innerHTML = '<div class="info-message">Aucun poste généré.</div>';
            return;
        }

        let html = '<div class="table-container"><table class="tech-table"><thead><tr>' +
            '<th>Nom</th><th>Distance (m)</th><th>Latitude</th><th>Longitude</th><th>Pipeline</th>' +
            '</tr></thead><tbody>';

        posts.forEach(p => {
            html += '<tr>' +
                '<td>' + Utils.escapeHtml(p.name) + '</td>' +
                '<td>' + p.distance.toFixed(1) + '</td>' +
                '<td>' + (p.lat !== null ? p.lat.toFixed(6) : '-') + '</td>' +
                '<td>' + (p.lon !== null ? p.lon.toFixed(6) : '-') + '</td>' +
                '<td>' + Utils.escapeHtml(p.equipment) + '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;

        try {
            if (typeof ProjectManager !== 'undefined') {
                const st = ProjectManager.getState();
                if (st && st.testPosts) {
                    st.testPosts.posts = posts;
                }
            }
        } catch (e) {}
    }

    function setupTestPostsForm() {
        const form = getDomElement('testPostsForm');
        if (form) {
            // v9.3 : la délégation capture est gérée par installTestPostsDelegation
        }
        getDomElement('exportPostsPDF')?.addEventListener('click', () => { if (window.CPController && typeof window.CPController.exportPostsPDF === 'function') window.CPController.exportPostsPDF(); });
        getDomElement('exportPostsCSV')?.addEventListener('click', () => { if (window.CPController && typeof window.CPController.exportPostsCSV === 'function') window.CPController.exportPostsCSV(); });
        const spacingSelect = getDomElement('tpSpacing');
        if (spacingSelect) {
            spacingSelect.addEventListener('change', function() { const manual = getDomElement('tpSpacingManual'); if (manual) manual.style.display = this.value === 'manual' ? 'block' : 'none'; });
        }
        populateTestPostsSelectors();
    }

    // ============================================================
    // v9.3 : Auto-sélection du système CP préféré
    //        (Intégration data-sync-patch.js v1.0)
    // ============================================================
    function autoSelectPreferredSystem(selectorId) {
        const sysSel = document.getElementById(selectorId);
        if (!sysSel) return false;

        const projectId = ProjectManager.getCurrentProjectId();
        if (!projectId || projectId === '__all__') return false;

        const systems = ProjectManager.getSystems() || [];
        if (systems.length === 0) return false;

        // Récupérer le système préféré via DataResolver
        let preferred = null;
        if (window.DataResolver && typeof window.DataResolver.getPreferredSystem === 'function') {
            preferred = window.DataResolver.getPreferredSystem(projectId);
        } else {
            // Fallback : ICCP > mixte > anodes
            preferred = systems.find(s => s.type === 'iccp')
                     || systems.find(s => s.type === 'mixte')
                     || systems[0];
        }

        if (!preferred) return false;

        const currentVal = sysSel.value;
        const isFirstSystemDefault =
            (currentVal === systems[0].id) &&
            (systems[0].id !== preferred.id);
        const isEmpty = !currentVal;

        if (isEmpty || isFirstSystemDefault) {
            sysSel.value = preferred.id;
            // Propager uniquement si module actif (évite effets de bord)
            const parentModule = sysSel.closest('.module');
            if (parentModule && parentModule.classList.contains('active')) {
                try {
                    sysSel.dispatchEvent(new Event('change', { bubbles: true }));
                } catch (e) { /* silencieux */ }
            }
            console.log('[UI v9.3] Système préféré sélectionné pour', selectorId, '→', preferred.name);
            return true;
        }
        return false;
    }

    function installSystemAutoSelection() {
        const systemModules = [
            { selector: 'cpSystemSelector',    trigger: 'cp-calc' },
            { selector: 'anodesSystemSelector',trigger: 'anodes' },
            { selector: 'iccpSystemSelector',  trigger: 'iccp' },
            { selector: 'measSystemSelector',  trigger: 'fieldmeas' },
            { selector: 'gbSystemSelector',    trigger: 'groundbed' },
            { selector: 'ifSystemSelector',    trigger: 'interference' }
        ];

        // 1. À l'entrée d'un module : auto-sélection
        document.addEventListener('moduleChanged', function(e) {
            const moduleId = e.detail && e.detail.moduleId;
            const target = systemModules.find(m => m.trigger === moduleId);
            if (target) {
                setTimeout(() => autoSelectPreferredSystem(target.selector), 400);
            }
        });

        // 2. Au chargement d'un projet
        document.addEventListener('projectLoaded', function() {
            setTimeout(() => {
                systemModules.forEach(m => autoSelectPreferredSystem(m.selector));
            }, 600);
        });

        // 3. Au changement de projet
        const projSelector = document.getElementById('projectSelector');
        if (projSelector) {
            projSelector.addEventListener('change', function() {
                setTimeout(() => {
                    systemModules.forEach(m => autoSelectPreferredSystem(m.selector));
                }, 500);
            });
        }

        // 4. Module Interference : si pipeline sélectionné, utiliser son système
        const ifPipeline = document.getElementById('ifPipelineSelect');
        if (ifPipeline) {
            ifPipeline.addEventListener('change', function() {
                const pipelineId = this.value;
                if (!pipelineId) return;
                setTimeout(() => {
                    let sys = null;
                    if (window.DataResolver && typeof window.DataResolver.getSystemForPipeline === 'function') {
                        sys = window.DataResolver.getSystemForPipeline(pipelineId);
                    }
                    if (sys) {
                        const sysSel = document.getElementById('ifSystemSelector');
                        if (sysSel && sysSel.value !== sys.id) {
                            sysSel.value = sys.id;
                            console.log('[UI v9.3] Interference : système lié au pipeline →', sys.name);
                        }
                    }
                }, 350);
            });
        }

        console.log('[UI v9.3] Auto-sélection système CP installée.');
    }

    // ============================================================
    // populateProjectSelector — SSOT (ROLE.txt §6)
    // ------------------------------------------------------------
    // ✅ REFACTORING : suppression du verrou _populateProjectSelectorLock
    //   et du throttle 250 ms.
    //   Cause racine des appels concurrents corrigée dans app.js
    //   (PATCH 6) : un seul bootstrap + un seul listener storage.
    //   Cette fonction est désormais idempotente et sans effet de
    //   bord temporel.
    // ============================================================
    function populateProjectSelector() {
        const selector = getDomElement('projectSelector');
        if (!selector) return;

        const currentVal = selector.value;
        selector.innerHTML = '';

        // Option "Tous les projets"
        const allOption = document.createElement('option');
        allOption.value = '__all__';
        allOption.textContent = 'Tous les projets';
        selector.appendChild(allOption);

        // Projets
        const projects = ProjectManager.getProjectsList();
        for (const proj of projects) {
            const option = document.createElement('option');
            option.value = proj.id;
            const typeLabel = proj.type === 'iccp' ? 'ICCP'
                            : proj.type === 'anodes' ? 'Anodes'
                            : 'Mixte';
            option.textContent = proj.id + ' - ' + proj.name + ' (' + typeLabel + ')';
            selector.appendChild(option);
        }

        // Sélection
        // Priorité : valeur courante explicite → projet actif de l'application
        // → « Tous les projets » → dernier projet utilisé → premier projet.
        // Un « __all__ » résiduel ne doit jamais écraser un projet actif
        // (le contexte de deep-link /studio?project=<ID> était sinon perdu
        // lors des repopulations tardives du sélecteur).
        let selectedId = null;
        const urlProjectId = (window.StudioRouter &&
            typeof window.StudioRouter.parseStudioRoute === 'function')
            ? (window.StudioRouter.parseStudioRoute(window.location.search, window.location.hash) || {}).projectId
            : null;
        const activeProjectId = ProjectManager.getCurrentProjectId();
        if (currentVal && currentVal !== '__all__' && projects.some(p => p.id === currentVal)) {
            selectedId = currentVal;
        } else if (activeProjectId && projects.some(p => p.id === activeProjectId)) {
            selectedId = activeProjectId;
        } else if (urlProjectId && projects.some(p => p.id === urlProjectId)) {
            selectedId = urlProjectId;
        } else if (currentVal === '__all__') {
            selectedId = '__all__';
        } else if (projects.length > 0) {
            const lastId = localStorage.getItem('lastProjectId');
            if (lastId && projects.some(p => p.id === lastId)) {
                selectedId = lastId;
            } else {
                selectedId = projects[0].id;
            }
        }

        if (selectedId) {
            selector.value = selectedId;
            if (selectedId === '__all__') {
                if (window.GisIntegration) {
                    window.GisIntegration.filters.set('projectId', null);
                }
                const filterSelect = getDomElement('filterEquipProject');
                if (filterSelect) {
                    filterSelect.value = '__all__';
                    if (window.GisIntegration &&
                        typeof window.GisIntegration.loadPoints === 'function' &&
                        isModuleActive('cartography')) {
                        window.GisIntegration.loadPoints(null, true);
                    }
                }
                _equipFilterProject = '';
                refreshEquipmentListUI(true);
            } else {
                if (window.GisIntegration) {
                    window.GisIntegration.filters.set('projectId', selectedId);
                }
                const filterSelect = getDomElement('filterEquipProject');
                if (filterSelect) filterSelect.value = selectedId;
                _equipFilterProject = selectedId;
                refreshEquipmentListUI(true);
                if (window.GisIntegration &&
                    typeof window.GisIntegration.loadPoints === 'function' &&
                    isModuleActive('cartography')) {
                    window.GisIntegration.loadPoints(selectedId, true);
                }
            }
        } else {
            if (window.GisIntegration) {
                window.GisIntegration.filters.set('projectId', null);
            }
            const filterSelect = getDomElement('filterEquipProject');
            if (filterSelect) filterSelect.value = '__all__';
            _equipFilterProject = '';
            refreshEquipmentListUI(true);
            if (window.GisIntegration &&
                typeof window.GisIntegration.loadPoints === 'function' &&
                isModuleActive('cartography')) {
                window.GisIntegration.loadPoints(null, true);
            }
        }

        setupFilterProjectSelector();

        refreshEquipmentProjectDropdown();
        refreshEquipmentListInCP();
        populateCPEquipmentSelector();
        populateGroundbedProjectSelect();
        populateInterferenceProjectSelect();
        populatePipelineSelects();
        loadHistory();

        if (window.UI && window.UI.renderDynamicEquipmentList) {
            window.UI.renderDynamicEquipmentList();
        }
    }

    function isModuleActive(moduleId) {
        const moduleEl = getDomElement(`module-${moduleId}`);
        return moduleEl && moduleEl.classList.contains('active');
    }

    function setupFilterProjectSelector() {
        const filterSelect = getDomElement('filterEquipProject');
        if (!filterSelect) return;

        let allOption = filterSelect.querySelector('option[value="__all__"]');
        if (!allOption) {
            allOption = document.createElement('option');
            allOption.value = '__all__';
            allOption.textContent = 'Tous les projets';
            filterSelect.prepend(allOption);
        }

        const currentProjectId = ProjectManager.getCurrentProjectId();
        const filterVal = filterSelect.value;

        if (!filterVal || filterVal === '' || !currentProjectId) {
            filterSelect.value = '__all__';
        }

        const newSelect = filterSelect.cloneNode(true);
        filterSelect.parentNode.replaceChild(newSelect, filterSelect);
        const newFilterSelect = getDomElement('filterEquipProject');

        newFilterSelect.addEventListener('change', function() {
            const val = this.value;
            if (val === '__all__' || val === '' || val === null || val === undefined) {
                _equipFilterProject = '';
                if (window.GisIntegration && typeof window.GisIntegration.loadPoints === 'function') {
                    window.GisIntegration.loadPoints(null, true);
                }
                const mainSelector = getDomElement('projectSelector');
                if (mainSelector) mainSelector.value = '__all__';
                refreshEquipmentListUI(true);
            } else {
                _equipFilterProject = val;
                if (window.GisIntegration && typeof window.GisIntegration.loadPoints === 'function') {
                    window.GisIntegration.loadPoints(val, true);
                }
                const mainSelector = getDomElement('projectSelector');
                if (mainSelector) mainSelector.value = val;
                refreshEquipmentListUI(true);
            }
        });
    }

    function initFieldSources() {
        const autoFields = ['cpSurface', 'iccpSurface', 'equipSurfaceAuto'];
        autoFields.forEach(id => {
            const el = getDomElement(id);
            if (el) {
                const wrapper = el.parentElement;
                if (wrapper && !wrapper.querySelector('.source-badge')) {
                    const badge = document.createElement('span');
                    badge.className = 'source-badge auto';
                    badge.textContent = 'calculé';
                    wrapper.appendChild(badge);
                }
                setFieldSource(id, 'auto');
            }
        });
        document.querySelectorAll('.result-value').forEach(el => {
            if (el.id) {
                el.classList.add('field-auto-calculated');
                el.readOnly = true;
                el.style.userSelect = 'text';
            }
        });
    }

    function loadProjectParams() {
        const state = ProjectManager.getState();
        const proj = state.project;
        if (!proj) return;
        const typeRadios = document.querySelectorAll('input[name="cpSystemType"]');
        typeRadios.forEach(radio => {
            radio.checked = (radio.value === proj.cpSystemType);
        });
        setModulesActivation(proj.cpSystemType || 'mixte');
        setSelectValue('defectDensity', proj.defectDensity);
        setSelectValue('agingFactor', proj.agingFactor);
        setSelectValue('targetPotential', proj.targetPotential);
        const shared = proj.shared || {};
        setSelectValue('cableLength', shared.cableLength);
        if (shared.cableLengthIsTotal) {
            const cableLengthSelect = document.getElementById('cableLength');
            if (cableLengthSelect) cableLengthSelect.dataset.isTotal = 'true';
            const badge = document.getElementById('cableLengthSyncBadge');
            if (badge && shared.cableLength) {
                badge.textContent = 'boucle SIG ' + parseFloat(shared.cableLength).toFixed(0) + ' m';
                badge.style.display = 'inline';
            }
        }
        setSelectValue('cableSection', shared.cableSection);
        setSelectValue('structureResistance', shared.structureResistance);
        setSelectValue('envSoilResistivity', proj.envSoilResistivity);
        setSelectValue('envSoilPh', proj.envSoilPh);
        setSelectValue('envSoilMoisture', proj.envSoilMoisture);
        setSelectValue('envSoilChlorides', proj.envSoilChlorides);
        setSelectValue('envSoilSulfates', proj.envSoilSulfates);
        setSelectValue('envSoilRedox', proj.envSoilRedox);
        setSelectValue('envWaterSalinity', proj.envWaterSalinity);
        setSelectValue('envWaterConductivity', proj.envWaterConductivity);
        setSelectValue('envWaterTemp', proj.envWaterTemp);
        setSelectValue('envWaterDO', proj.envWaterDO);
        setSelectValue('cpEnvironment', proj.cpEnvironment);
    }

    function setupAutoSaveFields() {
        const debouncedSave = debounce(() => { ProjectManager.saveCurrentProject(); }, 500);
        const fieldsToSave = [
            'defectDensity', 'agingFactor', 'targetPotential',
            'cableLength', 'cableSection', 'structureResistance',
            'envSoilResistivity', 'envSoilPh', 'envSoilMoisture', 'envSoilChlorides',
            'envSoilSulfates', 'envSoilRedox',
            'envWaterSalinity', 'envWaterConductivity', 'envWaterTemp', 'envWaterDO',
            'cpEnvironment'
        ];
        fieldsToSave.forEach(id => {
            const el = getDomElement(id);
            if (el) {
                const eventType = el.tagName === 'SELECT' ? 'change' : 'input';
                el.addEventListener(eventType, debouncedSave);
            }
        });
        document.querySelectorAll('input[name="cpSystemType"]').forEach(radio => {
            radio.addEventListener('change', function() {
                if (this.checked) {
                    const state = ProjectManager.getState();
                    state.project.cpSystemType = this.value;
                    debouncedSave();
                }
            });
        });
    }

    // ============================================================
    // Zones critiques
    // ============================================================
    function setupReinforcementZones() {
        // ─── Garde d'installation unique des listeners (ROLE.txt §9) ───
        // Le rendu (renderReinforcementZones) reste TOUJOURS exécuté
        // car il doit refléter l'état courant du projet.
        if (AppState._reinforcementZonesListenersInstalled) {
            renderReinforcementZones();
            return;
        }
        AppState._reinforcementZonesListenersInstalled = true;

        const addZoneBtn = getDomElement('addReinforcementZoneBtn');
        const confirmZoneBtn = getDomElement('confirmZoneBtn');
        const cancelZoneBtn = getDomElement('cancelZoneBtn');
        const analyzeBtn = getDomElement('analyzeReinforcementBtn');
        const autoDetectBtn = getDomElement('autoDetectZonesBtn');

        if (addZoneBtn) {
            addZoneBtn.addEventListener('click', function() {
                getDomElement('reinforcementZoneModal').style.display = 'flex';
                getDomElement('zoneName').value = 'Zone ' + ((ProjectManager.getState().iccp.reinforcementZones || []).length + 1);
                getDomElement('zoneLocation').value = '';
                getDomElement('zoneProblemType').value = 'other';
                getDomElement('zoneCriticality').value = 'medium';
                getDomElement('zoneAdditionalCurrent').value = '0.5';
                getDomElement('zoneAnodesCount').value = '';
            });
        }

        if (confirmZoneBtn) {
            confirmZoneBtn.addEventListener('click', function() {
                const name = getDomElement('zoneName').value.trim();
                const location = getDomElement('zoneLocation').value.trim();
                const problemType = getDomElement('zoneProblemType').value;
                const criticality = getDomElement('zoneCriticality').value;
                const additionalCurrent = Utils.safeNumber(getDomElement('zoneAdditionalCurrent').value);

                if (!name) { showToast('Veuillez saisir un nom.', 'warning'); return; }
                if (additionalCurrent <= 0) { showToast('Le courant supplémentaire doit être > 0.', 'warning'); return; }

                if (window.CPController && typeof window.CPController.addReinforcementZone === 'function') {
                    window.CPController.addReinforcementZone(name, location, problemType, criticality, additionalCurrent);
                } else {
                    const zones = ProjectManager.getState().iccp.reinforcementZones || [];
                    const zone = { id: Utils.generateId(), name, location, problemType, criticality, additionalCurrent };
                    zones.push(zone);
                    ProjectManager.getState().iccp.reinforcementZones = zones;
                    renderReinforcementZones();
                    showToast(`Zone "${Utils.escapeHtml(name)}" ajoutée.`, 'success');
                    ProjectManager.addHistoryEntry('iccp', `Ajout zone critique ${name}`, `${additionalCurrent} A`);
                    try { ProjectManager.saveCurrentProject(); } catch (err) { console.error(err); }
                }
                getDomElement('reinforcementZoneModal').style.display = 'none';
                if (getDomElement('iccpResultsContent') && !getDomElement('iccpResultsContent').classList.contains('hidden')) {
                    if (window.CPController && typeof window.CPController.analyzeReinforcementNeeds === 'function') window.CPController.analyzeReinforcementNeeds();
                }
            });
        }

        if (cancelZoneBtn) { cancelZoneBtn.addEventListener('click', function() { getDomElement('reinforcementZoneModal').style.display = 'none'; }); }

        if (analyzeBtn) { analyzeBtn.addEventListener('click', function() { if (window.CPController && typeof window.CPController.analyzeReinforcementNeeds === 'function') window.CPController.analyzeReinforcementNeeds(); }); }

        if (autoDetectBtn) { autoDetectBtn.addEventListener('click', function() { if (window.CPController && typeof window.CPController.autoDetectZones === 'function') window.CPController.autoDetectZones(); }); }

        const spacingMode = getDomElement('iccpSpacingMode');
        const manualSpacingGroup = getDomElement('iccpManualSpacingGroup');
        if (spacingMode && manualSpacingGroup) {
            spacingMode.addEventListener('change', function() { manualSpacingGroup.style.display = this.value === 'manual' ? 'block' : 'none'; });
        }

        renderReinforcementZones();
    }

    function renderReinforcementZones() {
        const container = getDomElement('reinforcementZonesContainer');
        if (!container) return;
        const zones = ProjectManager.getState().iccp.reinforcementZones || [];
        if (zones.length === 0) { container.innerHTML = '<div class="info-message">Aucune zone critique définie. Cliquez sur "Add Zone" pour ajouter une zone nécessitant un renforcement.</div>'; return; }
        let html = '';
        zones.forEach((zone, idx) => {
            const critClass = zone.criticality === 'high' ? 'high' : zone.criticality === 'medium' ? 'medium' : 'low';
            html += `<div class="zone-item" data-index="${idx}" role="listitem">
                <span class="zone-name">${Utils.escapeHtml(zone.name)}</span>
                <span class="zone-location">${Utils.escapeHtml(zone.location || '-')}</span>
                <span class="zone-problem">${Utils.escapeHtml(zone.problemType || '-')}</span>
                <span class="zone-criticality ${critClass}">${zone.criticality}</span>
                <span class="zone-current">${Utils.safeNumber(zone.additionalCurrent).toFixed(2)} A</span>
                <div class="zone-actions">
                    <button data-action="delete-zone" data-index="${idx}" aria-label="Supprimer la zone ${Utils.escapeHtml(zone.name)}" title="Supprimer"><i class="fas fa-trash" aria-hidden="true"></i></button>
                </div>
            </div>`;
        });
        container.innerHTML = html;
        container.querySelectorAll('[data-action="delete-zone"]').forEach(btn => {
            btn.addEventListener('click', function() {
                const idx = parseInt(this.dataset.index);
                const zones2 = ProjectManager.getState().iccp.reinforcementZones || [];
                if (idx >= 0 && idx < zones2.length) {
                    zones2.splice(idx, 1);
                    ProjectManager.getState().iccp.reinforcementZones = zones2;
                    renderReinforcementZones();
                    showToast('Zone supprimée.', 'warning');
                    try { ProjectManager.saveCurrentProject(); } catch (err) { console.error(err); }
                }
            });
        });
    }

    // ============================================================
    // Cartographie
    // ============================================================
    function setupCartography() {
        // ─── Garde d'installation unique (ROLE.txt §9) ───
        if (AppState._cartographyListenersInstalled) {
            return;
        }
        AppState._cartographyListenersInstalled = true;

        const addEquipmentBtn = getDomElement('mapAddEquipment');
        const centerBtn = getDomElement('mapCenter');
        const exportBtn = getDomElement('mapExport');
        const confirmBtn = getDomElement('confirmMapPoint');
        const cancelBtn = getDomElement('cancelMapPoint');

        if (addEquipmentBtn) {
            addEquipmentBtn.addEventListener('click', function() {
                document.querySelector('.nav-item[data-module="equipements"]')?.click();
                const mapInstance = window.GisIntegration?.getMap();
                if (mapInstance) {
                    const center = mapInstance.getCenter();
                    const container = getDomElement('equipWaypointsContainer');
                    if (container) {
                        container.innerHTML = '';
                        addEquipWaypointRow(center.lat, center.lng, null, false);
                    }
                }
                setTimeout(() => {
                    const tagField = getDomElement('equipTag');
                    if (tagField) tagField.focus();
                }, 300);
                showToast('Utilisez le formulaire "Gestion des équipements" pour ajouter un équipement avec ses coordonnées GPS.', 'info');
            });
        }

        if (centerBtn) centerBtn.addEventListener('click', () => { if (window.CPController && typeof window.CPController.centerMap === 'function') window.CPController.centerMap(); });
        if (exportBtn) exportBtn.addEventListener('click', () => { if (window.CPController && typeof window.CPController.exportMapData === 'function') window.CPController.exportMapData(); });
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                const type = getDomElement('mapPointType').value;
                const name = getDomElement('mapPointName').value.trim();
                const lat = Utils.safeNumber(getDomElement('mapPointLat').value);
                const lon = Utils.safeNumber(getDomElement('mapPointLon').value);
                if (window.CPController && typeof window.CPController.addMapPoint === 'function') window.CPController.addMapPoint(type, name, lat, lon);
                getDomElement('mapPointModal').style.display = 'none';
            });
        }
        if (cancelBtn) cancelBtn.addEventListener('click', () => { getDomElement('mapPointModal').style.display = 'none'; });

        // ⚠️ Le binding sur AppState.map est retiré ici : il est géré
        // par GisIntegration qui possède le cycle de vie de la carte.
    }

    function openMapPointModal(type) {
        getDomElement('mapPointType').value = type || 'other';
        getDomElement('mapPointName').value = '';
        getDomElement('mapPointLat').value = '';
        getDomElement('mapPointLon').value = '';
        getDomElement('mapPointModal').style.display = 'flex';
        if (type === 'testpost') getDomElement('mapPointName').placeholder = 'Poste test #';
        else if (type === 'anode') getDomElement('mapPointName').placeholder = 'Anode #';
        else if (type === 'equipment') getDomElement('mapPointName').placeholder = 'Équipement #';
        else if (type === 'groundbed') getDomElement('mapPointName').placeholder = 'Puits anodique #';
        else getDomElement('mapPointName').placeholder = 'Nom du point';
    }

    // ============================================================
    // Exports
    // ============================================================
    function exportGlobalReport() {
        const state = ProjectManager.getState();
        const projectId = ProjectManager.getCurrentProjectId();
        const project = ProjectManager.getProjectsList().find(p => p.id === projectId);

        let report = [];
        report.push('═══════════════════════════════════════════════════════════════');
        report.push('           RAPPORT GLOBAL CP ENGINEER PRO');
        report.push('═══════════════════════════════════════════════════════════════');
        report.push('');
        report.push(`📋 PROJET : ${project ? project.name : 'N/A'} (${projectId})`);
        report.push(`📅 DATE    : ${new Date().toLocaleString('fr-FR')}`);
        report.push(`📌 VERSION : ${APP_CONFIG.VERSION}`);
        report.push('');
        report.push('───────────────────────────────────────────────────────────────');
        report.push('  RÉSULTATS CP');
        report.push('───────────────────────────────────────────────────────────────');
        report.push(`  Courant requis        : ${state.cp.current.toFixed(3)} A`);
        report.push(`  IR Drop               : ${state.cp.irDrop.toFixed(3)} V`);
        report.push(`  Potentiel ON requis   : ${state.cp.requiredOnPotential.toFixed(0)} mV vs Cu/CuSO₄`);
        report.push('');
        report.push('───────────────────────────────────────────────────────────────');
        report.push('  ANODES SACRIFICIELLES');
        report.push('───────────────────────────────────────────────────────────────');
        report.push(`  Masse totale          : ${state.anodes.totalMass.toFixed(1)} kg`);
        report.push(`  Nombre d'anodes       : ${state.anodes.count}`);
        report.push(`  Durée de vie          : ${state.anodes.actualLife.toFixed(1)} ans`);
        report.push(`  Densité de courant    : ${state.anodes.currentDensity.toFixed(3)} A/m² ${state.anodes.densityOk ? '✅ OK' : '⚠️ À revoir'}`);
        report.push('');
        report.push('───────────────────────────────────────────────────────────────');
        report.push('  ICCP');
        report.push('───────────────────────────────────────────────────────────────');
        report.push(`  Courant               : ${state.iccp.current.toFixed(2)} A`);
        report.push(`  Tension               : ${state.iccp.voltage.toFixed(2)} V`);
        const iccpPower = state.iccp.powerDesign || state.iccp.power;
        report.push(`  Puissance             : ${iccpPower.toFixed(1)} W (SF appliqué une fois)`);
        report.push(`  Résistance groundbed  : ${(state.iccp.groundbedResistance || 0).toFixed(4)} Ω`);
        const lifeDesign = state.iccp.lifeDesign || state.iccp.lifeEstimate || 0;
        const lifeTheory = state.iccp.lifeTheoretical || 0;
        report.push(`  Durée de vie (conception) : ${lifeDesign.toFixed(1)} ans`);
        if (lifeTheory > 0 && lifeTheory !== lifeDesign) {
            report.push(`  Durée de vie (théorique)  : ${lifeTheory.toFixed(1)} ans`);
        }
        report.push(`  Densité de courant    : ${(state.iccp.currentDensity || 0).toFixed(3)} A/m² ${state.iccp.densityOk ? '✅ OK' : '⚠️ À revoir'}`);
        if (state.iccp.iccpSourceLabel) {
            report.push(`  Source courant ICCP   : ${state.iccp.iccpSourceLabel}`);
        }
        report.push('');
        report.push('───────────────────────────────────────────────────────────────');
        report.push('  ÉQUIPEMENTS');
        report.push('───────────────────────────────────────────────────────────────');
        const eqs = state.equipments.filter(eq => eq.projectId === projectId);
        const calculableEqs = eqs.filter(eq => isIndividualCPEquipment(eq));
        const totalSurface = eqs.reduce((s, eq) => s + getCanonicalEquipmentSurface(eq), 0);
        const calculated = calculableEqs.filter(eq => eq.cpData && eq.cpData.calculated).length;
        report.push(`  Total équipements     : ${eqs.length}`);
        report.push(`  Surface totale        : ${totalSurface.toFixed(1)} m²`);
        report.push(`  Équipements calculés  : ${calculated}/${calculableEqs.length}`);
        report.push('');
        report.push('───────────────────────────────────────────────────────────────');
        report.push('  GROUNDBED');
        report.push('───────────────────────────────────────────────────────────────');
        const gbResults = state.groundbed?.results;
        if (gbResults && gbResults.R_total) {
            report.push(`  Résistance total      : ${gbResults.R_total.toFixed(4)} Ω`);
            report.push(`  Courant total         : ${gbResults.I_total.toFixed(2)} A`);
            report.push(`  Tension redresseur    : ${gbResults.V_rectifier.toFixed(1)} V`);
            report.push(`  Puissance             : ${gbResults.P_rectifier.toFixed(0)} W`);
            const gbLifeReport = gbResults.lifeDesign || (gbResults.lifeWithSafety ? Math.min(gbResults.lifeWithSafety, 25) : 0);
            report.push(`  Durée de vie (conception) : ${gbLifeReport.toFixed(1)} ans (NACE SP0169 ≤25 ans)`);
            if (gbResults.rhoProject !== undefined && gbResults.rhoGroundbed !== undefined) {
                report.push(`  Résistivité projet    : ${gbResults.rhoProject} Ω·m`);
                report.push(`  Résistivité groundbed : ${gbResults.rhoGroundbed} Ω·m`);
            }
        } else {
            report.push('  Aucun résultat groundbed disponible.');
        }
        report.push('');
        report.push('───────────────────────────────────────────────────────────────');
        report.push('  INTERFÉRENCES');
        report.push('───────────────────────────────────────────────────────────────');
        const ifResults = state.interference?.results;
        if (ifResults && ifResults.globalStatus) {
            report.push(`  Statut global         : ${ifResults.globalStatus}`);
            report.push(`  AC induit             : ${ifResults.acInduced.toFixed(2)} V`);
            report.push(`  DC stray              : ${ifResults.dcStray.toFixed(3)} A`);
            if (ifResults.mitigations && ifResults.mitigations.length > 0) {
                report.push('  Mitigations           : ' + ifResults.mitigations.join(', '));
            }
        } else {
            report.push('  Aucune analyse d\'interférences disponible.');
        }
        report.push('');
        report.push('═══════════════════════════════════════════════════════════════');
        report.push(`  Rapport généré le ${new Date().toLocaleString('fr-FR')}`);
        report.push('═══════════════════════════════════════════════════════════════');

        const blob = new Blob([report.join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `rapport_global_${projectId}_${new Date().toISOString().slice(0,10)}.txt`;
        a.click();
        showToast('Rapport global exporté (TXT)', 'success');
    }

    function exportGroundbedPDF() {
        showToast('Export PDF groundbed - fonction à implémenter', 'info');
        if (window.CPController && typeof window.CPController.exportPDF === 'function') {
            window.CPController.exportPDF();
        }
    }

    function exportInterferencePDF() {
        showToast('Export PDF interférences - fonction à implémenter', 'info');
        if (window.CPController && typeof window.CPController.exportPDF === 'function') {
            window.CPController.exportPDF();
        }
    }

    // ============================================================
    // displayICCPResults – v9.3 (avec sync câble intégré)
    // ============================================================
    function displayICCPResults(results) {
        if (!results) {
            console.warn('displayICCPResults: Aucun résultat à afficher');
            return;
        }
        const placeholder = getDomElement('iccpPlaceholder');
        const resultsContent = getDomElement('iccpResultsContent');
        const tableBody = getDomElement('iccpTableBody');
        if (!resultsContent || !tableBody) {
            console.warn('displayICCPResults: Éléments HTML non trouvés');
            return;
        }
        if (placeholder) placeholder.classList.add('hidden');
        resultsContent.classList.remove('hidden');

        const currentEl = getDomElement('resICCPCurrent');
        const tensionEl = getDomElement('resICCPTension');
        const powerEl = getDomElement('resICCPPower');
        const resistanceEl = getDomElement('resICCPResistance');
        const gbResistanceEl = getDomElement('resGroundbedResistance');
        const currentPerAnodeEl = getDomElement('resCurrentPerAnode');
        const anodeDensityEl = getDomElement('resAnodeDensityICCP');
        const lifeEl = getDomElement('resICCPLife');

        if (currentEl) currentEl.innerText = (results.currentTotal || 0).toFixed(2);
        if (tensionEl) tensionEl.innerText = (results.voltageInitial || 0).toFixed(2);
        const powerDesignVal = (results.powerDesign !== undefined && results.powerDesign !== null)
            ? results.powerDesign
            : (results.powerInitial || 0);
        if (powerEl) powerEl.innerText = powerDesignVal.toFixed(1);
        if (resistanceEl) resistanceEl.innerText = (results.groupResistanceInitial || 0).toFixed(4);
        if (gbResistanceEl) gbResistanceEl.innerText = (results.groundbedResistance || 0).toFixed(4);
        if (currentPerAnodeEl) currentPerAnodeEl.innerText = (results.currentPerAnode || 0).toFixed(3);

        if (anodeDensityEl) {
            const jAnode = (results.currentDensityAnode !== undefined && results.currentDensityAnode !== null)
                ? results.currentDensityAnode
                : (results.currentDensity || 0);
            anodeDensityEl.innerText = jAnode.toFixed(3);
        }

        if (lifeEl) {
            const lifeDesignVal = (results.lifeDesign !== undefined && results.lifeDesign !== null)
                ? results.lifeDesign
                : (results.lifeEstimate || 0);
            const lifeTheoryVal = results.lifeTheoretical || 0;
            lifeEl.innerText = lifeDesignVal.toFixed(1);
            if (lifeTheoryVal > 0 && Math.abs(lifeTheoryVal - lifeDesignVal) > 0.1) {
                lifeEl.title = `Durée théorique (calcul brut) : ${lifeTheoryVal.toFixed(1)} ans — plafonnée à ${lifeDesignVal.toFixed(1)} ans (conception)`;
            } else {
                lifeEl.title = `Durée de vie : ${lifeDesignVal.toFixed(1)} ans`;
            }
        }

        let html = '';
        const rows = [
            { label: 'Courant total ICCP', value: (results.currentTotal || 0).toFixed(2), unit: 'A', formula: 'I = S × J / 1000 ou I_total source' },
            { label: 'Courant par anode', value: (results.currentPerAnode || 0).toFixed(3), unit: 'A', formula: 'I_anode = I_total / N_anodes' },
            { label: 'Tension initiale (V_initial)', value: (results.voltageInitial || 0).toFixed(2), unit: 'V', formula: 'V = I × R + V_backEMF' },
            { label: 'Tension finale (V_final)', value: (results.voltageFinal || 0).toFixed(2), unit: 'V', formula: 'V_final = I × R_final + V_backEMF' },
            { label: 'Back EMF', value: (results.backEmfVoltage || 0).toFixed(2), unit: 'V', formula: 'Force contre-électromotrice' },
            { label: 'Puissance initiale', value: (results.powerInitial || 0).toFixed(1), unit: 'W', formula: 'P = V × I' },
            { label: 'Puissance de conception (DC)', value: powerDesignVal.toFixed(1), unit: 'W',
              formula: `P_design = P × SF (SF = ${(results.safetyFactorPower || 1.15).toFixed(2)})` },
            // GAP-04 : Puissance AC requise au réseau (η redresseur)
            { label: 'Puissance AC réseau requise (η=0.85)', value:
              results.P_AC_required != null
                ? results.P_AC_required.toFixed(1)
                : (powerDesignVal > 0 ? (powerDesignVal / 0.85).toFixed(1) : '0.0'),
              unit: 'W',
              formula: 'P_AC = P_design / η (IEC 60146 — dimensionnement transformateur)' },
            { label: 'Résistance de groupe (Sunde)', value: (results.groupResistanceInitial || 0).toFixed(4), unit: 'Ω', formula: 'Interaction mutuelle' },
            { label: 'Résistance de groupe finale', value: (results.groupResistanceFinal || 0).toFixed(4), unit: 'Ω', formula: 'R_group × agingFactor' },
            { label: 'Résistance du puits (R_well)', value: (results.R_well || 0).toFixed(4), unit: 'Ω', formula: 'Dwight corrigé' },
            { label: 'Résistance groundbed totale', value: (results.groundbedResistance || 0).toFixed(4), unit: 'Ω', formula: 'R_group + R_well (série)' },
            { label: 'Résistance totale circuit', value: (results.totalResistance || 0).toFixed(4), unit: 'Ω', formula: 'R_groundbed + R_cable + R_struct' },
            { label: 'Résistance totale finale', value: (results.totalResistanceFinal || 0).toFixed(4), unit: 'Ω', formula: 'R_total × aging' }
        ];

        const jAnodeVal = (results.currentDensityAnode !== undefined && results.currentDensityAnode !== null)
            ? results.currentDensityAnode
            : (results.currentDensity || 0);
        rows.push({
            label: 'Densité de courant anodique',
            value: jAnodeVal.toFixed(3),
            unit: 'A/m²',
            formula: 'J_anode = I_anode / S_anode'
        });
        if (Math.abs(jAnodeVal) > 0 && Math.abs(jAnodeVal) < 1) {
            rows.push({
                label: '  (équivalent)',
                value: (jAnodeVal * 1000).toFixed(1),
                unit: 'mA/m²',
                formula: '× 1000'
            });
        }

        rows.push({ label: 'Limite de densité', value: (results.densityLimit || 0).toFixed(0), unit: 'A/m²', formula: 'Selon matériau anode' });
        rows.push({ label: 'Statut densité', value: results.densityOk ? '✅ OK' : '⚠️ À revoir', unit: '', formula: results.densityOk ? 'J_anode ≤ limite' : 'J_anode > limite' });

        const lifeDesignVal = results.lifeDesign || results.lifeEstimate || 0;
        const lifeTheoryVal = results.lifeTheoretical || 0;
        rows.push({ label: 'Durée de vie (conception)', value: lifeDesignVal.toFixed(1), unit: 'ans', formula: 'Plafonnée à 25 ans' });
        if (lifeTheoryVal > 0 && Math.abs(lifeTheoryVal - lifeDesignVal) > 0.1) {
            rows.push({ label: 'Durée de vie (théorique)', value: lifeTheoryVal.toFixed(1), unit: 'ans', formula: 'Calcul brut (non plafonné)' });
        }

        rows.push({ label: 'Nombre d\'anodes', value: (results.N_anodes || 0).toFixed(0), unit: '', formula: 'Paramètre utilisateur' });
        rows.push({ label: 'Surface d\'une anode', value: (results.anodeSurface || 0).toFixed(4), unit: 'm²', formula: 'π × d × L' });
        rows.push({ label: 'Masse totale estimée', value: (results.totalMassEstimate || 0).toFixed(1), unit: 'kg', formula: 'N × 25 kg' });

        rows.forEach(row => {
            html += `<tr>
                <td>${row.label}</td>
                <td>${row.value}</td>
                <td>${row.unit}</td>
                <td style="font-size:0.75rem; color:var(--text-muted);">${row.formula}</td>
            </tr>`;
        });
        tableBody.innerHTML = html;

        const resultsTab = document.querySelector('[data-tab-target="iccp-results-panel"]');
        if (resultsTab && !resultsTab.classList.contains('active')) {
            resultsTab.click();
        }

        const sourceInfo = getDomElement('iccpCurrentSourceInfo');
        if (sourceInfo) {
            if (results.iccpCurrentSource) {
                const srcLabels = {
                    manual: 'Manuel (saisie utilisateur)',
                    cp_calculated: 'CP calculé (I_CP)',
                    equipment_total: 'Cumul équipements',
                    unknown: 'Source inconnue'
                };
                const label = srcLabels[results.iccpCurrentSource] || results.iccpCurrentSource;
                const requiredCurrent = Number(results.requiredCurrent);
                const marginText = Number.isFinite(requiredCurrent) && requiredCurrent > 0
                    ? ` — I_requis = ${requiredCurrent.toFixed(3)} A, marge = ${Number(results.currentMarginPercent || 0).toFixed(0)}%`
                    : ' — I_requis = N/A';
                sourceInfo.textContent = `Source du courant : ${label} — I_selectionne = ${(results.currentTotal || 0).toFixed(3)} A${marginText}`;
                sourceInfo.style.display = 'block';
            } else if (results._sourceInfo) {
                sourceInfo.textContent = results._sourceInfo;
                sourceInfo.style.display = 'block';
            } else {
                sourceInfo.style.display = 'none';
            }
        }

        // ============================================================
        // v9.3 : SYNCHRONISATION CÂBLE DC (ex iccp-cable-sync-patch v1.1)
        // ------------------------------------------------------------
        // Auto-synchronise #cableCurrent avec le courant ICCP calculé.
        // ============================================================
        try {
            if (results && isFinite(results.currentTotal) && results.currentTotal > 0) {
                syncCableCurrentFromICCP(results.currentTotal, 'Calcul ICCP', { silent: true });
            }
        } catch (e) {
            console.warn('[UI v9.3] Erreur syncCableCurrentFromICCP:', e);
        }
    }

    // ============================================================
    // updateICCPCurrentSource / updateAnodeCurrentSource
    // ============================================================
    function updateICCPCurrentSource() {
        const sourceSelect = getDomElement('iccpCurrentSource');
        const manualGroup = getDomElement('iccpManualCurrentGroup');
        const iccpSurface = getDomElement('iccpSurface');
        const densitySelect = getDomElement('iccpCurrentDensitySelect');
        const infoDiv = getDomElement('iccpCurrentSourceInfo');
        const manualLabel = document.querySelector('label[for="iccpManualCurrent"]');

        if (!sourceSelect) return;

        if (manualGroup) {
            const isManual = sourceSelect.value === 'manual';
            manualGroup.style.display = isManual ? 'block' : 'none';
            manualGroup.setAttribute('aria-hidden', String(!isManual));
            if (manualLabel) manualLabel.textContent = isManual
                ? 'Courant manuel (A)'
                : 'Courant manuel (inactif)';
            const manualInput = getDomElement('iccpManualCurrent');
            if (manualInput) {
                manualInput.disabled = !isManual;
                manualInput.setAttribute('aria-disabled', String(!isManual));
            }
        }

        if (sourceSelect.value === 'cp_calculated' || sourceSelect.value === 'equipment_total') {
            let total = 0;
            let sourceLabel = '';
            if (sourceSelect.value === 'cp_calculated') {
                total = ProjectManager.getState().cp.current || 0;
                sourceLabel = 'CP calculé';
            } else {
                total = window.CPController?.getTotalEquipmentCurrent ? window.CPController.getTotalEquipmentCurrent() : 0;
                sourceLabel = 'Cumul équipements';
            }

            if (infoDiv) {
                infoDiv.style.display = 'block';
                infoDiv.textContent = `Source : ${sourceLabel} (${total.toFixed(3)} A). La densité est désactivée car le courant est imposé par la source.`;
            }

            if (densitySelect) {
                densitySelect.disabled = true;
                densitySelect.style.opacity = '0.6';
                densitySelect.style.cursor = 'not-allowed';
            }
        } else {
            if (densitySelect) {
                densitySelect.disabled = false;
                densitySelect.style.opacity = '1';
                densitySelect.style.cursor = 'pointer';
            }
            if (infoDiv) {
                infoDiv.style.display = 'none';
            }
        }
    }

    function updateAnodeCurrentSource() {
        const sourceSelect = getDomElement('anodeCurrentSource');
        const currentReq = getDomElement('anodeCurrentReq');
        const infoDiv = getDomElement('anodeCurrentSourceInfo');
        if (!sourceSelect || !currentReq) return;

        if (sourceSelect.value === 'cp_calculated') {
            const cpCurrent = ProjectManager.getState().cp.current || 0;
            if (cpCurrent > 0) {
                currentReq.value = cpCurrent.toFixed(3);
                currentReq.disabled = true;
                setFieldSource('anodeCurrentReq', 'auto');
                if (infoDiv) {
                    infoDiv.style.display = 'block';
                    infoDiv.textContent = `Source : Courant CP calculé (${cpCurrent.toFixed(3)} A)`;
                }
            }
        } else if (sourceSelect.value === 'equipment_total') {
            const total = window.CPController?.getTotalEquipmentCurrent ? window.CPController.getTotalEquipmentCurrent() : 0;
            if (total > 0) {
                currentReq.value = total.toFixed(3);
                currentReq.disabled = true;
                setFieldSource('anodeCurrentReq', 'auto');
                if (infoDiv) {
                    infoDiv.style.display = 'block';
                    infoDiv.textContent = `Source : Cumul équipements (${total.toFixed(3)} A)`;
                }
            }
        } else {
            currentReq.disabled = false;
            setFieldSource('anodeCurrentReq', 'manual');
            if (infoDiv) infoDiv.style.display = 'none';
        }
    }

    function syncGroundbedFromCP() {
        const cpCurrent = ProjectManager.getState().cp.current || 0;
        const gbTarget = getDomElement('gbTargetCurrent');
        if (gbTarget && AppState.gndLinkState.current) {
            gbTarget.value = cpCurrent.toFixed(3);
        }
    }

    function syncInterferenceFromCP() {
        const cpCurrent = ProjectManager.getState().cp.current || 0;
        const ifCurrent = getDomElement('ifDCCurrent');
        if (ifCurrent && AppState.ifLinkState.current) {
            ifCurrent.value = cpCurrent.toFixed(3);
        }
    }

    // ============================================================
    // ensureAnodeDefaults
    // ============================================================
    function ensureAnodeDefaults() {
        const potentialSelect = getDomElement('anodePotentialSelect');
        if (!potentialSelect) {
            console.warn('⚠️ anodePotentialSelect non trouvé dans le DOM');
            return;
        }
        const currentValue = parseFloat(potentialSelect.value);
        if (isNaN(currentValue) || currentValue >= -200) {
            console.log('🔧 anodePotentialSelect forcé à -1700 (valeur par défaut)');
            let found = false;
            for (let opt of potentialSelect.options) {
                if (parseFloat(opt.value) === -1700) {
                    potentialSelect.value = opt.value;
                    found = true;
                    break;
                }
            }
            if (!found) {
                const newOpt = document.createElement('option');
                newOpt.value = -1700;
                newOpt.textContent = '-1700 (Mg) - Défaut';
                potentialSelect.appendChild(newOpt);
                potentialSelect.value = -1700;
            }
        }
        const manualInput = getDomElement('anodePotentialManual');
        if (manualInput) {
            const manualVal = parseFloat(manualInput.value);
            if (isNaN(manualVal) || manualVal >= -200 || manualVal === 0) {
                manualInput.value = -1700;
            }
        }
        const materialSelect = getDomElement('anodeMaterialSelect');
        if (materialSelect) {
            const material = materialSelect.value;
            const materialData = APP_CONFIG.ANODE_MATERIALS[material];
            if (materialData && materialData.potential) {
                const currentVal = parseFloat(potentialSelect.value);
                if (currentVal !== materialData.potential) {
                    let found = false;
                    for (let opt of potentialSelect.options) {
                        if (parseFloat(opt.value) === materialData.potential) {
                            potentialSelect.value = opt.value;
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        const newOpt = document.createElement('option');
                        newOpt.value = materialData.potential;
                        newOpt.textContent = materialData.potential + ' (' + material + ')';
                        potentialSelect.appendChild(newOpt);
                        potentialSelect.value = materialData.potential;
                    }
                    console.log(`🔧 anodePotentialSelect synchronisé avec le matériau ${material} → ${materialData.potential} mV`);
                }
            }
        }
    }

    // ============================================================
    // tryAutoComputeCableLength
    // ============================================================
    function tryAutoComputeCableLength() {
        try {
            if (typeof CableLengthEngine === 'undefined') {
                console.warn('[UI] CableLengthEngine non chargé.');
                return null;
            }
            const projectId = ProjectManager.getCurrentProjectId();
            if (!projectId) {
                showToast('Aucun projet actif.', 'warning');
                return null;
            }

            const lengths = CableLengthEngine.computeFromProjectState(projectId, {
                marginPercent: 10,
                negativeStrategy: 'worst'
            });

            if (!lengths) {
                showToast(
                    '⚠️ Impossible de calculer : vérifiez que TR, GB et au moins un pipeline ont des coordonnées GPS.',
                    'warning'
                );
                return null;
            }

            const lengthInput = document.getElementById('cableLengthDC');
            const badge = document.getElementById('cableLengthAutoBadge');
            if (lengthInput) {
                lengthInput.value = lengths.total.roundedM;
                lengthInput.title =
                    'Auto (positions manuelles) : ' + lengths.total.geometricM.toFixed(0) +
                    ' m géo + marge = ' + lengths.total.roundedM + ' m';
            }
            if (badge) {
                badge.textContent = 'manuel +10 % (non optimisé)';
                badge.style.display = 'inline';
                badge.classList.remove('auto');
                badge.classList.add('manual');
            }
            showToast(
                '✅ Longueur (positions manuelles) : ' + lengths.total.roundedM +
                ' m — lancez l\'optimisation pour une estimation optimale.',
                'info'
            );
            return lengths;
        } catch (e) {
            console.error('[UI] Erreur tryAutoComputeCableLength:', e);
            showToast('❌ Erreur : ' + e.message, 'error');
            return null;
        }
    }

    // ============================================================
    // calculateCableSection — v9.3 (avec smart hint intégré)
    // ============================================================
    function calculateCableSection() {
        try {
            console.log('🔧 calculateCableSection appelée');
            const currentInput = document.getElementById('cableCurrent');
            const lengthInput = document.getElementById('cableLengthDC');
            const voltageDropSelect = document.getElementById('cableVoltageDrop');
            const voltageDropManual = document.getElementById('cableVoltageDropManual');
            const materialSelect = document.getElementById('cableMaterial');
            const sectionField = document.getElementById('cableSectionCalc');

            if (!currentInput || !lengthInput || !sectionField) {
                console.error('❌ Éléments manquants');
                showToast('Erreur : éléments du formulaire non trouvés.', 'error');
                return;
            }
            const current = parseFloat(currentInput.value) || 0;
            let length = parseFloat(lengthInput.value) || 0;

            if (length <= 0) {
                const auto = tryAutoComputeCableLength();
                if (auto && auto.total) {
                    length = auto.total.roundedM;
                    if (lengthInput) lengthInput.value = length;
                }
            }
            let voltageDrop = 0;
            if (voltageDropSelect) {
                if (voltageDropSelect.value === 'manual') {
                    voltageDrop = parseFloat(voltageDropManual?.value) || 0;
                } else {
                    voltageDrop = parseFloat(voltageDropSelect.value) || 0;
                }
            } else {
                voltageDrop = 3;
            }
            const material = materialSelect?.value || 'cu';

            if (current <= 0) {
                showToast('⚠️ Veuillez entrer un courant valide (> 0 A).', 'warning');
                sectionField.value = '⚠️';
                sectionField.style.color = 'var(--accent-orange)';
                return;
            }
            if (length <= 0) {
                showToast('⚠️ Veuillez entrer une longueur valide (> 0 m).', 'warning');
                sectionField.value = '⚠️';
                sectionField.style.color = 'var(--accent-orange)';
                return;
            }
            if (voltageDrop <= 0) {
                showToast('⚠️ Veuillez entrer une chute de tension valide (> 0 V).', 'warning');
                sectionField.value = '⚠️';
                sectionField.style.color = 'var(--accent-orange)';
                return;
            }

            const cableEngine = window.CableLengthEngine;
            if (!cableEngine || typeof cableEngine.calculateSection !== 'function') {
                throw new Error('CableLengthEngine non chargé.');
            }

            const sectionResult = cableEngine.calculateSection(
                current,
                length,
                voltageDrop,
                material
            );
            if (!sectionResult) {
                throw new Error('Paramètres de section câble invalides.');
            }

            const sectionTheorique = sectionResult.theoreticalMm2;
            const selectedSection = sectionResult.selectedMm2;
            const voltageDropReel = sectionResult.actualDropV;
            console.log(`📐 Section théorique : ${sectionTheorique.toFixed(1)} mm²`);

            if (sectionResult.status === 'LIMIT_EXCEEDED') {
                sectionField.value = selectedSection.toFixed(1);
                sectionField.style.color = 'var(--accent-orange)';
                sectionField.style.fontWeight = 'bold';
                sectionField.style.backgroundColor = 'var(--bg-elevated)';
                showToast(
                    `❌ Section théorique ${sectionTheorique.toFixed(1)} mm² supérieure au maximum commercial (${selectedSection} mm²). ` +
                    'La chute de tension admissible n’est pas respectée.',
                    'error'
                );
                updateCableCurrentHint();
                return;
            }

            sectionField.value = selectedSection.toFixed(1);
            sectionField.style.color = 'var(--accent-cyan)';
            sectionField.style.fontWeight = 'bold';
            sectionField.style.backgroundColor = 'var(--bg-elevated)';
            sectionField.style.display = 'block';
            sectionField.style.visibility = 'visible';

            let message = `✅ Section calculée : ${selectedSection.toFixed(1)} mm²`;
            if (selectedSection > 300) {
                message += ` ⚠️ Section élevée. Envisagez de réduire la longueur ou d'augmenter la tension.`;
            }
            message += ` (ΔV réel : ${voltageDropReel.toFixed(2)} V)`;
            console.log(`✅ Section calculée : ${selectedSection.toFixed(1)} mm²`);
            console.log(`📊 Chute de tension réelle : ${voltageDropReel.toFixed(2)} V`);
            showToast(message, selectedSection > 300 ? 'warning' : 'success');

            // v9.3 : mise à jour du hint
            updateCableCurrentHint();
        } catch (error) {
            console.error('❌ Erreur lors du calcul de la section du câble :', error);
            showToast('❌ Erreur lors du calcul de la section du câble.', 'error');
        }
    }

    /**
     * v9.3 : Astuce intelligente sur #cableCurrent
     *        (fusion de iccp-cable-sync-patch v1.1 installSmartHintOnCalculate)
     */
    function updateCableCurrentHint() {
        const cableCurrentInput = document.getElementById('cableCurrent');
        if (!cableCurrentInput) return;

        let hint = document.getElementById('cableCurrentHint');
        if (!hint) {
            hint = document.createElement('div');
            hint.id = 'cableCurrentHint';
            hint.style.cssText =
                'font-size:0.72rem; color:var(--accent-orange); margin-top:0.2rem; display:none;';
            hint.innerHTML = '<i class="fas fa-lightbulb"></i> Astuce : cliquez d\'abord sur <strong>Calculer ICCP</strong> ou <strong>Optimiser les positions</strong> pour pré-remplir ce courant.';
            cableCurrentInput.parentNode.appendChild(hint);
        }

        const val = parseFloat(cableCurrentInput.value);
        const isAuto = cableCurrentInput.classList.contains('field-auto-calculated');
        const isEmptyOrDefault = !isFinite(val) || val <= 0 || val === 10 || val === 168;
        hint.style.display = (isEmptyOrDefault && !isAuto) ? 'block' : 'none';
    }

    function applyCableToICCP() {
        try {
            const sectionField = document.getElementById('cableSectionCalc');
            const cableSectionSelect = document.getElementById('cableSection');
            const cableSectionManual = document.getElementById('cableSectionManual');
            const cableLengthSelect = document.getElementById('cableLength');
            const cableLengthManual = document.getElementById('cableLengthManual');

            if (!sectionField || !cableSectionSelect) {
                showToast('❌ Erreur : champs de section non trouvés.', 'error');
                return;
            }
            const sectionValue = parseFloat(sectionField.value);
            if (!sectionValue || sectionValue <= 0) {
                showToast('⚠️ Veuillez d\'abord calculer la section du câble.', 'warning');
                return;
            }
            let found = false;
            for (let opt of cableSectionSelect.options) {
                if (Math.abs(parseFloat(opt.value) - sectionValue) < 0.01) {
                    cableSectionSelect.value = opt.value;
                    found = true;
                    break;
                }
            }
            if (!found) {
                cableSectionSelect.value = 'manual';
                if (cableSectionManual) {
                    cableSectionManual.value = sectionValue.toFixed(1);
                    cableSectionManual.style.display = 'block';
                }
            }
            cableSectionSelect.dispatchEvent(new Event('change', { bubbles: true }));

            if (cableLengthSelect) {
                const lengthValue = parseFloat(document.getElementById('cableLengthDC')?.value);
                if (lengthValue && lengthValue > 0) {
                    let foundLen = false;
                    for (let opt of cableLengthSelect.options) {
                        if (Math.abs(parseFloat(opt.value) - lengthValue) < 0.1) {
                            cableLengthSelect.value = opt.value;
                            foundLen = true;
                            break;
                        }
                    }
                    if (!foundLen) {
                        cableLengthSelect.value = 'manual';
                        if (cableLengthManual) {
                            cableLengthManual.value = lengthValue.toFixed(0);
                            cableLengthManual.style.display = 'block';
                        }
                    }
                    cableLengthSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }

            const shared = ProjectManager.getSharedParams();
            if (shared) {
                shared.cableSection = sectionValue;
                const lengthVal = parseFloat(document.getElementById('cableLengthDC')?.value);
                if (lengthVal && lengthVal > 0) {
                    shared.cableLength = lengthVal;
                    shared.cableLengthIsTotal = true;
                }
                const activeSys = ProjectManager.getActiveSystem();
                if (activeSys) {
                    const iccpParams = ProjectManager.loadSystemParams(activeSys.id, 'iccp') || {};
                    iccpParams.S_cable = sectionValue;
                    if (lengthVal && lengthVal > 0) {
                        iccpParams.L_cable = lengthVal;
                        iccpParams.cableLengthIsTotal = true;
                    }
                    ProjectManager.saveSystemParams(activeSys.id, 'iccp', iccpParams);
                }
                ProjectManager.saveCurrentProject();
            }
            const lengthVal = parseFloat(document.getElementById('cableLengthDC')?.value);
            const badge = document.getElementById('cableLengthSyncBadge');
            if (badge && lengthVal > 0) {
                badge.textContent = 'boucle SIG ' + lengthVal.toFixed(0) + ' m';
                badge.style.display = 'inline';
            }
            showToast(`✅ Câble DC synchronisé avec le module CP : ${lengthVal > 0 ? lengthVal.toFixed(0) + ' m | ' : ''}${sectionValue.toFixed(1)} mm²`, 'success');
            updateSyncBadges();
        } catch (error) {
            console.error('❌ Erreur lors de l\'application de la section du câble :', error);
            showToast('❌ Erreur lors de l\'application de la section du câble.', 'error');
        }
    }

    function linkCableCurrentToICCP() {
        const iccpCurrent = ProjectManager.getState().iccp.current || 0;
        if (iccpCurrent <= 0) {
            showToast('Aucun courant ICCP calculé. Veuillez d\'abord calculer l\'ICCP.', 'warning');
            return;
        }
        const cableCurrentField = getDomElement('cableCurrent');
        if (cableCurrentField) {
            cableCurrentField.value = iccpCurrent.toFixed(2);
            showToast(`Courant ICCP (${iccpCurrent.toFixed(2)} A) lié au dimensionnement du câble.`, 'success');
            cableCurrentField.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // ============================================================
    // populateResistiveParams / applyResistiveModel
    // ============================================================
    function isResistiveEquipment(equipment) {
        if (!equipment || equipment.included === false) return false;
        return [
            'pipeline_enterre', 'pipeline_offshore',
            'reservoir_fond', 'reservoir_toit', 'ballon_souterrain',
            'tank', 'reservoir',
            'pieux', 'well_casing', 'fourreau',
            'coque_navire', 'jacket_offshore', 'monopieu'
        ].includes(equipment.type);
    }

    function populateResistiveParams() {
        try {
            const defectDensity = getFieldValue('defectDensity', 'defectDensityManual');
            const agingFactor = getFieldValue('agingFactor', 'agingFactorManual');
            const targetPotential = getFieldValue('targetPotential', 'targetPotentialManual');
            setSelectValue('defectDensityResistive', defectDensity);
            setSelectValue('agingFactorResistive', agingFactor);
            setSelectValue('targetPotentialResistive', targetPotential);
            showToast('✅ Paramètres CP chargés dans le modèle résistif.', 'success');
        } catch (e) {
            console.error('Erreur populateResistiveParams:', e);
            showToast('❌ Erreur lors du chargement des paramètres.', 'error');
        }
    }

    function applyResistiveModel() {
        try {
            const defectDensity = getFieldValue('defectDensityResistive', 'defectDensityResistiveManual');
            const agingFactor = getFieldValue('agingFactorResistive', 'agingFactorResistiveManual');
            const targetPotential = getFieldValue('targetPotentialResistive', 'targetPotentialResistiveManual');

            const state = ProjectManager.getState();
            const projectId = ProjectManager.getCurrentProjectId();
            if (!projectId) {
                showToast('⚠️ Aucun projet actif.', 'warning');
                return;
            }
            const equipments = state.equipments.filter(eq =>
                eq.projectId === projectId && isResistiveEquipment(eq)
            );
            if (equipments.length === 0) {
                showToast('⚠️ Aucun équipement métallique admissible trouvé dans ce projet.', 'warning');
                return;
            }
            const cpCurrent = state.cp.current || 0;
            if (cpCurrent <= 0) {
                showToast('⚠️ Courant CP non calculé. Calculez d\'abord le CP.', 'warning');
                return;
            }
            let totalConductance = 0;
            const results = [];
            equipments.forEach(eq => {
                const resistance = CalculationEngine.calculateEquipmentResistances(eq);
                const conductance = resistance.R_total > 0 ? 1 / resistance.R_total : 0;
                totalConductance += conductance;
                results.push({ tag: eq.tag, resistance: resistance.R_total, conductance: conductance });
            });

            const container = getDomElement('resistiveResults');
            if (!container) return;
            let html = `<table class="tech-table"><thead><tr><th>Équipement</th><th>Résistance (Ω)</th><th>Conductance (1/Ω)</th><th>Courant réparti (A)</th><th>% du total</th></tr></thead><tbody>`;
            results.forEach(r => {
                const currentShare = totalConductance > 0 ? (r.conductance / totalConductance) * cpCurrent : 0;
                const percent = totalConductance > 0 ? (r.conductance / totalConductance) * 100 : 0;
                html += `<tr>
                    <td>${Utils.escapeHtml(r.tag)}</td>
                    <td>${r.resistance.toFixed(4)}</td>
                    <td>${r.conductance.toFixed(6)}</td>
                    <td><strong>${currentShare.toFixed(3)} A</strong></td>
                    <td>${percent.toFixed(1)}%</td>
                </tr>`;
            });
            html += `<tr class="total-row"><td><strong>TOTAL</strong></td><td>—</td><td>${totalConductance.toFixed(6)}</td><td><strong>${cpCurrent.toFixed(3)} A</strong></td><td>100%</td></tr>`;
            html += '</tbody></table>';
            container.innerHTML = html;
            showToast(`✅ Modèle résistif appliqué : ${equipments.length} équipements répartis.`, 'success');
            if (!state.resistiveModel) state.resistiveModel = {};
            state.resistiveModel.results = {
                pipelines: results,
                totalConductance: totalConductance,
                totalCurrent: cpCurrent,
                timestamp: new Date().toISOString()
            };
            ProjectManager.saveCurrentProject();
        } catch (e) {
            console.error('Erreur applyResistiveModel:', e);
            showToast('❌ Erreur lors de l\'application du modèle résistif.', 'error');
        }
    }

    // ============================================================
    // generateWaterFromEnvironment / autoDetectZones / exports / generateSoilFromResistivity
    // ============================================================
    function generateWaterFromEnvironment() {
        const env = getDomElement('cpEnvironment')?.value || 'desert';
        const profile = CalculationEngine.generateWaterProfile(env);
        if (profile) {
            setSelectValue('envWaterSalinity', profile.salinity);
            setSelectValue('envWaterConductivity', profile.conductivity);
            setSelectValue('envWaterTemp', profile.temperature);
            setSelectValue('envWaterDO', profile.DO);
            showToast(`✅ Paramètres d'eau générés depuis l'environnement "${env}".`, 'success');
        } else {
            showToast('❌ Environnement non reconnu.', 'error');
        }
    }

    function autoDetectZones() {
        const state = ProjectManager.getState();
        const projectId = ProjectManager.getCurrentProjectId();
        if (!projectId) {
            showToast('⚠️ Aucun projet actif.', 'warning');
            return;
        }
        const equipments = state.equipments.filter(eq => eq.projectId === projectId && eq.included !== false);
        const zones = [];
        equipments.forEach(eq => {
            if (eq.soilResistivity > 100) {
                zones.push({
                    name: `Zone haute résistivité - ${eq.tag}`,
                    location: eq.tag || 'Inconnu',
                    problemType: 'high_resistivity',
                    criticality: eq.soilResistivity > 500 ? 'high' : 'medium',
                    additionalCurrent: (eq.soilResistivity / 100) * 0.5
                });
            }
        });
        const cpCurrent = state.cp.current || 0;
        equipments.forEach(eq => {
            if (eq.cpData && eq.cpData.calculated && eq.cpData.results.currentAmperes) {
                const eqCurrent = eq.cpData.results.currentAmperes;
                const expected = (eq.surface || 0) * 0.005;
                if (eqCurrent < expected * 0.5 && expected > 0) {
                    zones.push({
                        name: `Courant insuffisant - ${eq.tag}`,
                        location: eq.tag || 'Inconnu',
                        problemType: 'insufficient_current',
                        criticality: 'medium',
                        additionalCurrent: (expected - eqCurrent) * 1.2
                    });
                }
            }
        });
        if (zones.length === 0) {
            showToast('✅ Aucune zone critique détectée automatiquement.', 'info');
            return;
        }
        const existingZones = state.iccp.reinforcementZones || [];
        zones.forEach(zone => {
            const exists = existingZones.some(z => z.name === zone.name);
            if (!exists) {
                existingZones.push({ id: Utils.generateId(), ...zone });
            }
        });
        state.iccp.reinforcementZones = existingZones;
        renderReinforcementZones();
        ProjectManager.saveCurrentProject();
        showToast(`✅ ${zones.length} zone(s) critique(s) détectée(s) et ajoutée(s).`, 'success');
        ProjectManager.addHistoryEntry('iccp', 'Auto-détection zones critiques', `${zones.length} zones`);
    }

    function exportPostsPDF() {
        const posts = ProjectManager.getState().testPosts.posts || [];
        if (posts.length === 0) {
            showToast('⚠️ Aucun poste de test à exporter.', 'warning');
            return;
        }
        if (typeof window.jspdf === 'undefined') {
            showToast('❌ Bibliothèque PDF non chargée.', 'error');
            return;
        }
        try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF('p', 'mm', 'a4');
            const margin = 15;
            let y = margin;
            doc.setFontSize(16);
            doc.setFont('helvetica', 'bold');
            doc.text('POSTES DE TEST - RAPPORT', 105, y, { align: 'center' });
            y += 10;
            doc.setFontSize(10);
            doc.setFont('helvetica', 'normal');
            doc.text(`Projet: ${ProjectManager.getState().project.name || 'N/A'}`, margin, y);
            y += 5;
            doc.text(`ID Projet: ${ProjectManager.getCurrentProjectId() || 'N/A'}`, margin, y);
            y += 5;
            doc.text(`Date: ${new Date().toLocaleDateString('fr-FR')}`, margin, y);
            y += 5;
            doc.text(`Nombre de postes: ${posts.length}`, margin, y);
            y += 10;
            const headers = ['Nom', 'Distance (m)', 'Latitude', 'Longitude', 'Pipeline'];
            const colWidths = [30, 35, 35, 35, 45];
            const pageWidth = doc.internal.pageSize.getWidth();
            let x = margin;
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            headers.forEach((h, i) => {
                doc.text(h, x, y);
                x += colWidths[i];
            });
            y += 5;
            doc.setFont('helvetica', 'normal');
            posts.forEach(p => {
                if (y > 270) {
                    doc.addPage();
                    y = margin;
                    x = margin;
                    doc.setFont('helvetica', 'bold');
                    doc.setFontSize(8);
                    headers.forEach((h, i) => {
                        doc.text(h, x, y);
                        x += colWidths[i];
                    });
                    y += 5;
                    doc.setFont('helvetica', 'normal');
                    doc.setFontSize(8);
                    x = margin;
                }
                x = margin;
                doc.text(p.name || 'N/A', x, y);
                x += colWidths[0];
                doc.text((p.distance || 0).toFixed(1), x, y);
                x += colWidths[1];
                doc.text(p.lat !== null ? p.lat.toFixed(6) : '-', x, y);
                x += colWidths[2];
                doc.text(p.lon !== null ? p.lon.toFixed(6) : '-', x, y);
                x += colWidths[3];
                doc.text(p.equipment || '-', x, y);
                y += 5;
            });
            const fileName = `postes_test_${ProjectManager.getCurrentProjectId()}_${new Date().toISOString().slice(0,10)}.pdf`;
            doc.save(fileName);
            showToast(`✅ Rapport PDF des postes de test exporté : ${fileName}`, 'success');
        } catch (e) {
            console.error('Erreur exportPostsPDF:', e);
            showToast('❌ Erreur lors de l\'export PDF.', 'error');
        }
    }

    function exportPostsCSV() {
        const posts = ProjectManager.getState().testPosts.posts || [];
        if (posts.length === 0) {
            showToast('⚠️ Aucun poste de test à exporter.', 'warning');
            return;
        }
        try {
            let csv = 'Nom,Distance (m),Latitude,Longitude,Pipeline\n';
            posts.forEach(p => {
                csv += `${p.name || 'N/A'},${(p.distance || 0).toFixed(1)},${p.lat !== null ? p.lat.toFixed(6) : '-'},${p.lon !== null ? p.lon.toFixed(6) : '-'},${p.equipment || '-'}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `postes_test_${ProjectManager.getCurrentProjectId()}_${new Date().toISOString().slice(0,10)}.csv`;
            a.click();
            showToast('✅ Rapport CSV des postes de test exporté.', 'success');
        } catch (e) {
            console.error('Erreur exportPostsCSV:', e);
            showToast('❌ Erreur lors de l\'export CSV.', 'error');
        }
    }

    function generateSoilFromResistivity() {
        const resistivity = getFieldValue('envSoilResistivity', 'envSoilResistivityManual');
        if (resistivity <= 0) {
            showToast('⚠️ Résistivité invalide. Veuillez saisir une valeur > 0.', 'warning');
            return;
        }
        const profile = CalculationEngine.generateSoilProfile(resistivity);
        if (profile) {
            setSelectValue('envSoilPh', profile.pH);
            setSelectValue('envSoilMoisture', profile.moisture);
            setSelectValue('envSoilChlorides', profile.chlorides);
            setSelectValue('envSoilSulfates', profile.sulfates);
            setSelectValue('envSoilRedox', profile.redox);
            updateCorrosivity();
            showToast('✅ Profil de sol généré depuis la résistivité.', 'success');
        } else {
            showToast('❌ Erreur lors de la génération du profil de sol.', 'error');
        }
    }

    // ============================================================
    // SYNCHRONISATION GIS/3D
    // ============================================================
    function syncAllEquipmentToGIS() {
        if (window.CPController && typeof window.CPController.syncAllEquipmentToGIS === 'function') {
            window.CPController.syncAllEquipmentToGIS();
        } else {
            console.warn('CPController.syncAllEquipmentToGIS non disponible');
        }
    }

    function syncAllEquipmentTo3D() {
        if (window.CPController && typeof window.CPController.syncAllEquipmentTo3D === 'function') {
            window.CPController.syncAllEquipmentTo3D();
        } else {
            console.warn('CPController.syncAllEquipmentTo3D non disponible');
        }
    }

    function syncEquipmentToGIS(equipment) {
        if (window.CPController && typeof window.CPController.syncEquipmentToGIS === 'function') {
            window.CPController.syncEquipmentToGIS(equipment);
        } else {
            console.warn('CPController.syncEquipmentToGIS non disponible');
        }
    }

    function syncEquipmentTo3D(equipment) {
        if (window.CPController && typeof window.CPController.syncEquipmentTo3D === 'function') {
            window.CPController.syncEquipmentTo3D(equipment);
        } else {
            console.warn('CPController.syncEquipmentTo3D non disponible');
        }
    }

    // ============================================================
    // applyIlliziDefaults
    // ============================================================
    function applyIlliziDefaults() {
        if (_defaultsApplied) {
            Logger.info('[UI] applyIlliziDefaults ignoré car déjà appliqué.');
            return;
        }
        const d = APP_CONFIG.ILLIZI_DEFAULTS;
        const selectDefaults = [
            { id: 'cpEnvironment', value: d.environment },
            { id: 'cpNorm', value: d.norm },
            { id: 'cpCurrentDensitySelect', value: d.currentDensity },
            { id: 'cpResistivitySelect', value: d.resistivity },
            { id: 'cpCoatingSelect', value: d.coating },
            { id: 'defectDensity', value: d.defectDensity },
            { id: 'agingFactor', value: d.agingFactor },
            { id: 'targetPotential', value: d.targetPotential },
            { id: 'cableLength', value: d.cableLength },
            { id: 'cableSection', value: d.cableSection },
            { id: 'structureResistance', value: d.structureResistance },
            { id: 'anodeMaterialSelect', value: d.anodeMaterial },
            { id: 'anodeLifeSelect', value: d.anodeLife },
            { id: 'anodeMassUnitSelect', value: d.anodeMassUnit },
            { id: 'anodeLengthSelect', value: d.anodeLength },
            { id: 'anodeDiameterSelect', value: d.anodeDiameter },
            { id: 'anodeUtilizationSelect', value: d.anodeUtilization },
            { id: 'safetyFactor', value: d.safetyFactor },
            { id: 'anodePotentialSelect', value: d.anodePotential || -1700 },
            { id: 'anodeCapacitySelect', value: d.anodeCapacity },
            { id: 'anodeEfficiencySelect', value: d.anodeEfficiency },
            { id: 'anodeDensitySelect', value: d.anodeDensity },
            { id: 'anodeStandardSelect', value: d.anodeStandard },
            { id: 'iccpAnodeTypeSelect', value: d.iccpAnodeType },
            { id: 'iccpAnodeCount', value: d.iccpAnodeCount },
            { id: 'iccpAnodeLength', value: d.iccpAnodeLength },
            { id: 'iccpAnodeDiameter', value: d.iccpAnodeDiameter },
            { id: 'iccpDistance', value: d.iccpDistance },
            { id: 'iccpAgingFactor', value: d.iccpAgingFactor },
            { id: 'iccpCurrentDensitySelect', value: 50 },
            { id: 'gbTotalDepth', value: d.gbTotalDepth },
            { id: 'gbActiveDepth', value: d.gbActiveDepth },
            { id: 'gbDiameter', value: d.gbDiameter },
            { id: 'gbAnodeCount', value: d.gbAnodeCount },
            { id: 'gbAnodeLength', value: d.gbAnodeLength },
            { id: 'gbAnodeDiameter', value: d.gbAnodeDiameter },
            { id: 'gbAnodeWeight', value: d.gbAnodeWeight },
            // BUG-CP-004 : matériau anode groundbed — valeur par défaut Mg_HC
            //              (configurable via APP_CONFIG.ILLIZI_DEFAULTS.gbAnodeMaterial
            //               si ajouté ultérieurement)
            { id: 'gbAnodeMaterial', value: 'Mg_HC' },
            { id: 'gbAnodeCapacity', value: d.gbAnodeCapacity },
            { id: 'gbCableLength', value: d.gbCableLength },
            { id: 'gbCableSection', value: d.gbCableSection },
            { id: 'gbAgingFactor', value: d.gbAgingFactor },
            { id: 'gbSafetyFactor', value: d.gbSafetyFactor },
            { id: 'ifACVoltage', value: d.ifACVoltage },
            { id: 'ifACCurrent', value: d.ifACCurrent },
            { id: 'ifACDistance', value: d.ifACDistance },
            { id: 'ifACParallel', value: d.ifACParallel },
            { id: 'ifACSoilConductivity', value: d.ifACSoilCond },
            { id: 'ifDCDistance', value: d.ifDCDistance },
            { id: 'ifDCSeparation', value: d.ifDCSeparation },
            { id: 'ifDCSoilResistivity', value: d.ifDCSoilResistivity },
            { id: 'ifVictimPotInit', value: d.ifVictimPotInit },
            { id: 'ifVictimPotFinal', value: d.ifVictimPotFinal },
            { id: 'cableMaterial', value: d.cableMaterial },
            { id: 'cableVoltageDrop', value: d.cableVoltageDrop }
        ];
        selectDefaults.forEach(item => setSelectValue(item.id, item.value));

        const state = ProjectManager.getState();
        const projectId = ProjectManager.getCurrentProjectId();
        if (projectId) {
            const equipments = state.equipments.filter(eq => eq.projectId === projectId);
            const totalSurface = equipments.reduce((sum, eq) => sum + getCanonicalEquipmentSurface(eq), 0);
            if (totalSurface > 0) {
                const cpSurface = document.getElementById('cpSurface');
                if (cpSurface) {
                    cpSurface.value = totalSurface.toFixed(2);
                    setFieldSource('cpSurface', 'auto');
                }
                const iccpSurface = document.getElementById('iccpSurface');
                if (iccpSurface) {
                    iccpSurface.value = totalSurface.toFixed(2);
                    setFieldSource('iccpSurface', 'auto');
                }
                state.project.surface = totalSurface;
                Logger.info(`[UI] Surface synchronisée depuis les équipements: ${totalSurface.toFixed(2)} m²`);
            } else {
                const defaultSurface = d.surface || 1000;
                const cpSurface = document.getElementById('cpSurface');
                if (cpSurface) {
                    cpSurface.value = defaultSurface.toFixed(2);
                }
                const iccpSurface = document.getElementById('iccpSurface');
                if (iccpSurface) {
                    iccpSurface.value = defaultSurface.toFixed(2);
                }
                state.project.surface = defaultSurface;
                Logger.info(`[UI] Surface par défaut définie à ${defaultSurface} m²`);
                setTimeout(() => {
                    showToast(`💡 Surface par défaut définie à ${defaultSurface} m². Ajoutez des équipements ou modifiez la surface manuellement.`, 'info');
                }, 500);
            }
            try {
                ProjectManager.saveCurrentProject();
            } catch (err) {
                Logger.warn('[UI] Erreur lors de la sauvegarde de la surface:', err);
            }
        }
        _defaultsApplied = true;
    }

    // ============================================================
    // initLinks
    // ============================================================
    function initLinks() {
        const surfaceCp = getDomElement('cpSurface');
        const surfaceIccp = getDomElement('iccpSurface');
        const linkSurfaceBtn = getDomElement('linkSurfaceToIccp');
        const linkSurfaceInputBtn = getDomElement('linkSurfaceToIccpInput');
        if (surfaceCp && surfaceIccp) {
            const updateSurface = () => { if (AppState.currentLinkState.surface) surfaceIccp.value = surfaceCp.value; };
            surfaceCp.addEventListener('input', updateSurface);
            if (linkSurfaceBtn) linkSurfaceBtn.addEventListener('click', () => toggleLink('surface', linkSurfaceBtn, surfaceCp, surfaceIccp));
            if (linkSurfaceInputBtn) linkSurfaceInputBtn.addEventListener('click', () => toggleLink('surface', linkSurfaceInputBtn, surfaceCp, surfaceIccp));
            updateSurface();
        }
        const resCurrent = getDomElement('resCurrent');
        const anodeCurrent = getDomElement('anodeCurrentReq');
        const linkCurrentBtn = getDomElement('linkCurrentToAnodes');
        const linkCurrentInputBtn = getDomElement('linkCurrentToAnodesInput');
        if (resCurrent && anodeCurrent) {
            const updateCurrent = () => { if (AppState.currentLinkState.current) anodeCurrent.value = resCurrent.innerText; };
            const observer = new MutationObserver(updateCurrent);
            observer.observe(resCurrent, { childList: true, characterData: true, subtree: true });
            if (linkCurrentBtn) linkCurrentBtn.addEventListener('click', () => toggleLink('current', linkCurrentBtn, resCurrent, anodeCurrent, true));
            if (linkCurrentInputBtn) linkCurrentInputBtn.addEventListener('click', () => toggleLink('current', linkCurrentInputBtn, resCurrent, anodeCurrent, true));
            updateCurrent();
        }
        const targetPot = getDomElement('targetPotential');
        const freePot = getDomElement('freePotential');
        const linkTargetBtn = getDomElement('linkTargetToFreePot');
        if (targetPot && freePot) {
            const updateTarget = () => { if (AppState.currentLinkState.targetPot) freePot.value = targetPot.value; };
            targetPot.addEventListener('change', updateTarget);
            if (linkTargetBtn) linkTargetBtn.addEventListener('click', () => toggleLink('targetPot', linkTargetBtn, targetPot, freePot));
            updateTarget();
        }

        const gndResistivityBtn = getDomElement('linkGndResistivityToCP');
        const gndCurrentBtn = getDomElement('linkGndCurrentToCP');
        const cpResistivitySelect = getDomElement('cpResistivitySelect');
        const cpResistivityManual = getDomElement('cpResistivityManual');
        const gbResistivitySelect = getDomElement('gbSoilResistivity');
        const gbTargetCurrent = getDomElement('gbTargetCurrent');
        if (gndResistivityBtn && cpResistivitySelect && gbResistivitySelect) {
            gndResistivityBtn.addEventListener('click', function() {
                const sourceVal = cpResistivitySelect.value === 'manual' ? cpResistivityManual.value : cpResistivitySelect.value;
                toggleGndLink('resistivity', this, { value: sourceVal, tagName: 'INPUT' }, gbResistivitySelect);
            });
        }
        if (gndCurrentBtn && gbTargetCurrent) {
            const resCurr = getDomElement('resCurrent');
            gndCurrentBtn.addEventListener('click', function() {
                const sourceVal = resCurr ? resCurr.innerText : ProjectManager.getState().cp.current;
                toggleGndLink('current', this, { value: sourceVal, tagName: 'INPUT' }, gbTargetCurrent);
            });
        }

        const ifCurrentBtn = getDomElement('linkIfCurrentToCP');
        const ifPotentialBtn = getDomElement('linkIfPotentialToCP');
        const ifCurrent = getDomElement('ifDCCurrent');
        const ifPotential = getDomElement('ifDCPotentialON');
        const resCurr = getDomElement('resCurrent');
        const estPotential = getDomElement('estimatedOnPotential');

        if (ifCurrentBtn && resCurr && ifCurrent) {
            ifCurrentBtn.addEventListener('click', function() {
                const sourceVal = resCurr.innerText;
                toggleIfLink('current', this, { value: sourceVal, tagName: 'INPUT' }, ifCurrent);
            });
        }
        if (ifPotentialBtn && estPotential && ifPotential) {
            ifPotentialBtn.addEventListener('click', function() {
                const sourceVal = estPotential.innerText;
                toggleIfLink('potential', this, { value: sourceVal, tagName: 'INPUT' }, ifPotential);
            });
        }
    }

    // ============================================================
    // AUTO-RESTORE DE SESSION (sans toast)
    // ============================================================
    // Restaure silencieusement les paramètres et résultats de la
    // dernière session sans obliger l'utilisateur à recliquer
    // "Calculer" dans chaque module.
    // La restauration fonctionne en 3 étapes :
    //   1. Lire l'ID de la dernière session (localStorage)
    //   2. Charger le projet + système correspondant
    //   3. Appeler loadSystemParamsToModule pour chaque module
    //      (suppression des toasts pendant la restauration)
    // ============================================================
    async function autoRestoreLastSession() {
        try {
            // Récupérer la dernière session
            const raw = localStorage.getItem('cp_last_session');
            if (!raw) return;
            const session = JSON.parse(raw);
            const { projectId, systemId, activeModule } = session || {};
            if (!projectId) return;

            // Charger le projet si ce n'est pas déjà fait
            const currentProjId = ProjectManager.getCurrentProjectId();
            if (currentProjId !== projectId) {
                await ProjectManager.loadProject(projectId);
            }

            // Sélectionner le système actif
            if (systemId) {
                ProjectManager.setCurrentSystemId(systemId);
            }

            // Réinjecter dans le sélecteur de projet HTML
            const projSel = getDomElement('projectSelector');
            if (projSel && projectId) {
                try { projSel.value = projectId; } catch(e) {}
            }

            // Mettre à jour les sélecteurs de système
            populateAllSystemSelectors();
            renderSystems();
            renderGroundbedList();
            populateICCPGroundbedSelectors();

            // Restaurer silencieusement tous les modules (sans toast)
            // On patch showToast temporairement pour éviter les messages
            const _originalShowToast = window.showToast;
            const _silentToast = () => {};
            try {
                window.showToast = _silentToast;
                const sysIdToLoad = systemId || ProjectManager.getCurrentSystemId();
                if (sysIdToLoad) {
                    const modulesToRestore = ['cp-calc', 'anodes', 'iccp', 'groundbed', 'interference'];
                    for (const mod of modulesToRestore) {
                        try { loadSystemParamsToModule(mod, sysIdToLoad); } catch(e) {}
                    }
                }
            } finally {
                window.showToast = _originalShowToast || window.showToast;
            }

            // Mettre à jour le tableau de bord
            if (window.CPController) {
                if (typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
                if (typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
            }
            loadHistory();
            populateProjectParams();
            refreshEquipmentListUI(true);

            // Naviguer vers le module actif de la dernière session
            if (activeModule) {
                const navItem = document.querySelector(`.nav-item[data-module="${CSS.escape(activeModule)}"]`);
                if (navItem) {
                    // On ne clique pas automatiquement pour ne pas perturber
                    // mais on mémorise l'intention
                }
            }

            console.log('[AutoRestore] Session restaurée:', projectId, systemId);
            // Indicateur visuel discret
            const badge = document.createElement('div');
            badge.id = 'autoRestoreBadge';
            badge.style.cssText = [
                'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
                'background:rgba(16,185,129,0.92)', 'color:#fff', 'padding:8px 18px',
                'border-radius:20px', 'font-size:13px', 'font-weight:600',
                'box-shadow:0 4px 16px rgba(0,0,0,0.2)', 'z-index:99999',
                'transition:opacity 0.5s ease', 'pointer-events:none'
            ].join(';');
            badge.textContent = '✅ Dernière session restaurée automatiquement';
            document.body.appendChild(badge);
            setTimeout(() => {
                badge.style.opacity = '0';
                setTimeout(() => badge.remove(), 600);
            }, 2800);

        } catch (err) {
            console.warn('[AutoRestore] Impossible de restaurer la session:', err);
        }
    }

    // ============================================================
    // saveSessionSnapshot
    // Appelée après chaque sauvegarde pour mémoriser l'état de session
    // ============================================================
    function saveSessionSnapshot() {
        try {
            const projectId = ProjectManager.getCurrentProjectId();
            const systemId = ProjectManager.getCurrentSystemId();
            const activeModuleEl = document.querySelector('.module.active');
            const activeModule = activeModuleEl ? activeModuleEl.id.replace('module-', '') : null;
            if (projectId) {
                localStorage.setItem('cp_last_session', JSON.stringify({
                    projectId,
                    systemId,
                    activeModule,
                    savedAt: Date.now()
                }));
            }
        } catch(e) { /* silencieux */ }
    }

    // ============================================================
    // loadSystemParamsToModule
    // ============================================================
    function loadSystemParamsToModule(moduleId, systemId) {
        const sys = ProjectManager.getSystem(systemId);
        if (!sys) { showToast('Système introuvable', 'error'); return; }

        if (moduleId === 'cp-calc' || moduleId === 'cp') {
            const params = sys.params?.cp || {};
            const results = sys.results?.cp || {};
            if (params.S) getDomElement('cpSurface').value = params.S;
            if (params.DF) setSelectValue('defectDensity', params.DF);
            if (params.k) setSelectValue('agingFactor', params.k);
            if (params.J) setSelectValue('cpCurrentDensitySelect', params.J);
            if (params.eps) setSelectValue('cpCoatingSelect', params.eps);
            if (params.norm) getDomElement('cpNorm').value = params.norm;
            if (params.rho) setSelectValue('cpResistivitySelect', params.rho);
            if (params.anodeLength) setSelectValue('anodeLengthSelect', params.anodeLength);
            if (params.anodeDiameter) setSelectValue('anodeDiameterSelect', params.anodeDiameter);
            if (params.L_cable) setSelectValue('cableLength', params.L_cable);
            if (params.S_cable) setSelectValue('cableSection', params.S_cable);
            if (params.R_struct) setSelectValue('structureResistance', params.R_struct);
            if (params.targetOffMv) setSelectValue('targetPotential', params.targetOffMv);
            const anodeParams = sys.params?.anodes || {};
            if (anodeParams.L) setSelectValue('anodeLengthSelect', anodeParams.L);
            if (anodeParams.d) setSelectValue('anodeDiameterSelect', anodeParams.d);
            if (results.current) {
                ProjectManager.getState().cp.current = results.current;
                ProjectManager.getState().cp.irDrop = results.irDrop || 0;
                ProjectManager.getState().cp.requiredOnPotential = results.requiredOnPotential || -850;
                getDomElement('resCurrent').innerText = results.current.toFixed(3);
                getDomElement('resIRDrop').innerText = (results.irDrop || 0).toFixed(3);
                getDomElement('cpCalcPlaceholder').classList.add('hidden');
                getDomElement('cpCalcResultsContent').classList.remove('hidden');
            }
            showToast(`Paramètres CP chargés depuis ${Utils.escapeHtml(sys.name)}`, 'success');
        }

        if (moduleId === 'anodes') {
            const params = sys.params?.anodes || {};
            const results = sys.results?.anodes || {};
            if (params.I_req) getDomElement('anodeCurrentReq').value = params.I_req;
            if (params.life) setSelectValue('anodeLifeSelect', params.life);
            if (params.u) setSelectValue('anodeUtilizationSelect', params.u);
            if (params.safety) setSelectValue('safetyFactor', params.safety);
            if (params.unitMass) setSelectValue('anodeMassUnitSelect', params.unitMass);
            if (params.rho) setSelectValue('anodeSoilResistivity', params.rho);
            if (params.L) setSelectValue('anodeLengthSelect', params.L);
            if (params.d) setSelectValue('anodeDiameterSelect', params.d);
            if (params.anodePot) {
                setSelectValue('anodePotentialSelect', params.anodePot);
                const manualInput = getDomElement('anodePotentialManual');
                if (manualInput) manualInput.value = params.anodePot;
            }
            if (params.finalFactor) setSelectValue('finalResistanceFactor', params.finalFactor);
            if (results.totalMass) {
                ProjectManager.getState().anodes.totalMass = results.totalMass;
                ProjectManager.getState().anodes.count = results.count;
                ProjectManager.getState().anodes.actualLife = results.actualLife;
                getDomElement('resTotalMass').innerText = results.totalMass.toFixed(1);
                getDomElement('resAnodeCount').innerText = results.count;
                getDomElement('anodePlaceholder').classList.add('hidden');
                getDomElement('anodeResultsContent').classList.remove('hidden');
            }
            showToast(`Paramètres Anodes chargés depuis ${Utils.escapeHtml(sys.name)}`, 'success');
        }

        if (moduleId === 'iccp') {
            const params = sys.params?.iccp || {};
            const results = sys.results?.iccp || {};
            if (params.S) getDomElement('iccpSurface').value = params.S;
            if (params.J) setSelectValue('iccpCurrentDensitySelect', params.J);
            if (params.rho) setSelectValue('iccpResistivitySelect', params.rho);
            if (params.N) setSelectValue('iccpAnodeCount', params.N);
            if (params.L) setSelectValue('iccpAnodeLength', params.L);
            if (params.d) setSelectValue('iccpAnodeDiameter', params.d);
            if (params.spacing) getDomElement('iccpSpacing').value = params.spacing;
            if (params.aging) setSelectValue('iccpAgingFactor', params.aging);
            if (params.distanceAnodeStruct) setSelectValue('iccpDistance', params.distanceAnodeStruct);
            if (sys.groundbedId) {
                const gbSelect = getDomElement('iccpGroundbedSelector');
                if (gbSelect && ProjectManager.getGroundbedById(sys.groundbedId)) {
                    gbSelect.value = sys.groundbedId;
                }
            }
            if (results.current) {
                ProjectManager.getState().iccp.current = results.current;
                ProjectManager.getState().iccp.voltage = results.voltage;
                ProjectManager.getState().iccp.power = results.powerDesign || results.power;
                ProjectManager.getState().iccp.powerDesign = results.powerDesign;
                ProjectManager.getState().iccp.groundbedResistance = results.groundbedResistance || 0;
                ProjectManager.getState().iccp.lifeEstimate = results.lifeDesign || results.lifeEstimate || 0;
                ProjectManager.getState().iccp.lifeDesign = results.lifeDesign;
                ProjectManager.getState().iccp.lifeTheoretical = results.lifeTheoretical;
                ProjectManager.getState().iccp.iccpCurrentSource = results.iccpCurrentSource;
                ProjectManager.getState().iccp.iccpSourceLabel = results.iccpSourceLabel;
                ProjectManager.getState().iccp.calculatedRequirements = results.calculatedRequirements || {
                    current: results.rectifierCurrent || results.current,
                    voltage: results.rectifierVoltage || results.voltageFinal || results.voltage,
                    power: results.rectifierPower || results.powerDesign || results.power
                };
                ProjectManager.getState().iccp.transformerRectifierSelection = results.transformerRectifierSelection || null;

                getDomElement('resICCPCurrent').innerText = results.current.toFixed(2);
                getDomElement('resICCPTension').innerText = (results.voltage || 0).toFixed(2);
                const iccpPowerDisplay = results.powerDesign || results.power || 0;
                getDomElement('resICCPPower').innerText = iccpPowerDisplay.toFixed(1);
                getDomElement('iccpPlaceholder').classList.add('hidden');
                getDomElement('iccpResultsContent').classList.remove('hidden');
                if (results.groundbedResistance) {
                    getDomElement('resGroundbedResistance').innerText = results.groundbedResistance.toFixed(4);
                    getDomElement('resCurrentPerAnode').innerText = (results.current / (params.N || 1)).toFixed(3);
                    const jAnodeDisplay = results.currentDensity || 0;
                    getDomElement('resAnodeDensityICCP').innerText = jAnodeDisplay.toFixed(3);
                    getDomElement('resICCPLife').innerText = (results.lifeDesign || results.lifeEstimate || 0).toFixed(1);
                }
                if (results.calculationVersion) {
                    const gb = ProjectManager.getGroundbedById(sys.groundbedId);
                    if (gb && gb.version !== results.calculationVersion) {
                        const alertDiv = getDomElement('iccpAlertsContainer');
                        if (alertDiv) {
                            const staleMsg = document.createElement('div');
                            staleMsg.className = 'alert-item warning';
                            staleMsg.innerHTML = `<span class="alert-icon"><i class="fas fa-exclamation-triangle" aria-hidden="true"></i></span> ⚠️ Le puits anodique a été modifié. Recalculez l'ICCP pour mettre à jour les résultats.`;
                            alertDiv.prepend(staleMsg);
                        }
                    }
                }
                displayRectifierResults({
                    calculatedRequirements: ProjectManager.getState().iccp.calculatedRequirements,
                    transformerRectifierSelection: ProjectManager.getState().iccp.transformerRectifierSelection
                });
            }
            const zones = sys.params?.reinforcementZones || [];
            if (zones.length > 0) {
                ProjectManager.getState().iccp.reinforcementZones = zones;
                renderReinforcementZones();
            }
            showToast(`Paramètres ICCP chargés depuis ${Utils.escapeHtml(sys.name)}`, 'success');
        }

        if (moduleId === 'groundbed') {
            const params = sys.params?.groundbed || {};
            const results = sys.results?.groundbed || {};
            if (params.rho) setSelectValue('gbSoilResistivity', params.rho);
            if (params.totalDepth) setSelectValue('gbTotalDepth', params.totalDepth);
            if (params.diameter) setSelectValue('gbDiameter', params.diameter);
            if (params.activeDepth) setSelectValue('gbActiveDepth', params.activeDepth);
            if (params.anodeCount) setSelectValue('gbAnodeCount', params.anodeCount);
            if (params.anodeLength) setSelectValue('gbAnodeLength', params.anodeLength);
            if (params.anodeDiameter) {
                let diam = params.anodeDiameter;
                if (diam > 10000) {
                    console.warn('[UI] Diamètre anode corrompu détecté, réinitialisé à 75 mm');
                    diam = 75;
                }
                setSelectValue('gbAnodeDiameter', diam);
            }
                        if (params.anodeWeight) setSelectValue('gbAnodeWeight', params.anodeWeight);
            if (params.anodeCapacity) setSelectValue('gbAnodeCapacity', params.anodeCapacity);
            if (params.desiredLife) setSelectValue('gbAnodeLife', params.desiredLife);
            // BUG-CP-004 : restaurer matériau anode lors du chargement d'un système
            if (params.anodeMaterial) {
                const anodeMatEl = getDomElement('gbAnodeMaterial');
                if (anodeMatEl) {
                    const hasOpt = Array.from(anodeMatEl.options)
                        .some(o => o.value === params.anodeMaterial);
                    if (hasOpt) {
                        anodeMatEl.value = params.anodeMaterial;
                    }
                }
            }
            if (params.cableLength) setSelectValue('gbCableLength', params.cableLength);
            if (params.cableSection) setSelectValue('gbCableSection', params.cableSection);
            if (params.agingFactor) setSelectValue('gbAgingFactor', params.agingFactor);
            if (params.safetyFactor) setSelectValue('gbSafetyFactor', params.safetyFactor);
            if (params.targetCurrent) getDomElement('gbTargetCurrent').value = params.targetCurrent;
            if (params.layers) getDomElement('gbSoilLayers').value = params.layers;
            if (params.selectedPipelineIds) {
                const container = getDomElement('gbEquipmentList');
                if (container) {
                    container.dataset.selected = JSON.stringify(params.selectedPipelineIds);
                    container.querySelectorAll('input[type="checkbox"]').forEach(chk => {
                        chk.checked = params.selectedPipelineIds.includes(chk.dataset.equipId);
                    });
                    updateGroundbedTargetCurrent();
                }
            }
            if (results.R_total) {
                ProjectManager.getState().groundbed.results = results;
                displayGroundbedResults(results, params.totalDepth, params.activeDepth, params.anodeCount, params.anodeLength);
                getDomElement('gbPlaceholder').classList.add('hidden');
                getDomElement('gbResultsContent').classList.remove('hidden');
                const totalDepthVal = params.totalDepth || 0;
                const activeDepthVal = params.activeDepth || 0;
                const anodeCountVal = params.anodeCount || 0;
                const anodeLengthVal = params.anodeLength || 0;
                const spacing = activeDepthVal / anodeCountVal;
                if (totalDepthVal > 0 && activeDepthVal > 0 && anodeCountVal > 0) {
                    drawGroundbedVisual(totalDepthVal, activeDepthVal, anodeCountVal, anodeLengthVal, spacing);
                }
            }
            showToast(`Paramètres Groundbed chargés depuis ${Utils.escapeHtml(sys.name)}`, 'success');
        }

        if (moduleId === 'interference') {
            const params = sys.params?.interference || {};
            const results = sys.results?.interference || {};
            if (params.acVoltage) setSelectValue('ifACVoltage', params.acVoltage);
            if (params.acCurrent) setSelectValue('ifACCurrent', params.acCurrent);
            if (params.acFrequency) setSelectValue('ifACFrequency', params.acFrequency);
            if (params.acDistance) setSelectValue('ifACDistance', params.acDistance);
            if (params.acParallel) setSelectValue('ifACParallel', params.acParallel);
            if (params.acSoilCond) setSelectValue('ifACSoilConductivity', params.acSoilCond);
            if (params.pipeDiameter) setSelectValue('ifPipeDiameter', params.pipeDiameter * 1000);
            if (params.pipeLength) setSelectValue('ifPipeLength', params.pipeLength);
            if (params.coatingRes) setSelectValue('ifCoatingResistance', params.coatingRes);
            if (params.dcCurrent) getDomElement('ifDCCurrent').value = params.dcCurrent;
            if (params.dcPotON) getDomElement('ifDCPotentialON').value = params.dcPotON;
            if (params.dcDistance) setSelectValue('ifDCDistance', params.dcDistance);
            if (params.dcSeparation) setSelectValue('ifDCSeparation', params.dcSeparation);
            if (params.dcSoilResistivity) setSelectValue('ifDCSoilResistivity', params.dcSoilResistivity);
            if (params.victimPotInit) setSelectValue('ifVictimPotInit', params.victimPotInit);
            if (params.victimPotFinal) setSelectValue('ifVictimPotFinal', params.victimPotFinal);
            if (results.globalStatus) {
                ProjectManager.getState().interference.results = results;
                getDomElement('ifACInduced').innerText = (results.acInduced || 0).toFixed(2);
                getDomElement('ifACTouch').innerText = (results.touchVoltage || 0).toFixed(2);
                getDomElement('ifDCDelta').innerText = (results.deltaV || 0).toFixed(1);
                getDomElement('ifDCStray').innerText = (results.dcStray || 0).toFixed(3);
                getDomElement('ifStatus').innerText = results.globalStatus;
                getDomElement('ifRecommendation').innerText = (results.mitigations || []).join(' • ');
                getDomElement('ifPlaceholder').classList.add('hidden');
                getDomElement('ifResultsContent').classList.remove('hidden');
            }
            showToast(`Paramètres Interférences chargés depuis ${Utils.escapeHtml(sys.name)}`, 'success');
        }
        if (window.CPController && typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
    }

    // ============================================================
    // setModulesActivation
    // ============================================================
    function setModulesActivation(type) {
        const cpCalcModule = getDomElement('module-cp-calc');
        const anodesModule = getDomElement('module-anodes');
        const iccpModule = getDomElement('module-iccp');
        const disabledModules = type === 'iccp' ? ['module-anodes']
            : type === 'anodes' ? ['module-iccp'] : [];

        [cpCalcModule, anodesModule, iccpModule].forEach(module => {
            if (!module) return;
            const isDisabled = disabledModules.includes(module.id);
            module.classList.toggle('disabled-module', isDisabled);
            module.setAttribute('aria-disabled', String(isDisabled));
            module.querySelectorAll('input, select, textarea, button').forEach(control => {
                control.disabled = isDisabled;
            });

            const navItem = document.querySelector(`.nav-item[data-module="${module.dataset.module}"]`);
            if (navItem) {
                navItem.classList.toggle('disabled-module', isDisabled);
                navItem.setAttribute('aria-disabled', String(isDisabled));
            }
        });
    }

    // ============================================================
    // initTheme / setupNavigation / switchModule / setupSidebar / updateDate
    // ============================================================
    function refreshDashboardChartTheme() {
        const isLight = document.body.classList.contains('light-mode');
        const textColor = isLight ? '#536276' : '#a9b7c9';
        const tickColor = isLight ? '#61728a' : '#8ea0b7';
        const gridColor = isLight ? 'rgba(49, 70, 97, 0.12)' : 'rgba(142, 160, 183, 0.12)';
        const chartColors = isLight
            ? { cyan: '#078da1', orange: '#bd7200', remainder: '#d8e1eb' }
            : { cyan: '#22c7d9', orange: '#f3ad4d', remainder: '#26364b' };

        [window.dashboardChart1, window.dashboardChart2, window.dashboardChart3, window.dashboardChart4]
            .filter(Boolean)
            .forEach(chart => {
                if (!chart.options || !chart.data || !chart.data.datasets?.[0]) return;
                const scales = chart.options.scales || {};
                Object.values(scales).forEach(scale => {
                    if (scale.ticks) scale.ticks.color = tickColor;
                    if (scale.grid) scale.grid.color = gridColor;
                });
                if (chart.options.plugins?.legend?.labels) {
                    chart.options.plugins.legend.labels.color = textColor;
                }
                if (chart.data.datasets[0]) {
                    if (chart.config.type === 'pie') {
                        chart.data.datasets[0].backgroundColor = [chartColors.cyan, chartColors.remainder];
                    } else if (chart.config.type === 'bar') {
                        chart.data.datasets[0].backgroundColor = chartColors.cyan;
                    } else {
                        chart.data.datasets[0].borderColor = chart.config.type === 'line' && chart.data.datasets[0].label === 'Courant (A)'
                            ? chartColors.orange : chartColors.cyan;
                    }
                }
                chart.update('none');
            });
    }

    function initTheme() {
        const saved = localStorage.getItem('cp_theme');
        const btn = getDomElement('themeToggle');
        if (saved === 'light') document.body.classList.add('light-mode');
        refreshDashboardChartTheme();
        btn?.addEventListener('click', () => {
            document.body.classList.toggle('light-mode');
            localStorage.setItem('cp_theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
            refreshDashboardChartTheme();
        });
    }

    function setupNavigation() {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                if (item.classList.contains('disabled-module')) {
                    showToast('Ce module est indisponible pour le type CP sélectionné.', 'warning');
                    return;
                }
                switchModule(item.dataset.module);
            });
        });

        document.querySelectorAll('[data-tabs]').forEach(group => {
            const buttons = group.querySelectorAll('.ui-tab-button');
            const panels = group.querySelectorAll('.ui-tab-panel');

            buttons.forEach(button => {
                const target = button.dataset.tabTarget;
                button.setAttribute('aria-controls', target);
                button.setAttribute('tabindex', button.classList.contains('active') ? '0' : '-1');
                button.addEventListener('click', () => {
                    buttons.forEach(btn => {
                        const active = btn === button;
                        btn.classList.toggle('active', active);
                        btn.setAttribute('aria-selected', String(active));
                        btn.setAttribute('tabindex', active ? '0' : '-1');
                    });
                    panels.forEach(panel => {
                        const active = panel.id === target;
                        panel.classList.toggle('active', active);
                        panel.hidden = !active;
                    });
                });
                button.addEventListener('keydown', event => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    const index = Array.from(buttons).indexOf(button);
                    const nextIndex = event.key === 'ArrowRight'
                        ? (index + 1) % buttons.length
                        : (index - 1 + buttons.length) % buttons.length;
                    buttons[nextIndex].click();
                    buttons[nextIndex].focus();
                });
            });

            panels.forEach(panel => {
                panel.hidden = !panel.classList.contains('active');
            });
        });
    }

    function switchModule(moduleId) {
        document.querySelectorAll('.nav-item').forEach(n => {
            const active = n.dataset.module === moduleId;
            n.classList.toggle('active', active);
            n.querySelector('a')?.setAttribute('aria-current', active ? 'page' : 'false');
        });
        document.querySelectorAll('.module').forEach(m => m.classList.remove('active'));
        getDomElement(`module-${moduleId}`)?.classList.add('active');

        if (moduleId === 'visualisation3d') {
            populateVis3dSystemSelector();

            if (window.Gis3D) {
                if (!window.Gis3D.isReady()) {
                    window.Gis3D.init();
                }
                window.Gis3D.whenReady().then(() => {
                    const sysId = getDomElement('vis3dSystemSelector')?.value;
                    if (typeof window.Gis3D.setSystemFilter === 'function') {
                        window.Gis3D.setSystemFilter(sysId || null);
                    }
                    if (typeof window.Gis3D.loadData === 'function') {
                        window.Gis3D.loadData(ProjectManager.getCurrentProjectId() || '__all__');
                    }
                });
            }
        }

        if (moduleId === 'fieldmeas') refreshAssetDropdownForFieldMeas();
        if (moduleId === 'groundbed') {
            setTimeout(() => {
                const res = ProjectManager.getState().groundbed.results;
                if (res) {
                    const totalDepth = Utils.safeNumber(getDomElement('gbTotalDepth')?.value || 0);
                    const activeDepth = Utils.safeNumber(getDomElement('gbActiveDepth')?.value || 0);
                    const anodeCount = Utils.safeNumber(getDomElement('gbAnodeCount')?.value || 0);
                    const anodeLength = Utils.safeNumber(getDomElement('gbAnodeLength')?.value || 0);
                    const spacing = activeDepth / anodeCount;
                    if (totalDepth > 0 && activeDepth > 0 && anodeCount > 0) {
                        drawGroundbedVisual(totalDepth, activeDepth, anodeCount, anodeLength, spacing);
                    }
                }
                populateGroundbedEquipmentList();
                renderGroundbedList();
            }, 100);
        }
        if (moduleId === 'history') { refreshHistoryTable(); }
        if (moduleId === 'cartography') {
            setTimeout(() => {
                console.log('[UI] Activation du module Cartographie, initialisation de la carte...');
                if (window.GisIntegration && typeof window.GisIntegration.init === 'function') {
                    window.GisIntegration.init();
                    setTimeout(() => {
                        window.GisIntegration.loadPoints(FilterManager.getFilter('projectId'));
                    }, 300);
                }
            }, 300);
        }
        if (moduleId === 'iccp') {
            populateICCPGroundbedSelectors();
        }
        if (moduleId === 'testposts') {
            // v9.3 : rafraîchir les pipelines + longueur à l'entrée du module
            setTimeout(() => {
                refreshPipelinesAndLength(true);
            }, 300);
        }
        if (window.innerWidth <= 768) getDomElement('sidebar')?.classList.remove('open');

        // Sync inter-modules : les modules abonnés (auto-sélection de
        // système, boucle de rendu 3D, etc.) attendent cet événement.
        document.dispatchEvent(new CustomEvent('moduleChanged', {
            detail: { moduleId: moduleId }
        }));
    }

    function setupSidebar() {
        const toggle = getDomElement('sidebarToggle');
        const sidebar = getDomElement('sidebar');
        const main = getDomElement('mainContent');
        toggle?.addEventListener('click', () => {
            if (window.innerWidth <= 768) sidebar.classList.toggle('open');
            else { sidebar.classList.toggle('collapsed');
                main.classList.toggle('expanded'); }
            const isOpen = window.innerWidth <= 768
                ? sidebar.classList.contains('open')
                : !sidebar.classList.contains('collapsed');
            toggle.setAttribute('aria-expanded', String(isOpen));
        });
    }

    function updateDate() {
        const el = getDomElement('headerDate');
        if (!el) return;
        const update = () => el.textContent = new Date().toLocaleString('fr-FR');
        update();
        setInterval(update, 1000);
    }

    function setupManualOverrides() {
        document.querySelectorAll('.std-select, .std-select-env').forEach(select => {
            const manualId = select.id + 'Manual';
            const manual = getDomElement(manualId);
            if (manual) {
                const toggle = () => manual.style.display = select.value === 'manual' ? 'block' : 'none';
                select.addEventListener('change', toggle);
                toggle();
                if (select.id === 'envSoilResistivity' || select.id === 'envSoilPh' || select.id === 'envSoilChlorides' || select.id === 'envSoilSulfates' || select.id === 'envSoilRedox') {
                    select.addEventListener('change', () => updateCorrosivity());
                    if (manual) manual.addEventListener('input', () => updateCorrosivity());
                }
            }
        });
        document.querySelectorAll('#groundbedForm .std-select').forEach(select => {
            const manualId = select.id + 'Manual';
            const manual = getDomElement(manualId);
            if (manual) { select.addEventListener('change', () => { manual.style.display = select.value === 'manual' ? 'block' : 'none'; }); }
        });
        const manualResistivity = getDomElement('envSoilResistivityManual');
        if (manualResistivity) manualResistivity.addEventListener('input', () => updateCorrosivity());
        const massUnitSelect = getDomElement('anodeMassUnitSelect');
        const massUnitManual = getDomElement('anodeMassUnit');
        if (massUnitSelect && massUnitManual) {
            massUnitSelect.addEventListener('change', () => {
                if (massUnitSelect.value === 'manual') massUnitManual.style.display = 'block';
                else { massUnitManual.style.display = 'none';
                    massUnitManual.value = massUnitSelect.value; }
            });
        }
        const materialSelect = getDomElement('anodeMaterialSelect');
        if (materialSelect) materialSelect.addEventListener('change', () => updateAnodePropertiesFromMaterial());
        const initCurrSelect = getDomElement('anodeInitialCurrentSelect');
        if (initCurrSelect) initCurrSelect.addEventListener('change', () => {
            const manualField = getDomElement('anodeInitialCurrentManual');
            if (manualField) manualField.style.display = initCurrSelect.value === 'manual' ? 'block' : 'none';
        });
    }

    function updateAnodePropertiesFromMaterial() {
        const material = getDomElement('anodeMaterialSelect').value;
        const data = APP_CONFIG.ANODE_MATERIALS[material];
        if (data) {
            const potentialSelect = getDomElement('anodePotentialSelect');
            if (potentialSelect && potentialSelect.value !== 'manual') setSelectValue('anodePotentialSelect', data.potential);
            const capacitySelect = getDomElement('anodeCapacitySelect');
            if (capacitySelect && capacitySelect.value !== 'manual') setSelectValue('anodeCapacitySelect', data.capacity);
            const effSelect = getDomElement('anodeEfficiencySelect');
            if (effSelect && effSelect.value !== 'manual') setSelectValue('anodeEfficiencySelect', data.efficiency * 100);
            const densSelect = getDomElement('anodeDensitySelect');
            if (densSelect && densSelect.value !== 'manual') setSelectValue('anodeDensitySelect', data.density);
        }
    }

    function setupOuvrageListener() {
        const sel = getDomElement('ouvrageType');
        if (sel) sel.addEventListener('change', () => updateDimensionsFields());
        updateDimensionsFields();
    }

    function setupForms() {
        getDomElement('cpCalcForm')?.addEventListener('submit', async (e) => { e.preventDefault(); if (window.CPController && typeof window.CPController.calculateCP === 'function') await window.CPController.calculateCP(); await ProjectManager.saveCurrentProject(); });
        getDomElement('anodeForm')?.addEventListener('submit', async (e) => { e.preventDefault(); if (window.CPController && typeof window.CPController.calculateAnodes === 'function') await window.CPController.calculateAnodes(); await ProjectManager.saveCurrentProject(); });
        getDomElement('iccpForm')?.addEventListener('submit', async (e) => { e.preventDefault(); if (window.CPController && typeof window.CPController.calculateICCP === 'function') await window.CPController.calculateICCP(); await ProjectManager.saveCurrentProject(); });
        getDomElement('exportGlobalBtn')?.addEventListener('click', () => { if (window.CPController && typeof window.CPController.exportGlobalReport === 'function') window.CPController.exportGlobalReport(); });
        getDomElement('cpEnvironment')?.addEventListener('change', () => {
            autoFillFromEnvironment();
            if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
        });
    }

    function setupGroundbedForm() {
        const form = getDomElement('groundbedForm');
        if (form) { form.addEventListener('submit', (e) => { e.preventDefault(); const editId = getDomElement('gbEditId').value; if (window.CPController && typeof window.CPController.calculateGroundbed === 'function') window.CPController.calculateGroundbed(editId || null); }); }
        document.querySelectorAll('#groundbedForm .std-select').forEach(select => {
            const manualId = select.id + 'Manual';
            const manual = getDomElement(manualId);
            if (manual) { select.addEventListener('change', () => { manual.style.display = select.value === 'manual' ? 'block' : 'none'; }); }
        });
        const exportBtn = getDomElement('gbExportPDF');
        if (exportBtn) exportBtn.addEventListener('click', () => {
            if (window.CPController && typeof window.CPController.exportGroundbedPDF === 'function') window.CPController.exportGroundbedPDF();
        });
    }

    function setupInterferenceForm() {
        const form = getDomElement('interferenceForm');
        if (form) { form.addEventListener('submit', (e) => { e.preventDefault(); if (window.CPController && typeof window.CPController.calculateInterference === 'function') window.CPController.calculateInterference(); }); }
        const exportBtn = getDomElement('ifExportPDF');
        if (exportBtn) exportBtn.addEventListener('click', () => {
            if (window.CPController && typeof window.CPController.exportInterferencePDF === 'function') window.CPController.exportInterferencePDF();
        });
    }

    function setupHistoryForm() {
        // déjà géré
    }

    function addHelpTooltips() {
        document.querySelectorAll('.field-auto-calculated').forEach(el => {
            el.setAttribute('title', 'Ce champ est automatiquement synchronisé depuis les équipements. Cliquez sur le cadenas pour le déverrouiller.');
        });
        document.querySelectorAll('.field-manual').forEach(el => {
            el.setAttribute('title', 'Valeur saisie manuellement. Cliquez sur le cadenas pour passer en mode synchronisé.');
        });
    }

    // ============================================================
    // displayGroundbedResults
    // ============================================================
    function displayGroundbedResults(result, totalDepth, activeDepth, anodeCount, anodeLength) {
        if (!result) {
            console.warn('displayGroundbedResults: Aucun résultat à afficher');
            return;
        }

        if (typeof CalculationEngine !== 'undefined' && typeof CalculationEngine.normalizeGroundbedResult === 'function') {
            result = CalculationEngine.normalizeGroundbedResult(result);
        }

        const placeholder = getDomElement('gbPlaceholder');
        const resultsContent = getDomElement('gbResultsContent');
        if (placeholder) placeholder.classList.add('hidden');
        if (resultsContent) resultsContent.classList.remove('hidden');

        const setValue = (id, value, suffix = '') => {
            const el = getDomElement(id);
            if (el) el.innerText = value + suffix;
        };

        setValue('gbResistance', result.R_total.toFixed(4));
        setValue('gbCurrent', result.I_total.toFixed(2));
        setValue('gbVoltage', result.V_rectifier.toFixed(1));
        setValue('gbPower', result.P_rectifier.toFixed(0));

        const jAnodeVal = result.J_anode || 0;
        const gbAnodeDensityEl = getDomElement('gbAnodeDensity');
        if (gbAnodeDensityEl) {
            gbAnodeDensityEl.innerText = jAnodeVal.toFixed(3);
        }

        // FIX-LIFESPAN : afficher lifeDesign (plafonné NACE ≤25 ans) et non la valeur Faraday brute
        const gbLifeDesignVal = (typeof result.lifeDesign === 'number' && result.lifeDesign > 0)
            ? result.lifeDesign
            : ((typeof result.lifeWithSafety === 'number') ? Math.min(result.lifeWithSafety, 25) : 0);
        setValue('gbCalcLife', gbLifeDesignVal.toFixed(1));

        const tbody = getDomElement('gbTableBody');
        if (tbody) {
            const jAnodeDisplay = jAnodeVal.toFixed(3) + ' A/m²';
            const rhoProjectStr = (result.rhoProject !== undefined) ? result.rhoProject : '—';
            const rhoGroundbedStr = (result.rhoGroundbed !== undefined) ? result.rhoGroundbed : (result.rho_eff || '—');

            tbody.innerHTML = `
                <tr><td>Résistance d'anode (Dwight)</td><td>${result.R_single.toFixed(4)} Ω</td><td>ρ/(2πL) × [ln(4L/d) - 1]</td></tr>
                <tr><td>Résistance de groupe (Sunde)</td><td>${result.R_group.toFixed(4)} Ω</td><td>Interaction mutuelle</td></tr>
                <tr><td>Résistance du puits (R_well)</td><td>${(result.R_well || 0).toFixed(4)} Ω</td><td>Dwight corrigé (forage)</td></tr>
                <tr><td>Résistance groundbed pure</td><td>${(result.R_groundbed_pure || 0).toFixed(4)} Ω</td><td>R_group + R_well (série)</td></tr>
                <tr><td>Résistance des câbles</td><td>${result.R_cable.toFixed(4)} Ω</td><td>2 × ρ_cu × L / S (aller-retour)</td></tr>
                <tr><td>Résistance de structure</td><td>${result.R_struct.toFixed(4)} Ω</td><td>Paramètre utilisateur</td></tr>
                <tr><td>Résistance totale</td><td>${result.R_total.toFixed(4)} Ω</td><td>R_group + R_well + R_cable + R_struct</td></tr>
                <tr><td>Courant total</td><td>${result.I_total.toFixed(2)} A</td><td>Courant cible de conception</td></tr>
                <tr><td>Tension redresseur</td><td>${result.V_rectifier.toFixed(1)} V</td><td>I_total × R_total</td></tr>
                <tr><td>Puissance redresseur</td><td>${result.P_rectifier.toFixed(0)} W</td><td>V_rectifier × I_total</td></tr>
                <tr><td>Densité de courant anodique</td><td>${jAnodeDisplay}</td><td>J_anode = I_total / (N × S_anode)</td></tr>
                <tr><td>Limite de densité</td><td>${result.densityLimit} A/m²</td><td>Recommandée</td></tr>
                <tr><td>Statut densité</td><td>${result.densityOk ? '✅ OK' : '⚠️ À vérifier'}</td><td>J_anode ≤ limite</td></tr>
                <tr><td>Durée de vie (théorique brut Faraday)</td><td>${result.lifeWithAging.toFixed(1)} ans</td><td>Loi de Faraday (non plafonnée)</td></tr>
                <tr><td><strong>Durée de vie de CONCEPTION</strong></td><td><strong>${gbLifeDesignVal.toFixed(1)} ans</strong></td><td>Plafonnée NACE SP0169 / ISO 15589 (≤25 ans)</td></tr>
                <tr><td>Anodes requises pour la durée cible</td><td>${result.requiredAnodeCount || '—'}</td><td>Inclut vieillissement et facteur de sécurité</td></tr>
                <tr><td>Conformité durée de vie</td><td>${result.lifeOk === null ? '—' : (result.lifeOk ? '✅ OK' : '❌ Insuffisant')}</td><td>Durée calculée ≥ cible</td></tr>
                <tr><td>Masse totale d'anodes</td><td>${result.totalMass.toFixed(1)} kg</td><td>N × poids unitaire</td></tr>
                <tr><td>Espacement des anodes</td><td>${result.spacing.toFixed(2)} m</td><td>ActiveDepth / (N + 1)</td></tr>
                <tr><td>Anodes</td><td>${result.anodeCount}</td><td>Nombre total</td></tr>
                <tr><td>Résistivité projet (ρ_project)</td><td>${rhoProjectStr} Ω·m</td><td>Source de vérité projet</td></tr>
                <tr><td>Résistivité groundbed (ρ_gb)</td><td>${rhoGroundbedStr} Ω·m</td><td>Couche d'installation anodes</td></tr>
                <tr><td>Résistivité effective (ρ_eff)</td><td>${(result.rho_eff || result.rho || 0).toFixed(1)} Ω·m</td><td>Après moyenne pondérée des couches</td></tr>
                <tr><td>Résistivité harmonique de sensibilité</td><td>${result.rho_harmonic === null || result.rho_harmonic === undefined ? '—' : result.rho_harmonic.toFixed(1) + ' Ω·m'}</td><td>Contrôle d'incertitude multicouche</td></tr>
                <tr><td>Ratio de sensibilité multicouche</td><td>${result.layerSensitivityRatio === null || result.layerSensitivityRatio === undefined ? '—' : result.layerSensitivityRatio.toFixed(2)}</td><td>ρ_arithmétique / ρ_harmonique</td></tr>
                <tr><td>Modèle groundbed</td><td>${result.groundbedModel || '—'}</td><td>${result.layerResistivityMethod || '—'}</td></tr>
                <tr><td>Statut de conception</td><td>${result.designStatus || '—'}</td><td>${result.requiresSpecialistStudy ? 'Étude numérique spécialisée requise' : 'Vérification projet requise'}</td></tr>
            `;
        }

        const spacing = activeDepth / (anodeCount + 1);
        drawGroundbedVisual(totalDepth || 200, activeDepth || 150, anodeCount || 16, anodeLength || 1.5, spacing);

        if (result._warning) {
            const alertDiv = getDomElement('iccpAlertsContainer') || document.createElement('div');
            alertDiv.id = 'iccpAlertsContainer';
            alertDiv.className = 'alert-container';
            const warningMsg = document.createElement('div');
            warningMsg.className = 'alert-item warning';
            warningMsg.innerHTML = `<span class="alert-icon"><i class="fas fa-exclamation-triangle" aria-hidden="true"></i></span> ⚠️ ${result._warning}`;
            alertDiv.prepend(warningMsg);
            const resultsCard = getDomElement('gbResultsContent');
            if (resultsCard && !resultsCard.querySelector('#iccpAlertsContainer')) {
                resultsCard.prepend(alertDiv);
            }
        }

        const kpiMass = getDomElement('kpiMass');
        if (kpiMass) kpiMass.innerText = result.totalMass.toFixed(1);
        const kpiLife = getDomElement('kpiLife');
        if (kpiLife) kpiLife.innerText = gbLifeDesignVal.toFixed(1);
    }

    // ============================================================
    // displayAnodeResults
    // ============================================================
    function displayAnodeResults(result, life) {
        if (!result) return;
        const placeholder = getDomElement('anodePlaceholder');
        const resultsContent = getDomElement('anodeResultsContent');
        if (placeholder) placeholder.classList.add('hidden');
        if (resultsContent) resultsContent.classList.remove('hidden');

        const setValue = (id, value, suffix = '') => {
            const el = getDomElement(id);
            if (el) el.innerText = value + suffix;
        };
        setValue('resTotalMass', result.totalMass.toFixed(1));
        setValue('resAnodeCount', result.count);
        setValue('resCapacity', result.capacityAhKg);
        setValue('resAnodePotential', result.anodePotential);
        setValue('resAnodeResistance', result.R_anode.toFixed(4));
        setValue('resInitialCurrent', result.initialCurrent.toFixed(3));

        const barFill = getDomElement('anodeBarFill');
        const barText = getDomElement('anodeBarText');
        if (barFill && barFill) {
            const lifeRatio = Math.min(result.actualLife / life, 1);
            barFill.style.width = (lifeRatio * 100) + '%';
            if (barText) barText.textContent = (lifeRatio * 100).toFixed(0) + '%';
        }

        const tbody = getDomElement('anodeTableBody');
        if (tbody) {
            const jInitialDisplay = result.currentDensity.toFixed(3) + ' A/m²';
            const jFinalDisplay = result.currentDensityFinal.toFixed(3) + ' A/m²';
            tbody.innerHTML = `
                <tr><td>Matériau</td><td>${result.material}</td><td>Selon DNV-RP-B401</td></tr>
                <tr><td>Masse unitaire</td><td>${(result.totalMass / result.count).toFixed(1)} kg</td><td>Masse totale / nombre</td></tr>
                <tr><td>Courant initial (par anode)</td><td>${result.initialCurrent.toFixed(3)} A</td><td>ΔV / R_anode</td></tr>
                <tr><td>Courant final (par anode)</td><td>${result.finalCurrent.toFixed(3)} A</td><td>ΔV / (R_anode × facteur final)</td></tr>
                <tr><td>Courant initial (total)</td><td>${(result.I_initial_total || 0).toFixed(3)} A</td><td>N × I_initial_per_anode</td></tr>
                <tr><td>Courant final (total)</td><td>${(result.I_final_total || 0).toFixed(3)} A</td><td>N × I_final_per_anode</td></tr>
                <tr><td>Dimensionnement par</td><td>${result.sizingBasis || 'N/A'}</td><td>courant ou masse</td></tr>
                <tr><td>N (contrainte courant)</td><td>${result.N_by_current || 'N/A'}</td><td>I_req / I_final</td></tr>
                <tr><td>N (contrainte masse)</td><td>${result.N_by_mass || 'N/A'}</td><td>masse / masse_unitaire</td></tr>
                <tr><td>Capacité courant</td><td>${result.currentOk ? '✅ OK' : '❌ Insuffisant'}</td><td>I_final_total ≥ I_req</td></tr>
                <tr><td>Densité de courant initiale</td><td>${jInitialDisplay}</td><td>I_initial / S_anode</td></tr>
                <tr><td>Densité de courant finale</td><td>${jFinalDisplay}</td><td>I_final / S_anode</td></tr>
                <tr><td>Limite de densité</td><td>${result.densityLimit} A/m²</td><td>Selon matériau</td></tr>
                <tr><td>Statut densité</td><td>${result.densityOk ? '✅ OK' : '⚠️ À vérifier'}</td><td>J ≤ limite</td></tr>
                <tr><td>Résistance d'anode (Dwight)</td><td>${result.R_anode.toFixed(4)} Ω</td><td>ρ/(2πL) × [ln(4L/d) - 1]</td></tr>
                <tr><td>Résistance finale</td><td>${result.R_final.toFixed(4)} Ω</td><td>R_anode × facteur final</td></tr>
                <tr><td>Efficacité électrochimique</td><td>${(result.efficiency * 100).toFixed(0)}%</td><td>Selon matériau</td></tr>
                <tr><td>Orientation</td><td>${result.orientation}</td><td>Verticale ou horizontale</td></tr>
            `;
        }
    }

    // ============================================================
    // displayInterferenceResults
    // ============================================================
    function displayInterferenceResults(result) {
        if (!result) return;
        const placeholder = getDomElement('ifPlaceholder');
        const resultsContent = getDomElement('ifResultsContent');
        if (placeholder) placeholder.classList.add('hidden');
        if (resultsContent) resultsContent.classList.remove('hidden');
        // BUG-CP-006 : affichage de la classification du modèle
        if (result.modelClassification) {
            const classifHtml = `
                <div class="alert-item warning" style="margin-bottom:0.5rem;">
                    <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
                    <strong>Modèle : ${Utils.escapeHtml(result.modelClassification)}</strong>
                    — Analyse préliminaire. Ne remplace pas une étude
                    d'interférence détaillée (AMPP SP0177 §6).
                </div>
            `;
            // Insérer en haut du tableau de résultats
            const tbl = document.querySelector('#ifTableBody');
            if (tbl && tbl.parentNode) {
                const banner = document.createElement('div');
                banner.className = 'model-classification-banner';
                banner.innerHTML = classifHtml;
                tbl.parentNode.insertBefore(banner, tbl.parentNode.firstChild);
            }
        }

        const setValue = (id, value, suffix = '') => {
            const el = getDomElement(id);
            if (el) el.innerText = value + suffix;
        };
        setValue('ifACInduced', result.acInduced === null ? 'N/A' : result.acInduced.toFixed(2));
        setValue('ifACTouch', result.touchVoltage === null ? 'N/A' : result.touchVoltage.toFixed(2));
        setValue('ifDCDelta', result.deltaV === null ? 'N/A' : result.deltaV.toFixed(1));
        setValue('ifDCStray', result.dcStray === null ? 'N/A' : result.dcStray.toFixed(3));
        setValue('ifStatus', result.globalStatus);
        setValue('ifRecommendation', result.mitigations.join(' • '));

        const tbody = getDomElement('ifTableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr><td>AC induit</td><td>${result.acInduced === null ? 'N/A — DATA REQUIRED' : result.acInduced.toFixed(2) + ' V'}</td><td>Z × I_AC × L_parallel</td></tr>
                <tr><td>Touch voltage</td><td>${result.touchVoltage === null ? 'N/A — DATA REQUIRED' : result.touchVoltage.toFixed(2) + ' V'}</td><td>V_AC × R_body / (R_body + R_earth)</td></tr>
                <tr><td>Statut AC</td><td>${result.acStatus}</td><td>Critère touch voltage</td></tr>
                <tr><td>ΔV (victime – source)</td><td>${result.deltaV === null ? 'N/A — DATA REQUIRED' : result.deltaV.toFixed(1) + ' mV'}</td><td>V_initial – V_final</td></tr>
                <tr><td>Courant vagabond DC</td><td>${result.dcStray === null ? 'N/A — DATA REQUIRED' : result.dcStray.toFixed(3) + ' A'}</td><td>ΔV[mV] × 1e-3 / R_path</td></tr>
                <tr><td>Statut DC</td><td>${result.dcStatus}</td><td>Niveau de courant vagabond</td></tr>
                <tr><td>Résistance de chemin</td><td>${result.R_path.toFixed(4)} Ω</td><td>ρ/(2πd) × ln(4d/r)</td></tr>
                <tr><td>Mitigations</td><td>${result.mitigations.join('; ')}</td><td>Recommandations</td></tr>
            `;
        }

        const mitigationDiv = getDomElement('ifMitigationContent');
        if (mitigationDiv) {
            mitigationDiv.innerHTML = result.mitigations.map(m =>
                `<span class="mitigation-item"><i class="fas fa-check-circle"></i> ${m}</span>`
            ).join('');
        }
    }

    // ============================================================
    // renderDynamicEquipmentList
    // ============================================================
    async function renderDynamicEquipmentList() {
        const container = document.getElementById('dynamic-equip-content');
        const countEl = document.getElementById('dynamic-equip-count');
        if (!container) return;

        const currentProjectId = ProjectManager.getCurrentProjectId();

        let equipments = [];

        if (currentProjectId === null || currentProjectId === '__all__') {
            const projects = ProjectManager.getProjectsList();
            const results = await Promise.all(projects.map(p => StorageManager.loadEquipmentsForProject(p.id, true)));
            results.forEach(eqs => equipments = equipments.concat(eqs));
            equipments = equipments.filter(eq => eq.included !== false);
            countEl.textContent = equipments.length + ' équipements (tous projets)';
        }
        else {
            equipments = ProjectManager.getState().equipments.filter(eq =>
                eq.projectId === currentProjectId && eq.included !== false
            );
            countEl.textContent = equipments.length + ' équipements';
        }

        let html = `<table style="width:100%; border-collapse:collapse; font-size:12px;">
                        <thead>
                            <tr>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Tag</th>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Type</th>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Surface (m²)</th>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Statut</th>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Coordonnées GPS</th>
                            </tr>
                        </thead><tbody>`;

        equipments.forEach(eq => {
            let statusBadge = `<span style="background:#1a3347; color:#d6e6f5; padding:2px 10px; border-radius:30px; font-size:10px; font-weight:600;"><i class="fas fa-check-circle" style="color:#4db87d;"></i> OK</span>`;
            if (eq.type === 'rectifier' && eq.status === 'OFF') {
                statusBadge = `<span style="background:#361f1f; color:#f7a6a6; padding:2px 10px; border-radius:30px; font-size:10px; font-weight:600;"><i class="fas fa-times-circle"></i> OFF</span>`;
            }

            let coordsDisplay = '—';
            const coords = eq.coordinates;
            if (coords) {
                if (Array.isArray(coords) && coords.length > 1) {
                    const first = coords[0];
                    const last = coords[coords.length - 1];
                    coordsDisplay = `<i class="fas fa-map-pin" style="margin-right:3px; color:#e2b34b; font-size:10px;"></i> ${first.lat.toFixed(6)}°N, ${first.lon.toFixed(6)}°E → ${last.lat.toFixed(6)}°N, ${last.lon.toFixed(6)}°E`;
                } else if (Array.isArray(coords) && coords.length === 1) {
                    const p = coords[0];
                    coordsDisplay = `<i class="fas fa-map-pin" style="margin-right:3px; color:#e2b34b; font-size:10px;"></i> ${p.lat.toFixed(6)}°N, ${p.lon.toFixed(6)}°E`;
                } else if (coords.lat !== undefined) {
                    coordsDisplay = `<i class="fas fa-map-pin" style="margin-right:3px; color:#e2b34b; font-size:10px;"></i> ${coords.lat.toFixed(6)}°N, ${coords.lon.toFixed(6)}°E`;
                }
            }

            let projectColor = '#a78bfa';
            if (eq.projectId === 'PROJ-001') projectColor = '#00A3E0';
            else if (eq.projectId === 'PROJ-002') projectColor = '#FF6B00';

            html += `<tr>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0;"><span style="color:${projectColor}; font-weight:600;">${Utils.escapeHtml(eq.tag)}</span></td>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0;">${Utils.escapeHtml(eq.type)}</td>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0;">${Utils.safeNumber(eq.surface, 0).toFixed(1)}</td>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0;">${statusBadge}</td>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0; font-family:monospace; font-size:11px; color:#80a9cc;">${coordsDisplay}</td>
                    </tr>`;
        });

        html += `</tbody></table>`;
        container.innerHTML = html;
    }

    // ============================================================
    // INDICATEUR DE CHARGEMENT 3D
    // ============================================================
    function show3DLoading(message) {
        const container = document.getElementById('threeContainer');
        if (!container) return;
        let overlay = container.querySelector('.loading-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'loading-overlay';
            overlay.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; flex-direction:column; z-index:20; color:white; font-size:1.2rem;';
            overlay.innerHTML = `<div class="spinner" style="border:4px solid rgba(255,255,255,0.3); border-top:4px solid #06b6d4; border-radius:50%; width:40px; height:40px; animation:spin 1s linear infinite; margin-bottom:1rem;"></div><span class="loading-text">${message || 'Chargement...'}</span>`;
            container.style.position = 'relative';
            container.appendChild(overlay);
        } else {
            const textEl = overlay.querySelector('.loading-text');
            if (textEl) textEl.textContent = message || 'Chargement...';
            overlay.style.display = 'flex';
        }
    }

    function hide3DLoading() {
        const container = document.getElementById('threeContainer');
        if (!container) return;
        const overlay = container.querySelector('.loading-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    document.addEventListener('moduleLoadStatus', function(e) {
        const { moduleName, status, message } = e.detail;
        if (moduleName === 'gis3d' || moduleName === 'simulation3d') {
            if (status === 'loading') {
                show3DLoading(message || 'Chargement des modules 3D...');
            } else if (status === 'ready' || status === 'error') {
                hide3DLoading();
            }
        }
    });

    // ============================================================
    // INIT PRINCIPAL (async)
    // ============================================================
    async function init() {
        await StorageManager.initDatabase();
        await StorageManager.initEncryption();
        await ProjectManager.loadProjectsList();

        let attempts = 0;
        while (!window.CPController && attempts < 30) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        if (!window.CPController) {
            console.warn('CPController non disponible après 3s, certaines fonctionnalités seront limitées.');
        }

        initTheme();
        setupNavigation();

        // Hydratation DB → Studio (storage-proxy) : la liste des projets
        // change → on rafraîchit le sélecteur sans recharger la page.
        document.addEventListener('projectsHydrated', function() {
            populateProjectSelector();
        });

        setupSidebar();
        updateDate();
        setupManualOverrides();
        setupOuvrageListener();
        setupForms();
        updateCorrosivity();
        initDashboardCharts();
        if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
        setupGroundbedForm();
        setupInterferenceForm();
        setupHistoryForm();
        updateEquipTypeOptions();
        updateEquipDimensionsFields();

        const container = getDomElement('equipWaypointsContainer');
        if (container) {
            container.innerHTML = '';
            addEquipWaypointRow('', '', null, false);
        }

        // Import Excel
        const importGpsExcelBtn = getDomElement('importGpsExcelBtn');
        const gpsExcelInput = getDomElement('gpsExcelInput');

        if (importGpsExcelBtn && gpsExcelInput) {
            importGpsExcelBtn.addEventListener('click', function() {
                gpsExcelInput.click();
            });
            gpsExcelInput.addEventListener('change', handleGpsExcelImport);
        }

        const addWpBtn = getDomElement('addEquipWaypointBtn');
        if (addWpBtn) {
            addWpBtn.addEventListener('click', function() {
                addEquipWaypointRow('', '', null, true);
            });
        }

        populateAllSystemSelectors();

        document.querySelectorAll('.system-selector-bar select, .dashboard-system-selector select').forEach(sel => {
            sel.addEventListener('change', function() {
                const val = this.value;
                if (val) {
                    ProjectManager.setCurrentSystemId(val);
                    const activeModule = document.querySelector('.module.active');
                    if (activeModule) {
                        const moduleId = activeModule.id.replace('module-', '');
                        loadSystemParamsToModule(moduleId, val);
                    }
                    if (window.CPController && typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
                    renderSystems();
                    populateAllSystemSelectors();
                }
            });
        });

        const vis3dSelector = getDomElement('vis3dSystemSelector');
        if (vis3dSelector) {
            vis3dSelector.addEventListener('change', function() {
                const sysId = this.value;
                if (sysId) {
                    if (window.Gis3D && typeof window.Gis3D.setSystemFilter === 'function') {
                        window.Gis3D.setSystemFilter(sysId);
                    }
                    if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                        window.Gis3D.loadData();
                    }
                } else {
                    if (window.Gis3D && typeof window.Gis3D.setSystemFilter === 'function') {
                        window.Gis3D.setSystemFilter(null);
                    }
                    if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                        window.Gis3D.loadData();
                    }
                }
            });
        }

        const vis3dLoadBtn = getDomElement('vis3dLoadSystemBtn');
        if (vis3dLoadBtn) {
            vis3dLoadBtn.addEventListener('click', function() {
                const sysId = getDomElement('vis3dSystemSelector')?.value;
                if (sysId) {
                    if (window.Gis3D && typeof window.Gis3D.setSystemFilter === 'function') {
                        window.Gis3D.setSystemFilter(sysId);
                    }
                    if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                        window.Gis3D.loadData();
                    }
                    showToast(`Système ${sysId} chargé dans la visualisation 3D`, 'success');
                } else {
                    showToast('Veuillez sélectionner un système', 'warning');
                }
            });
        }

        getDomElement('cpUseCurrentSystem')?.addEventListener('click', function() {
            const sysId = getDomElement('cpSystemSelector')?.value;
            if (sysId) loadSystemParamsToModule('cp-calc', sysId);
        });
        getDomElement('anodesUseCurrentSystem')?.addEventListener('click', function() {
            const sysId = getDomElement('anodesSystemSelector')?.value;
            if (sysId) loadSystemParamsToModule('anodes', sysId);
        });
        getDomElement('iccpUseCurrentSystem')?.addEventListener('click', function() {
            const sysId = getDomElement('iccpSystemSelector')?.value;
            if (sysId) loadSystemParamsToModule('iccp', sysId);
        });
        getDomElement('gbUseCurrentSystem')?.addEventListener('click', function() {
            const sysId = getDomElement('gbSystemSelector')?.value;
            if (sysId) loadSystemParamsToModule('groundbed', sysId);
        });
        getDomElement('ifUseCurrentSystem')?.addEventListener('click', function() {
            const sysId = getDomElement('ifSystemSelector')?.value;
            if (sysId) loadSystemParamsToModule('interference', sysId);
        });

        getDomElement('saveCPSystemBtn')?.addEventListener('click', function() {
            const sysId = getDomElement('cpSystemSelector')?.value;
            if (sysId && ProjectManager.getState().cp.current > 0) {
                ProjectManager.saveSystemResults(sysId, 'cp', {
                    current: ProjectManager.getState().cp.current,
                    irDrop: ProjectManager.getState().cp.irDrop,
                    requiredOnPotential: ProjectManager.getState().cp.requiredOnPotential,
                    surface: ProjectManager.getState().project.surface,
                    timestamp: new Date().toISOString()
                });
                showToast('Résultats CP sauvegardés dans le système', 'success');
                try { ProjectManager.saveCurrentProject(); saveSessionSnapshot(); } catch (err) { console.error(err); }
            } else { showToast('Aucun résultat CP à sauvegarder', 'warning'); }
        });
        getDomElement('saveAnodesSystemBtn')?.addEventListener('click', function() {
            const sysId = getDomElement('anodesSystemSelector')?.value;
            if (sysId && ProjectManager.getState().anodes.totalMass > 0) {
                ProjectManager.saveSystemResults(sysId, 'anodes', {
                    totalMass: ProjectManager.getState().anodes.totalMass,
                    count: ProjectManager.getState().anodes.count,
                    actualLife: ProjectManager.getState().anodes.actualLife,
                    initialCurrent: ProjectManager.getState().anodes.initialCurrent,
                    currentDensity: ProjectManager.getState().anodes.currentDensity,
                    currentDensity_mA: ProjectManager.getState().anodes.currentDensity_mA,
                    densityOk: ProjectManager.getState().anodes.densityOk,
                    timestamp: new Date().toISOString()
                });
                showToast('Résultats Anodes sauvegardés dans le système', 'success');
                try { ProjectManager.saveCurrentProject(); saveSessionSnapshot(); } catch (err) { console.error(err); }
            } else { showToast('Aucun résultat Anodes à sauvegarder', 'warning'); }
        });
        getDomElement('saveIccpSystemBtn')?.addEventListener('click', function() {
            const sysId = getDomElement('iccpSystemSelector')?.value;
            if (sysId && ProjectManager.getState().iccp.current > 0) {
                ProjectManager.saveSystemResults(sysId, 'iccp', {
                    current: ProjectManager.getState().iccp.current,
                    voltage: ProjectManager.getState().iccp.voltage,
                    power: ProjectManager.getState().iccp.powerDesign || ProjectManager.getState().iccp.power,
                    powerDesign: ProjectManager.getState().iccp.powerDesign,
                    voltageFinal: ProjectManager.getState().iccp.voltageFinal,
                    currentDensity: ProjectManager.getState().iccp.currentDensity,
                    currentDensity_mA: ProjectManager.getState().iccp.currentDensity_mA,
                    densityOk: ProjectManager.getState().iccp.densityOk,
                    groundbedResistance: ProjectManager.getState().iccp.groundbedResistance || 0,
                    lifeEstimate: ProjectManager.getState().iccp.lifeDesign || ProjectManager.getState().iccp.lifeEstimate || 0,
                    lifeDesign: ProjectManager.getState().iccp.lifeDesign,
                    lifeTheoretical: ProjectManager.getState().iccp.lifeTheoretical,
                    iccpCurrentSource: ProjectManager.getState().iccp.iccpCurrentSource,
                    iccpSourceLabel: ProjectManager.getState().iccp.iccpSourceLabel,
                    calculationVersion: ProjectManager.getState().iccp.calculationVersion || null,
                    timestamp: new Date().toISOString()
                });
                showToast('Résultats ICCP sauvegardés dans le système', 'success');
                try { ProjectManager.saveCurrentProject(); saveSessionSnapshot(); } catch (err) { console.error(err); }
            } else { showToast('Aucun résultat ICCP à sauvegarder', 'warning'); }
        });
        getDomElement('saveGbSystemBtn')?.addEventListener('click', function() {
            const sysId = getDomElement('gbSystemSelector')?.value;
            if (sysId && ProjectManager.getState().groundbed.results) {
                const r = ProjectManager.getState().groundbed.results;
                ProjectManager.saveSystemResults(sysId, 'groundbed', {
                    R_total: r.R_total,
                    R_group: r.R_group,
                    R_well: r.R_well,
                    R_groundbed_pure: r.R_groundbed_pure,
                    R_cable: r.R_cable,
                    R_struct: r.R_struct,
                    I_total: r.I_total,
                    V_rectifier: r.V_rectifier,
                    P_rectifier: r.P_rectifier,
                    J_anode: r.J_anode,
                    J_anode_mA: r.J_anode_mA,
                    densityLimit: r.densityLimit,
                    densityOk: r.densityOk,
                    lifeWithSafety: r.lifeWithSafety,
                    totalMass: r.totalMass,
                    anodeCount: r.anodeCount,
                    rhoProject: r.rhoProject,
                    rhoGroundbed: r.rhoGroundbed,
                    timestamp: new Date().toISOString()
                });
                showToast('Résultats Groundbed sauvegardés dans le système', 'success');
                try { ProjectManager.saveCurrentProject(); saveSessionSnapshot(); } catch (err) { console.error(err); }
            } else { showToast('Aucun résultat Groundbed à sauvegarder', 'warning'); }
        });
        getDomElement('saveIfSystemBtn')?.addEventListener('click', function() {
            const sysId = getDomElement('ifSystemSelector')?.value;
            if (sysId && ProjectManager.getState().interference.results) {
                const r = ProjectManager.getState().interference.results;
                ProjectManager.saveSystemResults(sysId, 'interference', {
                    acInduced: r.acInduced,
                    touchVoltage: r.touchVoltage,
                    acStatus: r.acStatus,
                    deltaV: r.deltaV,
                    dcStray: r.dcStray,
                    dcStatus: r.dcStatus,
                    globalStatus: r.globalStatus,
                    mitigations: r.mitigations,
                    timestamp: new Date().toISOString()
                });
                showToast('Résultats Interférences sauvegardés dans le système', 'success');
                try { ProjectManager.saveCurrentProject(); saveSessionSnapshot(); } catch (err) { console.error(err); }
            } else { showToast('Aucun résultat Interférences à sauvegarder', 'warning'); }
        });

        getDomElement('historySystemSelector')?.addEventListener('change', function() { refreshHistoryTable(); });

        getDomElement('toggleSurfaceSync')?.addEventListener('click', function() {
            AppState.surfaceSyncEnabled = !AppState.surfaceSyncEnabled;
            const lockIcon = getDomElement('surfaceSyncLockIcon');
            const syncMessage = getDomElement('surfaceSyncMessage');
            if (lockIcon) lockIcon.className = AppState.surfaceSyncEnabled ? 'fas fa-lock' : 'fas fa-unlock';
            if (syncMessage) syncMessage.textContent = AppState.surfaceSyncEnabled ?
                'Surface automatiquement synchronisée depuis le module Équipements. Cliquez sur le cadenas pour passer en mode manuel.' :
                'Synchronisation automatique désactivée. La surface est en mode manuel.';
            showToast(`Synchronisation surface ${AppState.surfaceSyncEnabled ? 'activée' : 'désactivée'}`, 'info');
            if (!AppState.surfaceSyncEnabled) {
                getDomElement('cpSurface').readOnly = false;
                getDomElement('cpSurface').style.background = 'var(--bg-input)';
                getDomElement('cpSurface').style.borderStyle = 'solid';
                setFieldSource('cpSurface', 'manual');
            } else {
                getDomElement('cpSurface').readOnly = true;
                getDomElement('cpSurface').style.background = '#1e293b';
                getDomElement('cpSurface').style.borderStyle = 'dotted';
                setFieldSource('cpSurface', 'auto');
                if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
            }
        });
        getDomElement('syncSurfaceFromEquipments')?.addEventListener('click', () => {
            if (AppState.surfaceSyncEnabled) { if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments(); }
            else { showToast('La synchronisation automatique est désactivée. Activez-la pour synchroniser.', 'warning'); }
        });

        const equipTypeSelect = getDomElement('equipType');
        if (equipTypeSelect) { equipTypeSelect.addEventListener('change', function() { updateEquipDimensionsFields(); computeEquipSurface(); }); }

        getDomElement('equipmentForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();

            const editId = getDomElement('editEquipId').value;
            const tag = getDomElement('equipTag').value.trim();
            const type = getDomElement('equipType').value;
            const projectId = getDomElement('equipProjectId').value;
            const included = getDomElement('equipIncluded').checked;
            const systemId = getDomElement('equipSystemId').value || null;
            const surfaceAuto = getDomElement('equipSurfaceAuto').value;

            let surface = 0;
            if (surfaceAuto && parseFloat(surfaceAuto) > 0) {
                surface = parseFloat(surfaceAuto);
            } else {
                if (!TYPES_NO_DIMENSIONS.includes(type)) {
                    showToast('Veuillez sélectionner les dimensions pour calculer la surface', 'warning');
                    return;
                }
            }

            if (!projectId) {
                showToast('Veuillez sélectionner un projet', 'warning');
                return;
            }

            const fields = CalculationEngine.getOuvrageFields(type);
            const dimensions = {};
            fields.forEach(f => {
                const select = getDomElement(`dim_${f}`);
                if (select) {
                    let val = 0;
                    if (select.value === 'manual') {
                        const manual = getDomElement(`dim_${f}_manual`);
                        val = Utils.safeNumber(manual?.value, 0);
                    } else {
                        val = Utils.safeNumber(select.value, 0);
                    }
                    if (f === 'diametre_m' && val > 10) val = val / 1000;
                    dimensions[f] = val;
                }
            });

            const waypoints = collectEquipWaypoints();
            let coordinates = null;
            if (waypoints.length === 1) {
                coordinates = waypoints[0];
            } else if (waypoints.length > 1) {
                coordinates = waypoints;
            }

            if (!coordinates) {
                const lat = Utils.safeNumber(getDomElement('equipLat').value);
                const lon = Utils.safeNumber(getDomElement('equipLon').value);
                const alt = Utils.safeNumber(getDomElement('equipAlt').value);
                if (lat !== 0 || lon !== 0) {
                    coordinates = { lat, lon, alt: alt || null };
                }
            }

            if (editId) {
                await updateEquipment(editId, tag, type, surface, projectId, dimensions, included, systemId, coordinates);
            } else {
                await addEquipment(tag, type, surface, projectId, dimensions, included, systemId, coordinates);
            }

            resetEquipmentForm();

            const submitBtn = getDomElement('equipSubmitBtn');
            submitBtn.innerHTML = '<i class="fas fa-save" aria-hidden="true"></i> Ajouter équipement';

            const cancelBtn = getDomElement('cancelEditBtn');
            cancelBtn.style.display = 'none';

            AppState.editMode = false;
            AppState.editingEquipId = null;

            const form = getDomElement('equipmentForm');
            form.classList.remove('edit-mode-highlight');

            if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') {
                window.CPController.syncSurfaceFromEquipments();
            }
            populatePipelineSelects();
        });

        getDomElement('cancelEditBtn')?.addEventListener('click', () => cancelEdit());

        const systemRadios = document.querySelectorAll('input[name="cpSystemType"]');
        systemRadios.forEach(radio => { radio.addEventListener('change', (e) => { if (e.target.checked) { const newType = e.target.value;
                    ProjectManager.getState().project.cpSystemType = newType;
                    setModulesActivation(newType);
                    showToast(`Type de système changé : ${newType === 'iccp' ? 'ICCP seul' : newType === 'anodes' ? 'Anodes seules' : 'Mixte'}`, 'info');
                    ProjectManager.saveCurrentProject(); } }); });
        setModulesActivation(ProjectManager.getState().project.cpSystemType || 'mixte');

        const anodeCurrentField = getDomElement('anodeCurrentReq');
        if (anodeCurrentField) anodeCurrentField.addEventListener('change', () => { if (window.CPController && typeof window.CPController.checkConsistency === 'function') window.CPController.checkConsistency(); });

        const modal = getDomElement('projectModal');
        getDomElement('newProjectBtn').onclick = () => { modal.style.display = 'flex'; };
        getDomElement('cancelModal').onclick = () => { modal.style.display = 'none'; };
        getDomElement('confirmCreateProject').onclick = async () => {
            const projId = getDomElement('newProjectId').value.trim();
            const name = getDomElement('newProjectName').value.trim();
            const type = document.querySelector('input[name="projType"]:checked').value;
            if (!projId) { showToast('ID projet requis', 'warning'); return; }
            if (!name) { showToast('Nom requis', 'warning'); return; }
            try {
                await ProjectManager.createNewProject(projId, name, type);
                await ProjectManager.loadProjectsList();
                populateProjectSelector();
                await ProjectManager.loadProject(projId);
                loadProjectParams();
                if (!_defaultsApplied) {
                    applyIlliziDefaults();
                    _defaultsApplied = true;
                }
                ensureAnodeDefaults();
                modal.style.display = 'none';
                showToast(`Projet "${Utils.escapeHtml(name)} (${Utils.escapeHtml(projId)})" créé`, 'success');
            } catch (err) {
                showToast(err.message || 'Erreur création projet', 'error');
            }
        };
        getDomElement('deleteProjectBtn').onclick = async () => {
            try {
                await ProjectManager.deleteCurrentProject();
                await ProjectManager.loadProjectsList();
                populateProjectSelector();
                if (ProjectManager.getProjectsList().length > 0) { await ProjectManager.loadProject(ProjectManager.getProjectsList()[0].id); }
                showToast('Projet supprimé', 'warning');
            } catch (err) { showToast('Erreur lors de la suppression du projet', 'error'); console.error(err); }
        };

        const saveBtn = getDomElement('saveNowBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', function() {
                updateSaveStatus('saving');
                ProjectManager.saveCurrentProject()
                    .then(() => updateSaveStatus('saved'))
                    .catch(() => updateSaveStatus('error'));
            });
        }
        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); const btn = getDomElement('saveNowBtn'); if (btn) btn.click(); }
        });

        setInterval(() => {
            updateSaveStatus('saving');
            ProjectManager.saveCurrentProject()
                .then(() => updateSaveStatus('saved'))
                .catch(() => updateSaveStatus('error'));
        }, APP_CONFIG.SAVE_INTERVAL_MS);

        window.addEventListener('beforeunload', function(e) {
            const data = ProjectManager.getState();
            try {
                const serialized = JSON.stringify({ id: ProjectManager.getCurrentProjectId(), data: data });
                localStorage.setItem('cp_last_project', serialized);
            } catch (err) { /* ignore */ }
        });

        getDomElement('exportPDFBtn').addEventListener('click', () => { if (window.CPController && typeof window.CPController.exportPDF === 'function') window.CPController.exportPDF(); });
        getDomElement('validateBtn').addEventListener('click', () => { if (window.CPController && typeof window.CPController.generateValidationReport === 'function') window.CPController.generateValidationReport(); });
        getDomElement('syncCPToAnodesBtn')?.addEventListener('click', () => {
            const cpCurr = ProjectManager.getState().cp.current;
            if (cpCurr > 0) {
                getDomElement('anodeCurrentReq').value = cpCurr;
                showToast(`Courant CP (${cpCurr.toFixed(3)} A) appliqué aux anodes`, 'success');
                if (window.CPController && typeof window.CPController.checkConsistency === 'function') window.CPController.checkConsistency();
                ProjectManager.saveCurrentProject();
            } else { showToast('Calculez d\'abord le courant CP', 'warning'); }
        });
        getDomElement('applyEquipmentTotalBtn')?.addEventListener('click', () => { if (window.CPController && typeof window.CPController.applyEquipmentTotalToCP === 'function') window.CPController.applyEquipmentTotalToCP(); });

        getDomElement('refreshEquipList')?.addEventListener('click', async () => {
            await StorageManager.loadEquipmentsForProject(ProjectManager.getCurrentProjectId());
            refreshEquipmentListUI();
        });
        getDomElement('filterEquipProject')?.addEventListener('change', () => {
            _equipFilterProject = getDomElement('filterEquipProject')?.value || '';
            refreshEquipmentListUI();
        });
        getDomElement('sumEquipSurfaceBtn')?.addEventListener('click', () => {
            const total = ProjectManager.getState().equipments.reduce((acc, eq) => acc + getCanonicalEquipmentSurface(eq), 0);
            showToast(`Surface cumulée: ${total.toFixed(1)} m²`, 'info');
            return total;
        });
        getDomElement('calculateAllEquipBtn')?.addEventListener('click', () => calculateAllEquipmentCP());

        refreshEquipmentListUI();

        const systemModal = getDomElement('systemModal');
        getDomElement('addSystemBtnDash')?.addEventListener('click', () => { systemModal.style.display = 'flex'; });
        getDomElement('addSystemBtn')?.addEventListener('click', () => { systemModal.style.display = 'flex'; });
        getDomElement('cancelSystemModal')?.addEventListener('click', () => { systemModal.style.display = 'none'; });
        getDomElement('confirmCreateSystem')?.addEventListener('click', async () => {
            const name = getDomElement('newSystemName').value.trim();
            const type = getDomElement('newSystemType').value;
            if (!name) { showToast('Nom du système requis', 'warning'); return; }
            const sys = ProjectManager.createSystem(name, type);
            if (sys) {
                systemModal.style.display = 'none';
                getDomElement('newSystemName').value = '';
                populateAllSystemSelectors();
                renderSystems();
                populateSystemDropdown();
                populateVis3dSystemSelector();
                showToast(`Système "${Utils.escapeHtml(name)}" créé`, 'success');
            }
        });

        getDomElement('fieldMeasForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const assetId = getDomElement('fmAssetId').value;
            const asset = ProjectManager.getState().equipments.find(eq => eq.id === assetId);
            if (!asset) { showToast('Sélectionnez un équipement', 'error'); return; }
            const date = getDomElement('fmDate').value;
            const potON = getDomElement('fmPotON').value;
            const potOFF = getDomElement('fmPotOFF').value;
            const operator = getDomElement('fmOperator').value;
            const temperature = getDomElement('fmTemp').value;
            const refElectrode = getDomElement('fmRefElectrode').value;
            await addFieldMeasurement(asset.id, asset.tag, date, potON, potOFF, operator, temperature, refElectrode);
            getDomElement('fmPotON').value = '';
            getDomElement('fmPotOFF').value = '';
            getDomElement('fmOperator').value = '';
            getDomElement('fmTemp').value = '';
        });
        refreshFieldMeasurementsTable();
        refreshAssetDropdownForFieldMeas();

        getDomElement('dashAddSystemBtn')?.addEventListener('click', () => { getDomElement('systemModal').style.display = 'flex'; });
        getDomElement('dashDeleteSystemBtn')?.addEventListener('click', () => {
            const activeId = ProjectManager.getCurrentSystemId();
            if (activeId) {
                ProjectManager.deleteSystem(activeId);
                renderSystems();
                populateAllSystemSelectors();
                populateVis3dSystemSelector();
                if (window.CPController && typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
                populateSystemDropdown();
            }
        });

        initLinks();

        renderGroundbedList();
        populateICCPGroundbedSelectors();

        if (window.CPController) {
            if (typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
            if (typeof window.CPController.updateAnodeCurrentSource === 'function') window.CPController.updateAnodeCurrentSource();
            if (typeof window.CPController.updateICCPCurrentSource === 'function') window.CPController.updateICCPCurrentSource();
            if (typeof window.CPController.syncSurfaceFromEquipments === 'function') window.CPController.syncSurfaceFromEquipments();
            if (typeof window.CPController.syncGroundbedFromCP === 'function') window.CPController.syncGroundbedFromCP();
            if (typeof window.CPController.syncInterferenceFromCP === 'function') window.CPController.syncInterferenceFromCP();
        }

        const iccpSourceSelect = getDomElement('iccpCurrentSource');
        if (iccpSourceSelect) {
            const savedSource = ProjectManager.getState().iccp?.iccpCurrentSource;
            if (savedSource && savedSource !== 'unknown' &&
                Array.from(iccpSourceSelect.options).some(option => option.value === savedSource)) {
                iccpSourceSelect.value = savedSource;
            } else if (!iccpSourceSelect.value || savedSource === 'unknown') {
                iccpSourceSelect.value = 'cp_calculated';
                if (ProjectManager.getState().iccp) {
                    ProjectManager.getState().iccp.iccpCurrentSource = 'cp_calculated';
                    ProjectManager.getState().iccp.iccpSourceLabel = 'CP calcule';
                }
            }
        }
        if (iccpSourceSelect && !iccpSourceSelect.dataset.sourceListenerInstalled) {
            iccpSourceSelect.dataset.sourceListenerInstalled = 'true';
            iccpSourceSelect.addEventListener('change', () => {
                updateICCPCurrentSource();
                if (window.CPController && typeof window.CPController.syncGroundbedTargetCurrent === 'function') {
                    window.CPController.syncGroundbedTargetCurrent();
                }
            });
        }

        const gbData = await StorageManager.loadGroundbedData();
        if (gbData) ProjectManager.getState().groundbed.results = gbData;
        const ifData = await StorageManager.loadInterferenceData();
        if (ifData) ProjectManager.getState().interference.results = ifData;
        loadHistory();

        setupTestPostsForm();

        getDomElement('historyFilterModule')?.addEventListener('change', () => refreshHistoryTable());
        getDomElement('clearHistoryBtn')?.addEventListener('click', () => clearHistory());

        renderSystems();
        populateAllSystemSelectors();
        populateVis3dSystemSelector();

        initFieldSources();

        setupAutoSaveFields();

        document.querySelectorAll('input:not([readonly]):not([type="checkbox"]):not([type="radio"]), select:not([disabled])').forEach(el => {
            el.addEventListener('change', function() { if (this.id && !this.classList.contains('field-auto-calculated')) { setFieldSource(this.id, 'manual'); } });
            el.addEventListener('input', function() { if (this.id && !this.classList.contains('field-auto-calculated')) { setFieldSource(this.id, 'manual'); } });
        });

        getDomElement('gbProjectSelect')?.addEventListener('change', function() { populateGroundbedEquipmentList(); });
        getDomElement('ifPipelineSelect')?.addEventListener('change', function() { const val = this.value; if (val) { loadInterferenceFromEquipment(val); } });

        populateGroundbedEquipmentList();

        getDomElement('enableResistiveModel')?.addEventListener('change', function() {
            getDomElement('resistiveModelPanel').style.display = this.checked ? 'block' : 'none';
            if (this.checked && window.CPController) {
                populateResistiveParams();
            }
        });
        getDomElement('applyResistiveModel')?.addEventListener('click', () => {
            applyResistiveModel();
        });

        getDomElement('calcCableBtn')?.addEventListener('click', () => {
            calculateCableSection();
        });
        getDomElement('applyCableToICCP')?.addEventListener('click', () => {
            applyCableToICCP();
        });
        getDomElement('linkCableCurrentToICCP')?.addEventListener('click', () => {
            linkCableCurrentToICCP();
        });

        getDomElement('cableVoltageDrop')?.addEventListener('change', function() {
            const manual = getDomElement('cableVoltageDropManual');
            if (manual) manual.style.display = this.value === 'manual' ? 'block' : 'none';
        });

        // v9.3 : installation des hints câble + auto-sélection systèmes
        const cableCurrInput = document.getElementById('cableCurrent');
        if (cableCurrInput) {
            cableCurrInput.addEventListener('input', updateCableCurrentHint);
            cableCurrInput.addEventListener('change', updateCableCurrentHint);
            updateCableCurrentHint();
        }

        installSystemAutoSelection();

        addHelpTooltips();

        let retryCount = 0;
        const maxRetries = 3;
        const retryDelays = [500, 1500, 3000];

        function attemptPopulateSelector() {
            if (ProjectManager.getProjectsList().length > 0) { return; }
            if (retryCount >= maxRetries) {
                console.info('[UI] Aucun projet enregistré pour le moment. Initialisation du système en mode vide.');
                return;
            }
            const delay = retryDelays[retryCount] || 3000;
            retryCount++;
            setTimeout(async () => {
                await ProjectManager.loadProjectsList();
                populateProjectSelector();
                if (!_defaultsApplied) {
                    applyIlliziDefaults();
                    _defaultsApplied = true;
                }
                ensureAnodeDefaults();
                refreshEquipmentProjectDropdown();
                refreshEquipmentListInCP();
                populateCPEquipmentSelector();
                populateGroundbedProjectSelect();
                populateInterferenceProjectSelect();
                populatePipelineSelects();
                loadHistory();
                populateTestPostsSelectors();
                populateVis3dSystemSelector();
                if (ProjectManager.getProjectsList().length === 0) { attemptPopulateSelector(); }
            }, delay);
        }

        setTimeout(async () => {
            await ProjectManager.loadProjectsList();
            populateProjectSelector();
            populateTestPostsSelectors();
            populateVis3dSystemSelector();
            if (ProjectManager.getProjectsList().length === 0) { attemptPopulateSelector(); }
        }, 100);

        const projectSelector = getDomElement('projectSelector');
        if (projectSelector) {
            projectSelector.onchange = async (e) => {
                const val = e.target.value;
                if (val === '__all__') {
                    ProjectManager.setCurrentProjectId(null);
                    if (window.GisIntegration) {
                        window.GisIntegration.filters.set('projectId', null);
                    }
                    const filterSelect = getDomElement('filterEquipProject');
                    if (filterSelect) filterSelect.value = '__all__';
                    _equipFilterProject = '';
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
                    if (window.CPController) {
                        if (typeof window.CPController.updateDashboard === 'function') window.CPController.updateDashboard();
                    }
                    showToast('Affichage de tous les projets', 'info');

                    if (window.UI.renderDynamicEquipmentList) {
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
                    _equipCurrentPage = 1;
                    refreshEquipmentListUI(true);
                    refreshFieldMeasurementsTable();
                    refreshAssetDropdownForFieldMeas();
                    populateCPEquipmentSelector();
                    loadProjectParams();
                    if (!_defaultsApplied) {
                        applyIlliziDefaults();
                        _defaultsApplied = true;
                    }

                    if (window.GisIntegration) {
                        window.GisIntegration.filters.set('projectId', val);
                    }

                    const filterSelect = getDomElement('filterEquipProject');
                    if (filterSelect) filterSelect.value = val;
                    _equipFilterProject = val;

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
                        if (sysId) { loadSystemParamsToModule(moduleId, sysId); }
                    }
                    if (AppState.map && window.CPController && typeof window.CPController.loadMapPoints === 'function') window.CPController.loadMapPoints();
                    const vis3dSysId = getDomElement('vis3dSystemSelector')?.value;

                    if (window.UI.renderDynamicEquipmentList) {
                        window.UI.renderDynamicEquipmentList();
                    }
                    if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                        window.Gis3D.loadData(val);
                    }
                }
            };
        }

        getDomElement('suggestStandardsBtn')?.addEventListener('click', () => { if (window.CPController && typeof window.CPController.suggestStandards === 'function') window.CPController.suggestStandards(); });

        getDomElement('generateSoilFromResistivity')?.addEventListener('click', () => {
            generateSoilFromResistivity();
        });
        const autoSoilCheck = getDomElement('autoGenerateSoil');
        if (autoSoilCheck) {
            autoSoilCheck.addEventListener('change', function() {
                if (this.checked) {
                    generateSoilFromResistivity();
                    const resSelect = getDomElement('envSoilResistivity');
                    const resManual = getDomElement('envSoilResistivityManual');
                    const handler = debounce(() => generateSoilFromResistivity(), 500);
                    if (resSelect) resSelect.addEventListener('change', handler);
                    if (resManual) resManual.addEventListener('input', handler);
                    window._autoSoilHandlers = { resSelect, resManual, handler };
                }
            });
        }

        getDomElement('generateWaterFromEnv')?.addEventListener('click', () => {
            generateWaterFromEnvironment();
        });

        setupReinforcementZones();

        setupCartography();
        const mapContainer = getDomElement('mapContainer');
        if (mapContainer) {
            const observer = new MutationObserver(() => {
                const module = getDomElement('module-cartography');
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
            observer.observe(getDomElement('mainContent'), { childList: true, subtree: true });
            if (getDomElement('module-cartography')?.classList.contains('active')) {
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

        const gbForm = getDomElement('groundbedForm');
        if (gbForm) {
            gbForm.addEventListener('submit', function(e) {
                e.preventDefault();
                const editId = getDomElement('gbEditId').value;
                if (window.CPController && typeof window.CPController.calculateGroundbed === 'function') window.CPController.calculateGroundbed(editId || null);
            });
        }
        getDomElement('gbCreateNewBtn')?.addEventListener('click', () => { openGroundbedForm(null); });
        getDomElement('gbFormCancelBtn')?.addEventListener('click', () => { getDomElement('gbFormCard').style.display = 'none'; });
        getDomElement('iccpGroundbedSelector')?.addEventListener('change', function() {
            const sysId = ProjectManager.getCurrentSystemId();
            if (sysId) {
                const sys = ProjectManager.getSystem(sysId);
                if (sys && sys.type === 'iccp') {
                    sys.groundbedId = this.value || null;
                    ProjectManager.saveCurrentProject();
                    showToast('Puits associé au système actif', 'success');
                    renderSystems();
                }
            }
        });
        getDomElement('iccpCreateGroundbedBtn')?.addEventListener('click', () => {
            getDomElement('gbCreateNewBtn').click();
            document.querySelector('.nav-item[data-module="groundbed"]')?.click();
        });
        getDomElement('iccpRefreshGroundbedBtn')?.addEventListener('click', () => {
            populateICCPGroundbedSelectors();
            showToast('Sélecteur de puits actualisé', 'info');
        });

        if (typeof CoordSystem !== 'undefined') {
            const projectId = ProjectManager.getCurrentProjectId();
            if (projectId) {
                const state = ProjectManager.getState();
                const equipments = state.equipments.filter(eq => eq.projectId === projectId);
                const firstWithCoords = equipments.find(eq => eq.coordinates);
                if (firstWithCoords) {
                    const coords = firstWithCoords.coordinates;
                    let lat, lon, alt = 0;
                    if (Array.isArray(coords) && coords.length > 0) {
                        lat = coords[0].lat;
                        lon = coords[0].lon;
                        alt = coords[0].alt || 0;
                    } else if (coords.lat !== undefined) {
                        lat = coords.lat;
                        lon = coords.lon;
                        alt = coords.alt || 0;
                    }
                    if (CoordSystem.isValid(lat, lon, alt)) {
                        CoordSystem.setReference(lat, lon, alt);
                    }
                }
            }
        }

        if (!_defaultsApplied) {
            applyIlliziDefaults();
            _defaultsApplied = true;
        }
        ensureAnodeDefaults();

        // ---- Restauration automatique de la dernière session ----
        // Décalé de 400ms pour laisser le DOM et les sélecteurs se stabiliser
        setTimeout(() => autoRestoreLastSession(), 400);


                console.log('UI initialisée avec succès (' +
                    (typeof APP_CONFIG !== 'undefined' ? APP_CONFIG.VERSION : '9.6.0') + ').');
    }

    // ============================================================
    // refreshMapPointsTable
    // ============================================================
    function refreshMapPointsTable() {
        let refreshTimeout = null;

        if (refreshTimeout) {
            clearTimeout(refreshTimeout);
            refreshTimeout = null;
        }
        refreshTimeout = setTimeout(async () => {
            const tbody = document.getElementById('mapPointsTableBody');
            if (!tbody) {
                refreshTimeout = null;
                return;
            }

            const filterProjectId = FilterManager.getFilter('projectId');
            const isAllProjects = (filterProjectId === null || filterProjectId === undefined || filterProjectId === '__all__');

            let equipments = [];

            if (isAllProjects) {
                const projects = ProjectManager.getProjectsList();
                const loadPromises = projects.map(async (project) => {
                    try {
                        return await StorageManager.loadEquipmentsForProject(project.id, true);
                    } catch (err) {
                        console.warn(`[UI] Erreur chargement projet ${project.id}:`, err);
                        return [];
                    }
                });
                const results = await Promise.all(loadPromises);
                equipments = results.flat();
                console.log(`[UI] Tableau: ${equipments.length} équipements chargés depuis IndexedDB (tous projets)`);
            } else {
                const state = ProjectManager.getState();
                equipments = state.equipments.filter(eq => eq.projectId === filterProjectId);
            }

            const withCoords = equipments.filter(eq => {
                const coords = getEquipmentCoordinates(eq);
                if (!coords) return false;
                if (Array.isArray(coords)) {
                    return coords.length > 0 && coords.every(c => isValidCoord(c.lat, c.lon) && !isZeroCoord(c.lat, c.lon));
                }
                return isValidCoord(coords.lat, coords.lon) && !isZeroCoord(coords.lat, coords.lon);
            });

            const filtered = FilterManager.apply(withCoords);

            tbody.innerHTML = '';
            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7">Aucun équipement géoréférencé correspondant aux filtres.</td></tr>';
                refreshTimeout = null;
                return;
            }

            const fragment = document.createDocumentFragment();
            filtered.forEach(eq => {
                const coords = getEquipmentCoordinates(eq);
                let latStr = '', lonStr = '', altStr = '';
                let coordDisplay = '';
                const projectColor = getProjectColor(eq.projectId);

                if (Array.isArray(coords) && coords.length > 1) {
                    const first = coords[0];
                    const last = coords[coords.length - 1];
                    latStr = `${formatCoord(first.lat)} → ${formatCoord(last.lat)}`;
                    lonStr = `${formatCoord(first.lon)} → ${formatCoord(last.lon)}`;
                    altStr = `${formatCoord(first.alt, 1)} → ${formatCoord(last.alt, 1)}`;
                    coordDisplay = `<span style="color:${projectColor};" title="Tracé de ${coords.length} points">${Utils.escapeHtml(latStr)} / ${Utils.escapeHtml(lonStr)}</span>`;
                } else if (Array.isArray(coords) && coords.length === 1) {
                    const p = coords[0];
                    latStr = formatCoord(p.lat);
                    lonStr = formatCoord(p.lon);
                    altStr = formatCoord(p.alt, 1);
                    coordDisplay = `<span style="color:${projectColor};">${latStr}, ${lonStr}</span>`;
                } else if (coords && coords.lat !== undefined) {
                    latStr = formatCoord(coords.lat);
                    lonStr = formatCoord(coords.lon);
                    altStr = formatCoord(coords.alt, 1);
                    coordDisplay = `<span style="color:${projectColor};">${latStr}, ${lonStr}</span>`;
                } else {
                    coordDisplay = '—';
                }

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><span style="color:${projectColor}; font-weight:600;">${Utils.escapeHtml(eq.tag)}</span></td>
                    <td>${Utils.escapeHtml(eq.type)}</td>
                    <td><span style="color:${projectColor}; font-weight:600;">${Utils.escapeHtml(eq.projectId)}</span></td>
                    <td>${coordDisplay}</td>
                    <td style="font-size:0.7rem; color:var(--text-muted);">${Array.isArray(coords) && coords.length > 1 ? '🔹 ' + coords.length + ' points' : 'Point unique'}</td>
                    <td>${altStr}</td>
                    <td>
                        <button class="btn btn-sm btn-info edit-equip-point" data-id="${eq.id}">Modifier</button>
                        <button class="btn btn-sm btn-danger delete-equip-point" data-id="${eq.id}">Supprimer</button>
                    </td>
                `;
                fragment.appendChild(tr);
            });
            tbody.appendChild(fragment);

            tbody.querySelectorAll('.edit-equip-point').forEach(btn => {
                btn.addEventListener('click', function() {
                    const id = this.dataset.id;
                    if (window.UI && typeof window.UI.editEquipment === 'function') {
                        window.UI.editEquipment(id);
                        document.querySelector('.nav-item[data-module="equipements"]')?.click();
                    }
                });
            });
            tbody.querySelectorAll('.delete-equip-point').forEach(btn => {
                btn.addEventListener('click', function() {
                    if (confirm('Supprimer cet équipement ?')) {
                        const id = this.dataset.id;
                        removePoint(id);
                    }
                });
            });
            refreshTimeout = null;
        }, 200);
    }

    // Helpers locaux pour refreshMapPointsTable
    function getEquipmentCoordinates(eq) {
        if (typeof window.getEquipmentCoordinates === 'function') {
            return window.getEquipmentCoordinates(eq);
        }
        if (!eq || !eq.coordinates) return null;
        if (Array.isArray(eq.coordinates)) return eq.coordinates;
        if (eq.coordinates.lat !== undefined) return [eq.coordinates];
        return null;
    }

    function isValidCoord(lat, lon) {
        if (typeof window.isValidCoord === 'function') return window.isValidCoord(lat, lon);
        return typeof lat === 'number' && typeof lon === 'number' && !isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    function isZeroCoord(lat, lon) {
        if (typeof window.isZeroCoord === 'function') return window.isZeroCoord(lat, lon);
        return Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9;
    }

    function formatCoord(val, decimals) {
        if (typeof window.formatCoord === 'function') return window.formatCoord(val, decimals);
        if (val === undefined || val === null || isNaN(val)) return '?';
        return Number(val).toFixed(decimals || 6);
    }

    function getProjectColor(projectId) {
        if (typeof window.getProjectColor === 'function') return window.getProjectColor(projectId);
        return '#94a3b8';
    }

    function removePoint(pointId) {
        if (typeof window.removePoint === 'function') return window.removePoint(pointId);
    }

    // ============================================================
    // renderEquipmentListFor3D
    // ============================================================
    function renderEquipmentListFor3D(projectId, containerId, countId) {
        const container = document.getElementById(containerId);
        const countEl = document.getElementById(countId);
        if (!container) {
            console.warn('[UI] Conteneur non trouvé:', containerId);
            return;
        }

        let equipments = [];
        const state = ProjectManager.getState();

        if (projectId === 'all') {
            const projects = ProjectManager.getProjectsList();
            projects.forEach(p => {
                const projEquips = state.equipments.filter(eq => eq.projectId === p.id && eq.included !== false);
                equipments = equipments.concat(projEquips);
            });
            if (countEl) countEl.textContent = equipments.length;
        } else {
            equipments = state.equipments.filter(eq => eq.projectId === projectId && eq.included !== false);
            if (countEl) countEl.textContent = equipments.length;
        }

        if (equipments.length === 0) {
            container.innerHTML = `<div class="info-message" style="padding:10px; color:var(--text-muted);">Aucun équipement trouvé pour ce projet.</div>`;
            return;
        }

        let html = `<table style="width:100%; border-collapse:collapse; font-size:12px;">
                        <thead>
                            <tr>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Tag</th>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Type</th>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Surface (m²)</th>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Statut</th>
                                <th style="text-align:left; padding:6px 4px 6px 0; font-weight:500; color:#6e8fad; border-bottom:1px solid #1f3345; font-size:11px;">Coordonnées GPS</th>
                            </tr>
                        </thead>
                        <tbody>`;

        equipments.forEach(eq => {
            let status = 'OK';
            if (eq.type === 'rectifier' && eq.status === 'OFF') {
                status = 'OFF';
            }
            const statusBadge = status === 'OK' ?
                `<span style="background:#1a3347; color:#d6e6f5; padding:2px 10px; border-radius:30px; font-size:10px; font-weight:600; display:inline-block;"><i class="fas fa-check-circle" style="color:#4db87d;"></i> ${status}</span>` :
                `<span style="background:#361f1f; color:#f7a6a6; padding:2px 10px; border-radius:30px; font-size:10px; font-weight:600; display:inline-block;"><i class="fas fa-times-circle"></i> ${status}</span>`;

            let coordsDisplay = '';
            const coords = eq.coordinates;
            if (coords) {
                if (Array.isArray(coords) && coords.length > 1) {
                    const first = coords[0];
                    const last = coords[coords.length - 1];
                    coordsDisplay = `<i class="fas fa-map-pin" style="margin-right:3px; color:#e2b34b; font-size:10px;"></i> ${first.lat.toFixed(6)}°N, ${first.lon.toFixed(6)}°E → ${last.lat.toFixed(6)}°N, ${last.lon.toFixed(6)}°E`;
                } else {
                    const p = Array.isArray(coords) ? coords[0] : coords;
                    coordsDisplay = `<i class="fas fa-map-pin" style="margin-right:3px; color:#e2b34b; font-size:10px;"></i> ${p.lat.toFixed(6)}°N, ${p.lon.toFixed(6)}°E`;
                }
            } else {
                coordsDisplay = '—';
            }

            let projectColor = '#a78bfa';
            if (eq.projectId === 'PROJ-001') projectColor = '#00A3E0';
            else if (eq.projectId === 'PROJ-002') projectColor = '#FF6B00';

            html += `<tr>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0;"><span style="color:${projectColor}; font-weight:600;">${Utils.escapeHtml(eq.tag)}</span></td>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0;">${Utils.escapeHtml(eq.type)}</td>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0;">${Utils.safeNumber(eq.surface, 0).toFixed(1)}</td>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0;">${statusBadge}</td>
                        <td style="padding:6px 4px 6px 0; border-bottom:1px solid #1a2c3b; color:#cedff0; font-family:monospace; font-size:11px; color:#80a9cc;">${coordsDisplay}</td>
                    </tr>`;
        });

        html += `</tbody></table>`;
        container.innerHTML = html;
    }

    // ============================================================
    // Import Excel + validation GPS
    // ============================================================
    function validateCoordinateRange(points) {
        const validPoints = [];
        points.forEach(p => {
            const lat = parseFloat(p.lat);
            const lon = parseFloat(p.lon);
            const alt = p.alt ? parseFloat(p.alt) : null;
            if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                validPoints.push({ lat, lon, alt: (alt !== null && !isNaN(alt)) ? alt : null });
            }
        });
        return validPoints;
    }

    function parseExcelRows(jsonData) {
        const headers = Object.keys(jsonData[0] || {});
        let latHeader = null, lonHeader = null, altHeader = null;

        headers.forEach(header => {
            const h = header.toLowerCase().replace(/\(.*\)/g, '').trim();
            if (h === 'latitude' || h === 'lat') latHeader = header;
            if (h === 'longitude' || h === 'lon' || h === 'lng') lonHeader = header;
            if (h === 'altitude' || h === 'alt' || h === 'elevation') altHeader = header;
        });

        if (!latHeader || !lonHeader) {
            throw new Error("Impossible de trouver les colonnes Latitude et Longitude dans le fichier. Vérifiez les en-têtes.");
        }

        const points = [];
        jsonData.forEach(row => {
            const lat = parseFloat(row[latHeader]);
            const lon = parseFloat(row[lonHeader]);
            const alt = altHeader ? parseFloat(row[altHeader]) : null;
            points.push({ lat, lon, alt });
        });

        return validateCoordinateRange(points);
    }

    function populateWaypointsFromArray(points) {
        if (!points || points.length === 0) {
            showToast("Aucun point valide trouvé dans le fichier.", "warning");
            return;
        }
        const container = getDomElement('equipWaypointsContainer');
        if (!container) return;

        container.innerHTML = '';
        points.forEach((p, idx) => {
            addEquipWaypointRow(p.lat, p.lon, p.alt, idx > 0);
        });
        updateEquipRemoveButtons();

        computeEquipSurface();

        const autoLength = autoComputeBuriedPipelineLength(true, true);

        if (autoLength && autoLength > 0) {
            showToast(
                `✅ ${points.length} points importés — Longueur pipeline : ${autoLength.toFixed(1)} m`,
                "success"
            );
        } else {
            showToast(`✅ ${points.length} points GPS importés avec succès.`, "success");
        }
    }

    function handleGpsExcelImport(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet);

                if (jsonData.length === 0) {
                    showToast("Le fichier est vide ou ne contient pas de données.", "warning");
                    return;
                }

                const points = parseExcelRows(jsonData);
                if (points.length === 0) {
                    showToast("Aucun point GPS valide n'a été trouvé dans le fichier.", "error");
                    return;
                }

                populateWaypointsFromArray(points);
            } catch (err) {
                console.error("Erreur lors de l'import Excel :", err);
                showToast("❌ Erreur : " + err.message, "error");
            }
        };

        reader.onerror = function() {
            showToast("❌ Erreur lors de la lecture du fichier.", "error");
        };

        reader.readAsArrayBuffer(file);
        event.target.value = '';
    }

    // ============================================================
    // API PUBLIQUE
    // ============================================================
    return {
        init,
        renderSystems,
        populateAllSystemSelectors,
        refreshEquipmentList,
        refreshEquipmentListUI,
        refreshFieldMeasurementsTable,
        refreshAssetDropdownForFieldMeas,
        updateCorrosivity,
        populateProjectSelector,
        // Navigation inter-modules (deep-link /studio#<module> + router URL)
        switchModule,
        populateGroundbedProjectSelect,
        populateInterferenceProjectSelect,
        populatePipelineSelects,
        refreshHistoryTable,
        loadHistory,
        drawGroundbedVisual,
        updateEquipTypeOptions,
        updateEquipDimensionsFields,
        computeEquipSurface,
        updateDimensionsFields,
        autoFillFromEnvironment,
        initDashboardCharts,
        setModulesActivation,
        populateSystemDropdown,
        populateGroundbedEquipmentList,
        updateGroundbedTargetCurrent,
        populateCPEquipmentSelector,
        loadInterferenceFromEquipment,
        populateTestPostsSelectors,
        setupTestPostsForm,
        loadSystemParamsToModule,
        setupCartography,
        setupReinforcementZones,
        renderReinforcementZones,
        renderGroundbedList,
        populateICCPGroundbedSelectors,
        openGroundbedForm,
        suggestStandards,

        populateVis3dSystemSelector,
        refreshMapPointsTable,
        getDomElement,
        getFieldValue,
        propagateField,
        updateSyncBadges,
        toggleSharedLock,
        updateDerivedFields,
        validateSystem,
        showToast,
        setFieldSource,
        toggleLink,
        toggleGndLink,
        toggleIfLink,
        updateSaveStatus,
        applyIlliziDefaults,
        ensureAnodeDefaults,
        loadProjectParams,
        refreshEquipmentProjectDropdown,
        refreshEquipmentListInCP,

        updateAnodeCurrentSource,
        updateICCPCurrentSource,
        syncGroundbedFromCP,
        syncInterferenceFromCP,

        calculateEquipmentCP,
        generateTestPosts: generatePostsCorrected,

        calculateCableSection,
        tryAutoComputeCableLength,
        applyCableToICCP,
        linkCableCurrentToICCP,

        // v9.3 : méthode intégrée depuis iccp-cable-sync-patch v1.1
        syncCableCurrentFromICCP: syncCableCurrentFromICCP,
        syncCableLengthFromICCP: syncCableLengthFromICCP,

        displayICCPResults,
        displayRectifierResults,

        displayCPResults,

        displayAnodeResults,
        displayInterferenceResults,
        displayGroundbedResults,

        populateResistiveParams,
        applyResistiveModel,

        generateWaterFromEnvironment,

        autoDetectZones,

        exportPostsPDF,
        exportPostsCSV,

        generateSoilFromResistivity,

        syncAllEquipmentToGIS,
        syncAllEquipmentTo3D,
        syncEquipmentToGIS,
        syncEquipmentTo3D,

        addHelpTooltips,

        performValidation: function() {
            return this.validateSystem();
        },

        updateDashboardKPIs: updateDashboardKPIs,

        updateDashboard: function() {
            // 1. Graphiques (Chart.js)
            if (typeof this.updateDashboardChartsData === 'function') {
                this.updateDashboardChartsData();
            }

            // 2. KPIs DOM
            if (typeof updateDashboardKPIs === 'function') {
                updateDashboardKPIs();
            }

            // 3. Cartes systèmes
            if (typeof this.renderSystems === 'function') {
                this.renderSystems();
            }

            // 4. Surface synchronisée
            if (window.CPController && typeof window.CPController.syncSurfaceFromEquipments === 'function') {
                window.CPController.syncSurfaceFromEquipments();
            }
        },

        checkConsistency: function() {
            if (typeof this.validateSystem === 'function') this.validateSystem();
            const cpCurr = ProjectManager.getState().cp.current || 0;
            const anodeCurr = parseFloat(document.getElementById('anodeCurrentReq')?.value) || 0;
            if (cpCurr > 0 && anodeCurr > 0) {
                const ratio = cpCurr / anodeCurr;
                const badge = document.getElementById('consistencyBadge');
                if (badge) {
                    if (ratio > 0.95 && ratio < 1.05) {
                        badge.className = 'badge success';
                        badge.innerText = '✅ Cohérent';
                    } else {
                        badge.className = 'badge warning';
                        badge.innerText = '⚠️ Écart ' + (ratio * 100).toFixed(0) + '%';
                    }
                }
            }
        },

        applyEquipmentTotalToCP: function() {
            const total = window.CPController?.getTotalEquipmentCurrent ? window.CPController.getTotalEquipmentCurrent() : 0;
            if (total > 0) {
                const resCurrent = document.getElementById('resCurrent');
                if (resCurrent) resCurrent.innerText = total.toFixed(3);
                ProjectManager.getState().cp.current = total;
                ProjectManager.saveCurrentProject();
                this.showToast(`Courant cumulé (${total.toFixed(3)} A) appliqué au CP`, 'success');
            } else {
                this.showToast('Aucun courant cumulé disponible (calculez d\'abord les équipements)', 'warning');
            }
        },

        exportGlobalReport,
        exportGroundbedPDF,
        exportInterferencePDF,

        // ============================================================
        // Figure 1 = courant système (priorité ICCP > CP > équipements)
        // ============================================================
        updateDashboardChartsData: function() {
            if (typeof Chart === 'undefined') return;
            const state = ProjectManager.getState();
            const projectId = ProjectManager.getCurrentProjectId();
            const systems = ProjectManager.getSystems();
            const activeSystem = ProjectManager.getActiveSystem();

            if (window.dashboardChart1) {
                window.dashboardChart1.data.labels = systems.map(s => s.name);
                window.dashboardChart1.data.datasets[0].data = systems.map(s => {
                    // Priorité 1 : courant ICCP du système
                    if (s.results &&
                        s.results.iccp &&
                        typeof s.results.iccp.current === 'number' &&
                        isFinite(s.results.iccp.current) &&
                        s.results.iccp.current > 0) {
                        return s.results.iccp.current;
                    }
                    // Priorité 2 : courant CP du système
                    if (s.results &&
                        s.results.cp &&
                        typeof s.results.cp.current === 'number' &&
                        isFinite(s.results.cp.current) &&
                        s.results.cp.current > 0) {
                        return s.results.cp.current;
                    }
                    // Priorité 3 : fallback = somme des équipements calculés
                    return ProjectManager.getSystemTotalCurrent(s.id);
                });
                window.dashboardChart1.update();
            }

            if (window.dashboardChart2 && activeSystem) {
                const results = ProjectManager.loadSystemResults(activeSystem.id, 'anodes') || {};
                const life = results.actualLife || 0;
                const remaining = Math.max(0, 20 - life);
                window.dashboardChart2.data.datasets[0].data = [life, remaining];
                window.dashboardChart2.update();
            }

            if (window.dashboardChart3) {
                const measurements = state.fieldMeasurements.filter(m => m.projectId === projectId);
                window.dashboardChart3.data.labels = measurements.map(m => m.date);
                window.dashboardChart3.data.datasets[0].data = measurements.map(m => m.potOFF);
                window.dashboardChart3.update();
            }

            if (window.dashboardChart4) {
                if (!window.dashboardChart4.data.labels) {
                    window.dashboardChart4.data.labels = [];
                }
                const cpCurrent = (state.cp && state.cp.current) || 0;
                const now = new Date().toLocaleTimeString('fr-FR', {
                    hour: '2-digit', minute: '2-digit'
                });

                window.dashboardChart4.data.labels.push(now);
                window.dashboardChart4.data.datasets[0].data.push(cpCurrent);

                if (window.dashboardChart4.data.labels.length > 20) {
                    window.dashboardChart4.data.labels.shift();
                    window.dashboardChart4.data.datasets[0].data.shift();
                }
                window.dashboardChart4.update();
            }
        },

        updatePotentialChart: function() {
            this.updateDashboardChartsData();
        },

        emitDataSynced: function(fromSave) {
            const detail = { timestamp: Date.now() };
            if (fromSave === true) {
                detail._fromSave = true;
            }
            document.dispatchEvent(new CustomEvent('dataSynced', {
                detail: detail
            }));
        },

        // ============================================================
        // NOUVELLES MÉTHODES POUR LA VISUALISATION 3D
        // ============================================================
        populateVis3dSystemSelector: populateVis3dSystemSelector,
        renderEquipmentListFor3D: renderEquipmentListFor3D,
        renderDynamicEquipmentList: renderDynamicEquipmentList,

        // API DOM cache centralisée (ROLE.txt §18)
        invalidateDomElements: invalidateDomElements,
        invalidateDomCacheContainer: invalidateDomCacheContainer,
        clearDomCache: clearDomCache,

        show3DLoading: show3DLoading,
        hide3DLoading: hide3DLoading,

        // ============================================================
        // v9.3 : méthodes Test Posts exposées
        // ============================================================
        refreshPipelinesAndLength: refreshPipelinesAndLength,

        RHO_CU: RHO_CU
    };
})();

window.UI = UI;

// ============================================================
// v9.3 : Exposition automatique des méthodes UI sur window
// ============================================================
(function() {
    if (!window.UI) {
        console.error('[UI] ❌ window.UI non défini — impossible d\'exposer les méthodes.');
        return;
    }

    const EXCLUDED_KEYS = new Set([
        'init', 'state', 'length', 'name', 'prototype', 'constructor',
        'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
        'propertyIsEnumerable', 'toLocaleString', '__proto__'
    ]);

    let count = 0;
    const exposed = [];
    const skipped = [];

    Object.keys(window.UI).forEach(function(key) {
        if (EXCLUDED_KEYS.has(key)) {
            skipped.push(key);
            return;
        }

        if (typeof window[key] !== 'undefined') {
            if (window[key] === window.UI[key]) {
                return;
            }
            skipped.push(key);
            return;
        }

        const val = window.UI[key];
        if (typeof val === 'function' || (val !== null && typeof val === 'object')) {
            window[key] = val;
            count++;
            exposed.push(key);
        }
    });

    console.log('[UI] ✅ ' + count + ' méthodes exposées automatiquement au scope global.');
    console.log('[UI]    Exposées : ' + exposed.slice(0, 20).join(', ') + (exposed.length > 20 ? ', ... (+' + (exposed.length - 20) + ')' : ''));

    const CRITICAL = ['ensureAnodeDefaults', 'loadProjectParams',
                      'refreshEquipmentProjectDropdown', 'refreshEquipmentListInCP',
                      'syncCableCurrentFromICCP', 'syncCableLengthFromICCP'];
    CRITICAL.forEach(function(fn) {
        if (typeof window[fn] !== 'function') {
            console.warn('[UI] ⚠️  Fonction critique manquante dans UI : ' + fn);
        }
    });
})();