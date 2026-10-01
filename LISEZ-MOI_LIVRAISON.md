# CP Engineer Pro — version CORRIGÉE (synchronisation / routage / projectId)

Ce dossier contient la version corrigée **complète et exécutable** du SaaS
(branche `arena/01a0f30a-cp-projet`, commit 6eb85b7).

## Lancer sur votre machine

    python -m venv venv
    venv\Scripts\activate            (Windows)   |   source venv/bin/activate   (Linux/macOS)
    pip install -r requirements.txt
    python backend.py                ->  http://127.0.0.1:5000

Windows : double-cliquez simplement sur LANCER_CP_ENGINEER.bat

Le dossier `vendor/` (Chart.js, Leaflet, Three.js, jsPDF, XLSX, Font Awesome) est
INCLUS : graphiques, cartes et 3D fonctionnent sans Internet.
Note : le dossier vendor est normalement ignoré par Git ; il est
fourni ici uniquement pour que l'application soit complète hors ligne.

## Base de données

Par défaut le backend utilise `cp_data.db` du dossier du projet.
Pour tester SANS toucher à votre base de production, copiez-la et pointez dessus :

    Windows :  set CP_DB_PATH=C:\chemin\copie_cp_data.db
    Linux   :  CP_DB_PATH=/chemin/copie_cp_data.db python backend.py

## Vérifier que les correctifs sont bien là (2 minutes)

1. `http://127.0.0.1:5000/dashboard?project=PROJ-002` → KPI réels (5,20 km, 0,311 A / GZS-TR-01).
2. Clic sur « 💳 Abonnement & Factures PRO » → l'onglet s'ouvre **et l'adresse devient** `…/dashboard?project=PROJ-002#billing`.
3. F5 → vous restez sur l'onglet Abonnement (avant : retour à Vue d'ensemble).
4. `http://127.0.0.1:5000/studio?project=PROJ-002#equipements` → Studio sur PROJ-002, module Équipements (lignes GZS-01 / GZS-TR-01).
5. Sidebar Studio → « Historique » : module fonctionnel (avant : page vide).

## Tests fournis

    cd tests/e2e && npm init -y && npm install jsdom@24 fake-indexeddb
    node test-dashboard.e2e.mjs          # 24/24
    node test-studio.e2e.mjs             # 29/29
    node test-dashboard-sidebar.e2e.mjs  # 43/43

Aucune formule, fonction, algorithme ou logique de calcul CP/ICCP/SACP/Groundbed
n'a été modifiée (moteurs identiques, MD5 inchangés).
