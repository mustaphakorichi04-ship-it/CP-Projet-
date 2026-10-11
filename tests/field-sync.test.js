// ============================================================
// tests/field-sync.test.js
// ============================================================
// Tests de régression de la synchronisation automatique des champs
// partageant la même information (field-sync.js).
// Exécutés sur le VRAI index.html via jsdom (scripts de la page non
// exécutés : seuls les éléments HTML et field-sync.js sont chargés).
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fsSource = fs.readFileSync(path.join(root, 'field-sync.js'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/' });
const win = dom.window;
const doc = win.document;

let saveCount = 0;
const stubState = { project: { resistivity: 30, surface: 0, shared: { soilResistivity: 30 } } };
win.ProjectManager = {
    getState: () => stubState,
    saveCurrentProject: () => { saveCount++; }
};

win.eval(fsSource);
const FieldSync = win.FieldSync;
// jsdom : DOMContentLoaded asynchrone → init explicite (idempotent)
FieldSync.init();

function ev(type) { return new win.Event(type, { bubbles: true }); }
function eff(selectId, manualId) {
    const sel = doc.getElementById(selectId);
    assert.ok(sel, 'select introuvable : ' + selectId);
    if (sel.value === 'manual' && manualId) {
        const m = doc.getElementById(manualId);
        return m ? m.value : '';
    }
    return sel.value;
}
function setSelect(id, value) {
    const sel = doc.getElementById(id);
    assert.ok(sel, 'select introuvable : ' + id);
    sel.value = value;
    assert.strictEqual(sel.value, value, 'option absente dans ' + id + ' : ' + value);
    sel.dispatchEvent(ev('change'));
}

test('audit : 9 groupes et tous les ids référencés existent dans index.html', () => {
    assert.strictEqual(Object.keys(FieldSync.GROUPS).length, 9);
    const missing = [];
    Object.keys(FieldSync.GROUPS).forEach(key => {
        FieldSync.GROUPS[key].fields.forEach(f => {
            [f.select, f.manual, f.input].forEach(id => {
                if (id && !doc.getElementById(id)) missing.push(key + ':' + id);
            });
        });
    });
    assert.deepStrictEqual(missing, []);
});

test('rho : propagation d un select standard vers les 6 modules (sans boucle)', () => {
    let changeCount = 0;
    const counter = () => { changeCount++; };
    doc.addEventListener('change', counter, false);
    setSelect('anodeSoilResistivity', '100');
    doc.removeEventListener('change', counter, false);
    assert.strictEqual(eff('cpResistivitySelect'), '100');
    assert.strictEqual(eff('iccpResistivitySelect'), '100');
    assert.strictEqual(eff('gbSoilResistivity'), '100');
    assert.strictEqual(eff('ifDCSoilResistivity'), '100');
    assert.strictEqual(eff('envSoilResistivity'), '100');
    // 1 événement utilisateur + 5 répercussions = 6 (pas de boucle)
    assert.ok(changeCount <= 12, 'boucle trop coûteuse : ' + changeCount);
});

test('rho : valeur hors options → mode manuel préservé partout', () => {
    doc.getElementById('cpResistivitySelect').value = 'manual';
    doc.getElementById('cpResistivityManual').value = '47';
    doc.getElementById('cpResistivityManual').dispatchEvent(ev('input'));
    assert.strictEqual(eff('anodeSoilResistivity', 'anodeSoilResistivityManual'), '47');
    assert.strictEqual(eff('gbSoilResistivity', 'gbSoilResistivityManual'), '47');
    assert.strictEqual(eff('iccpResistivitySelect', 'iccpResistivityManual'), '47');
    assert.strictEqual(eff('ifDCSoilResistivity', 'ifDCSoilResistivityManual'), '47');
    assert.strictEqual(eff('envSoilResistivity', 'envSoilResistivityManual'), '47');
});

test('groupes : safety (1.10<->1.1), câbles, potentiel cible, vieillissement', () => {
    setSelect('safetyFactor', '1.10');
    assert.ok(Math.abs(parseFloat(eff('gbSafetyFactor', 'gbSafetyFactorManual')) - 1.1) < 1e-9);

    setSelect('cableLength', '50');
    assert.strictEqual(eff('gbCableLength', 'gbCableLengthManual'), '50');
    assert.strictEqual(doc.getElementById('cableLengthDC').value, '50');

    setSelect('targetPotential', '-900');
    assert.strictEqual(eff('targetPotentialResistive', 'targetPotentialResistiveManual'), '-900');

    setSelect('iccpAgingFactor', '1.5');
    assert.strictEqual(eff('agingFactor', 'agingFactorManual'), '1.5');
    assert.strictEqual(eff('gbAgingFactor', 'gbAgingFactorManual'), '1.5');
});

test('surface : miroir cpSurface <-> iccpSurface + pont état projet', () => {
    const cpSurf = doc.getElementById('cpSurface');
    cpSurf.value = '250.4';
    cpSurf.dispatchEvent(ev('input'));
    assert.strictEqual(doc.getElementById('iccpSurface').value, '250.4');
    assert.strictEqual(stubState.project.surface, 250.4);
});

test('sécurité : valeur vide non propagée, champs hors groupes intacts', () => {
    setSelect('cableSection', '25');
    assert.strictEqual(eff('gbCableSection', 'gbCableSectionManual'), '25');
    doc.getElementById('gbCableSection').value = 'manual';
    doc.getElementById('gbCableSectionManual').value = '';
    doc.getElementById('gbCableSectionManual').dispatchEvent(ev('input'));
    assert.strictEqual(eff('cableSection', 'cableSectionManual'), '25');

    setSelect('anodeSoilResistivity', '100');
    assert.notStrictEqual(doc.getElementById('equipSoilResistivity').value, '100');
    assert.notStrictEqual(eff('gbAnodeDiameter', 'gbAnodeDiameterManual'), '100');
    assert.notStrictEqual(eff('ifPipeDiameter', 'ifPipeDiameterManual'), '100');
    assert.notStrictEqual(eff('iccpAnodeCount', 'iccpAnodeCountManual'), '100');
});

test('cohérence : pont shared.soilResistivity + sauvegarde sur change', () => {
    const before = saveCount;
    setSelect('anodeSoilResistivity', '200');
    assert.strictEqual(stubState.project.shared.soilResistivity, 200);
    assert.strictEqual(stubState.project.resistivity, 200);
    assert.ok(saveCount > before, 'saveCurrentProject non appelé sur change');
});

test('réconciliation post-chargement : seul champ modifié répercuté (snapshot)', () => {
    const snap = FieldSync.snapshotModuleFields('iccp');
    doc.getElementById('iccpSurface').value = '1234'; // écriture .value= (load)
    const propagated = FieldSync.syncModuleFields('iccp', snap);
    // Use array checks instead of deepStrictEqual to avoid potential issues with array identity
    assert.ok(Array.isArray(propagated) && propagated.length === 1 && propagated[0] === 'protectedSurface', 
        `Expected ['protectedSurface'], got ${JSON.stringify(propagated)}`);
    assert.strictEqual(doc.getElementById('cpSurface').value, '1234');
    assert.strictEqual(eff('cableLength', 'cableLengthManual'), '50'); // non forcé
});

test('stabilité : pas de boucle infinie lors d un second changement', () => {
    let count = 0;
    const counter = () => { count++; };
    doc.addEventListener('change', counter, false);
    setSelect('gbSafetyFactor', '1.05');
    doc.removeEventListener('change', counter, false);
    assert.ok(Math.abs(parseFloat(eff('safetyFactor', 'safetyFactorManual')) - 1.05) < 1e-9);
    assert.ok(count <= 8, 'boucle trop coûteuse : ' + count);
});

