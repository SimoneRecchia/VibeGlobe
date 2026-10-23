import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { consoleProblems } from './support/adapters.ts';

// The Nuxt example's feature pages (F488): one page per feature group of PLAN.md, from "Map experience" to
// "Security", each running its browser checks, on both backends. The production build (npm run build) is served by
// its own Nitro server on a port of its own, so this file can run beside e2e/nuxt-example.spec.ts.
test.describe.configure({ mode: 'default' });
test.use({ viewport: { width: 640, height: 480 } });

const PORT = Number(process.env['NUXT_FEATURES_PORT'] ?? 5182);
const URL_BASE = `http://localhost:${PORT}`;
const GROUPS = [
  'map-experience',
  'navigation',
  'rendering',
  'tiles',
  'sources',
  'offline',
  'data-layers',
  'gis',
  'ui',
  'debugging',
  'security',
];
let server: ChildProcess | undefined;

test.beforeAll(async () => {
  server = spawn(process.execPath, ['apps/nuxt-example/.output/server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT) },
    stdio: 'ignore',
  });
  await expect
    .poll(
      async () =>
        fetch(URL_BASE).then(
          (response) => response.status,
          () => 0,
        ),
      { timeout: 30_000 },
    )
    .toBe(200);
});

test.afterAll(() => {
  server?.kill();
});

test('the home page links a page for every feature group (F488)', async ({ page }) => {
  await page.goto(URL_BASE);
  for (const group of GROUPS) await expect(page.locator(`a.to-${group}`)).toHaveCount(1);
});

for (const backend of ['webgl2', 'webgpu'] as const)
  test(`every feature group's checks pass on ${backend} (F488)`, async ({ page }) => {
    test.setTimeout(600_000);
    const problems = consoleProblems(page);
    const failed: string[] = [];
    for (const group of GROUPS) {
      await page.goto(`${URL_BASE}/features/${group}?backend=${backend}`);
      await page.waitForFunction(() => (window as unknown as { featureChecks?: unknown }).featureChecks !== undefined, {
        timeout: 60_000,
      });
      expect(await page.evaluate(() => window.adapterExample?.globes()[0]?.backend)).toBe(backend);
      const results = await page.evaluate(() =>
        (window as unknown as { featureChecks: { run(): Promise<Record<string, boolean>> } }).featureChecks.run(),
      );
      expect(Object.keys(results).length, group).toBeGreaterThan(0);
      for (const [name, ok] of Object.entries(results)) if (!ok) failed.push(`${group}: ${name}`);
    }
    expect(failed).toEqual([]);
    expect(problems).toEqual([]);
  });
