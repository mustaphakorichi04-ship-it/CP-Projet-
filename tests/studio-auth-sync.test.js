// ============================================================
// tests/studio-auth-sync.test.js
// ============================================================
// Régression BUG-CP-STUDIO-AUTH (Studio → Dashboard) :
// charge le VRAI storage-proxy.js dans jsdom et vérifie la SYMÉTRIE
// des clés de session entre le Studio et le Dashboard.
//
// CAUSE RACINE : login.html stocke le JWT sous `cp_token` (chaîne brute),
// le Dashboard lit déjà `cp_token || cp_auth_token`, MAIS getToken() du
// Studio ne lisait QUE `cp_auth_token`. Donc :
//   isAuthenticated() === false
//   → pushProjectsToBackend() faisait `return 0` (ligne 1969)
//   → les projets créés dans le Studio (PROJ-004/005) ne remontaient
//     JAMAIS au Dashboard (restaient dans l'IndexedDB du navigateur).
//
// CORRECTIF : getToken() accepte `cp_token` en repli ; clearToken()
// le retire aussi (sinon boucle 401 infinie sur session révoquée).
// ============================================================
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'storage-proxy.js'), 'utf8');

const virtualConsole = new VirtualConsole();
const jsdomErrors = [];
virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://localhost/studio',
    virtualConsole
});
const win = dom.window;

function closeWindow() { try { win.close(); } catch (e) {} }
after(closeWindow);

// Traçabilité réseau (aucun appel réel : /api/version est stubé).
const fetchCalls = [];
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
    const headers = Object.assign({}, options.headers || {});
    fetchCalls.push({ url: String(url), method, headers });
    if (String(url).includes('/api/version')) {
        // Legacy : useHttpOnlyCookie=false (mode démo réel).
        return makeResponse({ useHttpOnlyCookie: false, version: 'test' });
    }
    if (/\/api\/projects\?/.test(String(url)) && method === 'GET') {
        return makeResponse({ items: [] });
    }
    const m = String(url).match(/\/api\/projects\/([^/]+)$/);
    if (m && method === 'PUT') return makeResponse({ success: true, version: 1 });
    if (m && method === 'DELETE') return makeResponse({ success: true });
    if (/\/api\/projects$/.test(String(url)) && method === 'POST') {
        return makeResponse({ success: true, id: 'X', version: 1 }, 201);
    }
    return makeResponse({});
};

// StorageManager local minimal (IndexedDB absent en jsdom).
let localStore = [];
win.StorageManager = {
    loadProjects: async () => localStore.slice(),
    saveProject: async (p) => { localStore.push(p); return p; },
    loadEquipmentsForProject: async () => [],
    deleteProjectCascade: async (id) => { localStore = localStore.filter(x => x.id !== id); return true; },
    deleteProjectRecord: async (id) => { localStore = localStore.filter(x => x.id !== id); return true; },
    saveEquipment: async (e) => e
};
win.ProjectManager = { getCurrentProjectId: () => null, getState: () => ({ project: {}, equipments: [] }) };
win.UI = { showToast: () => {} };

win.eval(src);

// ── Helpers d'isolation entre tests (état module-level du proxy) ──
function resetSession() {
    try { win.StorageManager.clearToken(); } catch (e) {}
    try {
        win.localStorage.removeItem('cp_token');
        win.localStorage.removeItem('cp_auth_token');
        win.localStorage.removeItem('cp_pushed_projects');
        win.localStorage.removeItem('cp_deleted_projects');
        win.localStorage.removeItem('cp_project_versions');
        win.localStorage.removeItem('cp_sync_conflicts');
    } catch (e) {}
    localStore = [];
    fetchCalls.length = 0;
}
const putsFor = (id) => fetchCalls.filter(c => c.method === 'PUT' && c.url.endsWith('/api/projects/' + id));

// ────────────────────────────────────────────────────────────────
// 1. Le bug EXACT : login.html pose `cp_token`, getToken() doit le lire.
// ────────────────────────────────────────────────────────────────
test('BUG-CP-STUDIO-AUTH : getToken() lit le jeton posé par login.html (cp_token)', () => {
    resetSession();
    win.localStorage.setItem('cp_token', 'jwt-depuis-login-html');
    assert.strictEqual(win.StorageManager.getToken(), 'jwt-depuis-login-html',
        'getToken() doit accepter cp_token en repli (sinon push bloqué)');
    assert.strictEqual(win.StorageManager.isAuthenticated(), true);
});

