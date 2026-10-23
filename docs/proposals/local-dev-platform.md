# Proposal: `platform-local`, shared local infrastructure for OCC and ITP

- **Status:** Proposed
- **Date:** 2026-10-21
- **Decision needed from:** the owner of the three platform repositories
- **Scope:** a new repository. This file lives in `platform-aws` only until that repository
  exists; move it there as `docs/adr/0001` or `docs/proposal.md`.

## 1. Summary

`platform-aws` is not local development infrastructure: it is CDK that synthesises CloudFormation
for AWS and cannot run without an account (`iot-telemetry-pipeline/docs/development.md` says the
same: "platform-aws: Not runnable locally").

The two services already run locally, each from its own `docker-compose.yml`. What is missing is
running them **together, the way AWS runs them**: one PostgreSQL, one identity provider whose
issuer is stable, one broker, one public origin, and alerts flowing from the pipeline to the
command center without manual wiring. Today that takes a multi-step manual procedure.

This proposal creates one small repository that owns that shared local infrastructure, pinned to
the same versions and wiring as `platform-aws`, and keeps each service repository able to build,
test and run on its own.

Abbreviations: **OCC** = `ops-command-center`, **ITP** = `iot-telemetry-pipeline`.

## 2. Context

### 2.1 What exists today

|               | OCC                                                                                                                | ITP                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Compose file  | `docker/docker-compose.yml`                                                                                        | `docker-compose.yml`                                                                                       |
| PostgreSQL    | 17, host `:15432`, database `ops`, superuser `postgres`                                                            | 17, host `:5433`, database `telemetry`, superuser `postgres`; `telemetry_test` added by `scripts/stack.sh` |
| Identity      | Keycloak 26.8 `start-dev --import-realm`, host `:18081`, realm `occ` with 5 demo users                             | none                                                                                                       |
| Broker        | Mosquitto **2.1**, profile `telemetry`, no host port, accounts and ACL generated at start, `allow_anonymous false` | Mosquitto **2.0.22**, host `:1883`, `allow_anonymous true`, `max_queued_messages 200000`                   |
| Public origin | `console` image (nginx) on `:18080`: static console, `/api`, `/socket.io`, `/auth`                                 | none (ingest on `:3100`, Simulator Studio on `:3200`)                                                      |
| Observability | Prometheus and Grafana, profile `observability`, Grafana `:13001`                                                  | Prometheus `:9090` and Grafana `:3000`, profile `observe`, images pinned by digest                         |
| Entry points  | `pnpm docker:stack`, `pnpm docker:up` (postgres + keycloak)                                                        | `pnpm docker:demo`, `pnpm docker:up` (postgres + mosquitto)                                                |

Both repositories state that each builds and tests on its own and that no test needs the other.
That is a property to keep (section 3).

### 2.2 What hurts

