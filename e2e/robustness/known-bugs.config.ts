// The robustness suite's specs of open engine bugs (track G, ADR 0161): `known-bugs/*.bug.ts`, which the default run
// (`playwright.config.ts`, `*.spec.ts`) does not match. Each one fails until its bug in docs/internal/known-bugs.md is fixed;
// the fix renames it to `.spec.ts` (docs/internal/test-changes.md).
// Run: `npx playwright test -c e2e/robustness/known-bugs.config.ts`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chromium = base.projects?.find((project) => project.name === 'chromium');

/** @public Playwright reads it (`-c`). */
export default defineConfig({
  ...base,
  testDir: 'known-bugs',
  testMatch: '**/*.bug.ts',
  projects: [{ name: 'chromium', use: chromium?.use ?? {} }],
  // The servers' commands are written for the repository root.
  webServer: [base.webServer ?? []].flat().map((server) => ({ ...server, cwd: root })),
});
