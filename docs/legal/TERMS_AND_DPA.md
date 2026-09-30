# Conditions Générales de Vente SaaS (CGV) & Accord de Traitement des Données (DPA)
**Application : CP Engineer Pro SaaS (Industrial Release - NACE SP0169 / ISO 15589-1)**  
*Dernière mise à jour : 27 Septembre 2026*

---

## 1. Objet du Service & Propriété Intellectuelle
CP Engineer Pro SaaS fournit aux bureaux d'études, opérateurs d'oléoducs/gazoducs et industriels de l'énergie une suite d'ingénierie certifiée pour le calcul de protection cathodique (SACP, ICCP, Puits profonds, Atténuation de tension et Interférences CA/CC).
- **Propriété du Client** : Le Client conserve la propriété exclusive et intégrale de toutes les données d'actifs saisies (géométries des pipelines, tracés GPS, coordonnées des réservoirs, mesures de potentiel et de résistivité de sol).
- **Propriété du Prestataire** : Les algorithmes mathématiques, modèles d'optimisation non-linéaire, solveurs d'interférences et pondérations géotechniques sont la propriété intellectuelle exclusive de CP Engineer Pro.

---

## 2. Isolation Multi-Tenant & Confidentialité des Données Industrielles
1. **Cloisonnement Logique RLS** : Les données du Client sont cloisonnées de façon étanche via la technologie PostgreSQL Row-Level Security (RLS) avec `tenant_id` obligatoire et contextes de session dédiés.
2. **Option Enterprise (Base Dédiée)** : Pour les opérateurs d'infrastructures d'importance vitale (OIV) et exigences souveraines, l'option d'isolation en base de données dédiée physiquement séparée est fournie sans modification d'API.
3. **Chiffrement** : Toutes les données au repos sont chiffrées (AES-256) et toutes les communications sont chiffrées en transit (TLS 1.3 avec HttpOnly Cookies).

---

## 3. Conformité RGPD & Réversibilité (Art. 17 & 20)
- **Droit à la portabilité (Art. 20)** : Le Client peut à tout moment exporter l'intégralité de ses données (projets, historiques de calculs certifiés, journaux d'audit) dans un format ouvert JSON via l'API `GET /api/v1/compliance/export`.
- **Droit à l'oubli & Destruction (Art. 17)** : Sur demande de l'administrateur du tenant (`DELETE /api/v1/compliance/tenant`), l'ensemble des données, logs et sauvegardes secondaires de l'organisation sont détruits de manière irréversible sous 30 jours.

---

## 4. Facturation, Quotas & Disponibilité (SLA)
- **Modèle Tarifaire** : Facturation mensuelle par siège utilisateur (per-seat) incluant 500 calculs certifiés par mois et par siège actif, avec facturation à l'usage des calculs excédentaires (Metered Billing Stripe).
- **Disponibilité (SLA)** : Disponibilité minimale cible de **99.9%** hors fenêtres de maintenance programmée.
- **Mode Hors-Ligne (Field Technician)** : La suite supporte le fonctionnement hors-ligne (PWA) sur le terrain avec calculs non certifiés de secours et synchronisation sécurisée au retour réseau.
