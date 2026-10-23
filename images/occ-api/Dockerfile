# syntax=docker/dockerfile:1
# Platform layer over the occ-api image built from its own repository: adds the RDS certificate
# authorities so the service verifies the database server (sslmode=verify-full / DB_SSL=true).
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
# The checksum pins the bundle; a new AWS bundle fails the build on purpose (docs/runbook.md).
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