// ────────────────────────────────────────────────────────────────
// 2. Preuve de bout en bout : avec seulement cp_token, un projet
//    local est RÉELLEMENT poussé (PUT émis) au lieu de return 0.
//    C'est exactement le scénario PROJ-004/005 → Dashboard.
// ────────────────────────────────────────────────────────────────
test('BUG-CP-STUDIO-AUTH : push émet le PUT projet quand cp_token est présent', async () => {
    resetSession();
    win.localStorage.setItem('cp_token', 'jwt-depuis-login-html');
    localStore = [{ id: 'PROJ-004', name: 'Feeder Sud', type: 'mixte', data: { name: 'Feeder Sud' } }];

    assert.strictEqual(win.StorageManager.isAuthenticated(), true);
    const pushed = await win.StorageManager.pushProjectsToBackend({ silent: true });

    assert.ok(pushed >= 1, 'le projet local doit être poussé (push retournait 0 avant le correctif)');
    assert.ok(putsFor('PROJ-004').length >= 1, 'un PUT /api/projects/PROJ-004 doit être émis');
});

// ────────────────────────────────────────────────────────────────
// 3. Non-régression : le format legacy `cp_auth_token` marche toujours.
// ────────────────────────────────────────────────────────────────
test('non-régression : cp_auth_token (legacy) authentifie et pousse encore', async () => {
    resetSession();
    win.localStorage.setItem('cp_auth_token', JSON.stringify({
        token: 'jwt-legacy', expiry: Date.now() + 3600000, userId: 'u1', role: 'owner'
    }));
    localStore = [{ id: 'PROJ-LEGACY', name: 'L', type: 'mixte', data: {} }];

    assert.strictEqual(win.StorageManager.getToken(), 'jwt-legacy');
    assert.strictEqual(win.StorageManager.isAuthenticated(), true);
    const pushed = await win.StorageManager.pushProjectsToBackend({ silent: true });
    assert.ok(pushed >= 1 && putsFor('PROJ-LEGACY').length >= 1, 'legacy doit encore pousser');
});

// ────────────────────────────────────────────────────────────────
// 4. clearToken() retire AUSSI cp_token : sinon un jeton révoqué
//    serait ressuscité par getToken() → boucle 401 infinie.
// ────────────────────────────────────────────────────────────────
test('clearToken() retire cp_token (évite la résurrection du jeton révoqué)', () => {
    resetSession();
    win.localStorage.setItem('cp_token', 'jwt-revoque');
    win.localStorage.setItem('cp_auth_token', JSON.stringify({ token: 'x', expiry: Date.now() + 3600000 }));
    win.StorageManager.clearToken();

    assert.strictEqual(win.localStorage.getItem('cp_token'), null, 'cp_token doit être effacé');
    assert.strictEqual(win.localStorage.getItem('cp_auth_token'), null, 'cp_auth_token doit être effacé');
    assert.strictEqual(win.StorageManager.isAuthenticated(), false);
});

// ────────────────────────────────────────────────────────────────
// 5. Garde-fou : la sentinelle 'cookie' (mode HttpOnly) n'est PAS un
//    vrai JWT ; getToken() ne doit pas la retourner comme jeton.
// ────────────────────────────────────────────────────────────────
test('sentinelle cp_token="cookie" n est pas traitée comme un jeton', () => {
    resetSession();
    win.localStorage.setItem('cp_token', 'cookie');
    // En mode legacy, 'cookie' ne doit pas authentifier.
    assert.strictEqual(win.StorageManager.getToken(), null);
    assert.strictEqual(win.StorageManager.isAuthenticated(), false);
});

// ────────────────────────────────────────────────────────────────
// 6. Aucun jeton nulle part : push reste désactivé (return 0).
// ────────────────────────────────────────────────────────────────
test('sans aucun jeton : push ne fait rien (return 0, aucun PUT)', async () => {
    resetSession();
    localStore = [{ id: 'PROJ-NOAUTH', name: 'N', type: 'mixte', data: {} }];
    const pushed = await win.StorageManager.pushProjectsToBackend({ silent: true });
    assert.strictEqual(pushed, 0, 'sans authentification, aucun projet poussé');
    assert.strictEqual(putsFor('PROJ-NOAUTH').length, 0);
});

test('aucune erreur jsdom non gérée pendant la session', () => {
    assert.deepStrictEqual(jsdomErrors.map(e => String(e && e.message)), []);
    closeWindow();
});

