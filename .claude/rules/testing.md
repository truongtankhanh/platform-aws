# Testing

- Vitest 5. Template assertions are in `test/platform.test.ts` with helpers in `test/helpers.ts` (`synth`, `containers`,
  `environmentOf`, `secretNamesOf`, `flatten`). Lambda tests sit beside the code as `*.test.ts`.
- Assert on properties that matter (who can reach what, where secrets come from, what the service is told), not on whole
  templates, so a CDK upgrade does not break tests for no reason.
- A test proves cdk-nag fails on a new finding; keep it.
- The PostgreSQL isolation test needs `TEST_DATABASE_URL` and a PostgreSQL the test may create and drop databases on
  (names carry a random suffix). It is skipped without the variable; CI sets it.
- Tests and synth synthesise both stages and are heavy: run them one at a time, never in watch mode, and ask for the
  output instead of running them from an automated session.
