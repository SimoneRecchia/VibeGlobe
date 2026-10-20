import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig } from 'eslint/config';
import jsdoc from 'eslint-plugin-jsdoc';
import playwright from 'eslint-plugin-playwright';
import tseslint from 'typescript-eslint';
import { noCommentedOutCode } from './scripts/eslint/no-commented-out-code.ts';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      'docs-site/**',
      'test-results/**',
      'playwright-report/**',
      'benchmark-results/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    plugins: { local: { rules: { 'no-commented-out-code': noCommentedOutCode } } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'local/no-commented-out-code': 'error',
      // Small, focused modules and short functions (PLAN.md, Code quality); hot paths and tests are exempt below.
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['**/*.hot.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: { 'max-lines-per-function': 'off', 'max-lines': 'off' },
  },
  {
    // TSDoc on every public API of the published packages.
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: true },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSEnumDeclaration',
            'ExportNamedDeclaration > VariableDeclaration',
          ],
          checkConstructors: false,
        },
      ],
    },
  },
  {
    // Tests are never focused or skipped (PLAN.md: never remove or weaken a test).
    files: ['**/*.test.ts', '**/*.spec.ts'],
    plugins: { vitest },
    rules: {
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^(skipIf|runIf)$/]',
          message: 'Tests are never skipped conditionally.',
        },
      ],
    },
  },
  {
    // Playwright specs: the Vitest rules do not see tests imported from @playwright/test (KB-005).
    files: ['e2e/**/*.{spec,test}.ts'],
    plugins: { playwright },
    rules: {
      'playwright/no-focused-test': 'error',
      'playwright/no-skipped-test': ['error', { allowConditional: false, disallowFixme: true }],
    },
  },
);
