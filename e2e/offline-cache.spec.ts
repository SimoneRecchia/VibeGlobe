// The persistent cache of @vibeglobe/offline in the browser (M8, offline track): persistence across reloads,
// quotas, eviction, persistence requests, HTTP cache policy and revalidation, and the persistent-cache switch.
import { expect, test, type Page } from '@playwright/test';
import {
  emptyPixels,
  openHarness,
  recordTileRequests,
  servedTiers,
  startHarness,
  storedTileKeys,
  storedTiles,
  tileColumn,
  tileHeaders,
  viewAt,
  type HarnessConfig,
} from './support/offline.ts';

const ROME: HarnessConfig['view'] = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 };

/** A pan along a fixed path: the same tiles each time it runs. */
async function pan(page: Page): Promise<void> {
  for (const longitudeDeg of [12.5, 14, 15.5]) {
    await page.evaluate(
      (lon) => window.offlineHarness?.globe?.jumpTo({ longitudeDeg: lon, latitudeDeg: 41.9, zoom: 6 }),
      longitudeDeg,
    );
    await emptyPixels(page);
  }
}

/** The median of the engine's main-thread CPU time per frame during the pan. */
async function cpuDuringPan(page: Page, restartSession?: string): Promise<number> {
  if (restartSession) {
    await page.evaluate((session) => {
      const harness = window.offlineHarness;
      return harness?.start({
        sources: [{ id: 'world', pattern: 'world', session }],
        view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 },
        switches: { persistentCache: false },
      });
    }, restartSession);
  }
  await page.evaluate(() => {
    const globe = window.offlineHarness?.globe;
    const samples: number[] = [];
    (window as unknown as { cpuSamples: number[] }).cpuSamples = samples;
    globe?.diagnostics.setPhaseTiming(true, false);
    globe?.on('frame', () => samples.push(Object.values(globe.diagnostics.phaseTimesMs()).reduce((a, b) => a + b, 0)));
  });
  await pan(page);
  const cpu = (await page.evaluate(() => (window as unknown as { cpuSamples: number[] }).cpuSamples)).sort(
    (a, b) => a - b,
  );
  return cpu[Math.floor(cpu.length / 2)] ?? 0;
}

test('cached tiles are not requested again after a reload, and cache I/O stays off the main thread (F273)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    // Counts the main thread's IndexedDB transactions on the tile store: the cache worker owns them.
    const original = IDBDatabase.prototype.transaction;
    const counter = window as unknown as { mainThreadTileTransactions: number };
    counter.mainThreadTileTransactions = 0;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      const names = Array.isArray(args[0]) ? args[0] : [args[0]];
      if (names.includes('tiles')) counter.mainThreadTileTransactions++;
      return original.apply(this, args);
    };
    // Times what the cache traffic costs the main thread: posting requests to the cache worker.
    const post = Worker.prototype.postMessage;
    const cost = window as unknown as { cacheMessages: number; cacheMessageMs: number };
    cost.cacheMessages = 0;
    cost.cacheMessageMs = 0;
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      const start = performance.now();
      post.apply(this, args as never);
      const message = args[0] as { op?: string } | undefined;
      if (message?.op === 'put' || message?.op === 'get') {
        cost.cacheMessages++;
        cost.cacheMessageMs += performance.now() - start;
      }
    } as Worker['postMessage'];
  });
  const config: HarnessConfig = { sources: [{ id: 'world', pattern: 'world', session: 'f273' }], view: ROME };
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const first = recordTileRequests(page);
  await startHarness(page, config);
  // The engine's main-thread CPU per frame while the pan writes every tile to the cache, against the same pan with the
  // cache off (medians: absolute times are not judged on the software GPU, ADR 0012), and the main thread's own share
  // of the cache traffic, which is only posting messages to the worker.
  const withWrites = await cpuDuringPan(page);
  const written = new Set(first).size;
  await expect.poll(async () => (await storedTileKeys(page)).length).toBeGreaterThanOrEqual(written);
  const traffic = await page.evaluate(() => {
    const cost = window as unknown as { cacheMessages: number; cacheMessageMs: number };
    return { cacheMessages: cost.cacheMessages, cacheMessageMs: cost.cacheMessageMs };
  });
  expect(traffic.cacheMessages).toBeGreaterThanOrEqual(written);
  console.log(`main thread per cache message: ${(traffic.cacheMessageMs / traffic.cacheMessages).toFixed(3)} ms`);
  expect(traffic.cacheMessageMs / traffic.cacheMessages).toBeLessThan(0.5);
  const withoutCache = await cpuDuringPan(page, 'f273-baseline');
  console.log(
    `engine CPU median per frame: ${withWrites.toFixed(2)} ms with cache writes, ${withoutCache.toFixed(2)} ms without`,
  );
  expect(withWrites).toBeLessThanOrEqual(withoutCache * 1.25 + 1);
  expect(written).toBeGreaterThan(10);

  await page.reload();
  await openHarness(page, { keepStorage: true });
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const second = recordTileRequests(page);
  await startHarness(page, config);
  await pan(page);
  // No tile the first visit cached is requested again (a tile it never loaded may be: selection follows timing).
  const cached = new Set(first);
  expect(second.filter((path) => cached.has(path))).toEqual([]);
  expect(second.length).toBeLessThan(cached.size / 10);
  expect((await servedTiers(page))['persistent']).toBeGreaterThan(10);
  expect(await emptyPixels(page)).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { mainThreadTileTransactions: number }).mainThreadTileTransactions),
  ).toBe(0);
});

