// Google Photorealistic 3D Tiles (F468–F470, F572, F573, F323) in the `3dtiles-google` scenario. Without a key in
// the environment the Map Tiles API is the stand-in of `fixtures/tiles3d/google-3d-mock.ts` (the CI flow); with it,
// the first test runs against Google itself over Rome. The key comes only from the environment, never from the
// repository.
import { expect, test, type Page, type Route } from '@playwright/test';
import { EAST_PROVIDER, google3dMock, WEST_PROVIDER, type Google3DMock } from './fixtures/tiles3d/google-3d-mock.ts';
import { canvasImage, waitForIdle } from './support/globe.ts';
import { cityPoint, openCity, settleTiles, startCoverage, stopCoverage } from './support/tiles3d.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.setTimeout(180_000);

// Only a key of a billing account outside the EEA gets Photorealistic 3D Tiles (ADR 0031): with an EEA account (the
// owner's, the default) the flow runs against the stand-in.
const REAL_KEY = process.env['GOOGLE_BILLING_REGION'] === 'other' ? process.env['GOOGLE_MAPS_API_KEY'] : undefined;
const MOCK_KEY = 'mock-key';
const CORS = { 'Access-Control-Allow-Origin': '*' };

/** Serves the Map Tiles API from the stand-in. */
async function useMock(page: Page, mock: Google3DMock): Promise<void> {
  await page.route('https://tile.googleapis.com/**', async (route: Route) => {
    const response = await mock.fetch(route.request().url());
    await route.fulfill({
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), ...CORS },
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}

const view = (east: number, north: number, zoom = 17, tilt = 40): string => {
  const at = cityPoint(east, north);
  return `lon=${at.longitudeDeg}&lat=${at.latitudeDeg}&zoom=${zoom}&tilt=${tilt}`;
};

test('a session is created and photorealistic tiles stream and render over Rome (F468)', async ({ page }) => {
  const mock = google3dMock(MOCK_KEY);
  if (!REAL_KEY) await useMock(page, mock);
  const sessions: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/3dtiles/root.json')) sessions.push(request.url());
  });
  await openCity(page, `scenario=3dtiles-google&backend=webgl2&googleKey=${REAL_KEY ?? MOCK_KEY}&${view(0, 0)}`);
  await settleTiles(page, 120_000);
  console.log(REAL_KEY ? 'against the Map Tiles API' : 'against the stand-in');
  expect(sessions.length).toBeGreaterThanOrEqual(1);
  // The engine and its logs see URLs without the key or the session (ADR 0031).
  const logged = await page.evaluate(() => window.vibeglobeTiles3d?.requests.map((r) => r.url) ?? []);
  expect(logged.length).toBeGreaterThan(3);
  for (const url of logged) expect(url).not.toMatch(/key=/);
  const stats = await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats());
  expect(stats?.drawn).toBeGreaterThan(0);
  expect(stats?.failed).toBe(0);
  // Rays cannot check holes here (picking Google's tiles is refused, F323): the picture shows the city instead.
  const image = await canvasImage(page);
  let city = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r = 0, g = 0, b = 0] = [image.data[i], image.data[i + 1], image.data[i + 2]];
    if (REAL_KEY ? r + g + b > 30 : r > g + 12 && g > b + 12) city++;
  }
  expect(city).toBeGreaterThan(0.2 * image.width * image.height);
});

test('without a key the scenario explains what to configure and the globe keeps working (F468)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?scenario=3dtiles-google&imagery=world&backend=webgl2&${view(0, 0, 12, 0)}`);
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
  await page.evaluate(async () => window.vibeglobePlayground?.globe.ready);
  await expect(page.locator('.vg-tiles3d-message')).toContainText('API key');
  const before = await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
  await page.evaluate(async () => {
    await window.vibeglobePlayground?.globe.jumpTo({ zoom: 10 });
  });
  await waitForIdle(page);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0)).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('an EEA billing account is refused with the EEA terms named, and the globe keeps working (F572)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://tile.googleapis.com/')) requests.push(request.url());
  });
  await page.goto(
    `/?scenario=3dtiles-google&imagery=world&backend=webgl2&googleKey=${MOCK_KEY}&googleRegion=eea&${view(0, 0, 12, 0)}`,
  );
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
  await page.evaluate(async () => window.vibeglobePlayground?.globe.ready);
  await expect(page.locator('.vg-tiles3d-message')).toContainText('European Economic Area');
  await expect(page.locator('.vg-tiles3d-message')).toContainText('developers.google.com/maps/comms/eea/map-tiles');
  await page.evaluate(async () => {
    await window.vibeglobePlayground?.globe.jumpTo({ zoom: 10 });
  });
  await waitForIdle(page);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('sessions renew before they expire during continuous navigation, without failed tiles or holes (F469)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Sessions of the stand-in expire after 60 s; the adapter starts a new one after 50 s.
  const mock = google3dMock(MOCK_KEY, 60_000);
  await useMock(page, mock);
  await openCity(
    page,
    `scenario=3dtiles-google&backend=webgl2&googleKey=${MOCK_KEY}&googleSessionMs=50000&${view(-200, 0, 16.5, 30)}`,
  );
  await settleTiles(page);
  await startCoverage(page, 32);
  const end = Date.now() + 80_000;
  let step = 0;
  while (Date.now() < end) {
    step++;
    const at = cityPoint(-300 + ((step * 37) % 600), -300 + ((step * 53) % 600));
    await page.evaluate(
      async (target) => {
        await window.vibeglobePlayground?.globe.jumpTo({ ...target, zoom: 16.5, tiltDeg: 30 });
      },
      { longitudeDeg: at.longitudeDeg, latitudeDeg: at.latitudeDeg },
    );
    await page.waitForTimeout(400);
  }
  const coverage = await stopCoverage(page);
  expect(mock.sessions.length).toBeGreaterThanOrEqual(2);
  // The adapter used each session for its 50 s lifetime and started the next before any request needed it: no
  // request ever reached the stand-in with an expired session (it answers those 400).
  const [first, second] = mock.sessions;
  expect((second?.startedAtMs ?? 0) - (first?.startedAtMs ?? 0)).toBeGreaterThanOrEqual(50_000);
  expect(mock.log.filter((entry) => entry.status >= 400)).toEqual([]);
  expect(coverage.frames).toBeGreaterThan(20);
  expect(coverage.holes).toBe(0);
  expect(await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats().failed)).toBe(0);
});

