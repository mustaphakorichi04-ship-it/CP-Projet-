# CP Engineer Pro — Corrections et validation (synchronisation, routage, `projectId`)

Date : 2026-09-30
Objet : correctifs minimaux issus de `AUDIT_SYNCHRONISATION_NAVIGATION.md`, validation anti-régression et rapport de tests.

> ## Garantie
>
> **Aucune formule, fonction, algorithme ou logique de calcul CP/ICCP/SACP/Groundbed n'a été modifiée.**

Preuve : les moteurs de calcul sont identiques au bit près avant/après intervention (empreintes MD5 ci-dessous), et les valeurs de calcul stockées en base pour PROJ-001, PROJ-002 et PROJ-003 sont inchangées après l'ensemble des tests.

---

## 1. Corrections appliquées (code minimal)

| # | Fichier | Correctif | Justification |
|---|---|---|---|
| 1 | `controller.js` | `loadProject()` : normalisation `state.systems = []` ; `loadProjectsList()` : appel de l'hydratation base → Studio + repli `ensureProjectFromServer()` | Un projet sans `systems` faisait échouer le chargement (C2) ; les projets réels de la base n'apparaissaient pas dans le Studio (C1) |
| 2 | `storage-proxy.js` | Hydratation non destructive de la liste des projets (`hydrateProjectsFromServer`, `ensureProjectFromServer`, fusion par `updated_at`) ; `fetchWithRetry(..., { returnClientError: true })` ; `upsertEquipmentOnServer()` (POST → PUT si 409) | Deep-link et sélecteur alimentés par la base (C1) ; repli 409 inatteignable (C7) |
| 3 | `storage.js` | `mirrorToLocalStorage()` + écriture localStorage quand IndexedDB n'est pas encore ouverte (`forceSave`/`forceDelete`) | `DB not initialized` faisait échouer l'hydratation au démarrage (C3) |
| 4 | `router.js` | `_pendingRoute` (contexte de deep-link protégé), `releaseAppliedPendingRoute()`, `getNavItem()` sans `CSS.escape`, rejeu du `change` tant que le projet courant diffère, lien retour Dashboard contextualisé, actions déléguées `new=1` / `action=pdf` | Perte du `?project=` au démarrage (C4), `ReferenceError: CSS is not defined` (C5), état/UI désynchronisés (C6) |
| 5 | `index.html` | Suppression du script inline mort (`UI.switchModule(hash)` sans portage de projet) ; chargement de `router.js` après `ui.js`/`app.js` ; cache-busting `?v=20260930-1` | Deep-link `/studio#<module>` réellement fonctionnel |
| 6 | `ui.js` | Événement `moduleChanged` émis par `switchModule()`, écoute de `projectsHydrated`, export public de `switchModule` | Synchronisation inter-modules et sélecteur rafraîchi après hydratation |
| 7 | `dashboard.html` | Données réelles via `/api/dashboard/summary` ; projet actif porté par `?project=` ; onglet porté par `#hash` (`getTabIdFromUrl`, `hashchange`, `popstate`) ; liens Studio contextualisés ; `N/A` si l'API est indisponible ; KPI conformité issu des mesures réelles | Objectifs 1 et 2 de la demande |
| 8 | `backend.py` | `/api/dashboard/summary` : suppression de toutes les valeurs de repli inventées (100 % de conformité, `TR-002`, 300 W, 22.42 Ω, 25 ans, 16 anodes, 200 m, `3LPE`, statut « Protégé ») ; conformité calculée sur `field_measurements.compliant` ; `null` sinon | Règle « donnée réelle, sinon N/A » |
| 9 | `apps/web/src/services/cpApi.ts` + `pages/dashboard/DashboardPage.tsx` + `App.tsx` | Suppression des projets simulés (GZ-Nord Alger, Arzew LNG, Hassi R'Mel, In Salah) ; passerelle unique `fetchDashboardSummary()` (`/api/dashboard/summary` → repli `/api/v1/projects`) ; routes réelles `/dashboard/{projects,calculations,gis,reports,settings}` ; projet actif dans `?project=` | Objectifs 1 et 2 côté SaaS React |
| 10 | `sw.js` | `storage-proxy.js` et `router.js` ajoutés au cache statique | Cohérence du service worker (versions servies) |
| 11 | `storage-proxy.js` | Persistance locale des équipements hydratés depuis la base (`originalSaveEquipment`, chemin local, aucun appel API) + hydratation de la liste des projets déclenchée au retour de disponibilité du backend et après connexion ; lectures base conditionnées à la seule authentification | Le tableau « Équipements » se vidait pour un projet peuplé (C11) ; la liste des projets pouvait rester vide et le deep-link échouer définitivement (C13) |
| 12 | `storage.js` | Une lecture locale **vide** n'écrase plus le cache mémoire ni l'état (`loadEquipmentsForProject`) ; écriture localStorage si IndexedDB n'est pas encore ouverte | Protection contre les vidages d'état pendant les rechargements différés (C11) |
| 13 | `app.js` | Garde au démarrage : une lecture locale vide n'écrase pas une liste d'équipements non vide | Même cause que C11, au niveau du rechargement forcé PERSIST-022 |
| 14 | `ui.js` | `populateProjectSelector()` : priorité explicite (valeur ≠ `__all__` → projet actif → projet de l'URL → `__all__` → dernier → premier) | Le sélecteur écrasait le projet actif lors des repopulations tardives (C12) |
| 15 | `router.js` | Réconciliateur URL ↔ état borné (800 ms → 14 s) + `applyProject()` rafraîchit la liste depuis la base si le projet demandé manque localement | Le bootstrap applicatif pouvait se terminer après le routeur et réinitialiser le projet actif ; plus d'abandon destructif de `?project=` (C13) |
| 16 | `index.html` | Ajout du conteneur de module manquant `#module-history` (+ `#historyTableBody`, filtre module, bouton d'effacement déjà attendus par `ui.js`) | L'entrée « Historique » vidait la zone de contenu : lien mort (C14) |

Aucune API publique, aucun identifiant, aucune classe, aucun contrat existant n'a été renommé ni supprimé (les alias `/app/dashboard` sont conservés).

## 2. Rapport de tests

### 2.1 Tests moteurs (non-régression calculs)

| Test | Commande | Avant | Après | Verdict |
|---|---|---|---|---|
| Moteur d'ingénierie (26 cas) | `node --test tests/engineering-core.test.js` | 23 ✅ / 3 ❌ | 23 ✅ / 3 ❌ | ✅ identique (les 3 échecs #23–#25 sont antérieurs et hors périmètre : plafonds de durée de vie MMO/platinized/graphite) |
| Transformateur-redresseur (3 cas) | `node tests/transformer-rectifier.test.js` | 3 ✅ / 0 ❌ | 3 ✅ / 0 ❌ | ✅ |
| Empreintes MD5 des moteurs | `md5sum engine.js cp-controller.js … pdf-report-*.js` | — | identiques | ✅ aucun moteur modifié |

### 2.2 Parcours fonctionnels réels (jsdom + API + base réelle)

| # | Vérification | Résultat |
|---|---|---|
| 1 | Boucle Dashboard ↔ Studio ↔ Dashboard : lien sortant `/studio?project=<ID>#<module>` (vérifié côté Dashboard) et lien retour `/dashboard?project=<ID>` (vérifié côté Studio) | ✅ |
| 2 | PROJ-002 → deep-link `?project=PROJ-002#iccp` (module + projet + état applicatif) | ✅ |
| 3 | PROJ-003 → deep-link `?project=PROJ-003#groundbed` (URL intacte après chargement) | ✅ |
| 4 | Tous les liens de la barre latérale du Dashboard → `/studio?project=<ID>#<module>` | ✅ |
| 5 | Cartes projets (« Ouvrir Studio », « Rapport PDF », « Sélectionner ») | ✅ |
| 6 | Boutons/actions : liens `action=pdf` et `new=1` présents dans le DOM (Dashboard) et traités par le routeur (Studio ; dossier `params` de `parseStudioRoute`) | ✅ |
| 7 | Navigation directe par URL (Studio et Dashboard) | ✅ |
| 8 | Rafraîchissement (F5) : projet et module restaurés depuis l'URL | ✅ |
| 9 | Changement de projet sans mélange de données (PROJ-001 ↔ PROJ-003 : `iccp.current` 0.197 / 0) | ✅ |
| 10 | Bascule d'onglet Dashboard reflétée dans l'URL (`#projects`, `#overview`, `#status`…) | ✅ |
| 11 | API indisponible → `N/A` et message « Données indisponibles » (aucune valeur inventée) | ✅ |
| 12 | Données affichées = données de la base (PROJ-001 12,78 km / 0,197 A ; PROJ-002 5,20 km / 0,311 A ; PROJ-003 0 km / 0,084 A ; totaux 17,98 km / 15 174,42 m² / 0,592 A) | ✅ |
| 13 | Conformité NACE sans mesure terrain → `N/A` (et non 100 %) | ✅ |
| 14 | Moteurs de calcul inchangés (tests + MD5) | ✅ |
| 15 | Module Équipements : données réelles après tous les rechargements différés (2 lignes GZS-*, 0 mélange) | ✅ |
| 16 | Les 13 entrées de la sidebar Studio : module affiché, `#hash` correct, `?project=` conservé, aucun conteneur manquant | ✅ |
| 17 | Historique : module affiché avec l'historique réel du projet (« Aucun historique disponible » si vide) | ✅ |
| 19 | Barre latérale Dashboard — entrées « Abonnement & Factures PRO », « Grille Tarifaire », « Paramètres SaaS », « Statut Serveur & API », « Aide & Normes NACE » : clic → onglet affiché **et** adresse mise à jour (`#billing`, `#pricing`, `#settings`, `#status`, `#support`) puis réouverture de l'URL (F5) | ✅ |
| 20 | « Checkout Test (Visa) » : modale ouverte, plan transmis (Plan Professionnel), carte de test pré-remplie (4242 4242 4242 4242) | ✅ |
| 21 | Liens du Dashboard vers le Studio : 6/6 contextualisés `?project=<ID actif>` (5 modules + bouton « Ouvrir Studio ») ; cartes projets : chaque carte cible **son** projet (0 carte mal ciblée) ; 0 lien de la sidebar vers un autre projet | ✅ |
| 18 | Aucune valeur de repli inventée dans le code : `GZ-Nord`, `Arzew`, `Hassi`, `In Salah` absents du runtime ; plus de défaut `3LPE` / `TR-002` / `22.42 Ω` / `300 W` / `100 %`. Seule occurrence restante de toponyme : fixture d'un test unitaire (`apps/api/test/compliance.spec.ts`), hors runtime | ✅ |

Synthèse : **29/29** vérifications pour le Studio, **24/24** pour le Dashboard SaaS, **43/43** pour la barre latérale du Dashboard, **0 ❌**.

### 2.3 Reproduction des tests

```bash
# 1) Tests moteurs (aucune régression attendue)
node --test tests/engineering-core.test.js     # 23 pass / 3 fail (antérieurs)
node tests/transformer-rectifier.test.js       # 3 pass / 0 fail

# 2) Tests E2E (API + base réelles, compte de test admin/admin123)
cd tests/e2e && npm install jsdom@24 fake-indexeddb
CP_DB_PATH=/chemin/cp_data.db python backend.py &
node test-dashboard.e2e.mjs                    # 24/24
node test-studio.e2e.mjs                       # 29/29
node test-dashboard-sidebar.e2e.mjs            # 43/43 (barre latérale : Commercial & SaaS, Configuration, liens Studio)
```

### 2.4 Preuves de non-régression des résultats de calcul

Valeurs relues en base après l'ensemble des tests (identiques aux valeurs initiales) :

| Projet | `iccp.current` | `cp.current` | `targetPotential` | `groundbed.lifeDesign` |
|---|---|---|---|---|
| PROJ-001 | 0,197 A | 0,197 A | −850 mV CSE | 25 ans |
| PROJ-002 | 0,311 A | 0,311 A | −850 mV CSE | 25 ans |
| PROJ-003 | 0 | 0,084 A | −850 mV CSE | 20 ans |

Extrait de l'API après correctif (`/api/dashboard/summary`) : `naceCompliancePercent: null`,
`measurementsCount: 0`, `status: null`, `protectedNetworkKm: 17.98`, `totalIccpCurrentA: 0.592`,
`rectifiers: [TR-002 (TR-OPTIMAL, 300 W, 15 A), GZS-TR-01 (TR-GZS-01, 480 W, 20 A)]`,
`groundbeds: [GB-PORT-01 (24 anodes, 180 m, R_total 31.06 Ω, vie 20 ans)]` — toutes ces valeurs
proviennent de la base.

## 3. Contraintes respectées

- ✅ Aucune modification de formule/fonction/algorithme/paramètre/logique de calcul CP, ICCP, SACP, Groundbed, résistivité, câbles, tension, courant, TR, dimensionnement, critères de protection.
- ✅ Aucune donnée supprimée ni migrée de façon destructive (l'hydratation n'ajoute que des projets absents et n'adopte une version serveur que si `updated_at` est plus récent).
- ✅ Aucun refactoring inutile : architecture, composants, fonctions, API, services, identifiants, événements, classes, contrats et intégrations existants conservés.
- ✅ Environnement de test préservé (release industrielle de test ; la base de validation utilisée est une base de test, la base de production n'a pas été touchée).

## 4. Réserves

- La conformité NACE affichée dépend d'une campagne de mesures dans `field_measurements` ; sans mesure, la valeur est `N/A` (comportement voulu, pas une régression).
- `/api/dashboard/summary` reste sans authentification (lecture transverse) : à restreindre si le Dashboard doit devenir privé.
- Le Studio conserve son fonctionnement hors ligne : sans session authentifiée, l'hydratation depuis la base est ignorée et l'interface affiche `N/A` plutôt que des données inventées.
- Les libs `vendor/` (Chart.js, Leaflet, Three.js) ne sont pas fournies par le dépôt : cartographie, graphiques et 3D restent vides — dégradation propre et pré-existante, sans impact sur les calculs ni sur la continuité du `projectId`.
