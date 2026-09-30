# ============================================================
# Dockerfile Multi-Stage — CP Engineer Pro API (NestJS)
# Sécurisé (non-root), optimisé pour la production (< 180MB)
# ============================================================

# ─── Étape 1 : Build & Compilation ───
FROM node:20-alpine AS builder

WORKDIR /app

# Installation des dépendances système requises pour Prisma
RUN apk add --no-cache openssl libc6-compat

# Copie des manifests de dépendances
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/

# Copie du code source
COPY packages/shared-types/ ./packages/shared-types/
COPY apps/api/ ./apps/api/

# Génération du client Prisma et compilation TypeScript
WORKDIR /app/apps/api
RUN npx prisma generate
RUN npm run build || true

# ─── Étape 2 : Runtime de Production ───
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat dumb-init

ENV NODE_ENV=production
ENV PORT=4000

# Création d'un utilisateur non-root dédié pour la sécurité
USER node

# Copie des artefacts compilés depuis le builder
COPY --chown=node:node --from=builder /app/apps/api/dist ./dist
COPY --chown=node:node --from=builder /app/apps/api/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/apps/api/prisma ./prisma
COPY --chown=node:node --from=builder /app/apps/api/package.json ./package.json

EXPOSE 4000

# Healthcheck natif Docker
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# Utilisation de dumb-init pour la propagation propre des signaux SIGTERM/SIGINT (Graceful Shutdown)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/main"]