test('a small cache evicts least-recently-used tiles, and quota errors never break the view (F274)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const limit = 400_000;
  await startHarness(page, {
    sources: [{ id: 'world', pattern: 'world', session: 'f274' }],
    view: ROME,
    cacheBytes: limit,
  });
  for (const lon of [12.5, 40, 70, 100]) expect(await viewAt(page, lon, 41.9, 6)).toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.offlineHarness?.offline?.cacheUsage().then((u) => u.bytes)))
    .toBeGreaterThan(limit * 0.5);
  const tiles = await storedTiles(page);
  const stored = tiles.reduce((sum, t) => sum + t.bytes, 0);
  expect(stored).toBeLessThanOrEqual(limit);
  // The API's figure matches what is stored within 5%.
  const reported = await page.evaluate(() => window.offlineHarness?.offline?.cacheUsage().then((u) => u.bytes));
  expect(Math.abs((reported ?? 0) - stored)).toBeLessThanOrEqual(stored * 0.05);
  // The latest view's detail tiles are kept, the first view's were evicted (least recently used first).
  const detail = tiles
    .map((t) => t.key.split('/').map(Number))
    .filter(([, z = 0]) => z >= 5)
    .map(([, z = 0, x = 0]) => ((x + 0.5) / 2 ** z) * 360 - 180);
  expect(detail.some((lon) => Math.abs(lon - 100) < 20)).toBe(true);
  expect(detail.some((lon) => Math.abs(lon - 12.5) < 15)).toBe(false);
});

test('a QuotaExceededError on writes logs one warning while the engine keeps rendering from memory and network (F274)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    // Every write transaction on the tile store fails as a full disk does: at commit, with QuotaExceededError.
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      const tx = original.apply(this, args);
      const names = Array.isArray(args[0]) ? args[0] : [args[0]];
      if (args[1] === 'readwrite' && names.includes('tiles')) {
        Object.defineProperty(tx, 'error', { value: new DOMException('full', 'QuotaExceededError') });
        queueMicrotask(() => tx.abort());
      }
      return tx;
    };
  });
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('[vibeglobe/offline]')) warnings.push(message.text());
  });
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  await startHarness(page, {
    sources: [{ id: 'world', pattern: 'world', session: 'f274-quota' }],
    view: ROME,
    store: 'main-thread',
  });
  for (const lon of [12.5, 20, 12.5]) expect(await viewAt(page, lon, 41.9, 6)).toBe(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('full');
  const tiers = await servedTiers(page);
  expect(tiers['network']).toBeGreaterThan(10);
  expect(tiers['persistent']).toBeUndefined();
});

test('cache headers decide reuse: fresh tiles without requests, expired ones revalidated, no-store never stored (F277)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Columns cycle through four policies: max-age, no-cache with an ETag, no-store, and an Expires 3 s ahead.
  const policy = (path: string): number => tileColumn(path) % 4;
  const seen: { path: string; ifNoneMatch: string | undefined }[] = [];
  await openHarness(page);
  await tileHeaders(page, (path, request) => {
    seen.push({ path, ifNoneMatch: request.headers()['if-none-match'] });
    switch (policy(path)) {
      case 0:
        return { 'Cache-Control': 'max-age=3600' };
      case 1:
        if (request.headers()['if-none-match'] === '"same"') return { status: 304, headers: { ETag: '"same"' } };
        return { 'Cache-Control': 'no-cache', ETag: '"same"' };
      case 2:
        return { 'Cache-Control': 'no-store' };
      default:
        return { Expires: new Date(Date.now() + 3000).toUTCString(), Date: new Date().toUTCString() };
    }
  });
  const world = { id: 'world', pattern: 'world', session: 'f277' };
  const config: HarnessConfig = { sources: [world], view: ROME };
  await startHarness(page, config);
  expect(await emptyPixels(page)).toBe(0);
  await page.waitForTimeout(3500);
  const firstRound = seen.length;
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  const again = seen.slice(firstRound);
  const firstPaths = new Set(seen.slice(0, firstRound).map((r) => r.path));
  const by = (p: number) => [...firstPaths].filter((path) => policy(path) === p);
  const requested = new Set(again.map((r) => r.path));
  expect(by(0).length).toBeGreaterThan(0);
  expect(by(0).filter((path) => requested.has(path))).toEqual([]);
  expect(by(1).every((path) => requested.has(path))).toBe(true);
  expect(again.filter((r) => policy(r.path) === 1).every((r) => r.ifNoneMatch === '"same"')).toBe(true);
  expect(by(3).every((path) => requested.has(path))).toBe(true);
  expect(by(2).every((path) => requested.has(path))).toBe(true);
  const keys = (await storedTiles(page)).map((t) => t.key);
  expect(keys.filter((k) => Number(k.split('/')[2]) % 4 === 2)).toEqual([]);
  expect(keys.filter((k) => Number(k.split('/')[2]) % 4 === 0).length).toBeGreaterThan(0);

  // A per-source override shortens max-age (tiles of policy 0 are asked again after 1.5 s) but never lengthens the
  // Expires tiles (policy 3).
  await startHarness(page, { ...config, sources: [{ ...world, cachePolicy: { maxAgeMs: 1000 } }] });
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  await page.waitForTimeout(1500);
  const before = seen.length;
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  const third = new Set(seen.slice(before).map((r) => r.path));
  expect(by(0).every((path) => third.has(path))).toBe(true);
  await startHarness(page, { ...config, sources: [{ ...world, cachePolicy: { maxAgeMs: 1e9 } }] });
  expect(await emptyPixels(page)).toBe(0);
  await page.waitForTimeout(3500);
  const last = seen.length;
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  const fourth = new Set(seen.slice(last).map((r) => r.path));
  expect(by(3).every((path) => fourth.has(path))).toBe(true);
});

