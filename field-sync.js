// ============================================================
// field-sync.js — CP Engineer Pro v9.x
// ============================================================
// Synchronisation AUTOMATIQUE des champs de saisie partageant la
// même information à travers tous les modules.
//
// Audit (index.html — 238 champs / 12 modules) : les groupes
// ci-dessous regroupent les champs redondants (mêmes unités, même
// signification physique). Toute saisie — utilisateur OU chargement
// de système — est répercutée automatiquement sur les autres
// champs du groupe afin d'éviter toute saisie multiple, en
// préservant :
//   - les valeurs, les calculs et l'architecture existants ;
//   - les paires select + champ manuel (conventions de l'app :
//     option numérique si présente → sinon option 'manual' +
//     champ manuel → sinon option '(calculé)', identique à
//     setSelectValue() / applyCableSection de ui.js) ;
//   - les boutons 🔗 et verrous de paramètres partagés existants ;
//   - la source de vérité projet (state.project.shared) : la
//     résistivité du sol saisie alimente KPI + optimisation ICCP.
//
// Exclusions volontaires (données distinctes malgré une apparence
// similaire) : diamètres d'anodes (m vs mm), densités de courant
// SACP vs ICCP, potentiel libre vs potentiel cible, nombres
// d'anodes par puits, résistivité par équipement (périmètre
// équipement), couches de sol (gbSoilLayers), grandeurs calculées
// (résultats) et sélecteurs système/projet (déjà centralisés).
// ============================================================
(function () {
    'use strict';

    // --------------------------------------------------------
    // GROUPES — champs logiques synchronisés (audit)
    // --------------------------------------------------------
    // Un champ logique = { select, manual } (paire select/manuel)
    //                  | { input }          (champ simple)
    const GROUPS = {
        // Résistivité du sol (Ω·m) — 6 modules
        soilResistivity: {
            label: 'Résistivité du sol (Ω·m)',
            fields: [
                { select: 'cpResistivitySelect', manual: 'cpResistivityManual' },
                { select: 'iccpResistivitySelect', manual: 'iccpResistivityManual' },
                { select: 'gbSoilResistivity', manual: 'gbSoilResistivityManual' },
                { select: 'anodeSoilResistivity', manual: 'anodeSoilResistivityManual' },
                { select: 'ifDCSoilResistivity', manual: 'ifDCSoilResistivityManual' },
                { select: 'envSoilResistivity', manual: 'envSoilResistivityManual' }
            ]
        },
        // Surface protégée (m²) — champs autocalculés en lecture seule
        protectedSurface: {
            label: 'Surface protégée (m²)',
            fields: [
                { input: 'cpSurface' },
                { input: 'iccpSurface' }
            ]
        },
        // Facteur de vieillissement (k) — sans dimension
        agingFactor: {
            label: 'Facteur de vieillissement (k)',
            fields: [
                { select: 'agingFactor', manual: 'agingFactorManual' },
                { select: 'agingFactorResistive', manual: 'agingFactorResistiveManual' },
                { select: 'iccpAgingFactor', manual: 'iccpAgingFactorManual' },
                { select: 'gbAgingFactor', manual: 'gbAgingFactorManual' }
            ]
        },
        // Densité de défaut (DF) — modèle classique vs résistif
        defectDensity: {
            label: 'Densité de défaut (DF)',
            fields: [
                { select: 'defectDensity', manual: 'defectDensityManual' },
                { select: 'defectDensityResistive', manual: 'defectDensityResistiveManual' }
            ]
        },
        // Potentiel cible de protection (mV vs Cu/CuSO4)
        targetPotential: {
            label: 'Potentiel cible (mV)',
            fields: [
                { select: 'targetPotential', manual: 'targetPotentialManual' },
                { select: 'targetPotentialResistive', manual: 'targetPotentialResistiveManual' }
            ]
        },
        // Facteur de sécurité (ratio, ex. 1.10 = 10 %)
        safetyFactor: {
            label: 'Facteur de sécurité',
            fields: [
                { select: 'safetyFactor', manual: 'safetyFactorManual' },
                { select: 'gbSafetyFactor', manual: 'gbSafetyFactorManual' }
            ]
        },
        // Longueur de câble (m) — CP, groundbed et boucle DC ICCP
        cableLength: {
            label: 'Longueur câble (m)',
            fields: [
                { select: 'cableLength', manual: 'cableLengthManual' },
                { select: 'gbCableLength', manual: 'gbCableLengthManual' },
                { input: 'cableLengthDC' }
            ]
        },
        // Section de câble (mm²)
        cableSection: {
            label: 'Section câble (mm²)',
            fields: [
                { select: 'cableSection', manual: 'cableSectionManual' },
                { select: 'gbCableSection', manual: 'gbCableSectionManual' }
            ]
        },
        // Longueur d'anode sacrificielle (m) — module anodes + puits
        anodeLength: {
            label: "Longueur d'anode (m)",
            fields: [
                { select: 'anodeLengthSelect', manual: 'anodeLengthManual' },
                { select: 'gbAnodeLength', manual: 'gbAnodeLengthManual' }
            ]
        }
    };

    // --------------------------------------------------------
    // MODULE_OWNERS — champ de référence par module et par
    // groupe (réconciliation après chargement d'un système :
    // le module chargé fait foi pour les valeurs modifiées).
    // --------------------------------------------------------
    const MODULE_OWNERS = {
        'cp-calc': {
            soilResistivity: 'cpResistivitySelect',
            protectedSurface: 'cpSurface',
            agingFactor: 'agingFactor',
            defectDensity: 'defectDensity',
            targetPotential: 'targetPotential',
            cableLength: 'cableLength',
            cableSection: 'cableSection',
            anodeLength: 'anodeLengthSelect'
        },
        'anodes': {
            soilResistivity: 'anodeSoilResistivity',
            safetyFactor: 'safetyFactor',
            anodeLength: 'anodeLengthSelect'
        },
        'iccp': {
            soilResistivity: 'iccpResistivitySelect',
            protectedSurface: 'iccpSurface',
            agingFactor: 'iccpAgingFactor',
            cableLength: 'cableLengthDC'
        },
        'groundbed': {
            soilResistivity: 'gbSoilResistivity',
            agingFactor: 'gbAgingFactor',
            safetyFactor: 'gbSafetyFactor',
            cableLength: 'gbCableLength',
            cableSection: 'gbCableSection',
            anodeLength: 'gbAnodeLength'
        },
        'interference': {
            soilResistivity: 'ifDCSoilResistivity'
        }
    };

    // Index inverse : id DOM → { key, index }
    const ID_INDEX = {};
    Object.keys(GROUPS).forEach(function (key) {
        GROUPS[key].fields.forEach(function (field, index) {
            ['select', 'manual', 'input'].forEach(function (role) {
                if (field[role]) ID_INDEX[field[role]] = { key: key, index: index };
            });
        });
    });

    let _propagating = false;
    let _initialized = false;

    // --------------------------------------------------------
    // Utilitaires
    // --------------------------------------------------------
    function num(value) {
        if (value === null || value === undefined) return NaN;
        const s = String(value).trim().replace(',', '.');
        if (s === '' || s === 'manual') return NaN;
        return parseFloat(s);
    }

    function sameValue(a, b) {
        const na = num(a);
        const nb = num(b);
        if (!isNaN(na) && !isNaN(nb)) {
            return Math.abs(na - nb) <= 0.001;
        }
        return String(a).trim() === String(b).trim();
    }

    function isEmpty(value) {
        return value === null || value === undefined || String(value).trim() === '';
    }

    function el(id) {
        return document.getElementById(id);
    }

    // --------------------------------------------------------
    // Lecture / écriture d'un champ logique
    // --------------------------------------------------------
    function readField(field) {
        if (field.select) {
            const sel = el(field.select);
            if (!sel) return '';
            if (sel.value === 'manual' && field.manual) {
                const man = el(field.manual);
                return man ? man.value : '';
            }
            return sel.value;
        }
        const inp = el(field.input);
        return inp ? inp.value : '';
    }

    function findNumericOption(sel, value) {
        const n = num(value);
        if (isNaN(n)) return null;
        for (let i = 0; i < sel.options.length; i++) {
            const ov = num(sel.options[i].value);
            if (!isNaN(ov) && Math.abs(ov - n) <= 0.001) return sel.options[i];
        }
        return null;
    }

    function writeField(field, value) {
        if (isEmpty(value)) return;

        if (field.select) {
            const sel = el(field.select);
            if (!sel) return;

            // En mode manuel : mettre à jour le champ manuel seul
            // (la valeur se synchronise, le mode de saisie est préservé).
            if (sel.value === 'manual') {
                if (field.manual) {
                    const man = el(field.manual);
                    if (man && !sameValue(man.value, value)) {
                        man.value = value;
                        man.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
                return;
            }

            // 1) Option numérique correspondante → on l'utilise.
            const opt = findNumericOption(sel, value);
            if (opt) {
                if (sel.value !== opt.value) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                }
                return;
            }

            // 2) Option 'manual' disponible → bascule en manuel.
            const manualOpt = Array.prototype.find.call(
                sel.options, function (o) { return o.value === 'manual'; }
            );
            if (manualOpt && field.manual) {
                const man = el(field.manual);
                sel.value = 'manual';
                if (man) {
                    if (!sameValue(man.value, value)) man.value = value;
                    man.dispatchEvent(new Event('input', { bubbles: true }));
                }
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }

            // 3) Repli : option '(calculé)' — convention setSelectValue().
            const n = num(value);
            const newOpt = document.createElement('option');
            newOpt.value = isNaN(n) ? String(value) : String(n);
            newOpt.textContent = (isNaN(n) ? String(value) : String(n)) + ' (calculé)';
            sel.appendChild(newOpt);
            sel.value = newOpt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }

        // Champ simple (input)
        const inp = el(field.input);
        if (!inp || sameValue(inp.value, value)) return;
        inp.value = value;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // --------------------------------------------------------
    // Propagation dans un groupe
    // --------------------------------------------------------
    function propagateGroup(key, sourceIndex, value) {
        const group = GROUPS[key];
        if (!group || isEmpty(value)) return 0;
        let touched = 0;
        group.fields.forEach(function (field, index) {
            if (index === sourceIndex) return;
            const before = readField(field);
            writeField(field, value);
            if (!sameValue(before, value)) touched++;
        });
        return touched;
    }

    // --------------------------------------------------------
    // Pont vers la source de vérité projet (cohérence calculs)
    // --------------------------------------------------------
    function bridgeState(key, value, save) {
        try {
            if (!window.ProjectManager || typeof window.ProjectManager.getState !== 'function') return;
            const state = window.ProjectManager.getState();
            if (!state || !state.project) return;
            const n = num(value);
            if (isNaN(n)) return;

            if (key === 'soilResistivity') {
                if (n <= 0) return;
                state.project.resistivity = n;
                if (!state.project.shared) state.project.shared = {};
                state.project.shared.soilResistivity = n;
            } else if (key === 'protectedSurface') {
                if (n < 0) return;
                state.project.surface = n;
            } else {
                return;
            }
            if (save && typeof window.ProjectManager.saveCurrentProject === 'function') {
                window.ProjectManager.saveCurrentProject();
            }
        } catch (e) { /* silencieux : la synchronisation DOM reste active */ }
    }

    // --------------------------------------------------------
    // Handler d'événements délégués (input / change)
    // --------------------------------------------------------
    function onFieldEvent(event) {
        if (_propagating) return;
        const target = event && event.target;
        if (!target || !target.id) return;
        const loc = ID_INDEX[target.id];
        if (!loc) return;
        const group = GROUPS[loc.key];
        const value = readField(group.fields[loc.index]);
        if (isEmpty(value)) return; // jamais de propagation d'une valeur vide

        _propagating = true;
        try {
            propagateGroup(loc.key, loc.index, value);
            bridgeState(loc.key, value, event.type === 'change');
        } finally {
            _propagating = false;
        }
    }

    // --------------------------------------------------------
    // API publique
    // --------------------------------------------------------
    function resolveOwners(moduleId) {
        if (!moduleId) return null;
        if (moduleId === 'cp') moduleId = 'cp-calc';
        return MODULE_OWNERS[moduleId] || null;
    }

    function findFieldIndex(key, fieldId) {
        const group = GROUPS[key];
        if (!group) return -1;
        for (let i = 0; i < group.fields.length; i++) {
            const f = group.fields[i];
            if (f.select === fieldId || f.manual === fieldId || f.input === fieldId) return i;
        }
        return -1;
    }

    /**
     * Instantané des valeurs actuelles des champs de référence du
     * module. Appelé au DÉBUT de loadSystemParamsToModule() pour ne
     * répercuter à la fin que les valeurs réellement modifiées.
     */
    function snapshotModuleFields(moduleId) {
        const owners = resolveOwners(moduleId);
        const snapshot = {};
        if (!owners) return snapshot;
        Object.keys(owners).forEach(function (key) {
            const idx = findFieldIndex(key, owners[key]);
            if (idx < 0) return;
            snapshot[key] = readField(GROUPS[key].fields[idx]);
        });
        return snapshot;
    }

    /**
     * Réconciliation post-chargement : le module chargé fait foi pour
     * ses groupes ; seules les valeurs ayant CHANGÉ depuis l'instantané
     * sont répercutées vers les autres modules.
     * @param {string} moduleId
     * @param {Object|null} snapshot - renvoyé par snapshotModuleFields()
     * @returns {string[]} groupes répercutés
     */
    function syncModuleFields(moduleId, snapshot) {
        const owners = resolveOwners(moduleId);
        if (!owners) return [];
        const propagated = [];
        _propagating = true;
        try {
            Object.keys(owners).forEach(function (key) {
                const idx = findFieldIndex(key, owners[key]);
                if (idx < 0) return;
                const group = GROUPS[key];
                const value = readField(group.fields[idx]);
                if (isEmpty(value)) return;
                if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, key)
                    && sameValue(snapshot[key], value)) {
                    return; // inchangé par le chargement → on ne force rien
                }
                propagateGroup(key, idx, value);
                bridgeState(key, value, false);
                propagated.push(key);
            });
        } finally {
            _propagating = false;
        }
        return propagated;
    }

    /**
     * Propagation manuelle depuis un champ (diagnostic / tests).
     */
    function propagateFrom(fieldId) {
        const loc = ID_INDEX[fieldId];
        if (!loc) return 0;
        const group = GROUPS[loc.key];
        const value = readField(group.fields[loc.index]);
        if (isEmpty(value)) return 0;
        _propagating = true;
        try {
            const touched = propagateGroup(loc.key, loc.index, value);
            bridgeState(loc.key, value, false);
            return touched;
        } finally {
            _propagating = false;
        }
    }

    function init() {
        if (_initialized || typeof document === 'undefined') return;
        _initialized = true;
        document.addEventListener('input', onFieldEvent, false);
        document.addEventListener('change', onFieldEvent, false);
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    window.FieldSync = {
        version: '1.0.0',
        GROUPS: GROUPS,
        MODULE_OWNERS: MODULE_OWNERS,
        snapshotModuleFields: snapshotModuleFields,
        syncModuleFields: syncModuleFields,
        propagateFrom: propagateFrom,
        init: init
    };
})();



