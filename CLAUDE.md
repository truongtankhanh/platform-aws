# platform-aws

AWS infrastructure as TypeScript CDK for the campus operations platform: `ops-command-center` (OCC) and
`iot-telemetry-pipeline` (ITP) on ECS Fargate, RDS PostgreSQL, CloudFront and AWS IoT Core. It holds no application
code; it deploys images built from the other two repositories. Never deployed from this repository (no AWS account is
attached), so CI proves synthesis, cdk-nag and property assertions, not behaviour on AWS.

Details: `CONTEXT-SCAN.md` (full scan), `docs/architecture.md`, `docs/adr/`, `docs/runbook.md`, `docs/handover.md`.

## What it is

- **Primary:** an AWS CDK app (`bin/platform.ts` -> `lib/platform.ts` -> five stacks per stage: Registry, Network, Data,
  CommandCenter, Telemetry).
- **Secondary:** two CloudFormation custom-resource Lambdas in `lambda/` (database bootstrap, IoT certificate).
- **Minor:** `images/*/Dockerfile` platform layers over images built from OCC and ITP.
- **Not here:** a local dev environment (no compose), a server, a CLI or a library. The repo cannot run locally.

## Commands

| Command                    | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `npm ci`                   | Install (Node >= 22; CI uses 24)                                       |
| `npm run lint`             | ESLint                                                                 |
| `npm run typecheck`        | `tsc --noEmit` (`npm run build` is the same; there is no build output) |
| `npm run format:check`     | Prettier; CI fails on unformatted Markdown too                         |
| `npm test`                 | Vitest: template assertions and Lambda tests                           |
| `npm run synth`            | Staging, with cdk-nag                                                  |
| `npm run synth:production` | Production with `config/site.example.json`                             |

`npm test` and the synth commands synthesise both stages and bundle the Lambdas with esbuild; they are heavy. The
PostgreSQL integration test in `lambda/database-bootstrap/plan.test.ts` runs only when `TEST_DATABASE_URL` is set
(CI sets it); without it, it is skipped.

## Stack in one paragraph

TypeScript (strict, ESM, NodeNext), `aws-cdk-lib` + `constructs` + `cdk-nag` (AWS Solutions pack), run with `tsx`
(no build step). Lambdas are bundled by `NodejsFunction` (esbuild, ARM64, `NODEJS_24_X`) and use the AWS SDK v3 and
`pg`. Tests: Vitest. Formatting: Prettier (single quotes, trailing commas, width 100). No framework, no ORM, no logger
library, no validation library.

## Rules for working here

Conventions are in `.claude/rules/`: `async-and-errors.md`, `module-and-style.md`, `cdk-conventions.md`, `testing.md`.
The ones that matter most:

- Stages differ only in `lib/config.ts`; stacks never branch on the stage name.
- A cdk-nag acknowledgement goes on the exact construct with a reason, in `lib/nag.ts`. Renaming a construct changes
  the path regexes and the hashed logical ids there.
- Secrets come from Secrets Manager; no secret in an environment variable.
- Do not run tests or synth yourself on this machine; ask for the output. `lint`, `typecheck` and `format:check`
  are fine.
