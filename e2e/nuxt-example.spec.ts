import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { consoleProblems, expectRenderedGlobe, NUXT_URL } from './support/adapters.ts';
import { trackGpuObjects } from './support/leaks.ts';

// The Nuxt example (apps/nuxt-example) as a consumer ships it: its production build (npm run build) served by its own
// Nitro server, whose output these tests read.

const NAVIGATIONS = 20;
let server: ChildProcess | undefined;
const serverLog: string[] = [];

test.beforeAll(async () => {
  const port = new URL(NUXT_URL).port;
  server = spawn(process.execPath, ['apps/nuxt-example/.output/server/index.mjs'], {
    env: { ...process.env, PORT: port, NITRO_PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
  server.stderr?.on('data', (chunk: Buffer) => serverLog.push(`stderr: ${chunk.toString()}`));
  await expect
    .poll(
      async () =>
        fetch(NUXT_URL).then(
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

test('the Nuxt example renders its pages on the server without errors or warnings (F486)', async ({ request }) => {
  const home = await request.get(`${NUXT_URL}/`);
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain('VibeGlobe with Nuxt');
  const globe = await request.get(`${NUXT_URL}/globe`);
  expect(globe.status()).toBe(200);
  const html = await globe.text();
  expect(html).toContain('data-vibeglobe-placeholder');
  expect(html).toContain('Loading the globe');
  expect(html).not.toContain('<canvas');
  const image = await request.get(`${NUXT_URL}/imagery/natural-earth-4096.jpg`);
  expect(image.status()).toBe(200);
  expect(serverLog.filter((line) => /warn|error/i.test(line))).toEqual([]);
});

test(`the Nuxt example hydrates without mismatch and survives ${NAVIGATIONS} client navigations (F487)`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const problems = consoleProblems(page);
  const messages: string[] = [];
  page.on('console', (message) => messages.push(message.text()));
  await page.addInitScript(trackGpuObjects);
  const globeReady = async (): Promise<void> => {
    await page.waitForFunction(() => window.adapterExample?.globes()[0] !== undefined);
    await page.evaluate(() => window.adapterExample?.globes()[0]?.ready);
    await expect(page.locator('[data-vibeglobe-placeholder]')).toHaveCount(0);
  };
  await page.goto(`${NUXT_URL}/globe?backend=webgl2`);
  await globeReady();
  await expectRenderedGlobe(page);
  const counts = (): Promise<{ contexts: number; gpuObjects: number }> =>
    page.evaluate(() => {
      const w = window as unknown as { liveContexts: () => number; liveGpuObjects: () => number };
      return { contexts: w.liveContexts(), gpuObjects: w.liveGpuObjects() };
    });
  const first = await counts();
  for (let i = 0; i < NAVIGATIONS; i++) {
    await page.locator('a.home').click();
    await expect(page.locator('.home-page')).toBeVisible();
    await expect.poll(async () => (await counts()).contexts).toBe(0);
    await page.locator('a.to-globe').click();
    await globeReady();
  }
  await expectRenderedGlobe(page);
  await expect.poll(counts).toEqual(first);
  expect(messages.filter((text) => /hydration/i.test(text))).toEqual([]);
  expect(problems).toEqual([]);
});
