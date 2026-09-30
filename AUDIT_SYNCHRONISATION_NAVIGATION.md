# CP Engineer Pro — Audit synchronisation, état, `projectId`, routage et navigation

Date : 2026-09-30
Périmètre : Dashboard SaaS (`dashboard.html`), Vue d'ensemble React (`apps/web`), Studio SPA (`index.html` + `router.js`, `ui.js`, `app.js`, `controller.js`, `storage.js`, `storage-proxy.js`), API Flask (`backend.py`), base `cp_data.db` (projets réels PROJ-001, PROJ-002, PROJ-003).

Aucun fichier de calcul n'a été ouvert en écriture : `engine.js`, `cp-controller.js`, `ICCPOptimizationEngine.js`, `acCorrosionEngine.js`, `cableLengthEngine.js`, `transformerRectifierEngine.js`, `micEngine.js`, `cp-worker.js`, `pdfReport.js`, `pdf-report-*.js` sont identiques au bit près (comparaison MD5 avant/après, section 9).

---

## 1. Méthode — flux réellement tracé

`Chargement → Projet → State → Navigation → Module → Données → Sauvegarde → Synchronisation → Dashboard`

Pour chaque maillon, l'audit a vérifié : la source de vérité, le format d'URL, le portage du `projectId`, les points de rupture et la possibilité de revenir au Dashboard sans perdre le contexte. Chaque correctif n'a été écrit qu'après reproduction de la cause racine (test jsdom + backend réel, base de test `cp_data.db`).

## 2. Architecture constatée

| Couche | Fichier(s) | Rôle |
|---|---|---|
| Base réelle | `cp_data.db` (tables `projects`, `equipments`, `field_measurements`, `groundbeds`, `history`) | source de vérité unique |
| API / Services | `backend.py` (`/api/projects`, `/api/projects/<id>`, `/api/equipments`, `/api/projects/<id>/full-sync`, `/api/dashboard/summary`) | exposition des données réelles |
| Persistance locale | `storage.js` (IndexedDB + miroir localStorage), `storage-proxy.js` (proxy API + hydratation) | cache offline-first |
| Contrôleur | `controller.js` (`ProjectManager`) | `loadProject`, `loadProjectsList`, état applicatif |
| UI Studio | `ui.js` (modules, `switchModule`), `app.js` (bootstrap, onglets) | rendu des modules |
| Routeur Studio | `router.js` | URL `/studio?project=<ID>#<module>` |
| Dashboard SaaS | `dashboard.html` (`?project=<ID>#<onglet>`) et `apps/web` (`/dashboard[/section]?project=<ID>`) | vue transverse |

## 3. Constats et causes racines

### C1 — Le Studio ne lisait jamais la base : liste de projets locale uniquement (CRITIQUE)
- **Symptôme** : dans un navigateur neuf, le sélecteur de projets du Studio restait vide (ou incomplet) ; `/studio?project=PROJ-002` échouait silencieusement.
- **Cause racine** : `controller.js::loadProjectsList()` s'appuyait exclusivement sur `StorageManager.loadProjects()` (IndexedDB/localStorage). Les fonctions d'hydratation existaient dans `storage-proxy.js` mais n'étaient appelées nulle part.
- **Correctif** : appel de `StorageManager.hydrateProjectsFromServer()` dans `loadProjectsList()` (non destructif, throttlé 60 s, silencieux hors ligne) et repli `StorageManager.ensureProjectFromServer(projectId)` dans `loadProject()` pour les projets absents localement.
- **Fichiers** : `controller.js`, `storage-proxy.js`.

### C2 — `migrateGroundbeds()` plantait sur tout projet sans `systems` (CRITIQUE)
- **Symptôme** : `TypeError: Cannot read properties of undefined (reading 'filter')` → rejet de promesse non capturé ; `loadProject()` s'interrompait, le projet demandé n'était jamais chargé et le Studio retombait sur PROJ-001 (mélange de projets).
- **Cause racine** : `controller.js:1150` (`state.systems.filter(...)`) sans garde, alors que `loadProject()` normalise `dashboard`, `history`, `mapPoints`, `iccp`, `groundbeds`… mais pas `systems`.
- **Correctif** : normalisation `state.systems = []` dans `loadProject()` + garde locale dans `migrateGroundbeds()`.

### C3 — Écriture locale avant ouverture d'IndexedDB : `DB not initialized` (HAUT)
- **Symptôme** : lors d'un deep-link, l'hydratation du projet échouait (`Error: DB not initialized` remontée par `[Router] Application URL échouée`), donc le projet de l'URL était perdu.
- **Cause racine** : `storage.js::forceSave()` levait une exception quand `db` n'était pas encore ouverte par le bootstrap.
- **Correctif** : miroir localStorage (facteur commun `mirrorToLocalStorage`) au lieu de l'exception, pour `forceSave()` et `forceDelete()`.

