# syntax=docker/dockerfile:1
# Platform layer over the occ-api image built from its own repository: adds the RDS certificate
# authorities so the service verifies the database server (sslmode=verify-full / DB_SSL=true).
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
