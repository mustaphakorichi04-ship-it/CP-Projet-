// Test fonctionnel de la barre latérale du Dashboard SaaS réel (jsdom + backend Flask en cours).
// Couvre explicitement les entrées signalées comme « non fonctionnelles » :
//   Commercial & SaaS   : Abonnement & Factures PRO, Grille Tarifaire, Checkout Test (Visa)
//   Configuration       : Paramètres SaaS, Statut Serveur & API, Aide & Normes NACE
//   Modules du Studio   : Équipements, ICCP, Corrosivité, Cartographie, Groundbed
// Vérifie, pour chaque entrée : clic → onglet/module → URL (#hash) → réouverture de l'URL (F5)
// et la contextualisation du projet (aucun mélange PROJ-001/002/003).
import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = process.env.CP_E2E_BASE || 'http://127.0.0.1:5000';
const results = [];
function check(name, expected, actual) {
  const ok = expected === actual;
  results.push({ name, expected, actual, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}\n      attendu: ${expected}\n      obtenu : ${actual}`);
}

async function buildDom(url, waitMs = 6000) {
  const html = await (await fetch(url)).text();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => {});
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() { return this.textContent; },
        set(v) { this.textContent = v; },
      });
      window.fetch = (input, init) => fetch(new URL(String(input), BASE), init);
      window.scrollTo = () => {};
      window.console.warn = () => {};
      window.console.debug = () => {};
    },
  });
  await new Promise(r => setTimeout(r, waitMs));
  return dom;
}

const activeTab = (dom) => dom.window.document.querySelector('.view-tab.active')?.id || '(aucun)';
const hash = (dom) => dom.window.location.hash || '(vide)';

// ── 1. Connexion réelle puis chargement du Dashboard sur PROJ-002 ──────────
const login = await (await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
})).json();
if (!login.token) {
  console.error('❌ /api/login a échoué — vérifiez username/password (admin/admin123).');
  process.exit(1);
}

const dom = await buildDom(`${BASE}/dashboard?project=PROJ-002`);
const doc = dom.window.document;
// Le dashboard utilise le jeton JWT stocké par la page de login du SaaS.
dom.window.localStorage.setItem('cp_auth_token', JSON.stringify({
  token: login.token, expiry: Date.now() + 3600e3, userId: login.user_id, role: login.role,
}));

// ── 2. Présence de TOUTES les entrées de la barre latérale ────────────────
const ENTREES = [
  ['navBtnProjects', 'tab-projects', 'Gestion des Projets'],
  ['navBtnCalculators', 'tab-calculators', 'Simulateurs Express'],
  ['navBtnBilling', 'tab-billing', 'Abonnement & Factures PRO'],
  ['navBtnPricing', 'tab-pricing', 'Grille Tarifaire'],
  ['navBtnSettings', 'tab-settings', 'Paramètres SaaS'],
  ['navBtnStatus', 'tab-status', 'Statut Serveur & API'],
  ['navBtnSupport', 'tab-support', 'Aide & Normes NACE'],
];
for (const [id, , libelle] of ENTREES) {
  check(`2. Entrée « ${libelle} » présente`, true, !!doc.getElementById(id));
}
check('2. Entrée « Checkout Test (Visa) » présente', true, !!doc.getElementById('navBtnCheckout'));

const STUDIO_LINKS = [
  ['navStudioEquipements', 'equipements'],
  ['navStudioIccp', 'iccp'],
  ['navStudioCorrosivite', 'corrosivite'],
  ['navStudioCartography', 'cartography'],
  ['navStudioGroundbed', 'groundbed'],
];
for (const [id, module] of STUDIO_LINKS) {
  const a = doc.getElementById(id);
  check(`2. Lien Studio « ${module} » contextualisé PROJ-002`,
    `/studio?project=PROJ-002#${module}`, a ? a.getAttribute('href') : 'absent');
}

// ── 3. Clic → onglet affiché ET URL mise à jour (deep-link partageable) ──
const hashAttendu = {
  'tab-projects': '#projects', 'tab-calculators': '#calculators', 'tab-billing': '#billing',
  'tab-pricing': '#pricing', 'tab-settings': '#settings', 'tab-status': '#status', 'tab-support': '#support',
};
for (const [id, tab, libelle] of ENTREES) {
  doc.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
  doc.getElementById(id).click();
  await new Promise(r => setTimeout(r, 150));
  check(`3. Clic « ${libelle} » → onglet`, tab, activeTab(dom));
  check(`3. Clic « ${libelle} » → URL`, hashAttendu[tab], hash(dom));
}

// ── 4. Checkout Test (Visa) : modale réellement ouverte et pré-remplie ───
doc.getElementById('navBtnCheckout').click();
await new Promise(r => setTimeout(r, 250));
const modale = doc.getElementById('checkoutModal');
check('4. Checkout → modale affichée', 'flex', modale?.style.display || '(fermée)');
check('4. Checkout → plan transmis', 'Plan Professionnel', doc.getElementById('checkoutPlanTitle')?.textContent?.trim());
check('4. Checkout → carte de test pré-remplie', '4242 4242 4242 4242', doc.getElementById('inputCardNumber')?.value);
dom.window.close();

// ── 5. Réouverture directe de l'URL (équivalent F5 après clic) ───────────
for (const [, tab, libelle] of ENTREES) {
  const d2 = await buildDom(`${BASE}/dashboard?project=PROJ-002${hashAttendu[tab]}`, 4000);
  check(`5. URL directe ${hashAttendu[tab]} (${libelle}) → onglet`, tab, activeTab(d2));
  d2.window.close();
}

// ── 6. Aucun mélange entre projets : sidebar = projet actif, cartes = leur projet ──
const d3 = await buildDom(`${BASE}/dashboard?project=PROJ-003#projects`, 5000);
const doc3 = d3.window.document;
check('6. Lien Studio de la sidebar = projet actif (PROJ-003)', '/studio?project=PROJ-003#iccp',
  doc3.getElementById('navStudioIccp')?.getAttribute('href'));
const liensSidebar = [...doc3.querySelectorAll('aside a[href*="/studio"]')].map(a => a.getAttribute('href'));
// 6 liens : bouton « Ouvrir Studio » de l'en-tête + les 5 modules du Studio.
check('6. Liens Studio de la sidebar contextualisés (6)', 6, liensSidebar.length);
check('6. Aucun lien de la sidebar vers un autre projet', true,
  liensSidebar.every(h => h.includes('project=PROJ-003')));

const cartes = [...doc3.querySelectorAll('#allProjectsTbody tr')];
check('6. Cartes projets réelles affichées (3)', 3, cartes.length);
const malCiblees = cartes.filter(tr => {
  const id = (tr.querySelector('strong')?.textContent || '').trim().split(' ')[0];
  const liens = [...tr.querySelectorAll('a[href*="/studio"]')].map(a => a.getAttribute('href'));
  return liens.length === 0 || !liens.every(h => h.includes(`project=${id}`));
});
check('6. Chaque carte projets cible SON projet (0 carte mal ciblée)', 0, malCiblees.length);
check('6. Projets réels dans le sélecteur (3)', 3,
  [...doc3.querySelectorAll('#workspaceSelect option')].filter(o => /^PROJ-00\d$/.test(o.value)).length);
d3.window.close();

const total = results.length;
const ok = results.filter(r => r.ok).length;
console.log(`\n=== ${ok}/${total} vérifications PASS ===`);
process.exit(ok === total ? 0 : 1);
