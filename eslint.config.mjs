import tseslint from 'typescript-eslint';
import { globalIgnores } from 'eslint/config';

export default [
  globalIgnores(['**/node_modules/**', '**/.next/**', '**/dist/**', '**/storage/**', '**/artifacts/**', '**/.worktrees/**', '**/spikes/**']),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-debugger': 'error',
      eqeqeq: 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-debugger': 'error',
      eqeqeq: 'error',
    },
  },
];
