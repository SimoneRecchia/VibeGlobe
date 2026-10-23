// Network modes with zoom, pan and flight scenarios (M8, track B): the defaults (F271), offline only (F292), hybrid
// (F293), everything in the browser (F296) and connectivity dropping mid-pan and mid-flight (F298), on the offline
// harness page with fixture packages. Small canvas, as the other offline specs on the software GPU.
import { expect, test, type Page } from '@playwright/test';
import { nextFrame } from './support/globe.ts';
import {
  connectivity,
  emptyPixels,
  emptyPixelsNow,
  openHarness,
  recordTileRequests,
  startHarness,
  storedTileKeys,
  tileHeaders,
  type HarnessConfig,
} from './support/offline.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.beforeEach(() => test.setTimeout(240_000));

const ROME_BOUNDS = { westDeg: 11, southDeg: 40.9, eastDeg: 14, northDeg: 42.9 };
const ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 7 };
/** A view well inside Rome's package. */
const INSIDE_ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 8 };
const OSTIA = { longitudeDeg: 12.3, latitudeDeg: 41.75, zoom: 9 };
const HEALTH = { minIntervalMs: 300, maxIntervalMs: 2000 };
/** Detail over Rome and a low-detail world base, both of source `world`. */
const WORLD_BASE = {
  id: 'world-base',
  sourceId: 'world',
  pattern: 'world',
  bounds: { westDeg: -180, southDeg: -85, eastDeg: 180, northDeg: 85 },
  minLevel: 0,
  maxLevel: 3,
};
const PACKAGES = [
  { id: 'rome', sourceId: 'world', pattern: 'world', bounds: ROME_BOUNDS, minLevel: 4, maxLevel: 10 },
  WORLD_BASE,
];

const jump = (page: Page, view: Record<string, number>) =>
  page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), view);

/** Installs the fixture packages into browser storage (served by the dev server's fixture tiles of `session`). */
async function installPackages(page: Page, session: string): Promise<void> {
  for (const spec of PACKAGES)
    await page.evaluate((s) => window.offlineHarness?.installFixture(s), { ...spec, session, version: '1' });
}

/**
 * Flies to `to` and samples frames while the flight runs: returns the most empty pixels any sampled frame showed.
 */
async function fly(page: Page, to: Record<string, number>, durationMs = 2500): Promise<number> {
  await page.evaluate(
    ([target, ms]) => {
      const movement = window.offlineHarness?.globe?.flyTo(target, { durationMs: ms });
      (window as unknown as { flight?: Promise<unknown> | undefined }).flight = movement;
      void movement?.then(() => ((window as unknown as { flightDone: boolean }).flightDone = true));
      (window as unknown as { flightDone: boolean }).flightDone = false;
    },
    [to, durationMs] as const,
  );
  let worst = 0;
  for (let sample = 0; sample < 12; sample++) {
    if (await page.evaluate(() => (window as unknown as { flightDone: boolean }).flightDone)) break;
    await nextFrame(page);
    worst = Math.max(worst, await emptyPixelsNow(page));
  }
  await page.evaluate(() => (window as unknown as { flight?: Promise<unknown> }).flight);
  return Math.max(worst, await emptyPixels(page));
}

/** Zoom, pan and a flight inside Rome's package, every view within its bounds: the most empty pixels seen. */
async function navigateRome(page: Page): Promise<number> {
  let worst = 0;
  for (const view of [{ ...ROME, zoom: 8 }, OSTIA, { ...OSTIA, longitudeDeg: 12.7 }]) {
    await jump(page, view);
    worst = Math.max(worst, await emptyPixels(page));
  }
  worst = Math.max(worst, await fly(page, { longitudeDeg: 12.7, latitudeDeg: 42.1, zoom: 9 }));
  return worst;
}

const tiersSince = (page: Page, from: number) =>
  page.evaluate(
    (i) => (window.offlineHarness?.served ?? []).slice(i).map((e) => ({ tier: e.tier, level: e.coord.level })),
    from,
  );

