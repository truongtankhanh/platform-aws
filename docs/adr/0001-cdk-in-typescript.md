# ADR-0001: Infrastructure as code with AWS CDK in TypeScript

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The platform's two systems are TypeScript on Node.js, built by a small team that reviews every
change. The infrastructure has to describe two stages that differ in size and in a few behaviours
(demo data, custom domain, Multi-AZ), and it must be checkable in CI without an AWS account: the
public repository has none attached.

## Options

1. **CloudFormation or SAM templates** — no build step, but stage differences become conditions
   and parameters, and nothing can be unit-tested beyond linting.
2. **Terraform** — a large ecosystem and multi-cloud, but a second language for the team, state to
   host and lock, and plan output that needs an account to produce.
3. **AWS CDK in TypeScript** — the team's language; stages are typed objects; templates are
   synthesised offline and can be asserted on in ordinary tests; `cdk-nag` checks them against
   the AWS Solutions rules on every synth.

## Decision

Option 3.

- Stage differences live in one typed file (`lib/config.ts`); stacks never branch on a stage
  name. Values only a site can provide (domain, certificates, camera relay, alarm email) come
  from a JSON file outside the repository, and a stage that needs them refuses to synthesise
  without them.
- Five stacks per stage, split by rate of change and by blast radius: Registry, Network, Data,
  CommandCenter, Telemetry.
- `cdk-nag`'s AWS Solutions pack runs on every synth. Accepted findings are acknowledged on the
  exact construct that raised them, with the reason, in `lib/nag.ts`; a new finding anywhere
  fails CI.
- Tests synthesise both stages and assert on what matters for security and operation: who can
  reach what, where secrets come from, what the services are told about their environment.

## Consequences

- CI proves the infrastructure synthesises, passes the checks and has the properties the tests
  state. It does not prove it deploys: that needs an account (see the README's status).
- CDK's generated resources (custom-resource providers, log-retention functions) appear in the
  templates and in the nag findings; each is acknowledged with a reason rather than hidden.
- Tests assert on CloudFormation, so a CDK upgrade that changes generated shapes can break a test
  without breaking anything real. Assertions target properties, not whole templates, to keep
  that rare.

## Revisit when

Infrastructure outside AWS has to be managed alongside (then Terraform's providers start to pay
for themselves), or the team stops being a TypeScript team.
