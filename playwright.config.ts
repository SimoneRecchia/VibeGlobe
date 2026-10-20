import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env['PLAYGROUND_PORT'] ?? 5173);
const docsPort = Number(process.env['DOCS_PORT'] ?? 5174);
// Cloud containers ship a preinstalled Chromium; init.sh points VGE_CHROMIUM_PATH at it.
const chromiumPath = process.env['VGE_CHROMIUM_PATH'];

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: Boolean(process.env['CI']),
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
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
