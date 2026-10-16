# syntax=docker/dockerfile:1
# Keycloak for ops-command-center: an optimised build (no build step at start), served under /auth
# like the Compose stack, with the occ realm imported on first start and the RDS CA for verify-full.
ARG KEYCLOAK_VERSION=26.8
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS build
ENV KC_DB=postgres \
    KC_HTTP_RELATIVE_PATH=/auth \
    KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}
COPY --from=build /opt/keycloak/ /opt/keycloak/
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/keycloak/conf/rds-ca.pem
# Produced by scripts/prepare-realm.sh from ops-command-center's realm, without its demo users.
COPY occ-realm.json /opt/keycloak/data/import/occ-realm.json
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
