import { defineConfig, devices } from '@playwright/test';
import { gpuArgs } from './scripts/browser/gpu-args.ts';

const port = Number(process.env['PLAYGROUND_PORT'] ?? 5173);
const docsPort = Number(process.env['DOCS_PORT'] ?? 5174);
// Cloud containers ship a preinstalled Chromium; init.sh points VIBEGLOBE_CHROMIUM_PATH at it.
const chromiumPath = process.env['VIBEGLOBE_CHROMIUM_PATH'];

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  // Visual baselines (ADR 0012): one per view and backend, recorded only in the pinned CI environment.
  snapshotPathTemplate: '{testDir}/__baselines__/{arg}{ext}',
  forbidOnly: Boolean(process.env['CI']),
  // ADR 0012: on CI a failure is retried once to record a trace, but a test that passes only on retry fails the run.
  retries: process.env['CI'] ? 1 : 0,
  failOnFlakyTests: Boolean(process.env['CI']),
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: { args: gpuArgs(), ...(chromiumPath ? { executablePath: chromiumPath } : {}) },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'npm run dev', url: `http://localhost:${port}`, reuseExistingServer: true },
    // The lazy-loading fixture host (F547) is served from its production build (npm run build first).
    {
      command: 'npm run preview -w @vibeglobe/lazy-host',
      url: `http://localhost:${process.env['LAZY_HOST_PORT'] ?? 5175}`,
      reuseExistingServer: true,
    },
    {
      command: `npm run docs && npm run docs:serve -- --port ${docsPort}`,
      url: `http://localhost:${docsPort}`,
      reuseExistingServer: true,
    },
  ],
});
