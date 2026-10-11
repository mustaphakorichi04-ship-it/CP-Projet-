// ============================================================
// tests/storage-proxy-delete.test.js
// ============================================================
// Régression SUPPRESSION PROJET Studio → Backend :
// charge le VRAI storage-proxy.js dans jsdom et vérifie que
// StorageManager.deleteProjectCascade / deleteProjectRecord
// appellent bien DELETE /api/projects/<id> (résolution de la
// version serveur + If-Match, re-jeu sur conflit 409/428,
// 404 gracieux) PUIS exécutent la cascade locale d'origine.
// Sans ce proxy, un projet supprimé dans le Studio restait dans
// SQLite et réapparaissait dans /api/dashboard/summary.
// ============================================================
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'storage-proxy.js'), 'utf8');

const jsdomErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://localhost/studio',
    virtualConsole
});
const win = dom.window;

function closeWindow() {
    try { win.close(); } catch (e) { /* déjà fermée */ }
}
after(closeWindow);

// ── Session legacy (mode localStorage, useHttpOnlyCookie=false) ──
win.localStorage.setItem('cp_auth_token', JSON.stringify({
    token: 'jwt-test',
    expiry: Date.now() + 3600000,
    userId: 'user-1',
    role: 'owner'
}));

// ── Traçabilité réseau ──────────────────────────────────────
const fetchCalls = [];
const deleteScripts = new Map(); // projectId → file de {status, body}
const probeVersions = new Map(); // projectId → {status, body} du GET probe

function makeResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(JSON.stringify(body)),
        text: async () => JSON.stringify(body),
        clone: () => makeResponse(body, status),
        headers: { get: () => null }
    };
}

win.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    fetchCalls.push({
        url: String(url),
        method,
        headers: Object.assign({}, options.headers || {})
    });

    if (String(url).includes('/api/version')) {
        return makeResponse({ useHttpOnlyCookie: false, version: 'test' });
    }
    const projectMatch = String(url).match(/\/api\/projects\/([^/]+)$/);
    if (projectMatch && method === 'GET') {
        const probe = probeVersions.get(projectMatch[1]);
        return probe ? makeResponse(probe.body, probe.status)
                     : makeResponse({ id: projectMatch[1], version: 1 });
    }
    if (projectMatch && method === 'DELETE') {
        const script = deleteScripts.get(projectMatch[1]) || [];
        const next = script.shift() || { status: 200, body: { success: true } };
        return makeResponse(next.body, next.status);
    }
    return makeResponse({});
};

// ── Stubs applicatifs (cascade/record LOCAUX = comportement d'origine) ──
const localCalls = { cascade: [], record: [] };
win.StorageManager = {
    deleteProjectCascade: async (id) => { localCalls.cascade.push(id); return true; },
    deleteProjectRecord: async (id) => { localCalls.record.push(id); return true; }
};
win.ProjectManager = {
    getCurrentProjectId: () => 'PROJ-CURRENT',
    getState: () => ({ project: {}, equipments: [] })
};

// Charge le VRAI fichier (IIFE) : les proxies enveloppent les stubs ci-dessus.
win.eval(src);

const deletionsFor = (id) => fetchCalls.filter(
    c => c.method === 'DELETE' && c.url.endsWith('/api/projects/' + id));
const probesFor = (id) => fetchCalls.filter(
    c => c.method === 'GET' && c.url.endsWith('/api/projects/' + id));

