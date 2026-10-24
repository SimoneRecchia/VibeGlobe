import { defineConfig, devices } from '@playwright/test';
import { gpuArgs } from './scripts/browser/gpu-args.ts';

const port = Number(process.env['PLAYGROUND_PORT'] ?? 5173);
const docsPort = Number(process.env['DOCS_PORT'] ?? 5174);
// Cloud containers ship a preinstalled Chromium; init.sh points VIBEGLOBE_CHROMIUM_PATH at it.
const chromiumPath = process.env['VIBEGLOBE_CHROMIUM_PATH'];
/**
 * Elsewhere (CI's container), the full Chromium in its headless mode rather than Playwright's default headless shell:
 * the shell has no display pacing, so it queues frames faster than SwiftShader draws them and a capture waits behind
 * the queue for minutes (KB-102).
 */
const CHROMIUM = { ...devices['Desktop Chrome'], ...(chromiumPath ? {} : { channel: 'chromium' }) };
/** Tests whose results depend on having the machine to themselves. */
const MEASURES_THE_MACHINE =
  /globe-allocation\.spec\.ts|controls-inertia\.spec\.ts|imagery-timing\.spec\.ts|globe-leaks\.spec\.ts|adapter-leaks\.spec\.ts|hud-overhead\.spec\.ts/;
/** Without Docker (CI's container shards), the LAN host test runs elsewhere (CI's lan job). */
const NEEDS_DOCKER = process.env['VIBEGLOBE_NO_DOCKER'] === '1' ? [/offline-lan\.spec\.ts/] : [];
/**
 * With VIBEGLOBE_CROSS_BROWSER=1 (CI's nightly cross-browser job), the globe suites also run in Firefox and WebKit on
 * WebGL2 (and the measured link, F300, where the Network Information API is missing); tests of WebGPU itself stay
 * Chromium-only, and so do the visual baselines (recorded in CI's Chromium).
 */
const CROSS_BROWSER_SPECS =
  /globe-(core|precision|lifecycle)\.spec\.ts|offline-browsers\.spec\.ts|adaptive-loading\.spec\.ts/;
const WEBGPU_TESTS = /webgpu|WebGPU/;
const crossBrowserProjects =
  process.env['VIBEGLOBE_CROSS_BROWSER'] === '1'
    ? (['Desktop Firefox', 'Desktop Safari'] as const).map((device) => ({
        name: device === 'Desktop Firefox' ? 'firefox' : 'webkit',
        // The Chromium flags and executable do not apply.
        use: {
          ...devices[device],
          // Firefox disables WebGL on software-only Linux machines unless forced, and asks the user before persisting
          // storage: its testing prefs answer that prompt (F276).
          launchOptions:
            device === 'Desktop Firefox'
              ? {
                  firefoxUserPrefs: {
                    'webgl.force-enabled': true,
                    'dom.storageManager.prompt.testing': true,
                    'dom.storageManager.prompt.testing.allow': true,
                  },
                }
              : {},
        },
        testMatch: CROSS_BROWSER_SPECS,
        grepInvert: WEBGPU_TESTS,
      }))
    : [];

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  // Shards split by test, not by file, so a long spec does not hold one shard far past the others (ADR 0035).
  fullyParallel: true,
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
  projects: [
    { name: 'chromium', use: CHROMIUM, testIgnore: [MEASURES_THE_MACHINE, ...NEEDS_DOCKER] },
    // Measurements of the whole machine (heap sampling, GC traces) run after every other test, alone (F064).
    {
      name: 'measurements',
      use: CHROMIUM,
      testMatch: MEASURES_THE_MACHINE,
      dependencies: ['chromium'],
    },
    ...crossBrowserProjects,
  ],
  webServer: [
    { command: 'npm run dev', url: `http://localhost:${port}`, reuseExistingServer: true },
    // The lazy-loading fixture host (F547) is served from its production build (npm run build first).
    {
      command: 'npm run preview -w @vibeglobe/lazy-host',
      url: `http://localhost:${process.env['LAZY_HOST_PORT'] ?? 5175}`,
      reuseExistingServer: true,
    },
    // Standalone fixture tile servers: HTTP/1.1 reachable as two hosts (F089) and HTTP/2 over TLS (F096).
    {
      command: 'node scripts/fixtures/tiles/serve.ts --port 5177',
      url: 'http://localhost:5177/_fixture/up/log',
      reuseExistingServer: true,
    },
    {
      command: 'node scripts/fixtures/tiles/serve.ts --port 5178 --http2',
      url: 'https://localhost:5178/_fixture/up/log',
      ignoreHTTPSErrors: true,
      reuseExistingServer: true,
    },
    // The playground's production build (npm run build first), for tests of shipped bundles (F100).
    {
      command: 'npm run preview -w @vibeglobe/playground',
      url: `http://localhost:${process.env['PLAYGROUND_PREVIEW_PORT'] ?? 5176}`,
      reuseExistingServer: true,
    },
    // The framework adapters' example pages (M14), on the packages' sources; the plain HTML page loads the Web
    // Component's browser build (npm run build first).
    {
      command: 'npm run dev -w @vibeglobe/adapter-examples',
      url: `http://localhost:${process.env['ADAPTER_EXAMPLES_PORT'] ?? 5180}`,
      reuseExistingServer: true,
    },
    {
      command: `npm run docs && npm run docs:serve -- --port ${docsPort}`,
      url: `http://localhost:${docsPort}`,
      reuseExistingServer: true,
    },
  ],
});
