// Network modes and connectivity of @vibeglobe/offline in the browser (M8, offline track): online only, captive
// portals and dead endpoints, reconnection, provider rules and an application's own store and policy.
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { canvasImage } from './support/globe.ts';
import {
  connectivity,
  emptyPixels,
  emptyPixelsNow,
  openHarness,
  recordTileRequests,
  startHarness,
  storedTiles,
  tileHeaders,
  viewAt,
  type HarnessConfig,
} from './support/offline.ts';

const ROME_VIEW = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 7 };
const HEALTH = { minIntervalMs: 300, maxIntervalMs: 2000 };
const ROME_PACKAGE = {
  id: 'rome',
  version: '1',
  sourceId: 'world',
  pattern: 'patches',
  session: 'net-rome',
  bounds: { westDeg: 11.5, southDeg: 41.2, eastDeg: 13.5, northDeg: 42.6 },
  minLevel: 0,
  maxLevel: 8,
};

const WORLD_BASE = {
  ...ROME_PACKAGE,
  id: 'world-base',
  pattern: 'world',
  session: 'net-world',
  bounds: { westDeg: -180, southDeg: -85, eastDeg: 180, northDeg: 85 },
  maxLevel: 3,
};

const tiersSince = (page: Page, from: number): Promise<string[]> =>
  page.evaluate((i) => (window.offlineHarness?.served ?? []).slice(i).map((e) => e.tier), from);
const servedCount = (page: Page): Promise<number> => page.evaluate(() => window.offlineHarness?.served.length ?? 0);

/** Waits for engine frames to pass, without requiring idle (offline misses keep the engine asking). */
async function settle(page: Page, ms = 1500): Promise<void> {
  await page.waitForTimeout(ms);
}

test('online-only mode never reads an installed package, also when the network drops (F291)', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await openHarness(page);
  const config: HarnessConfig = {
    network: 'online',
    sources: [{ id: 'world', pattern: 'world', session: 'f291' }],
    view: ROME_VIEW,
    healthChecks: HEALTH,
  };
  await startHarness(page, config);
  await page.evaluate((spec) => window.offlineHarness?.installFixture(spec), ROME_PACKAGE);
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  const tiers = await tiersSince(page, 0);
  expect(tiers.length).toBeGreaterThan(10);
  expect(tiers).not.toContain('package');

  await context.setOffline(true);
  const before = await servedCount(page);
  await page.evaluate(() => window.offlineHarness?.globe?.jumpTo({ longitudeDeg: 12.3, latitudeDeg: 41.7, zoom: 8 }));
  await expect.poll(() => connectivity(page), { timeout: 20_000 }).toBe('offline');
  await settle(page);
  // The pinned base and the ancestors in memory keep the view whole; the package stays unread.
  expect(await emptyPixelsNow(page)).toBe(0);
  expect(await tiersSince(page, before)).not.toContain('package');
  const events = await page.evaluate(() =>
    window.offlineHarness?.events.filter((e) => e.type === 'connectivity-change'),
  );
  expect(events?.at(-1)?.payload).toMatchObject({ connectivity: 'offline' });
  await context.setOffline(false);
});

test('a captive portal counts as unreachable and is never used as tiles; packages and caches take over (F297)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openHarness(page);
  await page.route('**/fixture-tiles/f297/**', (route) =>
    route.fulfill({ status: 302, headers: { Location: '/offline-fixtures/portal/login.html' } }),
  );
  await page.route('**/offline-fixtures/portal/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Sign in to the Wi-Fi</body></html>' }),
  );
  await startHarness(page, {
    network: 'hybrid',
    sources: [{ id: 'world', pattern: 'world', session: 'f297' }],
    view: { longitudeDeg: 40, latitudeDeg: 41.9, zoom: 4 },
    healthChecks: HEALTH,
    awaitReady: false,
  });
  // The offline base of a hybrid setup: the world at low detail, plus Rome in detail.
  await page.evaluate((spec) => window.offlineHarness?.installFixture(spec), WORLD_BASE);
  await page.evaluate((spec) => window.offlineHarness?.installFixture(spec), ROME_PACKAGE);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await expect.poll(() => connectivity(page), { timeout: 20_000 }).toBe('offline');
  // The restart clears the served log: what it lists next is the new globe's.
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  await page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), ROME_VIEW);
  await settle(page, 3000);
  expect(await emptyPixelsNow(page)).toBe(0);
  const tiers = await page.evaluate(() => window.offlineHarness?.served.map((e) => e.tier) ?? []);
  expect(tiers).not.toContain('network');
  expect(tiers).toContain('package');
});