### C4 — L'URL était écrasée par le module par défaut : perte du `projectId` (CRITIQUE)
- **Symptôme** : `/studio?project=PROJ-002#iccp` devenait `/studio#dashboard` ; PROJ-002 → PROJ-001 après un clic de menu.
- **Cause racine** : au démarrage, `router.js::syncUrl()` reconstruisait l'URL à partir de l'état courant (`getActiveModuleId()` = `dashboard`, `getCurrentProjectId()` = `null` pendant le chargement asynchrone) ; le `?project=` demandé était supprimé avant d'avoir pu être appliqué.
- **Correctif** : contexte de deep-link mémorisé (`_pendingRoute`) au bootstrap et préservé dans `syncUrl()` tant qu'il n'est pas réellement appliqué (`releaseAppliedPendingRoute()` compare `getCurrentProjectId()`/`getActiveModuleId()`), libération explicite après 5 s si le projet n'existe pas.

### C5 — `CSS.escape` absent : le routeur s'arrêtait avant d'appliquer l'URL (HAUT)
- **Symptôme** : `ReferenceError: CSS is not defined` dans `moduleExists()` → `applyCurrentUrl()` abandonnait, aucun module de l'URL n'était activé.
- **Correctif** : `getNavItem(moduleId)` parcourt `.nav-item[data-module]` (plus de dépendance à `CSS.escape`, également plus sûr vis-à-vis de l'injection d'attribut).

### C6 — L'événement `change` du sélecteur était perdu au démarrage (HAUT)
- **Symptôme** : le sélecteur affichait PROJ-002 mais `ProjectManager.getCurrentProjectId()` restait PROJ-001 (état et UI désynchronisés).
- **Cause racine** : `applyProject()` ne (re)jouait l'événement `change` que si `selector.value` différait ; or le premier dispatch pouvait avoir lieu avant le branchement de `projectSelector.onchange` par `app.js`.
- **Correctif** : le `change` est rejoué tant que `ProjectManager.getCurrentProjectId()` ne correspond pas au projet demandé.

### C7 — `fetchWithRetry` levait une exception sur tout 4xx : le repli « 409 → PUT » était mort (HAUT)
- **Symptôme** : `Erreur client (409)` en boucle sur la synchronisation des équipements, message « Backend indisponible » alors que l'API répondait.
- **Cause racine** : le repli écrit dans `syncEquipment()` (`if (response.status === 409) → PUT`) était inatteignable, `fetchWithRetry` levant avant tout retour de réponse.
- **Correctif** : option `returnClientError` + factorisation `upsertEquipmentOnServer()` (POST puis PUT si 409), réutilisée par `StorageManager.saveEquipment()`.

### C8 — Dashboard : onglets et projet non portés par l'URL (MOYEN)
- **Symptôme** : clic sur un onglet → URL inchangée ; refresh → retour à la vue d'ensemble ; lien direct `#projects` ignoré ; le `#hash` entrant était écrasé par l'onglet par défaut.
- **Correctif** : `getTabIdFromUrl()` (lecture unique du hash), `state.currentTab` initialisé depuis l'URL avant la réécriture (`updateDashboardUrl({replace:true})`), écoute `hashchange`/`popstate`.

