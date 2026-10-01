// ============================================================
// router.js – CP Engineer Pro – Routeur de navigation du Studio
// ============================================================
// RÔLE
//   Assurer la continuité du contexte projet entre le Dashboard
//   SaaS (/) et le Studio (/studio), et rendre la navigation
//   adressable (deep-link, refresh, retour/avant navigateur).
//
// URL CANONIQUE
//   /studio?project=<PROJECT_ID>#<module-id>
//   Exemples :
//     /studio?project=PROJ-001#iccp
//     /studio?project=PROJ-002#groundbed
//     /studio#equipements
//
// CONTRAT
//   - Lit l'URL au démarrage (y compris après refresh) ;
//   - Applique le module via UI.switchModule() — aucune logique de
//     calcul n'est dupliquée ici ;
//   - Applique le projet via le sélecteur existant (#projectSelector)
//     en réutilisant le flux ui.js `projectSelector.onchange` ;
//   - Charge le projet depuis la base si absent localement
//     (StorageManager.ensureProjectFromServer) ;
//   - Réécrit l'URL quand l'utilisateur change de module ou de projet ;
//   - Répond à hashchange/popstate (boutons retour/avant).
//
// Ce fichier ne contient AUCUN calcul métier.
// ============================================================

(function () {
    'use strict';

    if (typeof window === 'undefined') return;
    if (window.StudioRouter && window.StudioRouter.__v1) return;

    const PROJECT_PARAM = 'project';
    const DEFAULT_LINK_SELECTORS = {
        dashboardLink: 'a[href="/dashboard"], a[href^="/dashboard?"]'
    };

    // ============================================================
    // 1. HELPERS PURS (testables sans DOM)
    // ============================================================

    /**
     * Extrait le contexte de navigation depuis une URL de Studio.
     * @param {string} search  - window.location.search (ex. "?project=PROJ-002")
     * @param {string} hash    - window.location.hash   (ex. "#groundbed")
     * @returns {{projectId: (string|null), moduleId: (string|null)}}
     */
    function parseStudioRoute(search, hash) {
        const result = { projectId: null, moduleId: null, params: {} };

        if (typeof search === 'string' && search.length > 0) {
            const raw = search.charAt(0) === '?' ? search.substring(1) : search;
            const params = new URLSearchParams(raw);
            const project = params.get(PROJECT_PARAM);
            if (project && /^[A-Za-z0-9\-_]{1,64}$/.test(project)) {
                result.projectId = project;
            }
            ['new', 'name', 'id', 'standard', 'length', 'action'].forEach(key => {
                const value = params.get(key);
                if (value !== null) result.params[key] = value;
            });
        }

        if (typeof hash === 'string' && hash.length > 1) {
            const rawHash = hash.charAt(0) === '#' ? hash.substring(1) : hash;
            // Tolérance : "#iccp?project=PROJ-002" et "#iccp/PROJ-002"
            const candidate = rawHash.split(/[?/&]/)[0].trim();
            if (candidate) {
                result.moduleId = candidate;
            }
            // projectId éventuellement porté par le hash (compatibilité)
            if (!result.projectId) {
                const hashParams = rawHash.split('?')[1];
                if (hashParams) {
                    const project = new URLSearchParams(hashParams).get(PROJECT_PARAM);
                    if (project && /^[A-Za-z0-9\-_]{1,64}$/.test(project)) {
                        result.projectId = project;
                    }
                }
            }
        }

        return result;
    }

    /**
     * Construit l'URL du Studio à partir du contexte courant.
     * @param {string|null} projectId
     * @param {string|null} moduleId
     * @returns {string}
     */
    function buildStudioUrl(projectId, moduleId) {
        let url = '/studio';
        if (projectId) {
            url += '?' + PROJECT_PARAM + '=' + encodeURIComponent(projectId);
        }
        if (moduleId) {
            url += '#' + moduleId;
        }
        return url;
    }

    /**
     * Construit l'URL du Dashboard SaaS en conservant le projet actif.
     * @param {string|null} projectId
     * @returns {string}
     */
    function buildDashboardUrl(projectId) {
        return projectId
            ? '/dashboard?' + PROJECT_PARAM + '=' + encodeURIComponent(projectId)
            : '/dashboard';
    }

    // ============================================================
    // 2. ÉTAT INTERNE
    // ============================================================

    let _applyingUrl = false;
    let _bootstrapped = false;

    // Contexte demandé par l'URL (?project= / #module) tant qu'il n'est pas
    // appliqué. Il protège le deep-link contre les réécritures d'URL du
    // bootstrap de l'application (module par défaut = dashboard).
    let _pendingRoute = null;

    function getCurrentProjectId() {
        if (window.ProjectManager && typeof window.ProjectManager.getCurrentProjectId === 'function') {
            return window.ProjectManager.getCurrentProjectId();
        }
        const selector = document.getElementById('projectSelector');
        return (selector && selector.value && selector.value !== '__all__') ? selector.value : null;
    }

    function getActiveModuleId() {
        const active = document.querySelector('.module.active');
        if (active && active.id && active.id.indexOf('module-') === 0) {
            return active.id.substring('module-'.length);
        }
        const navItem = document.querySelector('.nav-item.active');
        return (navItem && navItem.dataset) ? (navItem.dataset.module || null) : null;
    }

    /**
     * Retourne l'entrée de menu d'un module sans dépendre de CSS.escape
     * (non implémenté par tous les moteurs → ReferenceError qui
     * interrompait l'application de l'URL).
     * @param {string} moduleId
     * @returns {Element|null}
     */
    function getNavItem(moduleId) {
        if (!moduleId) return null;
        const items = document.querySelectorAll('.nav-item[data-module]');
        for (let i = 0; i < items.length; i++) {
            if (items[i].dataset && items[i].dataset.module === moduleId) return items[i];
        }
        return null;
    }

    function moduleExists(moduleId) {
        return !!getNavItem(moduleId);
    }

    /**
     * Libère le contexte deep-link uniquement lorsqu'il est réellement
     * appliqué (le chargement du projet est asynchrone : `getCurrentProjectId()`
     * peut encore renvoyer l'ancien projet juste après le dispatch du change).
     */
    function releaseAppliedPendingRoute() {
        if (!_pendingRoute) return;
        if (_pendingRoute.projectId && getCurrentProjectId() === _pendingRoute.projectId) {
            _pendingRoute.projectId = null;
        }
        if (_pendingRoute.moduleId && getActiveModuleId() === _pendingRoute.moduleId) {
            _pendingRoute.moduleId = null;
        }
        if (!_pendingRoute.projectId && !_pendingRoute.moduleId) {
            _pendingRoute = null;
        }
    }

    // ============================================================
    // 3. APPLICATION DU CONTEXTE
    // ============================================================

    /**
     * Applique le module demandé en réutilisant le clic du menu
     * (donc UI.switchModule + les listeners app.js de lazy-loading).
     * @param {string} moduleId
     * @returns {boolean}
     */
    function applyModule(moduleId) {
        if (!moduleId || !moduleExists(moduleId)) return false;

        const navItem = getNavItem(moduleId);
        if (!navItem) return false;

        if (navItem.classList.contains('disabled-module')) {
            return false;
        }

        const alreadyActive = navItem.classList.contains('active') &&
            document.getElementById('module-' + moduleId)?.classList.contains('active');
        if (alreadyActive) return true;

        navItem.click();
        return true;
    }

    /**
     * Applique le projet demandé via le sélecteur existant.
     * @param {string} projectId
     * @returns {Promise<boolean>}
     */
    async function applyProject(projectId) {
        if (!projectId || !window.ProjectManager) return false;

        const resolveSelector = () => document.getElementById('projectSelector');

        // Lecture locale d'abord ; si le projet demandé n'y est pas, la liste
        // est rafraîchie depuis la base (contrat : l'URL demande un projet
        // réel, le Studio doit le charger même au premier affichage).
        await window.ProjectManager.loadProjectsList({ skipServer: true });
        let projects = window.ProjectManager.getProjectsList() || [];

        if (!projects.some(p => p.id === projectId)) {
            await window.ProjectManager.loadProjectsList({ forceHydration: true });
            projects = window.ProjectManager.getProjectsList() || [];
            if (projects.some(p => p.id === projectId) &&
                window.UI && typeof window.UI.populateProjectSelector === 'function') {
                window.UI.populateProjectSelector();
            }
        }

        if (!projects.some(p => p.id === projectId) &&
            window.StorageManager &&
            typeof window.StorageManager.ensureProjectFromServer === 'function') {
            const fetched = await window.StorageManager.ensureProjectFromServer(projectId);
            if (fetched) {
                await window.ProjectManager.loadProjectsList({ skipServer: true });
                projects = window.ProjectManager.getProjectsList() || [];
                if (window.UI && typeof window.UI.populateProjectSelector === 'function') {
                    window.UI.populateProjectSelector();
                }
            }
        }

        if (!projects.some(p => p.id === projectId)) {
            console.warn('[Router] Projet introuvable (local + base) :', projectId);
            return false;
        }

        const selector = resolveSelector();
        if (!selector) return false;

        const currentId = (typeof window.ProjectManager.getCurrentProjectId === 'function')
            ? window.ProjectManager.getCurrentProjectId()
            : null;

        if (selector.value !== projectId) {
            selector.value = projectId;
        }

        // Le chargement du projet est déclenché par l'événement 'change' du
        // sélecteur. On le (re)joue tant que le projet courant n'est pas celui
        // demandé : au premier passage le bootstrap applicatif peut ne pas
        // avoir encore branché son écouteur (l'événement serait perdu).
        if (currentId !== projectId) {
            selector.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
    }

    /**
     * Ouvre la modale « Nouveau projet » du Studio, pré-remplie
     * (utilisée lorsque le Dashboard délègue la création au Studio).
     * @param {{id?: string, name?: string}} params
     * @returns {boolean}
     */
    function openNewProjectModal(params) {
        const btn = document.getElementById('newProjectBtn');
        const modal = document.getElementById('projectModal');
        if (!btn || !modal) return false;

        btn.click();

        const idField = document.getElementById('newProjectId');
        const nameField = document.getElementById('newProjectName');
        if (idField && params.id) idField.value = params.id;
        if (nameField && params.name) nameField.value = params.name;

        return true;
    }

    /**
     * Déclenche l'export PDF du projet actif (bouton existant du Studio).
     * @returns {boolean}
     */
    function triggerPdfExport() {
        const btn = document.getElementById('exportPDFBtn');
        if (!btn) return false;
        btn.click();
        return true;
    }

    /**
     * Applique l'URL courante (module + projet + actions déléguées).
     */
    async function applyCurrentUrl() {
        if (_applyingUrl) return;
        _applyingUrl = true;
        try {
            const route = parseStudioRoute(window.location.search, window.location.hash);
            const params = route.params || {};
            // Le contexte en attente (mémorisé au démarrage) reste prioritaire :
            // il permet les re-tentatives même si l'application a réécrit l'URL.
            const projectId = route.projectId || (_pendingRoute && _pendingRoute.projectId) || null;
            const moduleId = route.moduleId || (_pendingRoute && _pendingRoute.moduleId) || null;

            if (projectId) {
                const applied = await applyProject(projectId);
                if (!applied) {
                    console.warn('[Router] Contexte projet non appliqué :', projectId);
                }
            }

            if (moduleId && moduleExists(moduleId)) {
                applyModule(moduleId);
            }

            releaseAppliedPendingRoute();

            // Action déléguée par le Dashboard : génération du rapport PDF
            if (params.action === 'pdf') {
                setTimeout(() => {
                    if (!triggerPdfExport()) {
                        console.warn('[Router] Export PDF indisponible dans le Studio');
                    }
                }, 1500);
            }

            // Action déléguée : création d'un projet depuis le Dashboard
            if (params.new === '1') {
                setTimeout(() => {
                    openNewProjectModal({ id: params.id, name: params.name });
                }, 900);
            }
        } catch (e) {
            console.warn('[Router] Application URL échouée:', e);
        } finally {
            _applyingUrl = false;
        }
    }

    // ============================================================
    // 4. SYNCHRONISATION DE L'URL (sens inverse)
    // ============================================================

    function syncUrl(options) {
        if (_applyingUrl) return;
        const replace = !!(options && options.replace);
        // Tant qu'un deep-link n'est pas appliqué, l'URL demandée fait foi :
        // sinon le bootstrap (module dashboard sans projet) écraserait
        // ?project=<ID>#<module> et le contexte serait définitivement perdu.
        const pending = _pendingRoute || {};
        const projectId = pending.projectId || getCurrentProjectId();
        const moduleId = pending.moduleId || getActiveModuleId();
        const nextUrl = buildStudioUrl(projectId, moduleId);

        const currentUrl = window.location.pathname + window.location.search + window.location.hash;
        if (currentUrl === nextUrl) return;

        try {
            if (replace) {
                window.history.replaceState({ studioRoute: true }, '', nextUrl);
            } else {
                window.history.pushState({ studioRoute: true }, '', nextUrl);
            }
        } catch (e) {
            console.warn('[Router] Mise à jour URL impossible:', e);
        }
    }

    /**
     * Réconcilie l'état applicatif avec l'URL (contrat de navigation).
     *
     * Le bootstrap de l'application (sélecteur de projets, rechargements
     * différés) peut se terminer APRÈS le routeur et réinitialiser le projet
     * actif. Tant que l'URL demande un projet, on réapplique le contexte
     * (opération idempotente : ne fait rien si le projet est déjà actif).
     *
     * @returns {Promise<boolean>} true si le contexte de l'URL est appliqué.
     */
    async function reconcileFromUrl() {
        if (_applyingUrl) return true;
        const route = parseStudioRoute(window.location.search, window.location.hash);
        if (!route.projectId && !route.moduleId) return true;

        let consistent = true;

        if (route.projectId && getCurrentProjectId() !== route.projectId) {
            consistent = false;
            const applied = await applyProject(route.projectId);
            if (applied && getCurrentProjectId() === route.projectId) consistent = true;
        }

        if (route.moduleId && getActiveModuleId() !== route.moduleId) {
            consistent = false;
            if (applyModule(route.moduleId) && getActiveModuleId() === route.moduleId) consistent = true;
        }

        releaseAppliedPendingRoute();
        return consistent;
    }

    /**
     * Le lien « Tableau de bord SaaS » doit ramener le contexte projet.
     */
    function syncBackLink() {
        const projectId = getCurrentProjectId();
        document.querySelectorAll(DEFAULT_LINK_SELECTORS.dashboardLink).forEach(link => {
            link.setAttribute('href', buildDashboardUrl(projectId));
        });
    }

    // ============================================================
    // 5. ÉCOUTEURS
    // ============================================================

    function setupListeners() {
        // Clics sur le menu latéral (y compris clics programmatiques via .click())
        document.addEventListener('click', function (event) {
            const navItem = event.target && event.target.closest
                ? event.target.closest('.nav-item[data-module]')
                : null;
            if (!navItem) return;
            setTimeout(() => { syncUrl(); syncBackLink(); }, 0);
        }, true);

        // Changement de projet via le sélecteur existant
        document.addEventListener('change', function (event) {
            const target = event.target;
            if (!target || target.id !== 'projectSelector') return;
            if (!_applyingUrl && _pendingRoute && target.value !== _pendingRoute.projectId) {
                _pendingRoute.projectId = null; // choix utilisateur explicite
            }
            setTimeout(() => { syncUrl(); syncBackLink(); }, 0);
        }, true);

        // Événement émis par UI.switchModule (navigation programmatique)
        document.addEventListener('moduleChanged', function () {
            if (_applyingUrl) return;
            syncUrl();
        });

        // Retour/avant navigateur
        window.addEventListener('hashchange', function () {
            if (_applyingUrl) return;
            const moduleId = parseStudioRoute('', window.location.hash).moduleId;
            if (moduleId) {
                applyModule(moduleId);
            }
            syncBackLink();
        });

        window.addEventListener('popstate', function () {
            if (_applyingUrl) return;
            applyCurrentUrl();
            syncBackLink();
        });

        // Hydratation tardive de la base : re-résoudre le projet de l'URL
        document.addEventListener('projectsHydrated', function () {
            reconcileFromUrl();
        });
    }

    // ============================================================
    // 6. DÉMARRAGE
    // ============================================================

    function waitForProjectManager(maxAttempts, delayMs) {
        return new Promise(resolve => {
            let attempts = 0;
            const tick = () => {
                if (window.ProjectManager && window.UI && typeof window.UI.populateProjectSelector === 'function') {
                    resolve(true);
                    return;
                }
                attempts++;
                if (attempts >= maxAttempts) { resolve(false); return; }
                setTimeout(tick, delayMs);
            };
            tick();
        });
    }

    async function bootstrap() {
        if (_bootstrapped) return;
        _bootstrapped = true;

        // Mémorise le contexte AVANT toute réécriture d'URL par l'application.
        const initial = parseStudioRoute(window.location.search, window.location.hash);
        if (initial.projectId || initial.moduleId) {
            _pendingRoute = { projectId: initial.projectId, moduleId: initial.moduleId };
        }

        const ready = await waitForProjectManager(60, 150);
        if (!ready) {
            console.warn('[Router] ProjectManager/UI indisponible — routage partiel.');
        }

        await applyCurrentUrl();

        // Ré-application différée, bornée : le bootstrap de ui.js/app.js
        // (sélecteur de projets, rechargements forcés) se termine après le
        // routeur et peut réinitialiser le projet actif. On vérifie donc la
        // cohérence URL ↔ état à plusieurs reprises, puis on arrête.
        const RECONCILE_DELAYS_MS = [800, 2000, 3500, 5000, 7000, 10000, 14000];
        RECONCILE_DELAYS_MS.forEach(delay => {
            setTimeout(async () => {
                const consistent = await reconcileFromUrl();
                syncBackLink();
                if (consistent && delay >= 3500) {
                    if (_pendingRoute) {
                        _pendingRoute = null;
                        syncUrl({ replace: true });
                    }
                }
            }, delay);
        });

        // Dernier contrôle : si le projet demandé n'existe pas en base, on
        // libère le contexte (et seulement dans ce cas prouvé). Un projet
        // existant mais pas encore chargé garde son URL intacte : le
        // contexte sera appliqué au prochain cycle, jamais écrasé.
        setTimeout(async () => {
            if (!_pendingRoute || !_pendingRoute.projectId) return;
            const wanted = _pendingRoute.projectId;
            const applied = await reconcileFromUrl();
            if (applied) return;
            const projects = (window.ProjectManager && typeof window.ProjectManager.getProjectsList === 'function')
                ? (window.ProjectManager.getProjectsList() || [])
                : null;
            const known = projects === null ? true : projects.some(p => p.id === wanted);
            if (!known) {
                console.warn('[Router] Projet demandé absent de la base :', wanted);
                _pendingRoute = null;
            } else {
                console.warn('[Router] Contexte projet toujours en attente :', wanted);
            }
        }, 15000);
    }

    // ============================================================
    // 7. API PUBLIQUE
    // ============================================================

    const StudioRouter = {
        __v1: true,
        parseStudioRoute,
        buildStudioUrl,
        buildDashboardUrl,
        applyCurrentUrl,
        applyModule,
        applyProject,
        reconcileFromUrl,
        syncUrl,
        syncBackLink,
        bootstrap,
        getActiveModuleId,
        getCurrentProjectId,
        openNewProjectModal,
        triggerPdfExport
    };

    window.StudioRouter = StudioRouter;

    // Export Node (tests unitaires du parseur, sans DOM)
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioRouter;
    }

    setupListeners();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }

    console.log('[Router] ✅ Routeur Studio actif — /studio?project=<ID>#<module>');
})();
