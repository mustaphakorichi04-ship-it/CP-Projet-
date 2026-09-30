// ============================================================
// transformerRectifierEngine.js - Catalogue et selection des TR
// Les fiches constructeur doivent etre validees avant utilisation.
// ============================================================
(function(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TransformerRectifierEngine = factory();
    }
})(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    let catalog = {
        catalogVersion: '0.1',
        validationStatus: 'CATALOG_TO_BE_COMPLETED_AND_VALIDATED',
        source: 'Aucune donnee constructeur fournie dans le projet',
        items: []
    };

    const TECHNICAL_SELECTION_CRITERIA = Object.freeze([
        'nominalVoltage >= requiredVoltage',
        'nominalCurrent >= requiredCurrent',
        'nominalPower >= requiredPower'
    ]);

    function toPositiveNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : 0;
    }

    function normalizeRequirements(requirements) {
        const source = requirements || {};
        const current = toPositiveNumber(source.current);
        const voltage = toPositiveNumber(source.voltage);
        const power = toPositiveNumber(source.power) || current * voltage;
        return { current, voltage, power };
    }

    function normalizeItem(item) {
        if (!item || typeof item !== 'object') return null;
        const normalized = {
            id: String(item.id || '').trim(),
            manufacturer: String(item.manufacturer || '').trim(),
            model: String(item.model || '').trim(),
            nominalVoltage: toPositiveNumber(item.nominalVoltage),
            nominalCurrent: toPositiveNumber(item.nominalCurrent),
            nominalPower: toPositiveNumber(item.nominalPower),
            supplyVoltage: item.supplyVoltage || null,
            phases: item.phases || null,
            frequencyHz: item.frequencyHz || null,
            technology: item.technology || null,
            regulation: item.regulation || null,
            cooling: item.cooling || null,
            enclosureProtection: item.enclosureProtection || null,
            ratingBasis: item.ratingBasis || null,
            source: item.source || null,
            sourceUrl: item.sourceUrl || null,
            sourceDocument: item.sourceDocument || null,
            validationStatus: item.validationStatus || null
        };
        return normalized.id && normalized.nominalVoltage > 0 &&
            normalized.nominalCurrent > 0 && normalized.nominalPower > 0
            ? normalized : null;
    }

    function setCatalog(nextCatalog) {
        catalog = {
            ...(nextCatalog || {}),
            items: Array.isArray(nextCatalog?.items)
                ? nextCatalog.items.map(normalizeItem).filter(Boolean)
                : []
        };
        return getCatalog();
    }

    function getCatalog() {
        return {
            ...catalog,
            items: catalog.items.map(item => ({ ...item }))
        };
    }

    async function loadCatalog(url) {
        if (typeof fetch !== 'function') return getCatalog();
        const response = await fetch(url || 'transformers_rectifiers.json', { cache: 'no-store' });
        if (!response.ok) throw new Error('Catalogue TR indisponible: HTTP ' + response.status);
        return setCatalog(await response.json());
    }

    function isCompatible(item, requirements) {
        const needed = normalizeRequirements(requirements);
        return item.nominalVoltage >= needed.voltage &&
            item.nominalCurrent >= needed.current &&
            item.nominalPower >= needed.power;
    }

    function select(requirements) {
        const needed = normalizeRequirements(requirements);
        const compatibleCandidates = catalog.items
            .filter(item => isCompatible(item, needed))
            .map(item => ({
                ...item,
                oversizing: {
                    voltage: item.nominalVoltage / needed.voltage,
                    current: item.nominalCurrent / needed.current,
                    power: item.nominalPower / needed.power
                }
            }))
            .sort((left, right) => {
                const leftScore = Math.max(left.oversizing.voltage, left.oversizing.current, left.oversizing.power);
                const rightScore = Math.max(right.oversizing.voltage, right.oversizing.current, right.oversizing.power);
                return leftScore - rightScore ||
                    left.nominalPower - right.nominalPower ||
                    left.nominalVoltage - right.nominalVoltage ||
                    left.nominalCurrent - right.nominalCurrent;
            });

        const rejectedCandidates = catalog.items
            .filter(item => !isCompatible(item, needed))
            .map(item => ({
                ...item,
                failedCriteria: TECHNICAL_SELECTION_CRITERIA.filter((criterion, index) => {
                    return [item.nominalVoltage >= needed.voltage,
                        item.nominalCurrent >= needed.current,
                        item.nominalPower >= needed.power][index] === false;
                })
            }));

        const selected = compatibleCandidates[0] || null;
        return {
            status: selected ? 'COMPATIBLE' : 'NO_COMPATIBLE_TR',
            catalogStatus: catalog.validationStatus || 'UNKNOWN',
            selectionPolicy: 'TECHNICAL_RATINGS_ONLY',
            requirements: needed,
            compatibleCandidates,
            rejectedCandidates,
            selected,
            criteria: [...TECHNICAL_SELECTION_CRITERIA],
            trace: selected
                ? 'Selection fondee uniquement sur les calibres techniques V/I/P et le plus faible surdimensionnement principal.'
                : rejectedCandidates.length > 0
                    ? 'Aucun TR catalogue ne satisfait les trois criteres techniques. Voir failedCriteria pour la cause du rejet.'
                    : 'Catalogue TR vide ou non charge.'
        };
    }

    return { setCatalog, getCatalog, loadCatalog, normalizeRequirements, isCompatible, select };
});
