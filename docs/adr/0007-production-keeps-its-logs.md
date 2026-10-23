# ADR-0007: Production keeps its logs when a stack is deleted

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

Every log group, and the access-log bucket that holds the CloudFront, load balancer and S3 access logs, was created with `RemovalPolicy.DESTROY` in every stage, and
the bucket also emptied itself on deletion. The database and the image repositories were already protected in production (`deletionProtection`, `RETAIN`), so the
asymmetry was in the logs: deleting or replacing a production stack, by mistake or on purpose, destroyed the evidence of what the system had done, including the
record of who reached the load balancer. A demo stage has the opposite need: it is torn down and rebuilt, and leftovers from each cycle are clutter and cost.

## Options

1. **Keep `DESTROY` everywhere.** Simple, and the demo stage is clean, but production loses its audit trail with its stack.
2. **`RETAIN` everywhere.** Safe, but every rebuilt demo stage leaves orphaned log groups and a bucket behind.
3. **A stage setting.** Production retains, the demo stage does not, decided in the stage configuration like the other differences between stages (ADR-0001).

## Decision

Option 3.

- `observability.retainLogs` in `lib/config.ts`: `false` for staging, `true` for production.
- Every log group in the app is created through `logGroup()` in `lib/retention.ts` with the stage's `LogPolicy` (retention and removal), so a new log group cannot be created
  with its own removal policy by accident. A test asserts the policy of every log group in every stack for both stages.
- The access-log bucket follows the same setting. A bucket that is kept is not emptied on deletion (emptying only makes sense when the bucket goes too), so
  `autoDeleteObjects` is on only when the bucket is removed.
- Not covered, on purpose: the console bucket (every deploy rebuilds and republishes it) and the IoT client certificate secret (the certificate it holds is deleted
  with the resource, so the secret must not outlive it).

## Consequences

- Deleting a production stack leaves its log groups and the access-log bucket behind. They are not billed for compute, but they keep storing: log groups keep their
  retention (90 days in production), so events still age out, and the bucket's lifecycle rule keeps expiring objects. The empty shells have to be deleted by hand once the
  evidence is no longer needed.
- Rebuilding a production stack creates new log groups with new generated names, so nothing collides with the ones that were kept.
- Logs of the database instance itself are managed by RDS and are unaffected by this setting.
- Verified by template assertions only. How CloudFormation behaves when a production stack is actually deleted has not been observed (no AWS account is attached).

## Revisit when

A stage other than staging and production is added (it needs its own value), or the logs move to a central account or an organisation-wide log archive, which makes
per-stack retention moot.
