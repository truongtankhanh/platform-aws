# ADR-0002: One PostgreSQL instance per stage, one database and login per system

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Three things need PostgreSQL: the command center (`ops`), Keycloak (`keycloak`) and the telemetry
pipeline (`telemetry`). The platform rule is that a system's database is private to it
([platform ADR-0003](https://github.com/truongtankhanh/architecture-decisions/blob/main/decisions/0003-systems-integrate-through-public-apis-never-a-shared-database.md)).
At campus scale none of them needs a large instance, and RDS charges per instance.

RDS creates one database and one admin login. Creating more databases and logins needs SQL,
which CloudFormation cannot run.

## Options

1. **One instance per system** — strongest isolation (noisy neighbours, maintenance windows,
   major upgrades independent), three times the instance cost and three Multi-AZ pairs in
   production.
2. **Aurora Serverless v2** — scales to the load, but its minimum capacity costs more than a small
   provisioned instance for a steady, modest load, and it adds an engine to learn.
3. **One instance per stage; one database and one owning login per system** — privacy enforced by
   PostgreSQL itself, one instance to pay for and operate.

## Decision

Option 3.

- Each system's login owns its database; `CONNECT` is revoked from `PUBLIC`, so a login cannot
  open another system's database. The integration test runs this against a real PostgreSQL and
  checks the refusal.
- A custom resource (`lambda/database-bootstrap`) creates the logins and databases with passwords
  from each system's own secret. It is idempotent: a re-run only sets each password again, which
  is also how a rotated system password reaches the database.
- The instance enforces TLS (`rds.force_ssl=1`) and every client verifies the server certificate:
  the services' images get the RDS CA bundle in a thin platform layer (`images/`).
- Storage autoscales; Multi-AZ, backups and deletion protection are stage settings.

## Consequences

- A heavy query in one system can slow the others. CPU and storage alarms watch the instance;
  splitting a system out is a new instance plus a dump and restore, with no code change.
- System passwords are not rotated by a rotation function: rotating one means updating its
  secret, re-running the bootstrap and restarting that service (docs/runbook.md). The admin login
  rotates automatically every 30 days.
- The bootstrap needs a Lambda function inside the VPC with access to the admin secret. It runs
  only during deployments and has no other trigger.

## Revisit when

One system's load or maintenance needs differ enough from the others' that sharing costs more in
coordination than a second instance costs in money.
