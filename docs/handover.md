# Handover guide

For whoever takes over this repository. It explains how the code is organised, which couplings are
easy to break, how to make the usual changes, what has never been verified, and what is known to be
weak. The README, `architecture.md`, the ADRs and the runbook say _what and why_; this says _what
to do next_ and _what will bite you_.

Everything here was checked against the code at the time of writing. Where a claim comes from the
ADRs and was never observed on a live account, it says so.

## 1. Read this first

- **What it is.** TypeScript AWS CDK that deploys two other systems, `ops-command-center` (OCC) and
  `iot-telemetry-pipeline` (ITP), on ECS Fargate, RDS PostgreSQL, CloudFront and AWS IoT Core. It
  contains no application code. The only runtime code here is two CloudFormation custom-resource
  Lambdas (`lambda/`).
- **What it is not (yet).** Deployed. No AWS account is attached, so the Deploy workflow has never
  run. CI proves the stacks synthesise, pass cdk-nag and satisfy the property assertions in
  `test/`. It does not prove they deploy or behave as designed (section 6).
- **Reading order.** README, `docs/architecture.md`, ADR-0001 to 0006, `docs/runbook.md`, then this
  file. The ADRs carry "Verification" and "Revisit when" sections that matter.

## 2. Set up and check your work

Node 22 or newer (`engines`); CI reads `.nvmrc` (24) and the Lambdas run on `NODEJS_24_X`.

| Command                    | What it does                                                  |
| -------------------------- | ------------------------------------------------------------- |
| `npm ci`                   | Install                                                       |
| `npm run format:check`     | Prettier (CI fails on unformatted files, Markdown included)   |
| `npm run lint`             | ESLint                                                        |
| `npm run typecheck`        | `tsc --noEmit` over `bin lib lambda test`                     |
| `npm test`                 | Vitest: template assertions and Lambda tests                  |
| `npm run synth`            | Staging, with cdk-nag                                         |
| `npm run synth:production` | Production with `config/site.example.json` (fictional values) |

CI (`.github/workflows/ci.yml`) runs all of the above plus four more jobs: `workflows` (actionlint
and shellcheck), `image-layers` (the OCC API and ingest layers build on a plain Node base),
`keycloak-image` (builds the Keycloak image from OCC's current realm; advisory, because a red result
means the other repository moved) and `audit` (`npm audit --audit-level=high`, only on the weekly
schedule and by hand). Dependabot opens weekly pull requests for npm packages and actions. The
required check is `verify`; the rest report.

Things to know before running them:

- `npm test` and `npm run synth` synthesise both stages and bundle the Lambdas with esbuild. It is
  CPU- and RAM-heavy for a laptop and the Vitest timeout is 120 s. Run them one at a time and do not
  leave watchers running.
