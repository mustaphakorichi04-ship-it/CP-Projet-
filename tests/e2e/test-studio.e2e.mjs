// Test fonctionnel du Studio CP Engineer Pro (jsdom + backend Flask + base réelle).
// Vérifie : deep-link ?project=&hash, navigation sidebar, changement de projet,
// continuité du projectId entre modules, absence de mélange entre projets.
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom';
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';

// jsdom n'embarque pas IndexedDB (utilisé par offline-sync.js / storage.js).
process.on('unhandledRejection', (e) => { console.log('[unhandledRejection]', String(e && e.message || e).slice(0, 140)); });

const BASE = 'http://127.0.0.1:5000';
const results = [];
function check(name, expected, actual) {
  const ok = String(expected) === String(actual);
  results.push({ name, expected, actual, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}\n      attendu: ${expected}\n      obtenu : ${actual}`);
}

// ── Session réelle (token JWT) ──────────────────────────────────────────────
const loginRes = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const session = await loginRes.json();
if (!session.token) { console.error('LOGIN IMPOSSIBLE', session); process.exit(2); }

class LocalOnly extends ResourceLoader {
  fetch(url, options) {
    if (!url.startsWith(BASE)) return Promise.resolve(Buffer.from('')); // CDN ignoré
    return super.fetch(url, options);
  }
}

async function buildDom(url, { auth = true, waitMs = 15000 } = {}) {
  const html = await (await fetch(url)).text();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    resources: new LocalOnly(),
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() { return this.textContent; },
        set(v) { this.textContent = v; },
      });
      window.fetch = (input, init) => fetch(new URL(String(input), BASE), init);
      window.console.warn = () => {};
      window.console.debug = () => {};
      window.console.info = () => {};
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
      window.indexedDB = fakeIndexedDB;
      window.IDBKeyRange = fakeIDBKeyRange;
      if (auth) {
        window.localStorage.setItem('cp_auth_token', JSON.stringify({
          token: session.token,
          expiry: Date.now() + 3600 * 1000,
          userId: session.user_id,
          role: session.role,
        }));
      }
    },
  });
  await new Promise(r => setTimeout(r, waitMs));
  return dom;
}

const waitFor = async (fn, timeoutMs = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (fn()) return true; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
};

const text = (dom, sel) => (dom.window.document.querySelector(sel) || {}).textContent?.trim() || '';
const optValues = (dom) => Array.from(dom.window.document.getElementById('projectSelector')?.options || []).map(o => o.value);

// ── 1. Deep-link URL directe : /studio?project=PROJ-002#iccp ───────────────
{
  const dom = await buildDom(`${BASE}/studio?project=PROJ-002#iccp`);
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById('projectSelector')?.value === 'PROJ-002', 20000);

  check('1. Projets réels chargés depuis la base (PROJ-001/002/003)', 'true',
        String(optValues(dom).includes('PROJ-001') && optValues(dom).includes('PROJ-002') && optValues(dom).includes('PROJ-003')));
  check('1. Deep-link : projet appliqué au sélecteur', 'PROJ-002', doc.getElementById('projectSelector').value);
  check('1. Deep-link : module ICCP actif', 'true', String(doc.getElementById('module-iccp')?.classList.contains('active')));
  check('1. Nav sidebar ICCP marquée active', 'true', String(!!doc.querySelector('.nav-item[data-module="iccp"].active')));
  check('1. État applicatif = projet de l’URL (source unique)', 'PROJ-002',
        dom.window.ProjectManager.getState()?.project?.id);
  check('1. Donnée réelle de la base (iccp.current PROJ-002 = 0.311)', '0.311',
        String(dom.window.ProjectManager.getState()?.iccp?.current));
  check('1. URL conservée après chargement', 'true',
        String(dom.window.location.search.includes('project=PROJ-002') && dom.window.location.hash === '#iccp'));
  // Boucle complète : Dashboard → Studio → retour Dashboard avec le même projet
  check('1. Lien retour Dashboard contextualisé (projectId conservé)', 'true',
        String((doc.querySelector('a[href^="/dashboard"]')?.getAttribute('href') || '').includes('project=PROJ-002')));

  // Navigation sidebar : Équipements
  const navEquip = doc.querySelector('.nav-item[data-module="equipements"] a') || doc.querySelector('.nav-item[data-module="equipements"]');
  navEquip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitFor(() => doc.getElementById('module-equipements')?.classList.contains('active'), 8000);
  check('1. Clic sidebar Équipements → module affiché', 'true', String(doc.getElementById('module-equipements').classList.contains('active')));
  check('1. Clic sidebar → module reflété dans l’URL', '#equipements', dom.window.location.hash);
  check('1. projectId conservé après navigation module', 'true', String(dom.window.location.search.includes('project=PROJ-002')));

  // Calcul CP puis retour ICCP : le contexte projet doit survivre
  const navCalc = doc.querySelector('.nav-item[data-module="cp-calc"] a') || doc.querySelector('.nav-item[data-module="cp-calc"]');
  navCalc.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitFor(() => doc.getElementById('module-cp-calc')?.classList.contains('active'), 8000);
  check('1. Parcours ICCP → Calcul CP sans perte de projet', 'PROJ-002', doc.getElementById('projectSelector').value);

  dom.window.close();
}

