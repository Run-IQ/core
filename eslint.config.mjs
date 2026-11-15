import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'node_modules/', '**/*.config.*'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    // AK10: `instanceof` never decides what a value is in the package: a subclass, a forged
    // prototype or a patched Symbol.hasInstance can satisfy it. Use identity (a WeakSet filled where
    // the value is made), `isEngineError`, `util.types` brand checks, or `src/utils/brand.ts`.
    // The allow-list is empty on purpose: a new use needs a ruling.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='instanceof']",
          message: 'instanceof is forbidden in src/: tell a value by identity or by a brand check.',
        },
      ],
    },
  },
);