- The PostgreSQL integration test (`lambda/database-bootstrap/plan.test.ts`) is **skipped** unless
  `TEST_DATABASE_URL` is set. A green local run without it does not cover the isolation guarantee
  (one system cannot open another's database). CI sets it from a `postgres:17` service, and when `CI`
  is set a missing URL fails the run instead of skipping.
- `images/keycloak/occ-realm.json` is git-ignored and generated. To build the Keycloak image locally,
  run `scripts/prepare-realm.sh <occ-repo>/docker/keycloak/occ-realm.json` first.

## 3. How the code is organised

| Path                           | Responsibility                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `bin/platform.ts`              | Reads `-c stage`, `-c imageTag`, `-c siteFile`; calls `buildPlatform`                                     |
| `lib/config.ts`                | The only place stages differ (`StageConfig`); `resolveStage`                                              |
| `lib/platform.ts`              | Creates the five stacks, wires them, tags them, applies nag acknowledgements                              |
| `lib/stacks/registry.ts`       | ECR repositories (`platform-<stage>/<image>`), `RETAIN`                                                   |
| `lib/stacks/network.ts`        | VPC (public / app / isolated), ECS cluster with Service Connect, alarm topic                              |
| `lib/stacks/data.ts`           | RDS, per-system login secrets, bootstrap, DB alarms                                                       |
| `lib/stacks/command-center.ts` | CloudFront, S3, ALB, WAF, Keycloak, API, API alarms (the largest file)                                    |
| `lib/stacks/telemetry.ts`      | IoT policies, ingest certificate, ingest service, telemetry alarms                                        |
| `lib/constructs/`              | `MetricsSidecar`, `DatabaseBootstrap`, `IotClientCertificate`, `CloudFrontOriginPrefixList`, `AlarmTopic` |
| `lib/database-access.ts`       | Security-group rule from a service to the database                                                        |
| `lib/nag.ts`                   | Every accepted cdk-nag finding with its reason                                                            |
| `lambda/database-bootstrap/`   | Creates databases and logins; `plan.ts` is the pure, tested part                                          |
| `lambda/iot-certificate/`      | Creates the IoT key pair and writes it straight to Secrets Manager                                        |
| `images/`, `scripts/`          | Thin platform layers over the services' own images; realm preparation                                     |
| `test/`                        | Assertions on synthesised templates (`helpers.ts` synthesises a stage)                                    |

Stack dependencies (CDK enforces the deploy order from the references):

```
Registry                                      (ECR repositories, deployed first by the workflow)
Network ──▶ Data ──▶ CommandCenter ──▶ Telemetry
   └─────────────────────────┴─────────────────▲   (VPC, cluster and alarm topic go to all three)
```

`CommandCenter` exports its API and Keycloak security groups; `Telemetry` adds ingress rules to them.

### Conventions the code relies on

1. **Stages differ only in `lib/config.ts`.** Stacks never branch on the stage name. The one other
   switch is `config.site`: when present, the stack uses the custom domain, HTTPS to the origin and
   real cameras. A staging deploy with a site file therefore behaves like a production one in those
   respects. Whether devices are expected, and so whether silence alarms, is its own setting
   (`telemetry.devicesExpected`).
2. **The consumer owns the security-group rule.** `allowDatabaseAccess` and the `IngestTo*` rules are
   created in the service's own stack. Creating them on the database or API side would make the
   stacks depend on each other in a cycle. Follow the same pattern for anything new.
3. **No secret in an environment variable.** Secrets are injected through the container `secrets`
   (Secrets Manager). A test fails if the API's environment has a name matching
   `PASSWORD|SECRET|PRIVATE|TOKEN`.
4. **Security acceptances are per resource.** See "Handle a cdk-nag finding" below.
5. **Tests assert properties, not snapshots** (ADR-0001), so they survive CDK upgrades. Keep it that
   way when adding tests.

## 4. Couplings that must stay consistent

Changing one side without the other fails at runtime, often with a misleading symptom, not at
synth.

| Invariant                                                                       | Defined in                                                   | If it drifts                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Public URL = `OIDC_ISSUER` = `KC_HOSTNAME` (+ `/auth`) = token `iss`            | `command-center.ts`                                          | Every API call is 401                                                              |
| Service Connect names `keycloak`, `occ-api`, and ports 8080 / 3000              | `command-center.ts`; **literals repeated** in `telemetry.ts` | Alert delivery or JWKS fetch fails                                                 |
| Topic `campus/+/+/telemetry`, share group `ingest`, client prefix `ingest`      | consts in `telemetry.ts`; ITP ADR-0001                       | Ingest receives nothing or is refused                                              |
| Device policy topic `campus/<zone>/<thing>/telemetry`                           | `telemetry.ts`                                               | Devices cannot publish                                                             |
| Realm contents: clients `occ-console`, `telemetry-pipeline`, audience `occ-api` | OCC repo (`docker/keycloak/occ-realm.json`)                  | Sign-in or alert delivery breaks; `prepare-realm.sh` only strips users and secrets |
| Ingest `minHealthyPercent: 100`; Keycloak `0 / 100`                             | `telemetry.ts`, `command-center.ts`                          | Dropped QoS 1 messages during deploys; two Keycloak nodes with separate caches     |
| ECR name `platform-<stage>/<image>` and tag `<occ>-<itp>-<run>-<attempt>`       | `registry.ts`, `deploy.yml`                                  | Tasks cannot pull their image                                                      |
| Region `ap-southeast-1`; CloudFront certificate in `us-east-1`                  | `config.ts`, `deploy.yml`, `site.json`                       | Synth or deploy refuses                                                            |
| Header `X-Viewer-Address` (CloudFront Function writes, WAF keys on it)          | `command-center.ts`                                          | Rate limits key on a forgeable address                                             |
| Database name = login name = secret `username`, lowercase `[a-z][a-z0-9_]*`     | `data.ts`, `lambda/database-bootstrap/plan.ts`               | Bootstrap throws                                                                   |

## 5. Recipes

### Resize, rescale, change retention

Edit the stage in `lib/config.ts`. Some tests pin concrete numbers (production `m7g.large`, API
2 to 6 tasks, ingest 4 connections, region); update them in the same change. Log retention must be
a value CloudWatch supports (`lib/retention.ts` throws otherwise). Ingest capacity is
`tasks × connections × 100 msg/s` (ADR-0003).

### Handle a cdk-nag finding

A new finding fails `npm test` and `npm run synth`. Decide whether to fix or accept.

- **Fix** if you can.
- **Accept** by adding an entry to `ACKNOWLEDGEMENTS` in `lib/nag.ts`: the narrowest `path` regex,
  the exact rule `id`, a real `reason`, and `when` if it holds only for some stages. Never
  acknowledge a whole stack.
- Copy the `id` from the failing output. Some ids embed a hashed logical id, for example
  `<BootstrapFunctionD62F3ADB.Arn>`, `<ApiMetricsEmfLogGroup710AD6A2.Arn>`,
  `<IngestCertificateFunction0D4AC654.Arn>`, and the `AWS679f…` custom-resource function.
  **Renaming or moving a construct changes those hashes and the path regexes, and the finding comes
  back.**

### Rotate the ingest certificate or the origin header

The runbook says "change the construct's id". That is correct and also **breaks cdk-nag**: the
acknowledgements match `IngestCertificate/…` and `OriginVerify/Resource` by path. Rename the
construct and update the matching entries in `lib/nag.ts` (including the hashed ids above) in the
same change, or CI fails.

### Add a database for a new system

1. Add the name to `DatabaseName` and to `databases` in each stage (`config.ts`).
2. The Data stack creates the secret and the bootstrap re-runs (the set of databases changed).
3. Add `allowDatabaseAccess(...)` in the new service's stack.
4. Extend the nag path `/(ops|keycloak|telemetry)-login/` (`SMG4`) in `lib/nag.ts`.
5. Extend the bootstrap assertion in `test/platform.test.ts`.

### Add a Fargate service

Mirror `TelemetryStack`: task definition, secrets from Secrets Manager, a log group with the stage's
retention, `MetricsSidecar` if it exposes Prometheus metrics, its own security group, the database
rule, Service Connect, `circuitBreaker: { rollback: true }`, autoscaling. Then: add the image name
to `IMAGES` in `registry.ts`; add the build to the `build` job and the image to the `docker save` and the push loop of the `deploy` job in `deploy.yml`; extend the `ECS2` and
`IAM5` entries in `lib/nag.ts`, whose paths list `KeycloakTask|ApiTask|IngestTask` explicitly;
add tests for what is exposed and to whom.

### Add a stage

Add an object to `STAGES` in `config.ts` (and to `NEEDS_SITE` if it is not a demo). Then update:
the `stage` choices and `AWS_REGION` in `deploy.yml`, the `synth()` type in `test/helpers.ts`,
the GitHub environments in the runbook. Stage names appear in stack names
(`Platform-<Stage>-…`), ECR repositories and the Cloud Map namespace; the VPC CIDR is fixed at
`10.40.0.0/16` in every stage.

### Upgrade a pinned component

| Component      | Where                                                               | Care                                                                        |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| PostgreSQL     | `VER_17_9`, **twice** in `data.ts` (parameter group and instance)   | Change both                                                                 |
| Keycloak       | `ARG KEYCLOAK_IMAGE` (tag **and** digest) in `images/keycloak/`     | Minor upgrade is deliberate (ADR-0006); re-test realm import and the issuer |
| ADOT collector | `ADOT_COLLECTOR_IMAGE` (tag **and** digest) in `metrics-sidecar.ts` | Config format changes between releases; take the multi-arch index digest    |
| RDS CA bundle  | `ADD --checksum=…` in the three `images/*/Dockerfile`               | See "Refresh the RDS CA bundle" in the runbook                              |
| CDK / cdk-nag  | `package.json`                                                      | Generated shapes can break assertions; fix the assertion, not the stack     |
| Lambda runtime | `NODEJS_24_X` in two constructs                                     | Bundling banner and `NODE_EXTRA_CA_CERTS` path assume the managed runtime   |

### Add an environment variable to a service

Non-secret values go in the container `environment` in the stack file. Secrets go in `secrets`
from Secrets Manager. If the API reads a new setting, check the OCC repo for its name.

### Operational tasks

Registering a device, rotating credentials, first-time Keycloak setup: `docs/runbook.md`. The
system-login rotation needs `database.loginGeneration` bumped in `config.ts`.

## 6. First deployment and what is still unproven

Prerequisites are in the runbook (CDK bootstrap, the GitHub OIDC deploy role, environments with
`AWS_DEPLOY_ROLE_ARN` and `SITE_JSON`). Note that `deploy.yml` reads them as `vars.*`, so define
them as environment **variables**, not secrets. Start with staging.

Run the Deploy workflow, then do the runbook's "After the first deployment" steps. Then verify
these, which the ADRs list as designed but never observed. Update the ADRs when each is confirmed.

1. **Sign-in through CloudFront under `/auth`**, and that a token issued on the internal address
   (`keycloak:8080`, used by ingest) carries the public issuer. Compare `iss` with `OIDC_ISSUER`.
2. **Keycloak generates the `telemetry-pipeline` client secret on import.** Then copy it to
   `PipelineClientSecret` and restart ingest. Until then alerts sit in ITP's outbox and ingest logs
   `invalid_client`.
3. **IoT policy evaluation.** Ingest subscribes to the shared filter; a wider filter is refused. A
   device can publish only to its own topic and cannot connect under another name.
4. **Collector conversion.** `telemetry_sequence_gaps_total` must arrive in CloudWatch as a
   per-period sum before the `SequenceGaps` alarm is trusted (ADR-0005).
5. **ALB lockdown.** A direct request to the ALB's DNS name gets 404, as does `/auth/admin`; an
   ambiguous path such as `/auth/..` gets 400.
6. **WAF.** Look for false positives of the common rule set on large bodies (ADR-0004), and that
   the rate limits trigger per viewer address.
7. **Rollbacks.** The ECS circuit breaker rolls back an unhealthy release.
8. **Console publish.** Client-side routes load, `index.html` is revalidated, hashed assets are
   cached.
9. **ECS Exec logging.** Open `aws ecs execute-command` on the Keycloak task and check the session
   appears in the Network stack's `ExecLogs` group (the task role may write there). Then open the
   runbook's port-forward and check whether it appears there too; it is expected not to, in which
   case only CloudTrail records it.
10. **Database parameter group.** RDS accepts `log_parameter_max_length = 0` (ADR-0008), and a slow
    statement is logged without its values.

## 7. Operating it

Alarms all notify one SNS topic per stage; confirm the e-mail subscription after deploy. The
symptom-to-first-check table is in the runbook.

| Alarm                                  | Stack         | Meaning                                                                                                                               |
| -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Api5xx`, `ApiUnhealthy`, `ApiLatency` | CommandCenter | API errors, a replica failing readiness, p95 above 1 s                                                                                |
| `KeycloakDown`                         | CommandCenter | No running Keycloak task for 5 min (a release takes about a minute, so it does not alarm)                                             |
| `CpuHigh`, `StorageLow`                | Data          | DB CPU above 80 % for 15 min; free storage under 10 % of the initial volume for 15 min (autoscaling not keeping up or at its maximum) |
| `SequenceGaps`                         | Telemetry     | Devices reported lost messages                                                                                                        |
| `IngestTasksLow`                       | Telemetry     | Fewer ingest tasks running than the stage's minimum for 5 min                                                                         |
| `NoReadings`                           | Telemetry     | No readings for 15 min. Only where `telemetry.devicesExpected` is set. It also fires if the metrics collector stops                   |

Task counts come from Container Insights (enabled on the cluster) and treat missing data as
breaching, because a service with no task can stop reporting. There is still no alarm on the API's
running task count (`ApiUnhealthy` needs targets to exist) or on CPU or memory of the services.

## 8. Known risks and gaps

Ordered by how much I would worry. None is fixed here; each is a candidate ticket.

1. **Resolved (ADR-0007): production teardown used to lose logs.** Production now keeps its log
   groups and the access-log bucket when a stack is deleted (`observability.retainLogs`); they
   have to be deleted by hand afterwards. Demo stages still remove them.
2. **Keycloak is a single task** with a local cache. A release means about a minute without
   sign-in and a task failure means no sign-in until it restarts. This is a documented trade-off
   (ADR-0006). The `KeycloakDown` alarm now reports it after five minutes without a task.
3. **The `X-Origin-Verify` value is not hidden from AWS readers (accepted, ADR-0009).** The template holds only a
   Secrets Manager dynamic reference (a test asserts that), but CloudFormation resolves it and the
   plaintext is stored in the CloudFront origin custom header and the ALB listener rules. Anyone
   with describe permissions on those can read it. It is the second layer after the prefix list;
   if it leaks, the rate limits stop being reliable and nothing that needs an identity opens. Keep
   those describe permissions narrow.
4. **The deploy workflow applies everything unreviewed.** `cdk deploy --all --require-approval never`
   means IAM and security-group changes are not paused for confirmation. The only gate is the
   required reviewers on the `production` GitHub environment, which is configured outside this
   repository. What changed: the code of the other two repositories is now built in a separate
   `build` job with no AWS access, so a malicious dependency there cannot read the deploy role's
   token. The `deploy` job still pushes what that job built and uploads its console files into
   AWS, so a compromised build can still ship a bad release; it just cannot reach the account
   directly. The workflow's new final check does not roll anything back.
5. **Floating inputs (mostly closed).** `occ_ref` and `itp_ref` are now required with no default; the
   Keycloak and ADOT images are pinned by digest; the RDS CA bundle is checked against a SHA-256 and
   GitHub Actions are pinned by commit SHA (Dependabot keeps them current). What remains is that a
   ref may still be a branch name, which builds whatever it points to at that moment.
   (The image tag itself is now safe: the repositories are immutable, the tag carries the attempt
   number, and a stage has the tag `unset-pass-imageTag` until a deploy names one, so a manual
   `cdk deploy` without `-c imageTag=…` fails to pull and rolls back, with a name that says why.)
6. **Coupling to the other two repositories.** CI checks out OCC `main` and reads
   `docker/keycloak/occ-realm.json`; `deploy.yml` assumes `docker/api/Dockerfile`,
   `apps/ingest/Dockerfile` and `pnpm --filter @occ/console`. A refactor upstream breaks CI or
   deploy here with no change in this repository, and it has happened: OCC moved its Docker files
   into `docker/` on 2026-10-22, which broke the `keycloak-image` job and the Deploy workflow
   until the paths here were updated.
7. **Manual steps that fail quietly.** The pipeline client secret copy, the alarm e-mail
   confirmation, deleting the Keycloak bootstrap administrator, and system-password rotation
   (`loginGeneration` plus a restart) all depend on a person remembering.
8. **Staging is a demo.** `demoMode` seeds data and runs a simulator, and CloudFront reaches the
   ALB over HTTP inside AWS (restricted to CloudFront addresses). Keep it away from real data.
9. **Command-center telemetry is not connected on AWS.** Production runs `TELEMETRY_SOURCE=off`, so
   the console has no asset telemetry there. Fixing it needs client-certificate support in OCC
   (ADR-0003).
10. **Devices are registered by hand** until fleet provisioning exists (ITP-17).
11. **Literal duplication.** Ports 3000 and 8080 and the Service Connect names are repeated in
    `telemetry.ts`; the PostgreSQL version appears twice in `data.ts`.

## 9. Decisions to revisit

The ADRs end with "Revisit when"; the short form:

- Terraform instead of CDK when infrastructure outside AWS must be managed (0001).
- A second RDS instance when one system's load or maintenance needs diverge (0002).
- Mosquitto on ECS when a site needs the broker on its own premises, or an IoT rule into a queue if
  per-connection limits get unwieldy (0003).
- A WAF on CloudFront (separate stack in `us-east-1`) if the edge needs it; separate hostnames if
  console and API need different release domains (0004).
- Managed Prometheus and Grafana if teams want existing dashboards on AWS (0005).
- Cognito or the site's own IdP once OCC supports runtime IdP configuration; two Keycloak nodes if
  availability matters, which needs the cluster port opened and failover tested (0006).

## 10. Outside this repository

- [ops-command-center](https://github.com/truongtankhanh/ops-command-center): realm, API, console
  (OCC-29 added the pipeline's client).
- [iot-telemetry-pipeline](https://github.com/truongtankhanh/iot-telemetry-pipeline): ingest;
  ITP-17 (fleet provisioning), ITP-19 (certificates and multiple connections), ITP-20 (client
  credentials).
- [architecture-decisions](https://github.com/truongtankhanh/architecture-decisions): platform-wide
  ADRs referenced throughout (0003 databases private to a system, 0005 and 0006 identity,
  0007 Compose as the on-premises target, 0010 observability baseline).
