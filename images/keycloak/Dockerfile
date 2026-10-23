# syntax=docker/dockerfile:1
# Keycloak for ops-command-center: an optimised build (no build step at start), served under /auth
# like the Compose stack, with the occ realm imported on first start and the RDS CA for verify-full.
# Pinned by digest: the tag alone can be moved. To update, take the digest of the new tag with
# `docker buildx imagetools inspect quay.io/keycloak/keycloak:<version>` and change both parts.
ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.8@sha256:a78d6b79572168cb25886b80a8b5b8d4ed4390743e3eecb810538683e209dd6b
FROM ${KEYCLOAK_IMAGE} AS build
ENV KC_DB=postgres \
    KC_HTTP_RELATIVE_PATH=/auth \
    KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM ${KEYCLOAK_IMAGE}
COPY --from=build /opt/keycloak/ /opt/keycloak/
# The checksum pins the RDS certificate bundle. When AWS publishes a new bundle the build fails
# here on purpose; see docs/runbook.md for how to review and refresh it (in all three Dockerfiles).
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/keycloak/conf/rds-ca.pem
# Produced by scripts/prepare-realm.sh from ops-command-center's realm, without its demo users.
COPY occ-realm.json /opt/keycloak/data/import/occ-realm.json
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
