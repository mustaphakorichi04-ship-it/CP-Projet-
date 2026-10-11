// ============================================================
// tests/dashboard-sync.test.js
// ============================================================
// Régression Studio ↔ Dashboard :
// charge le VRAI dashboard.html dans jsdom (scripts inline exécutés,
// /api/dashboard/summary simulé) et vérifie que l'auto-refresh :
//  1. rend les projets et les KPI du projet sélectionné ;
//  2. fait DISPARAÎTRE un projet supprimé dans le Studio (sans
//     rechargement de page) en basculant sur le projet restant ;
//  3. met à jour les KPI après une modification de données/calcul.
// Le refresh est déclenché via l'événement visibilitychange (même
// chemin que l'intervalle de 30 s) pour éviter d'attendre 30 s.
// ============================================================
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');

// ── Résumé serveur simulé (forme de /api/dashboard/summary) ──
const summary = {
    engineer: {
        name: 'Ing. Mustapha Korichi',
        title: 'Senior CP Specialist',
        certification: 'NACE Level 4',
        avatar: 'MK'
    },
    kpis: { activeProjectsCount: 2 },
    projects: [
        { id: 'PROJ-001', name: 'EMK', type: 'mixte', standard: 'NACE SP0169',
          pipelineLengthKm: 12.78, pipelineSurfaceM2: 1000, rectifiersCount: 2,
          groundbedsCount: 1, iccpCurrentA: 0.197, status: 'Protégé (-850 mV CSE)',
          updatedAt: '2026-10-01' },
        { id: 'PROJ-002', name: 'NORD', type: 'iccp', standard: 'NACE SP0169',
          pipelineLengthKm: 5.20, pipelineSurfaceM2: 400, rectifiersCount: 1,
          groundbedsCount: 1, iccpCurrentA: 0.450, status: 'Protégé (-850 mV CSE)',
          updatedAt: '2026-10-02' }
    ],
    pipelines: [],
    rectifiers: [],
    groundbeds: [],
    equipments: []
};

const fetchLog = [];
const jsdomErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => jsdomErrors.push(e));
virtualConsole.on('error', () => {});
virtualConsole.on('warn', () => {});

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

const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://localhost/dashboard',
    virtualConsole,
    beforeParse(window) {
        // jsdom : visibilityState = 'prerender' par défaut → on simule un
        // onglet visible pour que l'auto-refresh (visibilitychange/30 s) s'active.
        Object.defineProperty(window.document, 'visibilityState', {
            configurable: true, get: () => 'visible'
        });
        Object.defineProperty(window.document, 'hidden', {
            configurable: true, get: () => false
        });
        window.localStorage.setItem('cp_token', 'jwt-dashboard-test');
        window.localStorage.setItem('cp_active_project', 'PROJ-001');
        window.fetch = async (url, options = {}) => {
            const target = String(url);
            fetchLog.push({ url: target, method: (options.method || 'GET').toUpperCase() });
            if (target.includes('/api/dashboard/summary')) return makeResponse(summary);
            if (target.includes('/api/v1/health')) return makeResponse({ status: 'ok' });
            return makeResponse({});
        };
    }
});
const win = dom.window;
const doc = win.document;

function closeWindow() {
    try { win.close(); } catch (e) { /* déjà fermée */ }
}
after(closeWindow);

// jsdom : innerText n'est pas implémenté → l'écriture crée une propriété
// simple (parfois numérique) ; on coerce en String avec repli textContent.
function text(el) {
    if (!el) return '';
    const value = (el.innerText !== undefined && el.innerText !== null)
        ? el.innerText : null;
    if (value !== null) return String(value);
    return el.textContent ? String(el.textContent) : '';
}

async function waitFor(predicate, message, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise(r => setTimeout(r, 15));
    }
    assert.ok(predicate(), 'timeout : ' + message);
}

function triggerAutoRefresh() {
    // Même chemin que l'intervalle de 30 s : visibilitychange → refresh.
    doc.dispatchEvent(new win.Event('visibilitychange'));
}

const optionValues = () =>
    Array.from(doc.getElementById('workspaceSelect').options).map(o => o.value);

test('chargement initial : projets rendus + KPI du projet sélectionné', async () => {
    await waitFor(
        () => fetchLog.some(c => c.url.includes('/api/dashboard/summary')),
        'appel initial de /api/dashboard/summary'
    );
    await waitFor(() => optionValues().includes('PROJ-001') && optionValues().includes('PROJ-002'),
        'peuplement du select des espaces de travail');

    // Auth : le Bearer doit être envoyé (boucle login↔dashboard sinon).
    const summaryCall = fetchLog.find(c => c.url.includes('/api/dashboard/summary'));
    assert.ok(summaryCall, 'summary non appelé');

    // Sélection mémorisée : PROJ-001.
    assert.strictEqual(doc.getElementById('workspaceSelect').value, 'PROJ-001');

    // KPI courant du projet PROJ-001 (0.197 A), pas l'agrégat global.
    await waitFor(
        () => text(doc.getElementById('kpiCurrentDemand')).includes('0.197'),
        'KPI courant PROJ-001'
    );

    // Tableau « Tous les projets » : 2 lignes.
    const rows = doc.querySelectorAll('#allProjectsTbody tr');
    assert.strictEqual(rows.length, 2, 'lignes du tableau projets');

    // Badge projet global.
    assert.strictEqual(text(doc.getElementById('badgeProjectCount')).trim(), '2');
});

test('auto-refresh : projet supprimé dans le Studio disparaît du Dashboard', async () => {
    // L'utilisateur consulte PROJ-002…
    win.switchWorkspace('PROJ-002');
    assert.strictEqual(win.localStorage.getItem('cp_active_project'), 'PROJ-002');
    await waitFor(() => text(doc.getElementById('kpiCurrentDemand')).includes('0.450'),
        'KPI PROJ-002 affiché avant suppression');

    // …puis le SUPPRIME dans le Studio : le backend ne renvoie plus PROJ-002.
    summary.projects = summary.projects.filter(p => p.id !== 'PROJ-002');
    summary.kpis.activeProjectsCount = 1;

    triggerAutoRefresh();
    await waitFor(() => !optionValues().includes('PROJ-002'),
        'disparition de PROJ-002 du select');
    await waitFor(() => doc.querySelectorAll('#allProjectsTbody tr').length === 1,
        'disparition de PROJ-002 du tableau');

    // Bascule automatique sur le projet restant (PROJ-001), sans rechargement.
    assert.strictEqual(doc.getElementById('workspaceSelect').value, 'PROJ-001');
    assert.strictEqual(text(doc.getElementById('badgeProjectCount')).trim(), '1');
    await waitFor(() => text(doc.getElementById('kpiCurrentDemand')).includes('0.197'),
        'KPI basculé sur PROJ-001');
});

test('auto-refresh : modification de données/calcul met à jour les KPI', async () => {
    // Changement côté Studio : nouveau courant ICCP + longueur réseau.
    const proj = summary.projects.find(p => p.id === 'PROJ-001');
    proj.iccpCurrentA = 0.321;
    proj.pipelineLengthKm = 15.50;

    triggerAutoRefresh();
    await waitFor(() => text(doc.getElementById('kpiCurrentDemand')).includes('0.321'),
        'KPI courant recalculé (0.321 A)');
    await waitFor(
        () => text(doc.getElementById('kpiNetworkKm')).includes('15.50'),
        'KPI longueur réseau recalculée (15.50 km)'
    );

    assert.ok(jsdomErrors.length === 0,
        'erreurs jsdom : ' + jsdomErrors.map(e => e && e.message).join(' | '));
    closeWindow();
});