test('a single dead endpoint is marked unreachable alone, and its checks back off (F297)', async ({ page }) => {
  test.setTimeout(180_000);
  await openHarness(page);
  const deadRequests: number[] = [];
  await page.route('http://127.0.0.1:*/**', (route) => {
    deadRequests.push(Date.now());
    return route.abort('connectionrefused');
  });
  const port = new URL(page.url()).port;
  await startHarness(page, {
    sources: [
      { id: 'live', pattern: 'world', session: 'f297-live', maxLevel: 4 },
      {
        id: 'dead',
        url: `http://127.0.0.1:${port}/fixture-tiles/f297-dead/levels/mercator/{z}/{x}/{y}.png`,
        minLevel: 5,
      },
    ],
    view: ROME_VIEW,
    healthChecks: HEALTH,
  });
  await expect.poll(() => connectivity(page), { timeout: 20_000 }).toBe('degraded');
  expect(await page.evaluate(() => window.offlineHarness?.events.at(-1)?.payload)).toMatchObject({
    connectivity: 'degraded',
    unreachable: [`http://127.0.0.1:${port}`],
  });
  const from = deadRequests.length;
  await page.waitForTimeout(8000);
  const checks = deadRequests.slice(from);
  // Waits of 0.3, 0.6, 1.2, 2, 2, … s: a handful of checks in 8 s, never two within the minimum interval.
  expect(checks.length).toBeGreaterThanOrEqual(3);
  expect(checks.length).toBeLessThanOrEqual(8);
  for (let i = 1; i < checks.length; i++) expect((checks[i] ?? 0) - (checks[i - 1] ?? 0)).toBeGreaterThanOrEqual(250);
  // The live endpoint keeps serving.
  expect(await emptyPixelsNow(page)).toBe(0);
});

/** Largest per-channel change between two frames. */
function largestChange(a: PNG, b: PNG): number {
  let largest = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++) largest = Math.max(largest, Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)));
  return largest;
}

test('when connectivity returns, the visible view loads first and refines with cross-fades, no popping (F299)', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await openHarness(page);
  const config: HarnessConfig = {
    sources: [{ id: 'world', pattern: 'levels', session: 'f299' }],
    view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 4 },
    healthChecks: HEALTH,
    clockStepMs: 16,
  };
  await startHarness(page, config);
  expect(await emptyPixels(page)).toBe(0);
  await context.setOffline(true);
  await page.evaluate(() => window.offlineHarness?.globe?.jumpTo({ longitudeDeg: 139.7, latitudeDeg: 35.7, zoom: 6 }));
  await expect.poll(() => connectivity(page), { timeout: 20_000 }).toBe('offline');
  await settle(page);
  const requests = recordTileRequests(page);
  let previous = await canvasImage(page);
  await context.setOffline(false);
  await expect.poll(() => connectivity(page), { timeout: 10_000 }).toBe('online');
  // The first tiles asked for after the return are the visible view's: around Tokyo, at the view's levels.
  await expect.poll(() => requests.length, { timeout: 10_000 }).toBeGreaterThan(3);
  for (const path of requests.slice(0, 4)) {
    const [z, x] = (/\/(\d+)\/(\d+)\/\d+\.png$/.exec(path) ?? []).slice(1).map(Number) as [number, number];
    const lon = ((x + 0.5) / 2 ** z) * 360 - 180;
    expect(Math.abs(lon - 139.7)).toBeLessThan(360 / 2 ** z + 10);
  }
  // Frame by frame (16 ms of engine time each), refinement fades in: no pixel jumps the whole way at once.
  let changes = 0;
  for (let frame = 0; frame < 30; frame++) {
    const next = await canvasImage(page);
    const change = largestChange(previous, next);
    if (change > 0) changes++;
    expect(change).toBeLessThanOrEqual(96);
    previous = next;
  }
  expect(changes).toBeGreaterThan(0);
  expect(await emptyPixels(page)).toBe(0);
  const events = await page.evaluate(() =>
    window.offlineHarness?.events.filter((e) => e.type === 'connectivity-change').map((e) => e.payload),
  );
  expect(events?.map((e) => (e as { connectivity: string }).connectivity)).toEqual(['offline', 'online']);

  // During a pan: connectivity returns between two steps and every step stays whole.
  await context.setOffline(true);
  await expect.poll(() => connectivity(page), { timeout: 20_000 }).toBe('offline');
  for (const [i, lon] of [140, 142, 144, 146, 148].entries()) {
    if (i === 2) await context.setOffline(false);
    await page.evaluate(
      (l) => window.offlineHarness?.globe?.jumpTo({ longitudeDeg: l, latitudeDeg: 35.7, zoom: 6 }),
      lon,
    );
    await settle(page, 800);
    expect(await emptyPixelsNow(page)).toBe(0);
  }
  await expect.poll(() => connectivity(page), { timeout: 10_000 }).toBe('online');
});

