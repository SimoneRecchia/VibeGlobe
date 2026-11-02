// The playground's showcase (owner, 2026-10-25): every control of @vibeglobe/ui, the settings panel and the help
// overlay over the demo data and the space background; `?ui=0` hides the controls. Under automation the default page
// stays the bare engine, so the showcase is asked for with `?showcase=1&ui=1` (apps/playground/src/page-mode.ts).
import { expect, test, type Page } from '@playwright/test';

const CONTROLS = [
  'search',
  'view-mode',
  'zoom',
  'compass',
  'tilt',
  'home',
  'geolocation',
  'layers',
  'fullscreen',
  'readout',
  'scale',
  'attribution',
  'measure',
  'draw',
  'bookmarks',
  'screenshot',
  'minimap',
  'showcase-settings',
  'showcase-help',
];

async function openShowcase(page: Page, query: string): Promise<void> {
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => window.vibeglobeShowcase !== undefined, undefined, { timeout: 60_000 });
}

test('the showcase shows every control, the settings change theme, language and space, and the help lists the gestures', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await openShowcase(page, 'showcase=1&ui=1&lang=en');
  expect(await page.evaluate(() => window.vibeglobeShowcase?.ui?.controls().map((c) => c.id))).toEqual(CONTROLS);
  expect(await page.evaluate(() => window.vibeglobeShowcase?.layers?.stack.order)).toEqual(
    expect.arrayContaining(['demo-area', 'demo-route', 'demo-markers', 'demo-labels']),
  );
  await expect.poll(() => page.evaluate(() => window.vibeglobeShowcase?.space !== undefined)).toBe(true);

  // The help lists the gestures of every input.
  await page.getByRole('button', { name: /Help/ }).click();
  for (const device of ['Mouse', 'Trackpad', 'Touch', 'Keyboard'])
    await expect(page.getByText(device, { exact: true })).toBeVisible();

  // Settings: theme, language (the panels follow it), space background off.
  await page.getByRole('button', { name: /Settings/ }).click();
  await page.getByLabel('Theme').selectOption('dark');
  expect(await page.evaluate(() => window.vibeglobeShowcase?.ui?.theme)).toBe('dark');
  await page.getByLabel('Space background').uncheck();
  await expect.poll(() => page.evaluate(() => window.vibeglobeShowcase?.space === undefined)).toBe(true);
  await page.getByLabel('Language').selectOption('it');
  await expect(page.getByRole('button', { name: /Aiuto/ })).toBeVisible();
  expect(errors).toEqual([]);
});

/** The tour's scenes that run on the bundled data and the fixture server, in the catalog's order. */
const OFFLINE_SCENES = [
  'globe',
  'sky',
  'sun',
  'poles',
  'view-modes',
  'navigation',
  'camera',
  'limits',
  'adapters',
  'composition',
  'relief',
  'vector-styles',
  'buildings',
  'markers',
  'shapes',
  'live',
  'files',
  'energy-park',
  'instancing',
  '3d-tiles',
  'measure',
  'coordinates',
  'share',
  'offline',
  'quality',
  'diagnostics',
  'integrations',
];

/** The scene the tour shows once it has started; undefined while one loads or the page reloads. */
async function sceneShown(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.vibeglobeShowcase?.tour?.scene).catch(() => undefined);
}

test('the tour opens every scene without the network and without errors; online scenes wait for consent', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const outside: string[] = [];
  await page.route(
    (url) => url.hostname !== 'localhost' && url.protocol.startsWith('http'),
    (route) => {
      outside.push(route.request().url());
      return route.abort();
    },
  );
  await openShowcase(page, 'showcase=1&ui=1&lang=en');
  for (const scene of OFFLINE_SCENES) {
    await page.evaluate((id) => (location.hash = `#scene=${id}`), scene).catch(() => undefined);
    await expect.poll(() => sceneShown(page), { timeout: 90_000, message: scene }).toBe(scene);
  }
  for (const scene of ['europe', 'openfreemap', 'real-terrain']) {
    await page.evaluate((id) => (location.hash = `#scene=${id}`), scene);
    await expect(page.getByRole('button', { name: 'Load online data' })).toBeVisible();
  }
  expect(await sceneShown(page)).toBeUndefined();
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test('?ui=0 hides the controls of the showcase, which keeps its data', async ({ page }) => {
  await openShowcase(page, 'showcase=1&ui=0');
  await expect(page.locator('.vg-ui')).toHaveCount(0);
  expect(await page.evaluate(() => window.vibeglobeShowcase?.layers?.stack.size)).toBeGreaterThan(3);
});

test('scenario pages show the default controls when asked for, and the page under automation none (F418)', async ({
  page,
}) => {
  await openShowcase(page, 'ui=1&lon=10&lat=45&zoom=3');
  expect(await page.evaluate(() => window.vibeglobeShowcase?.ui?.controls().map((c) => c.id))).toEqual([
    'view-mode',
    'zoom',
    'compass',
    'tilt',
    'home',
  ]);
  await page.goto('/?lon=10&lat=45&zoom=3');
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
  await page.evaluate(async () => window.vibeglobePlayground?.globe.ready);
  await expect(page.locator('.vg-ui')).toHaveCount(0);
});

declare global {
  interface Window {
    /** `apps/playground/src/showcase.ts`, as far as these tests read it. */
    vibeglobeShowcase?: {
      ui?: { theme: string; controls(): { id: string }[] };
      layers?: { stack: { order: readonly string[]; size: number } };
      space?: unknown;
      tour?: { scene: string | undefined };
    };
  }
}
