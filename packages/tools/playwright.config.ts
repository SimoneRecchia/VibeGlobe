// Browser checks of the data pipeline's outputs in the playground (packages/tools/src/browser/*.spec.ts). Run with
// `npx playwright test -c packages/tools/playwright.config.ts` from the repository root.
import { defineConfig, devices } from '@playwright/test';
import { gpuArgs } from '../../scripts/browser/gpu-args.ts';

const port = Number(process.env['PLAYGROUND_PORT'] ?? 5173);
const chromiumPath = process.env['VIBEGLOBE_CHROMIUM_PATH'];

export default defineConfig({
  testDir: 'src/browser',
  testMatch: '**/*.spec.ts',
  forbidOnly: Boolean(process.env['CI']),
  reporter: 'list',
  timeout: 240_000,
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: { args: gpuArgs(), ...(chromiumPath ? { executablePath: chromiumPath } : {}) },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [{ command: 'npm run dev', cwd: '../..', url: `http://localhost:${port}`, reuseExistingServer: true }],
});