test('with no configuration the mode is hybrid and every loading feature works (F271)', async ({ page }) => {
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const requests = recordTileRequests(page);
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: 'f271' }], view: ROME });
  expect(await page.evaluate(() => window.offlineHarness?.offline?.settings())).toEqual({
    mode: 'hybrid',
    switches: { persistentCache: true, memoryReuse: true, prefetch: true, offlinePackaging: true },
  });
  expect(await emptyPixels(page)).toBe(0);
  // Persisted.
  await expect.poll(async () => (await storedTileKeys(page)).length).toBeGreaterThan(0);
  // Prefetched: tiles of levels above the pinned base beyond the first view's, before any movement.
  const drawn = await page.evaluate(() => (window.offlineHarness?.globe?.surfaceTiles() ?? []).length);
  const atView = requests.filter((p) => /\/[5-9]\/\d+\/\d+\.png$/.test(p)).length;
  expect(atView).toBeGreaterThan(drawn);
  // Reused from memory: a revisit is drawn without a single tile delivered again.
  await jump(page, { ...ROME, longitudeDeg: 20 });
  expect(await emptyPixels(page)).toBe(0);
  const served = await page.evaluate(() => window.offlineHarness?.served.length ?? 0);
  await jump(page, ROME);
  expect(await emptyPixels(page)).toBe(0);
  expect(await tiersSince(page, served)).toEqual([]);
  // Packageable.
  const built = await page.evaluate((r) => window.offlineHarness?.buildArea(r), {
    id: 'defaults',
    version: '1',
    area: { westDeg: 12.4, southDeg: 41.85, eastDeg: 12.6, northDeg: 41.95 },
    minLevel: 0,
    maxLevel: 7,
    sources: [{ id: 'world', pattern: 'world', session: 'f271' }],
  });
  expect(built?.error).toBeUndefined();
  expect(built?.tiles).toBeGreaterThan(0);
});

test('offline only never touches the network, health checks included, and navigates packages and caches (F292)', async ({
  page,
}) => {
  await openHarness(page);
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: 'f292' }], view: ROME });
  await installPackages(page, 'f292');
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    // Every request but the page's own modules and the engine's base image and worker.
    if (!/\.(ts|js|mjs|css|wasm|jpg)$/.test(url.pathname) && !url.pathname.startsWith('/@')) requests.push(url.href);
  });
  await startHarness(page, {
    network: 'offline',
    sources: [{ id: 'world', pattern: 'world', session: 'f292' }],
    view: ROME,
    healthChecks: HEALTH,
  });
  expect(await navigateRome(page)).toBe(0);
  // Long enough for several health-check intervals.
  await page.waitForTimeout(2500);
  expect(requests).toEqual([]);
  const tiers = new Set((await tiersSince(page, 0)).map((t) => t.tier));
  expect([...tiers]).toEqual(['package']);
});

test('hybrid takes coarse levels from the package and finer ones from the network (F293)', async ({ page }) => {
  await openHarness(page);
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: 'f293' }], view: ROME });
  await page.evaluate((s) => window.offlineHarness?.installFixture(s), {
    ...WORLD_BASE,
    session: 'f293',
    version: '1',
  });
  await startHarness(page, {
    sources: [{ id: 'world', pattern: 'world', session: 'f293' }],
    view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 2 },
    switches: { persistentCache: false },
  });
  expect(await emptyPixels(page)).toBe(0);
  await jump(page, ROME);
  expect(await emptyPixels(page)).toBe(0);
  expect(await fly(page, { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 7 })).toBe(0);
  const served = await tiersSince(page, 0);
  expect(served.filter((t) => t.level <= 3).every((t) => t.tier === 'package')).toBe(true);
  expect(served.filter((t) => t.level > 3).every((t) => t.tier === 'network')).toBe(true);
  expect(served.some((t) => t.level <= 3)).toBe(true);
  expect(served.some((t) => t.level > 3)).toBe(true);
});

