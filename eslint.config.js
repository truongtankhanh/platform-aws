import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['cdk.out/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // CDK constructs are created for their side effects on the tree.
      'no-new': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
