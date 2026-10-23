# Modules and style

- ESM (`"type": "module"`, `module: NodeNext`). Relative imports end in `.js`: `from '../config.js'`.
- Type-only imports use `import type` (ESLint `@typescript-eslint/consistent-type-imports` is `error`;
  `verbatimModuleSyntax` is on).
- Files are kebab-case, one primary class or concern per file. Stacks live in `lib/stacks/`, reusable constructs in
  `lib/constructs/`, plain helpers directly in `lib/`.
- Prettier (`.prettierrc`): single quotes, trailing commas `all`, `printWidth` 100. `.editorconfig`: LF, 2 spaces,
  final newline. CI runs `prettier --check .`, Markdown included.
- ESLint: `js.configs.recommended` + `typescript-eslint` recommended; `no-new` is off because constructs are created
  for their side effects.
- TypeScript is strict with `noUncheckedIndexedAccess`; indexed access needs a guard or `!` with a reason.
- Doc comments (`/** */`) explain why, not what, and reference the ADR where one applies.