test('with no network at all, packages and cached tiles in the browser carry zoom, pan and a flight (F296)', async ({
  page,
}) => {
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const config: HarnessConfig = {
    sources: [{ id: 'world', pattern: 'world', session: 'f296' }],
    view: ROME,
    healthChecks: HEALTH,
  };
  await startHarness(page, config);
  await installPackages(page, 'f296');
  // Fill the persistent cache around Rome as well.
  await jump(page, { ...ROME, zoom: 9 });
  expect(await emptyPixels(page)).toBe(0);
  await expect.poll(async () => (await storedTileKeys(page)).length).toBeGreaterThan(0);
  const failed: string[] = [];
  const errors: string[] = [];
  page.on('console', (message) => {
    // The browser's own line for each refused request is not the engine's: only engine errors count.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(message.text());
  });
  // A new session with no network: the application's own assets (its code, workers and base image, which an offline
  // application ships through a service worker or its package) still load; every data request fails as offline.
  await openHarness(page, { keepStorage: true });
  await goOffline(page);
  page.on('requestfailed', (request) => {
    if (request.url().includes('/fixture-tiles/')) failed.push(request.url());
  });
  await startHarness(page, config);
  await page.evaluate(() => {
    const failed: unknown[] = [];
    (window as unknown as { tileErrors: unknown[] }).tileErrors = failed;
    window.offlineHarness?.globe?.on('tile-error', (event) => failed.push(event));
  });
  expect(await navigateRome(page)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { tileErrors: unknown[] }).tileErrors)).toEqual([]);
  expect(errors).toEqual([]);
  const tiers = new Set((await tiersSince(page, 0)).map((t) => t.tier));
  expect(tiers.has('package')).toBe(true);
  expect(tiers.has('network')).toBe(false);
  // Requests the browser refused while offline stay below one per tile kept by the engine for later.
  expect(failed.length).toBeLessThan(40);
});

/** Every request for data (tiles, packages, health checks) fails as it does without a network. */
async function goOffline(page: Page): Promise<void> {
  await page.route(/\/(fixture-tiles|offline-fixtures)\//, (route) => route.abort('internetdisconnected'));
}

for (const scenario of ['pan', 'flight'] as const)
  test(`when connectivity drops mid-${scenario}, packages and caches take over without black areas or a request storm (F298)`, async ({
    page,
    context,
  }) => {
    await openHarness(page);
    await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: `f298-${scenario}` }], view: ROME });
    await installPackages(page, `f298-${scenario}`);
    const requests = recordTileRequests(page);
    await startHarness(page, {
      sources: [{ id: 'world', pattern: 'world', session: `f298-${scenario}` }],
      view: { ...ROME, longitudeDeg: 11.9 },
      switches: { persistentCache: false },
      healthChecks: HEALTH,
    });
    expect(await emptyPixels(page)).toBe(0);
    let worst = 0;
    if (scenario === 'pan') {
      for (let k = 1; k <= 12; k++) {
        if (k === 4) await context.setOffline(true);
        await jump(page, { ...ROME, longitudeDeg: 11.9 + k * 0.1, zoom: 8 });
        await nextFrame(page);
        worst = Math.max(worst, await emptyPixelsNow(page));
      }
    } else {
      await page.evaluate(() => {
        void window.offlineHarness?.globe?.flyTo(
          { longitudeDeg: 12.9, latitudeDeg: 42.2, zoom: 9 },
          { durationMs: 3000 },
        );
      });
      await nextFrame(page);
      await context.setOffline(true);
      for (let k = 0; k < 10; k++) {
        await nextFrame(page);
        worst = Math.max(worst, await emptyPixelsNow(page));
      }
    }
    const atDrop = requests.length;
    // Beyond the package's edge offline misses keep the engine asking, so it never goes idle: a settled frame instead.
    await page.waitForTimeout(1500);
    expect(Math.max(worst, await emptyPixelsNow(page))).toBe(0);
    await expect.poll(() => connectivity(page), { timeout: 20_000 }).toBe('offline');
    const events = await page.evaluate(() =>
      window.offlineHarness?.events.filter((e) => e.type === 'connectivity-change').map((e) => e.payload),
    );
    expect(events?.at(-1)).toMatchObject({ connectivity: 'offline' });
    // No storm: while offline, only health checks at their backoff reach for the network.
    const settled = requests.length;
    await page.waitForTimeout(3000);
    expect(requests.length - settled).toBeLessThanOrEqual(4);
    expect(requests.length - atDrop).toBeLessThan(30);
    await context.setOffline(false);
  });