test("the attribution shows Google's logo and the visible tiles' copyrights, never covered (F470)", async ({
  page,
}) => {
  const mock = google3dMock(MOCK_KEY);
  await useMock(page, mock);
  const credits = page.locator('.vg-tiles3d-credits');
  await openCity(page, `scenario=3dtiles-google&backend=webgl2&googleKey=${MOCK_KEY}&${view(-380, 0, 18, 0)}`);
  await settleTiles(page);
  await expect(credits).toContainText('Google');
  await expect(credits).toContainText(WEST_PROVIDER);
  await expect(credits).not.toContainText(EAST_PROVIDER);
  await page.evaluate(
    async (target) => {
      await window.vibeglobePlayground?.globe.jumpTo({ ...target, zoom: 18, tiltDeg: 0 });
    },
    cityPoint(380, 0),
  );
  await settleTiles(page);
  await expect(credits).toContainText(EAST_PROVIDER);
  await expect(credits).not.toContainText(WEST_PROVIDER);
  // Every control and panel of the page: none covers the logo or the copyrights.
  const covered = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.vg-tiles3d-credits');
    if (!element) return ['no credits'];
    const box = element.getBoundingClientRect();
    const out: string[] = [];
    for (const [x, y] of [
      [box.left + 1, box.top + 1],
      [box.right - 1, box.top + 1],
      [box.left + 1, box.bottom - 1],
      [box.right - 1, box.bottom - 1],
    ] as const) {
      const top = document.elementFromPoint(x, y);
      if (!top || !element.contains(top)) out.push(`${x},${y}: ${top?.className ?? 'nothing'}`);
    }
    for (const other of document.querySelectorAll<HTMLElement>('button, input, select, [role], .vg-credits, #status')) {
      if (element.contains(other) || other.contains(element)) continue;
      const b = other.getBoundingClientRect();
      if (b.width === 0 || getComputedStyle(other).visibility === 'hidden') continue;
      if (b.left < box.right && b.right > box.left && b.top < box.bottom && b.bottom > box.top)
        out.push(`overlaps ${other.tagName}.${other.className}`);
    }
    return out;
  });
  expect(covered).toEqual([]);
});

test('Google tiles are display only and never stored (F470, F323)', async ({ page }) => {
  const mock = google3dMock(MOCK_KEY);
  await useMock(page, mock);
  await openCity(page, `scenario=3dtiles-google&backend=webgl2&googleKey=${MOCK_KEY}&${view(0, 0, 17.5, 0)}`);
  await settleTiles(page);
  // Picking and tile data access are refused, naming the Google profile (F323).
  const refusals = await page.evaluate(() => {
    const extension = window.vibeglobeTiles3d?.extension;
    const out: string[] = [];
    for (const call of [() => extension?.pick(160, 120), () => extension?.tileset()])
      try {
        call();
        out.push('allowed');
      } catch (error) {
        out.push(`${(error as { code?: string }).code}: ${(error as Error).message}`);
      }
    return out;
  });
  expect(refusals).toHaveLength(2);
  for (const refusal of refusals) expect(refusal).toMatch(/^display-only: .*'google' profile/);
  // A click is refused too, and logged instead of picking.
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.click((box?.x ?? 0) + 160, (box?.y ?? 0) + 120);
  expect(await page.evaluate(() => window.vibeglobeTiles3d?.picks.length)).toBe(0);
  // Nothing of Google's is kept in the page's persistent storage.
  const stored = await page.evaluate(async () => {
    const names = await caches.keys();
    const cached: string[] = [];
    for (const name of names) for (const request of await (await caches.open(name)).keys()) cached.push(request.url);
    const databases = (await indexedDB.databases()).map((d) => d.name ?? '');
    return { cached: cached.filter((u) => u.includes('googleapis')), databases };
  });
  expect(stored.cached).toEqual([]);
  expect(stored.databases.filter((name) => /google|tiles3d/i.test(name))).toEqual([]);
  expect(mock.log.length).toBeGreaterThan(3);
});
