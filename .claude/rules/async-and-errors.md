# Async and errors

Observed across `bin/`, `lib/` and `lambda/` (no exceptions found).

- Use `async`/`await`. The code has no `.then(`, no `new Promise`, no callbacks and no `require(`.
- Fail with a plain `throw new Error(<message>)` that names the offending value, for example
  ``throw new Error(`Invalid database name "${name}"`)``. There are no custom `Error` classes; do not add one without a
  reason.
- Validate at the boundary and throw: `resolveStage` (unknown stage, missing site values), `retention` (unsupported
  days), `plan` (identifier, empty password), Lambda handlers (incomplete SDK results).
- Lambda handlers let errors propagate so the custom resource fails. The only `try` blocks are `try/finally` around
  closing a client (`database-bootstrap`) and a tolerant `ignoreMissing` for `ResourceNotFoundException`
  (`iot-certificate`).
- Never log a secret. `describe()` in `plan.ts` exists so passwords are replaced before logging.