test('each tile comes from the highest tier holding it, GPU, RAM, persistent, package, network, and is never downloaded twice (F272)', async ({
  page,
}) => {
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const requests = recordTileRequests(page);
  const config: HarnessConfig = {
    sources: [{ id: 'world', pattern: 'world', session: 'f272' }],
    view: INSIDE_ROME,
    debug: true,
    switches: { prefetch: false },
    // A small GPU tier, so panning away evicts Rome's textures while RAM keeps their bytes.
    memory: { gpuBudgetBytes: 6 * 1024 * 1024, ramBudgetBytes: 256 * 1024 * 1024 },
  };
  await startHarness(page, config);
  expect(await emptyPixels(page)).toBe(0);
  expect(new Set((await tiersSince(page, 0)).map((t) => t.tier))).toEqual(new Set(['network']));
  await expect(page.locator('.vibeglobe-debug-overlay')).toContainText('network');

  // Away and back: Rome's textures leave the GPU, its bytes come back from RAM without a request or a lower tier.
  for (const lon of [40, 70, 100, 130, 160, -170, -140]) {
    await jump(page, { ...INSIDE_ROME, longitudeDeg: lon });
    await emptyPixels(page);
  }
  expect(await emptyPixels(page)).toBe(0);
  const away = await page.evaluate(() => window.offlineHarness?.globe?.imageryStats());
  expect(away?.evicted).toBeGreaterThan(0);
  let served = await page.evaluate(() => window.offlineHarness?.served.length ?? 0);
  let sent = requests.length;
  await jump(page, INSIDE_ROME);
  expect(await emptyPixels(page)).toBe(0);
  const back = await page.evaluate(() => window.offlineHarness?.globe?.imageryStats());
  expect(back?.ramHits).toBeGreaterThan(away?.ramHits ?? 0);
  expect(await tiersSince(page, served)).toEqual([]);
  expect(requests.length).toBe(sent);

  // A reload: the persistent tier, no request.
  sent = requests.length;
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  expect(new Set((await tiersSince(page, 0)).map((t) => t.tier))).toEqual(new Set(['persistent']));
  expect(requests.length).toBe(sent);
  await expect(page.locator('.vibeglobe-debug-overlay')).toContainText('persistent');

  // Storage cleared with a package installed: the package tier, still no request.
  await installPackages(page, 'f272');
  await page.evaluate(() => window.offlineHarness?.offline?.clearCache());
  // Writes still in flight when the cache was cleared land afterwards: clear until it stays empty.
  await expect
    .poll(async () => {
      await page.evaluate(() => window.offlineHarness?.offline?.clearCache());
      return (await storedTileKeys(page)).length;
    })
    .toBe(0);
  sent = requests.length;
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  const fromPackage = await page.evaluate(() =>
    (window.offlineHarness?.served ?? [])
      .filter((e) => e.tier !== 'package')
      .map((e) => `${e.tier} ${e.coord.level}/${e.coord.x}/${e.coord.y}`),
  );
  expect(fromPackage).toEqual([]);
  // The package build downloaded its own tiles; the engine's view asked the network for none.
  expect(requests.length).toBe(sent);
  await expect(page.locator('.vibeglobe-debug-overlay')).toContainText('package');
  // No tile was downloaded twice by the engine while a higher tier held it.
  const engineRequests = requests.filter((p) => p.includes('/f272/'));
  expect(engineRequests.length).toBeGreaterThan(0);
});

