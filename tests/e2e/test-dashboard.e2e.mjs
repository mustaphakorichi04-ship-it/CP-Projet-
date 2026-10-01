// Test fonctionnel du Dashboard SaaS réel (jsdom + backend Flask en cours).
// Vérifie : données réelles, contexte projet (?project=), liens Studio, onglets (#hash).
import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = 'http://127.0.0.1:5000';
const results = [];
function check(name, expected, actual) {
  const ok = expected === actual;
  results.push({ name, expected, actual, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}\n      attendu: ${expected}\n      obtenu : ${actual}`);
}

async function buildDom(url) {
  const html = await (await fetch(url)).text();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => console.log('[jsdom error]', e.message));
  virtualConsole.on('error', () => {});
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // jsdom n'implémente pas innerText → alias vers textContent (équivalent pour du texte simple)
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() { return this.textContent; },
        set(v) { this.textContent = v; },
      });
      window.fetch = (input, init) => fetch(new URL(String(input), BASE), init);
      window.console.warn = () => {};
      window.console.debug = () => {};
    },
  });
  return dom;
}

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (fn()) return true; } catch { /* continue */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

const text = (dom, sel) => (dom.window.document.querySelector(sel) || {}).textContent?.trim() || '';
// Les nombres sont affichés au format fr-FR (virgule décimale) : on normalise pour comparer.
const fr = (v) => String(v).replace(/(\d),(\d)/g, '$1.$2').replace(/\s+/g, ' ').trim();

// ── 1. Deep-link : /dashboard?project=PROJ-002#projects ────────────────────
{
  const dom = await buildDom(`${BASE}/dashboard?project=PROJ-002#projects`);
  await waitFor(() => text(dom, '#heroProjectTitle') === 'Projet Gazoduc Sud');
  const doc = dom.window.document;

  check('1. Projet actif = PROJ-002 (deep-link)', 'Projet Gazoduc Sud', text(dom, '#heroProjectTitle'));
  check('1. Onglet actif = Gestion des Projets (hash)', 'tab-projects', doc.querySelector('.view-tab.active')?.id);
  check('1. KPI réseau du projet actif', '5.20 km', fr(text(dom, '#kpiNetworkKm')));
  check('1. KPI postes de soutirage', '1 actif', fr(text(dom, '#kpiRectifiersCount')));
  check('1. KPI courant débité (réel)', 'Courant débité : 0.311 A (GZS-TR-01)', fr(text(dom, '#kpiCurrentDemand')));
  check('1. Périmètre du tableau', 'PROJ-002 • Projet Gazoduc Sud', text(dom, '#overviewScope'));
  check('1. Sélecteur d’espace de travail', 'PROJ-002', doc.getElementById('workspaceSelect').value);

  const body = doc.getElementById('overviewPipelinesTbody').textContent;
  check('1. Pipeline du projet affiché', 'true', String(body.includes('GZS-01')));
  check('1. Aucun mélange entre projets (EMK-42 absent)', 'false', String(body.includes('EMK-42')));

  const iccpLink = doc.querySelector('#overviewPipelinesTbody a[href*="#iccp"]');
  check('1. Lien ICCP contextualisé', '/studio?project=PROJ-002#iccp', iccpLink?.getAttribute('href'));
  check('1. Lien sidebar Équipements contextualisé', '/studio?project=PROJ-002#equipements',
        doc.getElementById('navStudioEquipements').getAttribute('href'));
  check('1. Lien sidebar Groundbed contextualisé', '/studio?project=PROJ-002#groundbed',
        doc.getElementById('navStudioGroundbed').getAttribute('href'));
  check('1. URL conservée (refresh possible)', 'true', String(dom.window.location.search.includes('project=PROJ-002')));
  dom.window.close();
}

// ── 2. Sans paramètre : premier projet réel + URL complétée ────────────────
{
  const dom = await buildDom(`${BASE}/dashboard`);
  await waitFor(() => text(dom, '#heroProjectTitle') !== '—' && text(dom, '#heroProjectTitle') !== '');
  check('2. Projet par défaut = premier de la base', 'Projet EMK', text(dom, '#heroProjectTitle'));
  check('2. Onglet par défaut', 'tab-overview', dom.window.document.querySelector('.view-tab.active')?.id);
  check('2. URL complétée avec le projet', 'true', String(dom.window.location.search.includes('project=PROJ-001')));
  check('2. Projets listés (3)', 3, dom.window.document.querySelectorAll('#allProjectsTbody tr').length);
  dom.window.close();
}

// ── 3. Changement de projet → pas de mélange + liens recalculés ────────────
{
  const dom = await buildDom(`${BASE}/dashboard?project=PROJ-001#overview`);
  await waitFor(() => text(dom, '#heroProjectTitle') === 'Projet EMK');
  const doc = dom.window.document;

  const selectBtn = Array.from(doc.querySelectorAll('#allProjectsTbody button'))
    .find(b => b.getAttribute('onclick')?.includes("PROJ-003"));
  check('3. Bouton de sélection PROJ-003 présent', 'true', String(!!selectBtn));
  selectBtn.click();
  await waitFor(() => text(dom, '#heroProjectTitle') === 'Projet Anodes Port', 4000);

  check('3. Bascule projet → PROJ-003', 'Projet Anodes Port', text(dom, '#heroProjectTitle'));
  check('3. URL mise à jour', 'true', String(dom.window.location.search.includes('project=PROJ-003')));
  check('3. Lien Studio recalculé', '/studio?project=PROJ-003#iccp',
        doc.getElementById('navStudioIccp').getAttribute('href'));
  check('3. Ouvrages du projet (aucun pipeline)', 'true',
        String(doc.getElementById('overviewPipelinesTbody').textContent.includes('Aucun ouvrage')));
  dom.window.close();
}

// ── 4. API indisponible → N/A (jamais de donnée inventée) ──────────────────
{
  const html = await (await fetch(`${BASE}/dashboard`)).text();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(html, {
    url: `${BASE}/dashboard`,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() { return this.textContent; },
        set(v) { this.textContent = v; },
      });
      window.fetch = () => Promise.reject(new Error('offline'));
      window.console.warn = () => {};
    },
  });
  await waitFor(() => text(dom, '#overviewPipelinesTbody').includes('Données indisponibles'), 8000);
  check('4. KPI indisponible → N/A', 'N/A', text(dom, '#kpiNetworkKm'));
  check('4. Table ouvrages → message d’indisponibilité', 'true',
        String(dom.window.document.getElementById('overviewPipelinesTbody').textContent.includes('Données indisponibles')));
  dom.window.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} vérifications PASS ===`);
process.exit(failed.length === 0 ? 0 : 1);
