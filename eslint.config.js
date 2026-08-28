// Flat ESLint config for the whole monorepo.
// Kept intentionally lean: typescript-eslint's non type-checked recommended set
// gives fast, deterministic feedback in CI without needing a full program build.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/drizzle/**',
      '**/.pglite/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Scripts, seeds and the CLI-facing surfaces legitimately print to stdout.
    files: ['scripts/**/*.ts', 'packages/db/src/seed/**/*.ts', 'apps/api/src/server.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts'],
    languageOptions: {
      globals: { React: 'readonly', process: 'readonly', fetch: 'readonly', URLSearchParams: 'readonly' },
    },
  },
);