test('expired tiles are revalidated with If-None-Match: 304 reuses them, changed tiles replace them (F278)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  let changed = false;
  const etagOf = (path: string): string => (changed && tileColumn(path) % 2 === 0 ? '"v2"' : '"v1"');
  const revalidations: string[] = [];
  const statuses: number[] = [];
  await openHarness(page);
  await page.route('**/fixture-tiles/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const sent = request.headers()['if-none-match'];
    if (sent !== undefined) revalidations.push(sent);
    if (sent === etagOf(path)) {
      statuses.push(304);
      return route.fulfill({ status: 304, headers: { ETag: etagOf(path), 'Cache-Control': 'no-cache' } });
    }
    // A changed tile has new content: the "levels" pattern instead of "world".
    const url = etagOf(path) === '"v2"' ? request.url().replace('/world/', '/levels/') : request.url();
    const response = await route.fetch({ url });
    statuses.push(200);
    return route.fulfill({
      response,
      headers: { ...response.headers(), 'cache-control': 'no-cache', etag: etagOf(path) },
    });
  });
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: 'f278' }], view: ROME });
  expect(await emptyPixels(page)).toBe(0);
  const firstCount = statuses.length;
  await expect.poll(async () => (await storedTiles(page)).length).toBe(firstCount);
  changed = true;
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  const second = statuses.slice(firstCount);
  expect(revalidations.length).toBe(second.length);
  expect(revalidations.every((tag) => tag === '"v1"')).toBe(true);
  expect(second.filter((s) => s === 304).length).toBeGreaterThan(0);
  expect(second.filter((s) => s === 200).length).toBeGreaterThan(0);
  const tiers = await servedTiers(page);
  expect(tiers['revalidated']).toBe(second.filter((s) => s === 304).length);
  await expect
    .poll(async () =>
      (await storedTiles(page)).filter((t) => Number(t.key.split('/')[2]) % 2 === 0).every((t) => t.etag === '"v2"'),
    )
    .toBe(true);
  expect(
    (await storedTiles(page)).filter((t) => Number(t.key.split('/')[2]) % 2 === 1).every((t) => t.etag === '"v1"'),
  ).toBe(true);
});

test('with the persistent cache off nothing is stored; off for one source, the others still persist (F280)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const off: HarnessConfig = {
    sources: [{ id: 'world', pattern: 'world', session: 'f280' }],
    view: ROME,
    switches: { persistentCache: false },
  };
  const first = recordTileRequests(page);
  await startHarness(page, off);
  expect(await emptyPixels(page)).toBe(0);
  expect(await storedTiles(page)).toEqual([]);
  await page.reload();
  await openHarness(page, { keepStorage: true });
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const second = recordTileRequests(page);
  await startHarness(page, off);
  expect(await emptyPixels(page)).toBe(0);
  expect(new Set(second)).toEqual(new Set(first));
  expect(await storedTiles(page)).toEqual([]);

  // Off for source a only: a (levels 0–4) and b (5 and finer) load together, only b persists.
  await startHarness(page, {
    sources: [
      { id: 'a', pattern: 'world', session: 'f280-a', maxLevel: 4 },
      { id: 'b', pattern: 'levels', session: 'f280-b', minLevel: 5 },
    ],
    view: ROME,
    switchScopes: [{ switches: { persistentCache: false }, scope: { sourceId: 'a' } }],
  });
  expect(await emptyPixels(page)).toBe(0);
  const served = await page.evaluate(() => window.offlineHarness?.served.map((e) => e.sourceId) ?? []);
  expect(served).toContain('a');
  expect(served).toContain('b');
  await expect
    .poll(async () => (await storedTiles(page)).filter((t) => t.key.startsWith('b/')).length)
    .toBeGreaterThan(0);
  expect((await storedTiles(page)).filter((t) => t.key.startsWith('a/'))).toEqual([]);
});
