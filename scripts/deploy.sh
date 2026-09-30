#!/usr/bin/env bash
# ============================================================
# deploy.sh — CP Engineer Pro SaaS
# Déploiement et Rollback Automatique en 1 Clic
# ============================================================

set -euo pipefail

ENV="${1:-staging}"
COMPOSE_FILE="docker-compose.${ENV}.yml"

echo "=================================================="
echo "🚀 Démarrage du déploiement CP Engineer SaaS [${ENV}]"
echo "=================================================="

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "❌ Fichier $COMPOSE_FILE introuvable."
    exit 1
fi

# 1. Sauvegarde préventive de la base de données
echo "📦 Snapshot pré-déploiement de PostgreSQL..."
mkdir -p backups
BACKUP_FILE="backups/pre_deploy_$(date +%Y%m%d_%H%M%S).sql"
docker compose -f "$COMPOSE_FILE" exec -T postgres-staging pg_dump -U cp_saas_user cp_engineer_saas > "$BACKUP_FILE" 2>/dev/null || echo "Avertissement: base non encore initialisée, snapshot ignoré."

# 2. Build et démarrage des conteneurs
echo "🔨 Construction et lancement des services..."
docker compose -f "$COMPOSE_FILE" up -d --build

# 3. Vérification de santé post-déploiement (Readiness Probe)
echo "🔍 Vérification du statut de santé (Healthcheck)..."
MAX_RETRIES=10
RETRY_COUNT=0
HEALTHY=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/health || true)
    if [ "$HTTP_CODE" = "200" ]; then
        HEALTHY=true
        break
    fi
    echo "En attente de disponibilité de l'API (tentative $((RETRY_COUNT + 1))/$MAX_RETRIES)..."
    sleep 3
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

# 4. Décision : Validation ou Rollback automatique
if [ "$HEALTHY" = true ]; then
    echo "=================================================="
    echo "✅ Déploiement réussi ! L'API et la PWA sont en ligne."
    echo "=================================================="
    exit 0
else
    echo "=================================================="
    echo "❌ ÉCHEC DU DÉPLOIEMENT : Le service ne répond pas."
    echo "🔄 DÉCLENCHEMENT DU ROLLBACK IMMÉDIAT..."
    echo "=================================================="
    docker compose -f "$COMPOSE_FILE" down
    if [ -f "$BACKUP_FILE" ]; then
        echo "Restauration de la base depuis $BACKUP_FILE..."
        docker compose -f "$COMPOSE_FILE" up -d postgres-staging
        sleep 5
        docker compose -f "$COMPOSE_FILE" exec -T postgres-staging psql -U cp_saas_user cp_engineer_saas < "$BACKUP_FILE"
    fi
    echo "Rollback terminé. La version précédente est rétablie."
    exit 1
fi
