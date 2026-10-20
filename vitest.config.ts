import { readFileSync } from 'node:fs';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Coverage minima live in a versioned file so the test guard can detect any loosening (scripts/check-tests.ts).
const coverageThresholds = JSON.parse(
  readFileSync(new URL('quality/coverage.json', import.meta.url), 'utf8'),
) as Record<string, { lines: number }>;

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources, so tests need no prior build.
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    setupFiles: ['scripts/test/property-seed.ts'],
    projects: [
      {
        extends: true,
        test: { name: 'packages', include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'] },
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