test('deleteProjectCascade : probe version → DELETE If-Match → cascade locale', async () => {
    probeVersions.set('PROJ-DEL-1', { status: 200, body: { id: 'PROJ-DEL-1', version: 3 } });

    await win.StorageManager.deleteProjectCascade('PROJ-DEL-1');

    // 1. Version serveur résolue via GET (pas de cache local au départ).
    assert.strictEqual(probesFor('PROJ-DEL-1').length, 1, 'GET probe manquant');

    // 2. DELETE émis avec l'If-Match de la version serveur.
    const dels = deletionsFor('PROJ-DEL-1');
    assert.strictEqual(dels.length, 1, 'DELETE non émis');
    assert.strictEqual(dels[0].headers['If-Match'], '3', 'If-Match incorrect');

    // 3. Cascade LOCALE d'origine exécutée (après la suppression serveur).
    assert.deepStrictEqual(localCalls.cascade, ['PROJ-DEL-1'], 'cascade locale non appelée');

    // 4. État de version/conflit nettoyé après suppression.
    const versions = JSON.parse(win.localStorage.getItem('cp_project_versions') || '{}');
    assert.ok(!('PROJ-DEL-1' in versions), 'version locale non nettoyée');
});

test('deleteProjectCascade : conflit 409 → re-jeu avec currentVersion serveur', async () => {
    probeVersions.set('PROJ-DEL-2', { status: 200, body: { id: 'PROJ-DEL-2', version: 4 } });
    deleteScripts.set('PROJ-DEL-2', [
        { status: 409, body: { error: 'PROJECT_VERSION_CONFLICT', currentVersion: 9 } },
        { status: 200, body: { success: true } }
    ]);

    await win.StorageManager.deleteProjectCascade('PROJ-DEL-2');

    const dels = deletionsFor('PROJ-DEL-2');
    assert.strictEqual(dels.length, 2, 're-jeu du DELETE absent');
    assert.strictEqual(dels[0].headers['If-Match'], '4', 'premier If-Match incorrect');
    assert.strictEqual(dels[1].headers['If-Match'], '9', 're-jeu sans version serveur');
    assert.deepStrictEqual(localCalls.cascade, ['PROJ-DEL-1', 'PROJ-DEL-2']);
});

test('deleteProjectCascade : 428 (version requise) → re-jeu avec currentVersion', async () => {
    probeVersions.set('PROJ-DEL-4', { status: 200, body: { id: 'PROJ-DEL-4', version: 5 } });
    deleteScripts.set('PROJ-DEL-4', [
        { status: 428, body: { error: 'PROJECT_VERSION_REQUIRED', currentVersion: 6 } },
        { status: 200, body: { success: true } }
    ]);

    await win.StorageManager.deleteProjectCascade('PROJ-DEL-4');

    const dels = deletionsFor('PROJ-DEL-4');
    assert.strictEqual(dels.length, 2, 're-jeu du DELETE absent');
    assert.strictEqual(dels[1].headers['If-Match'], '6');
    assert.deepStrictEqual(localCalls.cascade, ['PROJ-DEL-1', 'PROJ-DEL-2', 'PROJ-DEL-4']);
});

test('deleteProjectCascade : projet déjà absent (404) → cascade locale quand même', async () => {
    probeVersions.set('PROJ-DEL-3', { status: 404, body: { error: 'Introuvable' } });

    await win.StorageManager.deleteProjectCascade('PROJ-DEL-3');

    assert.strictEqual(deletionsFor('PROJ-DEL-3').length, 0, 'DELETE inutile envoyé');
    assert.deepStrictEqual(
        localCalls.cascade,
        ['PROJ-DEL-1', 'PROJ-DEL-2', 'PROJ-DEL-4', 'PROJ-DEL-3']
    );
});

test('deleteProjectRecord (re-key) : suppression serveur best-effort de l ancien ID', async () => {
    probeVersions.set('PROJ-OLD', { status: 200, body: { id: 'PROJ-OLD', version: 2 } });

    await win.StorageManager.deleteProjectRecord('PROJ-OLD');

    const dels = deletionsFor('PROJ-OLD');
    assert.strictEqual(dels.length, 1, 'DELETE serveur absent pour l ancien ID');
    assert.strictEqual(dels[0].headers['If-Match'], '2');
    assert.deepStrictEqual(localCalls.record, ['PROJ-OLD'], 'suppression locale non appelée');
});

test('aucune erreur jsdom non gérée pendant la session', () => {
    assert.deepStrictEqual(jsdomErrors.map(e => String(e && e.message)), []);
    closeWindow();
});