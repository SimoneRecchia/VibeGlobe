import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env['PLAYGROUND_PORT'] ?? 5173);
const docsPort = Number(process.env['DOCS_PORT'] ?? 5174);
// Cloud containers ship a preinstalled Chromium; init.sh points VIBEGLOBE_CHROMIUM_PATH at it.
const chromiumPath = process.env['VIBEGLOBE_CHROMIUM_PATH'];
// ADR 0012: GPU-less machines render WebGL2 through SwiftShader (ANGLE) and WebGPU through its SwiftShader adapter, so
// every test can choose a backend with ?backend=webgpu or ?backend=webgl2.
const SOFTWARE_GPU_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

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
    launchOptions: { args: SOFTWARE_GPU_ARGS, ...(chromiumPath ? { executablePath: chromiumPath } : {}) },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'npm run dev', url: `http://localhost:${port}`, reuseExistingServer: true },
    {
      command: `npm run docs && npm run docs:serve -- --port ${docsPort}`,
      url: `http://localhost:${docsPort}`,
      reuseExistingServer: true,
    },
  ],
});
