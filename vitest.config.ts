import { readFileSync } from 'node:fs';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Coverage minima live in a versioned file so the test guard can detect any loosening (scripts/check-tests.ts).
const coverageThresholds = JSON.parse(
  readFileSync(new URL('quality/coverage.json', import.meta.url), 'utf8'),
) as Record<string, { lines: number }>;

/**
 * Tests that count heap allocations by sampling (F064, KB-028): V8 coverage instrumentation changes how functions are
 * optimized, so their counts mean nothing under it. A coverage run leaves them out and `npm run coverage` runs them
 * after it, uninstrumented (docs/test-changes.md, 2026-10-22).
 */
const ALLOCATION_TESTS = [
  'packages/core/src/globe/frame-allocation.test.ts',
  'packages/core/src/cache/cache-allocation.test.ts',
  'packages/renderer/src/eye-relative.test.ts',
];
/**
 * They also run only when named on the command line (`npm run coverage` names them, one file at a time): next to the
 * other files they measured the load of the machine, not the engine (KB-106).
 */
const allocationRun = process.argv.some((arg) => ALLOCATION_TESTS.some((file) => arg.endsWith(file)));

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources, so tests need no prior build.
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    setupFiles: ['scripts/test/property-seed.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          exclude: allocationRun ? [] : ALLOCATION_TESTS,
        },
      },
      { extends: true, test: { name: 'scripts', include: ['scripts/**/*.test.ts', 'benchmarks/**/*.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reporter: ['text-summary', 'html'],
      thresholds: coverageThresholds,
    },
  },
});
