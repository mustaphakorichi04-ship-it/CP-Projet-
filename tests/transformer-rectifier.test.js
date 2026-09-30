'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const TransformerRectifierEngine = require('../transformerRectifierEngine.js');

function useTestCatalog() {
    TransformerRectifierEngine.setCatalog({
        validationStatus: 'TEST_FIXTURE_ONLY',
        items: [
            { id: 'TEST-0130', manufacturer: 'Test', model: '30V-80A', nominalVoltage: 30, nominalCurrent: 80, nominalPower: 2400 },
            { id: 'TEST-0240', manufacturer: 'Test', model: '40V-80A', nominalVoltage: 40, nominalCurrent: 80, nominalPower: 3200 },
            { id: 'TEST-0350', manufacturer: 'Test', model: '50V-100A', nominalVoltage: 50, nominalCurrent: 100, nominalPower: 5000 }
        ]
    });
}

test('selects a TR only when voltage, current and power are all sufficient', () => {
    useTestCatalog();
    const result = TransformerRectifierEngine.select({ current: 72, voltage: 38, power: 2740 });

    assert.equal(result.status, 'COMPATIBLE');
    assert.equal(result.selected.id, 'TEST-0240');
    assert.equal(result.compatibleCandidates.length, 2);
});

test('rejects a TR that passes power but fails current or voltage', () => {
    TransformerRectifierEngine.setCatalog({
        validationStatus: 'TEST_FIXTURE_ONLY',
        items: [{ id: 'POWER-ONLY', nominalVoltage: 40, nominalCurrent: 60, nominalPower: 5000 }]
    });

    const result = TransformerRectifierEngine.select({ current: 72, voltage: 38, power: 2740 });
    assert.equal(result.status, 'NO_COMPATIBLE_TR');
    assert.equal(result.compatibleCandidates.length, 0);
});

test('reports an incomplete production catalog without inventing a TR', () => {
    TransformerRectifierEngine.setCatalog({
        validationStatus: 'CATALOG_TO_BE_COMPLETED_AND_VALIDATED',
        items: []
    });

    const result = TransformerRectifierEngine.select({ current: 10, voltage: 20, power: 200 });
    assert.equal(result.status, 'NO_COMPATIBLE_TR');
    assert.equal(result.selected, null);
});