### C9 — Données mockées / inventées (MOYEN → supprimées)
| Emplacement | Valeur inventée | Remplacement |
|---|---|---|
| `backend.py` `/api/dashboard/summary` | `naceCompliancePercent: 100.0`, `"100 %"`, critère « validé » | conformité calculée sur `field_measurements.compliant` ; **aucune mesure → `null` (N/A)** |
| `backend.py` | `coatingType` défaut `'3LPE'`, `coatingCondition` défaut `'neuf'` | valeur réelle de l'équipement, sinon `null` |
| `backend.py` | `model` défaut `'TR-002'`, `power` défaut `300` | valeurs réelles, sinon `null` |
| `backend.py` | statut « Protégé (-850 mV CSE) » / « Actif » | statut réel stocké, sinon `null` (N/A) |
| `backend.py` | groundbed `anodeCount: 16`, `totalDepth: 200`, `R_total: 22.42`, `lifeDesign: 25` | dimensions/résultats réels, sinon `null` |
| `dashboard.html` | textes statiques « Projet EMK », KPI figés, sandbox | rendus depuis `/api/dashboard/summary` |
| `apps/web` (`DashboardPage.tsx`) | constantes `MOCK_PROJECTS` (GZ-Nord Alger, Arzew LNG…) | `cpApi.ts` → `/api/v1/projects` (BFF) ou `/api/dashboard/summary` |
| `index.html` | script inline `UI.switchModule(hash)` (jamais exécuté : fonction non exportée à l'époque, aucun portage de projet) | `router.js` (déclaré après `ui.js`/`app.js`) |

Règle appliquée partout : **donnée réelle sinon `N/A`**, jamais de valeur inventée.

Seule occurrence résiduelle d'un toponyme simulé : une fixture de test unitaire (`apps/api/test/compliance.spec.ts`), hors runtime applicatif.

### C11 — Le tableau « Équipements » du Studio se vidait (CRITIQUE)
- **Symptôme** : `/studio?project=PROJ-002#equipements` affichait d'abord les 2 équipements réels puis, ~1 s plus tard, un tableau vide (et le filtre projet retombait sur « Tous les projets »).
- **Cause racine** (chaîne complète, reproduite en instrumentant `app.js`/`storage.js`) :
  1. les équipements hydratés depuis la base n'étaient conservés qu'en mémoire (`_memoryCache`) — jamais écrits dans le stockage local du navigateur ;
  2. `app.js` (PERSIST-022) relance un chargement **forcé** (`loadEquipmentsForProject(projectId, true)`) ~2 s après le démarrage ; la lecture IndexedDB étant vide, elle renvoyait `[]`, **écrasait le cache mémoire** et l'état applicatif ;
  3. `ui.js::refreshEquipmentListUI()` rendait alors un tableau vide.
- **Correctif** : persistance locale des équipements hydratés (`originalSaveEquipment`, voie locale pure, aucun appel API), garde « une lecture locale vide n'écrase jamais une liste non vide », et pas de relecture forcée pendant une sauvegarde interne.

### C12 — Le sélecteur de projets écrasait le projet actif (CRITIQUE)
- **Symptôme** : le projet de l'URL était appliqué puis perdu lors des repopulations tardives du sélecteur (`__all__` réaffiché), entraînant le rechargement d'un autre projet et la perte du contexte.
- **Cause racine** : `ui.js::populateProjectSelector()` donnait la priorité à la valeur courante `__all__` sur le projet réellement actif (`ProjectManager.getCurrentProjectId()`).
- **Correctif** : ordre de priorité explicite — valeur explicite ≠ `__all__` → projet actif → projet demandé par l'URL → `__all__` → dernier projet utilisé → premier projet.

### C13 — Course de disponibilité backend : liste de projets jamais hydratée (HAUT)
- **Symptôme** : selon le moment où le bootstrap du Studio s'exécutait par rapport à la restauration du jeton / au contrôle `/api/version`, la liste des projets restait vide et le deep-link `?project=` échouait **définitivement** (aucune nouvelle tentative prévue).
- **Causes racines** : (a) l'hydratation dépendait de l'indicateur `_isBackendAvailable`, mis à `false` par n'importe quel 4xx transitoire et jamais réévalué avant 30 s ; (b) aucune hydratation n'était déclenchée lors du retour de disponibilité ; (c) le routeur abandonnait le deep-link après 5 s **en supprimant `?project=` de l'URL**, ce qui rendait toute re-tentative impossible.
- **Correctif** : lectures base conditionnées à la seule authentification (une lecture réussie rétablit la disponibilité), hydratation déclenchée au retour du backend et après connexion, réconciliateur URL ↔ état borné côté routeur, et plus aucune suppression de `?project=` en cas d'échec (nettoyage uniquement si le projet est prouvé absent de la base).

### C14 — Entrée de menu « Historique » sans module (HAUT)
- **Symptôme** : cliquer « Historique » dans la sidebar activait l'entrée de menu mais **vidait la zone de contenu** (aucun `#module-history` en HTML), et `refreshHistoryTable()` n'avait aucune cible (`#historyTableBody` absent).
- **Correctif** : ajout du conteneur de module manquant `#module-history` + `#historyTableBody` (+ filtre module et bouton d'effacement déjà attendus par `ui.js`) ; le rendu existant (`loadHistory`/`refreshHistoryTable`) fonctionne tel quel et affiche l'historique réel du projet, ou « Aucun historique disponible » (aucune donnée inventée).

### C15 — Barre latérale du Dashboard : entrées « Commercial & SaaS » et « Configuration & Support » sans route (MOYEN)
- **Périmètre** : Dashboard SaaS (`/dashboard`) — entrées « 💳 Abonnement & Factures PRO », « 💎 Grille Tarifaire », « 🛒 Checkout Test (Visa) », « ⚙️ Paramètres SaaS », « 🟢 Statut Serveur & API », « ❓ Aide & Normes NACE », ainsi que les 5 liens directs vers les modules du Studio et le bouton « Ouvrir Studio ».
- **Cause racine** : ces entrées appelaient `showTab()`/`openCheckoutModal()` **définis nulle part dans l'URL** — le clic changeait bien la classe `.view-tab.active`, mais **l'adresse ne changeait pas** : impossible de partager/rafraîchir/revenir sur l'onglet, et aucun des liens `/studio` n'était contextualisé (`/studio#iccp` sans `?project=`, donc retombée sur un autre projet). Aucune route n'existait pour la barre latérale du Dashboard.
- **Correctif (C8)** : `getTabIdFromUrl()`, `state.currentTab` initialisé depuis le hash **avant** la réécriture d'URL, mise à jour du hash à chaque `showTab()` (`#projects`, `#calculators`, `#billing`, `#pricing`, `#settings`, `#status`, `#support`), écoute `hashchange`/`popstate`, et `syncStudioLinks()` qui réécrit tous les liens `/studio` (+ bouton « Ouvrir Studio ») avec `?project=<ID actif>`.
- **Vérification** : `tests/e2e/test-dashboard-sidebar.e2e.mjs` — **43/43** (présence des 14 entrées, clic → onglet + URL, réouverture de chaque URL directe, modale Checkout pré-remplie, sidebar et cartes projets sans mélange inter-projets).

### C10 — État concurrent (MOYEN)
- `projectSelector.onchange` est assigné deux fois (`ui.js:7347` puis `app.js:2097`) : la seconde affectation écrase la première (les deux implémentations sont équivalentes, mais la redondance est signalée comme risque de régression si l'ordre des scripts change).
- Le Studio écrivait dans `/api/equipments` sans jamais lire les équipements existants côté base (blob `projects.data` = source de vérité) ; traité par le repli 409 → PUT (C7) et par la persistance locale des équipements hydratés (C11).
- Les fichiers `vendor/` (Chart.js, Leaflet, Three.js) ne sont pas fournis par le dépôt : cartographie, graphiques et 3D restent vides (dégradation propre, pré-existante, hors périmètre calcul).

## 4. Contrats d'URL retenus (inchangés, désormais respectés)

| Contexte | URL canonique |
|---|---|
| Studio, module + projet | `/studio?project=<ID>#<module>` |
| Dashboard SaaS | `/dashboard?project=<ID>#<onglet>` (onglets : overview, projects, calculators, billing, pricing, settings, status, support) |
| Vue d'ensemble React | `/dashboard[/projects|/calculations|/gis|/reports|/settings]?project=<ID>` |
| Création déléguée | `/studio?new=1&name=<nom>&id=<ID>&standard=<std>&length=<km>` |
| Export PDF délégué | `/studio?project=<ID>&action=pdf` |

## 5. Continuité du `projectId` — chaîne vérifiée

`URL ?project=` → `router.js::applyProject()` → `#projectSelector` (événement `change`) → `ProjectManager.loadProject()` → `StorageManager.loadProjects()/ensureProjectFromServer()` → état `state.project.id` → modules → `syncUrl()` (URL réécrite) → lien retour `/dashboard?project=<ID>` → Dashboard (projet actif restauré).

Aucun module n'invente d'identifiant : `dataResolver.js`, `gisIntegration.js`, `ui.js` et les moteurs reçoivent le `projectId` courant ou retombent sur `N/A`/`__all__`.

## 6. Ce qui n'a pas été modifié (garantie de non-régression métier)

- Aucune formule, aucun paramètre par défaut de calcul, aucun critère de protection, aucune constante de dimensionnement.
- Aucune modification de `engine.js`, `cp-controller.js`, `ICCPOptimizationEngine.js`, `acCorrosionEngine.js`, `cableLengthEngine.js`, `transformerRectifierEngine.js`, `micEngine.js`, `cp-worker.js`, `pdfReport.js`, `pdf-report-*.js` (MD5 identiques avant/après).
- Aucune migration destructive : l'hydratation n'ajoute que des projets absents et n'écrase un projet local que si la version serveur est plus récente (`updated_at`) ; aucune suppression n'est effectuée par l'hydratation.

## 7. Limites connues (à traiter hors de ce correctif)

- `/api/dashboard/summary` n'exige pas d'authentification (lecture transverse) : à restreindre si le Dashboard doit être privé.
- Le bloc `engineer` du résumé est l'identité de la plateforme (configuration), pas une donnée de projet ; il n'alimente aucun KPI technique.
- La conformité NACE dépend de la table `field_measurements` : sans campagne de mesures enregistrée, la valeur affichée est `N/A` — c'est volontaire.
