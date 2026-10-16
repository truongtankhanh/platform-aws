#!/usr/bin/env bash
# Derives the realm Keycloak imports on AWS from ops-command-center's demo realm:
#   - demo users (password = username) are removed: real users come from the site's directory,
#     federated in Keycloak, or are created by an administrator;
#   - sslRequired stays "external": browsers reach Keycloak only over HTTPS through CloudFront,
#     while the API fetches signing keys over Service Connect from a private address.
# Clients, roles and the audience mapper are kept exactly as the console and API expect them.
set -euo pipefail
source_realm="${1:?usage: prepare-realm.sh <ops-command-center>/ops/keycloak/occ-realm.json [out]}"
out="${2:-images/keycloak/occ-realm.json}"
jq 'del(.users)' "$source_realm" > "$out"
echo "Realm written to $out ($(jq '.clients | length' "$out") clients, $(jq '.roles.realm | length' "$out") roles, users removed)"
