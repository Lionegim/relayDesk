# Keycloak de TEST pour Relay Desk : image officielle 26.8.1 (empreinte de l'index multi-architectures), optimisée
# pour PostgreSQL et la santé, comme le recommande la documentation Keycloak (« kc.sh build » puis « start --optimized »).
# Aucun secret, aucune donnée, aucun thème ni fournisseur ajouté. Construite sur la VM : docker compose … build keycloak.
# Même empreinte sur quay.io/keycloak/keycloak:26.8.1 à confirmer : docker buildx imagetools inspect quay.io/keycloak/keycloak:26.8.1
ARG KEYCLOAK_IMAGE=docker.io/keycloak/keycloak:26.8.1@sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244

FROM ${KEYCLOAK_IMAGE} AS builder
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=false
RUN /opt/keycloak/bin/kc.sh build

FROM ${KEYCLOAK_IMAGE}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
USER 1000