1. **Running the platform together is manual.** ITP `docs/development.md` ("Manual integration
   check") has the developer start OCC's whole stack, then ITP's infrastructure, then run ingest
   **on the host**, copy the `telemetry-pipeline` client secret into `apps/ingest/.env`, and
   uncomment four `OCC_*` variables.
2. **Ingest must run on the host because of the token issuer.** OCC's Keycloak has no fixed
   hostname, so a token's `iss` follows the address the caller used. The OCC API accepts exactly
   one issuer (`OIDC_ISSUER`). A token fetched from inside a container at
   `host.docker.internal:18080` would not carry `localhost:18080`. Three different issuers are in
   use already: `http://localhost:18080/auth/realms/occ` (Compose),
   `http://localhost:15173/auth/realms/occ` (`pnpm dev`, `apps/api/.env.example`) and the public
   URL on AWS.
3. **AWS fixes this and local does not.** `platform-aws` sets `KC_HOSTNAME` to the public URL so
   that tokens fetched on the internal address (`http://keycloak:8080`) still carry the public
   issuer (platform-aws ADR-0006). That design is "designed, not observed", so local is also the
   cheapest place to test it.
4. **Duplicated and drifting infrastructure.** Two PostgreSQL instances, two Mosquitto versions
   (ITP pins 2.0.22 on purpose: 2.1 changes `max_packet_size` and receive maximum), two
   Prometheus and Grafana pairs with different ports, and the ITP guidance to "run them one after
   the other" because both full stacks are heavy.
5. **Local diverges from AWS in the places that matter.** AWS: one instance with one database and
   one owning login per system, `CONNECT` revoked from `PUBLIC`, TLS enforced, Keycloak on its own
   database. Local: a shared superuser, no TLS, Keycloak on its default development storage. A
   permission or TLS bug cannot show up locally.
6. **Parity is checked in one direction only.** ITP checks platform-aws's hard-coded values with a
   daily test against `lib/stacks/telemetry.ts` (ITP ADR-0010). Nothing checks that the local
   stacks use the same values.

## 3. Goals and non-goals

### Goals

- **G1.** One command brings up an integrated local platform: both services, their dependencies,
  and alert delivery working with no manual secret copying.
- **G2.** The local topology follows `platform-aws` wherever the difference could hide a bug: one
  public origin, fixed token issuer, per-system database and login, pinned versions.
- **G3.** A mode that runs **only the dependencies** (PostgreSQL, Keycloak, broker), so a developer
  can run a service from source on the host, as `pnpm dev` does today.
- **G4.** Each service repository keeps working, building and testing alone. Adopting
  `platform-local` is optional for them.
- **G5.** Versions and values that must agree live in one place and are checked against
  `platform-aws` by an automated test.
- **G6.** Light by default. Anything heavy (observability, mTLS, cameras) is a profile.

### Non-goals

- **Not an AWS emulator.** IoT Core policy evaluation, CloudFront, WAF and Fargate behaviour are not
  reproduced; they are what the first real deployment has to verify.
- **Not production, not a template.** Credentials are demo credentials, as in both repositories.
- **Not a replacement** for either repository's Compose file, e2e suite or Kubernetes overlay.
- **Holds no application code.** It builds images from sibling checkouts.

## 4. Proposed design

### 4.1 Repository layout

```
platform-local/
  compose.yml                 the integrated stack (profiles below)
  versions.env                every pinned image tag in one place
  .env.example                ports, paths to the sibling checkouts, demo credentials
  postgres/init/              creates databases and logins, mirroring platform-aws
  keycloak/                   compose overrides only; the realm is read from OCC, never copied
  mosquitto/                  broker configs (see Q3)
  observability/              Prometheus and Grafana, if not reused from the services
  scripts/platform.sh         up | down | reset | status | logs | doctor
  tests/                      smoke, alert-to-incident e2e, parity with platform-aws
  docs/                       architecture, runbook, ADRs
```

### 4.2 Modes and profiles

| Mode       | Command (sketch)      | What runs                                                               | Use                                              |
| ---------- | --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| `deps`     | `platform.sh up deps` | PostgreSQL, Keycloak, broker                                            | Run `pnpm dev` or ingest from source on the host |
| `full`     | `platform.sh up full` | `deps` + OCC API and console + ITP ingest, built from sibling checkouts | Integrated demo and manual testing               |
| standalone | unchanged             | each repo's own Compose                                                 | Work on one repo only                            |

Profiles layered on `full`: `simulate` (ITP simulator and OCC `telemetry-sim`), `observe`
(Prometheus and Grafana), `mtls` (TLS-only broker requiring client certificates, as ITP used to
verify its AWS IoT Core path), `cameras` (a MediaMTX relay, to exercise `CAMERA_SOURCE=mediamtx`).

### 4.3 How the two projects are composed

| Option                                                          | Verdict                                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose `include` of both repositories' files                   | **Rejected.** Both define `postgres`, `mosquitto`, `prometheus` and `grafana`; duplicate service names are an error, and renaming them means editing the other repositories.            |
| Extend one repository's Compose to include the other's services | Rejected. Makes one service repository own the platform and breaks G4 symmetry.                                                                                                         |
| **A separate Compose that builds from sibling checkouts**       | **Chosen.** Build contexts come from `OCC_DIR` and `ITP_DIR` (default `../ops-command-center`, `../iot-telemetry-pipeline`). The realm file is mounted from `OCC_DIR/docker/keycloak/`. |
| Kubernetes (`kind`) using ITP's `deploy/k8s/overlays/local`     | Not for the default path: heavier, and OCC has no manifests. Remains available to ITP.                                                                                                  |

### 4.4 Database

One PostgreSQL 17 instance. The init script creates, per system, a login named after its database
and revokes `CONNECT` from `PUBLIC`, the same effect as `lambda/database-bootstrap/plan.ts` in
`platform-aws`: `ops`, `ops_test`, `keycloak`, `telemetry`, `telemetry_test` (OCC's e2e needs a
name ending in `_test`; ITP's `scripts/stack.sh` creates `telemetry_test`). Keycloak uses the `keycloak`
database instead of its development storage.

The host port keeps OCC's `:15432`, so OCC's `.env.example` stays valid. ITP's `.env.example`
points at `:5433` and its e2e wipes the `public` schema of `telemetry_test`, so the infrastructure
must never share the `telemetry` database with that suite (see Q2).

### 4.5 Identity and the issuer (the core technical decision)

- Keycloak runs with `KC_HOSTNAME=http://localhost:18080/auth`, as `platform-aws` does with its
  public URL. Whatever address a caller uses, tokens carry that one issuer, so
  `OIDC_ISSUER=http://localhost:18080/auth/realms/occ` is valid for the OCC API and for ingest
  **running in a container** with `OCC_TOKEN_URL=http://keycloak:8080/auth/realms/occ/...`.
- This is a hypothesis, not a fact: it is exactly the behaviour `platform-aws` ADR-0006 marks "not
  yet observed". The first spike (section 6) proves or disproves it, and the result goes back
  into that ADR.
- The realm is OCC's own `docker/keycloak/occ-realm.json`, unmodified. Locally the demo secret of
  `telemetry-pipeline` (`occ-demo-telemetry-pipeline`) is known, so no manual copy is needed. This
  is a deliberate difference from AWS, where `scripts/prepare-realm.sh` strips users and secrets;
  `doctor` flags it so nobody mistakes the local realm for the AWS one.
- `pnpm dev` serves the console on `:15173` and proxies `/auth`, which makes the issuer
  `:15173`. A fixed hostname cannot serve both origins. See Q1.

### 4.6 Broker

The two services use the broker differently today: OCC's path uses accounts and an ACL
(`occ/<site>/asset/<code>/telemetry`), ITP's path is anonymous with the `campus/+/+/telemetry`
shared subscription. ITP ADR-0007 plans to converge them; that is on hold. So the default is
**two broker services** with the configs each repository already uses (Q3), not a merged one.

Pinned versions come from `versions.env`. The `mtls` profile reproduces the TLS-and-client-
certificate path (ingest already supports `MQTT_CERT_PEM`, `MQTT_KEY_PEM`, `MQTT_CONNECTIONS`)
to exercise the AWS-shaped connection settings. It cannot reproduce IoT Core's 100 messages/s per
connection limit or its policy evaluation.

### 4.7 One public origin

The `console` image from OCC (nginx) stays the only entry point on `:18080`, proxying `/api`,
`/socket.io` and `/auth`, exactly as CloudFront does on AWS. Ingest (`:3100`), Simulator Studio
(`:3200`), Keycloak (`:18081`), PostgreSQL and the broker publish on `127.0.0.1` only.

### 4.8 Parity with `platform-aws`

`tests/parity` reads `platform-aws` (path in `.env`, same technique as ITP ADR-0010) and fails if
these differ from `versions.env` or `compose.yml`:

| Value                                                        | Source in `platform-aws`                       |
| ------------------------------------------------------------ | ---------------------------------------------- |
| PostgreSQL major version                                     | `lib/stacks/data.ts` (`VER_17_9`)              |
| Database names                                               | `DatabaseName` in `lib/config.ts`              |
| Keycloak minor version                                       | `images/keycloak/Dockerfile`                   |
| Topic filter, share group, client id prefix                  | `lib/stacks/telemetry.ts`                      |
| `OIDC_AUDIENCE`, API and ingest ports, Service Connect names | `lib/stacks/command-center.ts`, `telemetry.ts` |
| Keycloak client ids                                          | the `occ` realm, `telemetry-pipeline`          |

It reads regular expressions over TypeScript because that needs nothing from `platform-aws`. The
cost is a third reader of `telemetry.ts` (ITP is the second), so a restructure there breaks more
repositories. The follow-up is for `platform-aws` to emit a small manifest of these values, which
ITP ADR-0010 already names as its option 3.

### 4.9 Developer workflow

```
scripts/platform.sh doctor      # Docker memory, free ports, sibling checkouts, versions.env vs images
scripts/platform.sh up deps     # then `pnpm dev` in either repo
scripts/platform.sh up full     # integrated demo; add --profile simulate to produce alerts
scripts/platform.sh status      # health of every service and the URL to open
scripts/platform.sh reset       # drop volumes and start clean
```

The same script is what CI calls, so the documented path and the tested path are one.

### 4.10 Tests of this repository

1. `docker compose config` for every profile.
2. Smoke: `deps` and `full` reach healthy; sign-in works; `/api/health/ready` is up.
3. **Alert to incident, automated.** The `simulate` profile runs ITP's `server-room-overheat`
   scenario; the test waits for an incident reported by `service-account-telemetry-pipeline` to
   appear in OCC's API and for it to resolve. This replaces the manual integration check.
4. Isolation: the `ops` login cannot connect to the `telemetry` database.
5. Parity (section 4.8).

## 5. Impact on the existing repositories

| Repository               | Change                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ops-command-center`     | None required. Optional: a line in its README pointing at `platform-local`; keep the realm path `docker/keycloak/occ-realm.json` stable. |
| `iot-telemetry-pipeline` | None required. Optional: replace the "Manual integration check" with a link; its `development.md` table gains `platform-local`.          |
| `platform-aws`           | None required. `docs/handover.md` should list `platform-local` as a consumer of its values; consider emitting a manifest (section 4.8).  |

## 6. Rollout

| Phase       | Deliverable                                                                                                                              | Exit criterion                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 0. Spike    | A throwaway Compose with Keycloak at `KC_HOSTNAME=http://localhost:18080/auth`; ingest in a container fetches a token on `keycloak:8080` | `iss` equals `OIDC_ISSUER`; result recorded in platform-aws ADR-0006. Measure memory of `deps` and `full`. |
| 1. `deps`   | PostgreSQL with per-system logins, Keycloak, brokers; `doctor`; docs                                                                     | OCC and ITP each run from source against it with no `.env` change beyond the host                          |
| 2. `full`   | OCC API and console and ITP ingest from sibling checkouts                                                                                | Sign-in works; alerts deliver with no manual secret                                                        |
| 3. CI       | Smoke and alert-to-incident test in CI                                                                                                   | The manual integration check is deleted from the docs                                                      |
| 4. Parity   | The checks in 4.8                                                                                                                        | A deliberate mismatch fails CI                                                                             |
| 5. Profiles | `observe`, `mtls`, `cameras`                                                                                                             | Each documented with what it does and does not prove                                                       |

## 7. Risks

| Risk                                                                             | Mitigation                                                                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The fixed-hostname behaviour does not hold, so containers cannot share an issuer | Phase 0 comes first. Fallback: keep ingest on the host (today's behaviour) and document it.                                           |
| Memory: ITP says both full stacks are heavy                                      | One PostgreSQL, one Keycloak, profiles for the rest; set a budget from the phase 0 measurement and make `doctor` check it.            |
| Sibling checkouts drift (a refactor moves a Dockerfile or the realm)             | Paths in `.env`; `doctor` verifies they exist; the smoke test fails loudly. Same exposure `platform-aws` already has in `deploy.yml`. |
| A third copy of the shared values                                                | `versions.env` is the single copy in this repository, and parity tests compare it to `platform-aws`.                                  |
| People take demo credentials for a template                                      | Loopback-only ports, the same "not a template" wording as the services, `doctor` warning.                                             |
| Maintenance cost of one more repository                                          | Keep it infrastructure-only; it must not grow application logic.                                                                      |

## 8. Alternatives considered

1. **Status quo plus better docs.** Cheapest, but the manual steps and the drift remain, and the
   fixed issuer is never tested.
2. **Extend OCC's Compose to host ITP's services too.** Fastest, but ties the platform to one
   service repository and breaks standalone use.
3. **Compose `include`.** Blocked by duplicate service names (section 4.3).
4. **Kubernetes locally for everything.** ITP has an overlay, OCC does not, and it is heavier than
   the problem needs.
5. **An AWS emulator.** Not evaluated in depth; it would add a dependency and still leave the
   unverified parts (IoT policy evaluation, CloudFront routing) unverified.

## 9. Open questions

| #   | Question                                                                                        | Recommendation                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | A fixed `KC_HOSTNAME` forces one origin, but `pnpm dev` serves the console on `:15173`.         | Two Keycloak settings: `full` fixes the hostname (parity with AWS); `deps` keeps the current dynamic behaviour so `pnpm dev` and its `.env` keep working. Confirm after phase 0.                                                     |
| Q2  | Per-system logins locally change `DB_USER` and `DATABASE_URL` from `postgres`.                  | Do it, because it is the only way to see ownership and `CONNECT` problems before AWS. Keep a `postgres` superuser for tooling. If the apps' migrations need more privilege than the owner role has, that is a finding about AWS too. |
| Q3  | One broker or two?                                                                              | Two, until ITP ADR-0007 converges the telemetry paths. Revisit when the OCC V3 drops its MQTT client.                                                                                                                                |
| Q4  | Reuse the services' Prometheus and Grafana provisioning or copy it?                             | Mount from the service repositories (same as the realm) to avoid a copy, as long as their paths stay stable.                                                                                                                         |
| Q5  | Where should the pinned versions be authoritative: this repository or the service repositories? | `platform-local` for infrastructure images (PostgreSQL, Keycloak, Mosquitto, Prometheus, Grafana); the service repositories keep their own app images. Align the Mosquitto 2.0.22 vs 2.1 split deliberately, not by accident.        |
| Q6  | Does the team want an `mtls` profile now?                                                       | Defer to phase 5; ITP already has a TLS test path, so the value is mostly in `MQTT_CONNECTIONS > 1`.                                                                                                                                 |
| Q7  | Repository name and home                                                                        | `platform-local`, next to the other three under the same owner.                                                                                                                                                                      |

## 10. Source facts

Checked in the three repositories on 2026-10-21; OCC paths re-checked on 2026-10-23 after its commit `5d895df` moved the Docker files into `docker/`. Re-check before relying on any of them.

- OCC `docker/docker-compose.yml` (services, ports, profiles, `OIDC_*`), `apps/api/.env.example`
  (`OIDC_ISSUER` on `:15173`), `docker/mosquitto/mosquitto.conf`, `docker/keycloak/occ-realm.json`
  (clients `occ-console` and `telemetry-pipeline`; roles `operator`, `supervisor`, `technician`,
  `viewer`; 5 users), `package.json` (`docker:up` = postgres and keycloak).
- ITP `docker-compose.yml`, `.env.example`, `scripts/stack.sh`, `deploy/mosquitto/mosquitto.conf`,
  `docs/development.md` ("Working across the three repositories", "Manual integration check"),
  `docs/system-context.md` (topologies and values that must agree), ADR-0006, ADR-0007, ADR-0010.
- `platform-aws` `lib/stacks/data.ts`, `command-center.ts`, `telemetry.ts`,
  `lambda/database-bootstrap/plan.ts`, `scripts/prepare-realm.sh`, ADR-0006.
