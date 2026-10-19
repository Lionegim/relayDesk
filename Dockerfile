# syntax=docker/dockerfile:1
# Image de Relay Desk : Node 24 (Debian slim), utilisateur non-root, aucun secret ni donnée dans l'image.
# Étapes : deps (dépendances de production), test (suite complète, données fictives), runtime (image finale).
# Les fichiers copiés sont listés explicitement ; .dockerignore exclut le reste du contexte.

ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Aucune dépendance n'a de script d'installation : --ignore-scripts n'enlève rien et ferme cette porte.
# build_ca (facultatif) : autorité d'un proxy TLS d'entreprise, montée pour cette commande seulement, jamais dans l'image.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
COPY test ./test
# Configuration déclarative et outils hors ligne pour les tests de préflight ; exclus de l’image runtime.
COPY compose.yaml ./
COPY deploy ./deploy
COPY docs/operations.md ./docs/operations.md
COPY scripts/backup.mjs ./scripts/backup.mjs
USER node
ENV RELAY_CONNECTORS_ENABLED=false RELAY_AI_ENABLED=false DEMO_DATA=1
RUN --network=none npm test

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=4310
WORKDIR /app
# Code et dépendances appartiennent à root, en lecture seule pour l'utilisateur node.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json server.js ./
COPY src ./src
COPY public ./public
COPY deploy/healthcheck.mjs ./deploy/healthcheck.mjs
COPY scripts/backup.mjs ./scripts/backup.mjs
# /data : seul répertoire inscriptible (volume). Le secret du coffre est monté à part, en lecture seule.
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node
VOLUME ["/data"]
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "deploy/healthcheck.mjs"]
STOPSIGNAL SIGTERM
# Pas de npm start : il chargerait un éventuel .env. La configuration vient uniquement de l'environnement et des *_FILE.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