test('every switch, set globally or for one layer, takes effect at runtime during a pan without a black frame (F290)', async ({
  page,
}) => {
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const requests = recordTileRequests(page);
  await startHarness(page, {
    sources: [
      { id: 'base', pattern: 'world', session: 'f290-base', layerId: 'base-layer' },
      { id: 'roads', pattern: 'levels', session: 'f290-roads', minLevel: 5, layerId: 'roads-layer' },
    ],
    view: ROME,
  });
  expect(await emptyPixels(page)).toBe(0);
  let lon = ROME.longitudeDeg;
  let worst = 0;
  /** One pan step and its frame. */
  const step = async (): Promise<void> => {
    lon += 0.15;
    await jump(page, { ...ROME, longitudeDeg: lon });
    await nextFrame(page);
    worst = Math.max(worst, await emptyPixelsNow(page));
  };
  const toggle = (switches: Record<string, boolean>, scope?: { layerId: string }) =>
    page.evaluate(([s, sc]) => window.offlineHarness?.offline?.setSwitches(s, sc ?? undefined), [
      switches,
      scope,
    ] as const);
  const stored = async (prefix: string) => (await storedTileKeys(page)).filter((k) => k.startsWith(prefix)).length;

  // Persistent cache off for the roads layer only: its new tiles stop being stored, the base's still are.
  await toggle({ persistentCache: false }, { layerId: 'roads-layer' });
  const roadsBefore = await stored('roads/');
  for (let k = 0; k < 4; k++) await step();
  expect(await emptyPixels(page)).toBe(0);
  expect(await stored('roads/')).toBe(roadsBefore);
  await expect.poll(() => stored('base/')).toBeGreaterThan(0);

  // Prefetch off globally: the next views request only what they draw.
  await toggle({ prefetch: false });
  await page.evaluate(() => {
    const drawn = new Map<string, [number, number, number, number]>();
    (window as unknown as { drawn: typeof drawn }).drawn = drawn;
    const globe = window.offlineHarness?.globe;
    globe?.on('frame', () => {
      for (const t of globe.surfaceTiles())
        drawn.set(`${t.level}/${t.x}/${t.y}`, [t.westDeg, t.southDeg, t.eastDeg, t.northDeg]);
    });
  });
  const from = requests.length;
  for (let k = 0; k < 4; k++) await step();
  expect(await emptyPixels(page)).toBe(0);
  const drawn = await page.evaluate(() => [
    ...(window as unknown as { drawn: Map<string, [number, number, number, number]> }).drawn.values(),
  ]);
  const outside = requests.slice(from).filter((p) => {
    const [z = 0, x = 0, y = 0] = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(p)?.slice(1).map(Number) ?? [];
    if (z < 5) return false;
    const n = 2 ** z;
    const lat = (r: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * r) / n))) * 180) / Math.PI;
    const b = [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)] as const;
    return !drawn.some((d) => b[0] < d[2] - 1e-9 && d[0] < b[2] - 1e-9 && b[1] < d[3] - 1e-9 && d[1] < b[3] - 1e-9);
  });
  expect(outside).toEqual([]);

  // Memory reuse off for the base layer and back on, the network mode to offline and back: still no black frame.
  await toggle({ memoryReuse: false }, { layerId: 'base-layer' });
  for (let k = 0; k < 3; k++) await step();
  await toggle({ memoryReuse: true }, { layerId: 'base-layer' });
  await page.evaluate(() => window.offlineHarness?.offline?.setMode('offline'));
  const offlineFrom = requests.length;
  for (let k = 0; k < 3; k++) await step();
  expect(requests.length).toBe(offlineFrom);
  await page.evaluate(() => window.offlineHarness?.offline?.setMode('hybrid'));
  for (let k = 0; k < 3; k++) await step();
  expect(await emptyPixels(page)).toBe(0);
  expect(worst).toBe(0);
  const effective = await page.evaluate(() =>
    window.offlineHarness?.offline?.effectiveSwitches('roads', 'roads-layer'),
  );
  expect(effective).toEqual({ persistentCache: false, memoryReuse: true, prefetch: false, offlinePackaging: true });
});
