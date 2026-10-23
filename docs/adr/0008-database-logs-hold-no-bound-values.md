# ADR-0008: The database log holds statements, not the values bound to them

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

The RDS instance logs statements slower than one second (`log_min_duration_statement`, ADR-0002's parameter group) and exports the `postgresql` log to CloudWatch for the
stage's retention. PostgreSQL logs such a statement together with the values bound to its parameters unless `log_parameter_max_length` says otherwise, and its default is
to log them in full. The services behind this database (ops-command-center, iot-telemetry-pipeline, Keycloak) bind their own data: incident descriptions, zone and device
identifiers, user subjects. A slow query would therefore copy that data into a log group that more people can read than can read the database.

## Options

1. **Keep the default.** Slow-query logs show exactly which values were slow, which helps tuning; the data lands in CloudWatch.
2. **Turn slow-statement logging off.** No exposure, and no way to see a slow query.
3. **Keep the logging, drop the values** (`log_parameter_max_length = 0`). The statement text and its duration are logged, the bound values are not.

## Decision

Option 3, in the parameter group in `lib/stacks/data.ts`, with a test that asserts both settings.

The statement text is still useful for tuning (which query, how long, how often). If a particular slow query needs its values to be reproduced, they can be taken from the
service that issued it, or the parameter can be raised for the length of an investigation and set back.

## Consequences

- Slow-query entries show `$1`, `$2` and so on instead of values.
- **This does not cover a literal inside the statement text.** The database bootstrap sets a login's password with `CREATE ROLE ... PASSWORD '...'` and `ALTER ROLE ...`, where the
  password is part of the text. PostgreSQL logs the text of a statement that fails (and of one that runs longer than the threshold). The Lambda's own log never contains the password, but
  the server log could. Closing that is a separate decision, tracked as open work until it is confirmed on a live account and a mitigation is chosen; it is not solved by this ADR.
- `log_parameter_max_length` is a standard PostgreSQL parameter, but whether RDS accepts it in this parameter group has not been observed (no AWS account is attached). The first
  deployment confirms it.

## Revisit when

A tuning need appears that the statement text alone cannot serve, or the first deployment shows RDS rejecting the parameter.
