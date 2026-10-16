# ADR-0006: Keycloak on Fargate as the platform's identity provider

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The command center requires an OIDC access token on every request and every socket, verifies
`iss`, `aud` (`occ-api`) and RS256 signatures, and reads roles from the token (OCC ADR-0010 and
ADR-0011). Its console's OIDC authority is its own origin's `/auth/realms/occ`, with a public
client `occ-console`. Sites already have a staff directory, and platform ADR-0005 keeps roles in
the platform while sign-in comes from that directory.

## Options

1. **Amazon Cognito** — managed, but the console expects a Keycloak-shaped authority on its own
   origin, and Cognito access tokens identify the client in `client_id` rather than `aud`, which
   the API checks. Either the console and API change, or Cognito does not fit.
2. **Keycloak run by the site** — the site may have none, and the console would still need it on
   the platform's origin.
3. **Keycloak in the platform, on Fargate**, with the command center's realm imported and the
   site's directory federated into it.

## Decision

Option 3.

- An optimised Keycloak image (`images/keycloak`) with the `occ` realm baked in: clients, roles
  and the audience mapper as the command center defines them, **demo users removed** by
  `scripts/prepare-realm.sh`. CI builds it from the command center's current realm and checks
  that no users remain.
- Keycloak's database is a login and database of its own on the stage's instance (ADR-0002),
  verified TLS included.
- It is served under `/auth` through CloudFront (ADR-0004), with `KC_HOSTNAME` set to the public
  URL so tokens carry the issuer the API expects. The API fetches signing keys over Service
  Connect from a private address.
- The admin console is not public; administrators reach it with an ECS Exec port-forward. The
  bootstrap administrator is for first sign-in only; the runbook replaces it with named
  administrators and adds the site's identity provider (Entra ID or any OIDC/SAML directory).

## Consequences

- The platform now runs and upgrades an identity provider. Keycloak releases are pinned in the
  image and upgraded deliberately.
- **One node.** Running two needs Keycloak's distributed cache configured for ECS (JDBC-based
  discovery); until then an outage of the task means no new sign-ins, while signed-in consoles
  keep working until their tokens expire.
- With Keycloak in the platform, service-to-service authentication (platform ADR-0006) has a
  natural answer: a confidential client with a service account for the pipeline.

## Verification

- **Checked in CI:** the image builds from the command center's current realm, and the realm in
  it has no users and still has the `occ-console` client.
- **Designed, not yet observed on a live account:** sign-in through CloudFront under `/auth`, and
  the issuer in tokens matching `OIDC_ISSUER`.

## Revisit when

A site mandates its own identity provider for the console directly, or the console gains
runtime IdP configuration (the command center's release work) — then Cognito or the site's IdP
can replace this service.