test('a source whose provider forbids persistent caching is never stored; the other sources are (F318)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  await startHarness(page, {
    sources: [
      {
        id: 'strict',
        pattern: 'world',
        session: 'f318-strict',
        maxLevel: 4,
        rules: { id: 'no-cache-provider', forbids: ['persistentCache'], respectCacheHeaders: true },
      },
      { id: 'open', pattern: 'levels', session: 'f318-open', minLevel: 5 },
    ],
    view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 3 },
  });
  for (const [lon, zoom] of [
    [12.5, 5],
    [12.5, 7],
    [20, 7],
    [30, 6],
  ] as const)
    expect(await viewAt(page, lon, 41.9, zoom)).toBe(0);
  const served = await page.evaluate(() => window.offlineHarness?.served.map((e) => e.sourceId) ?? []);
  expect(served).toContain('strict');
  await expect
    .poll(async () => (await storedTiles(page)).filter((t) => t.key.startsWith('open/')).length)
    .toBeGreaterThan(0);
  expect((await storedTiles(page)).filter((t) => t.key.startsWith('strict/'))).toEqual([]);
});

test('an application plugs in its own cache store and network policy; both pass the contracts of the built-in ones (F327)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const contracts = await page.evaluate(async () => {
    const repo = location.pathname.replace(/\/e2e\/support\/[^/]*$/, '');
    type Results = { passed: boolean; name: string }[];
    const offline = (await import(/* @vite-ignore */ `${repo}/packages/offline/src/index.ts`)) as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const plugin = (await import(/* @vite-ignore */ `${repo}/e2e/fixtures/offline-plugin/index.ts`)) as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const stores = {
      memory: () => offline['memoryStore']?.({ maxBytes: 4096 }),
      indexedDb: () => offline['indexedDbStore']?.({ maxBytes: 4096, database: `contract-${Math.random()}` }),
      worker: () => offline['workerStore']?.({ maxBytes: 4096, database: `contract-${Math.random()}` }),
      custom: () => plugin['mapStore']?.(4096, {}),
    };
    const out: Record<string, Results> = {};
    for (const [name, create] of Object.entries(stores))
      out[name] = (await offline['runCacheStoreContract']?.(create)) as Results;
    const switches = new (offline['SwitchBoard'] as unknown as new () => unknown)();
    out['builtInPolicy'] = offline['runNetworkPolicyContract']?.(() =>
      offline['defaultNetworkPolicy']?.({ mode: () => 'hybrid', switches, rules: () => undefined }),
    ) as Results;
    out['customPolicy'] = offline['runNetworkPolicyContract']?.(() => plugin['liveSourcesPolicy']?.({})) as Results;
    return out;
  });
  for (const [name, results] of Object.entries(contracts)) {
    expect(results.length, name).toBeGreaterThan(3);
    expect(
      results.filter((r) => !r.passed),
      name,
    ).toEqual([]);
  }

  const requests = recordTileRequests(page);
  await startHarness(page, {
    plugin: true,
    sources: [
      { id: 'world', pattern: 'world', session: 'f327', maxLevel: 4 },
      { id: 'live-traffic', pattern: 'levels', session: 'f327-live', minLevel: 5 },
    ],
    view: ROME_VIEW,
  });
  expect(await emptyPixels(page)).toBe(0);
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  const counters = await page.evaluate(
    () => (window as unknown as { pluginCounters: Record<string, number> }).pluginCounters,
  );
  expect(counters['decisions']).toBeGreaterThan(10);
  expect(counters['puts']).toBeGreaterThan(0);
  // The policy keeps live sources out of the store: after the restart only they are downloaded again.
  const tiers = await page.evaluate(() => window.offlineHarness?.served.map((e) => `${e.sourceId}:${e.tier}`) ?? []);
  expect(tiers.filter((t) => t.startsWith('world:')).every((t) => t === 'world:persistent')).toBe(true);
  expect(tiers.filter((t) => t.startsWith('live-traffic:')).every((t) => t === 'live-traffic:network')).toBe(true);
  expect(requests.length).toBeGreaterThan(0);
  // Nothing went to the built-in store.
  expect(await storedTiles(page)).toEqual([]);
});