// ── 2. Changement de projet dans le Studio (aucun mélange) ────────────────
{
  const dom = await buildDom(`${BASE}/studio?project=PROJ-001#overview`);
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById('projectSelector')?.value === 'PROJ-001', 20000);

  check('2. Projet initial appliqué', 'PROJ-001', doc.getElementById('projectSelector').value);
  check('2. Donnée réelle de la base (iccp.current PROJ-001 = 0.197)', '0.197',
        String(dom.window.ProjectManager.getState()?.iccp?.current));

  const sel = doc.getElementById('projectSelector');
  sel.value = 'PROJ-003';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 3000));

  check('2. Bascule projet → sélecteur', 'PROJ-003', sel.value);
  check('2. Bascule projet → URL (refresh/direct URL)', 'true', String(dom.window.location.search.includes('project=PROJ-003')));
  check('2. État applicatif basculé (aucun mélange de projets)', 'PROJ-003',
        dom.window.ProjectManager.getState()?.project?.id);
  check('2. Données du projet basculé (iccp.current PROJ-003 = 0)', '0',
        String(dom.window.ProjectManager.getState()?.iccp?.current));

  // Retour PROJ-001 : continuité
  sel.value = 'PROJ-001';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 2500));
  check('2. Retour PROJ-001 → URL conservée', 'true', String(dom.window.location.search.includes('project=PROJ-001')));
  dom.window.close();
}

// ── 3. Deep-link projet sur module PDF / export ───────────────────────────
{
  const dom = await buildDom(`${BASE}/studio?project=PROJ-003#groundbed`);
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById('projectSelector')?.value === 'PROJ-003', 20000);
  check('3. Deep-link Groundbed → module actif', 'true', String(doc.getElementById('module-groundbed')?.classList.contains('active')));
  check('3. Deep-link Groundbed → projet PROJ-003', 'PROJ-003', doc.getElementById('projectSelector').value);
  check('3. Deep-link Groundbed → URL intacte', '#groundbed', dom.window.location.hash);
  dom.window.close();
}

// ── 4. Module Équipements : données réelles persistées (pas de vidage) ────
{
  const dom = await buildDom(`${BASE}/studio?project=PROJ-002#equipements`);
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById('projectSelector')?.value === 'PROJ-002', 20000);
  // Laisse passer les rechargements différés du bootstrap (PERSIST-022 ~2 s,
  // repopulations du sélecteur) : la liste ne doit jamais se vider ensuite.
  await new Promise(r => setTimeout(r, 9000));

  const rows = doc.getElementById('equipmentsTableBody');
  check('4. Équipements du projet affichés après stabilisation', 2, rows ? rows.children.length : -1);
  check('4. Aucun mélange entre projets (EMK-42 absent)', 'false',
        String(rows ? rows.textContent.includes('EMK-42') : true));
  check('4. projectId toujours actif après rechargements différés', 'PROJ-002',
        doc.getElementById('projectSelector').value);
  check('4. Donnée de calcul réelle intacte (iccp.current)', '0.311',
        String(dom.window.ProjectManager.getState()?.iccp?.current));
  dom.window.close();
}

// ── 5. Tous les modules de la sidebar : navigation + continuité projet ────
{
  const dom = await buildDom(`${BASE}/studio?project=PROJ-002#dashboard`, { waitMs: 9000 });
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById('projectSelector')?.value === 'PROJ-002', 20000);

  const navItems = Array.from(doc.querySelectorAll('.nav-item[data-module]'));
  const failures = [];
  let tested = 0;

  for (const item of navItems) {
    const moduleId = item.dataset.module;
    const disabled = item.classList.contains('disabled-module');
    (item.querySelector('a') || item).dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
    );
    await new Promise(r => setTimeout(r, 600));

    const url = dom.window.location.search + dom.window.location.hash;
    const project = dom.window.ProjectManager.getCurrentProjectId();
    const activeModule = doc.querySelector('.module.active')?.id;

    if (project !== 'PROJ-002') failures.push(`${moduleId}: projet=${project}`);
    if (!url.includes('project=PROJ-002')) failures.push(`${moduleId}: URL=${url}`);
    if (!disabled) {
      if (activeModule !== 'module-' + moduleId) failures.push(`${moduleId}: module actif=${activeModule}`);
      if (dom.window.location.hash !== '#' + moduleId) failures.push(`${moduleId}: hash=${dom.window.location.hash}`);
    }
    tested++;
  }

  check('5. Modules de la sidebar testés (tous)', navItems.length, tested);
  check('5. Aucun module de la sidebar sans conteneur', 'aucun',
        navItems.filter(i => !doc.getElementById('module-' + i.dataset.module)).map(i => i.dataset.module).join(',') || 'aucun');
  check('5. Aucun module ne perd le projet ni l’URL', 'aucune', failures.length ? failures.join(' ; ') : 'aucune');
  dom.window.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} vérifications PASS ===`);
process.exit(failed.length === 0 ? 0 : 1);
