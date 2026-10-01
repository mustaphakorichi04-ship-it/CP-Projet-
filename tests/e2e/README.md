# Tests E2E — synchronisation, routage et continuité `projectId`

Ces trois harnais valident le parcours réel **Dashboard SaaS ↔ Studio** contre une API Flask
et une base `cp_data.db` réels (aucune donnée simulée côté application).

## Pré-requis

```bash
# Dépendances du harnais (jsdom + IndexedDB en mémoire)
cd tests/e2e && npm init -y && npm install jsdom@24 fake-indexeddb

# Base de test (3 projets réels : PROJ-001, PROJ-002, PROJ-003) + backend
export CP_DB_PATH=/chemin/vers/cp_data.db
python backend.py            # écoute sur 127.0.0.1:5000
```

Le compte de test attendu est `admin` / `admin123` (compte de développement créé par
`init_db()` lorsque `CP_ADMIN_PASSWORD` n'est pas défini et que l'environnement n'est pas
la production).

## Exécution

```bash
node test-dashboard.e2e.mjs          # Dashboard        : 24 vérifications
node test-studio.e2e.mjs             # Studio           : 29 vérifications
node test-dashboard-sidebar.e2e.mjs  # Barre latérale   : 43 vérifications
```

Le code de sortie vaut 0 si toutes les vérifications passent.

## Couverture

- `test-dashboard.e2e.mjs` : deep-link `?project=PROJ-002#projects`, KPI calculés sur la base,
  absence de mélange entre projets, liens Studio contextualisés, bascule PROJ-003,
  indisponibilité de l'API → `N/A` (jamais de valeur inventée).
- `test-dashboard-sidebar.e2e.mjs` : **toutes les entrées de la barre latérale du Dashboard** —
  « Gestion des Projets », « Simulateurs Express », « Abonnement & Factures PRO », « Grille Tarifaire »,
  « Checkout Test (Visa) » (modale + carte de test), « Paramètres SaaS », « Statut Serveur & API »,
  « Aide & Normes NACE », les 5 liens de modules du Studio et le bouton « Ouvrir Studio » : présence,
  clic → onglet affiché **et** URL mise à jour, réouverture de chaque URL directe (F5), contextualisation
  `?project=<ID actif>`, cartes projets ciblant **leur** projet, aucun mélange inter-projets.
- `test-studio.e2e.mjs` : deep-link `?project=..#<module>`, activation du module et du menu,
  état applicatif issu de la base (`iccp.current`), conservation du `projectId` lors des
  navigations de modules, bascule de projet, lien retour Dashboard contextualisé,
  URL intacte après chargement, module Équipements peuplé après tous les rechargements
  différés, **les 13 entrées de la sidebar** (module affiché, `#hash`, `?project=` conservé,
  aucun conteneur manquant).
