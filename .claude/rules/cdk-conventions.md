# CDK conventions

Observed in `lib/` and confirmed by `docs/adr/0001` and the tests.

- **Stage differences live only in `lib/config.ts`** (`StageConfig`). Stacks read config and never branch on the stage
  name. The other switch is `config.site` (custom domain, HTTPS to origin, real cameras, `NoReadings` alarm).
- **Secrets**: from Secrets Manager through the container `secrets`. No secret in `environment`; a test checks the API's
  variable names.
- **Security groups**: the consumer stack creates the ingress rule (`allowDatabaseAccess`, `IngestTo*`), because creating
  it on the target side would make the stacks depend on each other.
- **cdk-nag**: every accepted finding is an entry in `ACKNOWLEDGEMENTS` (`lib/nag.ts`) with the narrowest `path`
  regex, the exact rule id and a reason. Never acknowledge a whole stack. Some ids embed hashed logical ids; renaming or
  moving a construct breaks them.
- **Log groups** get the stage's retention through `retention()`; services use `circuitBreaker: { rollback: true }`.
- **Cross-repo values** (topic filter, share group, client id prefix, ports, metric names) are read by ITP's parity
  test from `lib/stacks/telemetry.ts`; restructure that file with care.
- Significant decisions get an ADR in `docs/adr/` (context, options, decision, consequences, revisit when).
