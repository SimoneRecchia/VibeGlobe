import { expect, test, type Page } from '@playwright/test';
import { canvasImage, emptyPixelsInside, nextFrame, openGlobe, silhouetteRadiusPx } from './support/globe.js';
import {
  centerTile,
  fixtureSession,
  mercatorTile,
  requestLog,
  waitForImagery,
  waitForStreaming,
  type LoggedRequest,
} from './support/imagery.js';

/** M3 increment 5: the engine against faulty, slow, limited and multiplexed tile servers (ADR 0007, M3 plan §3). */

test.describe.configure({ timeout: 180_000 });

const ROME = { lon: 12.5, lat: 41.9 };
const HTTP1 = 'http://localhost:5177';
const HTTP2 = 'https://localhost:5178';

async function jump(page: Page, view: { lon?: number; lat?: number; zoom?: number }): Promise<void> {
  await page.evaluate(
    (v) =>
      window.vibeglobePlayground?.globe.jumpTo({
        ...(v.lon === undefined ? {} : { longitudeDeg: v.lon }),
        ...(v.lat === undefined ? {} : { latitudeDeg: v.lat }),
        ...(v.zoom === undefined ? {} : { zoom: v.zoom }),
      }),
    view,
  );
  await nextFrame(page);
}

/** The most requests in flight at once, from the server's log of start and end times. */
function maxInFlight(requests: readonly LoggedRequest[]): number {
  const edges = requests.flatMap((r) => [
    [r.startMs, 1],
    [r.endMs ?? Infinity, -1],
  ]);
  edges.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));
  let current = 0;
  let max = 0;
  for (const [, delta] of edges) max = Math.max(max, (current += delta ?? 0));
  return max;
}

/** Captures frames until `done` holds, asserting each is complete; returns how many. */
async function completeFramesUntil(page: Page, done: () => Promise<boolean>, timeoutMs = 60_000): Promise<number> {
  const radius = await silhouetteRadiusPx(page);
  const deadline = Date.now() + timeoutMs;
  let frames = 0;
  while (Date.now() < deadline) {
    expect(emptyPixelsInside(await canvasImage(page), radius)).toBe(0);
    frames++;
    if (await done()) break;
  }
  return frames;
}

test('requests in flight stay within the limit of each host, and two hosts load in parallel (F089)', async ({
  page,
}) => {
  const session = await fixtureSession(page, [{ minLevel: 4, latencyMs: 200 }], HTTP1);
  await openGlobe(
    page,
    `imagery=levels&session=${session}&tileBase=http://{s}:5177/&subdomains=localhost,127.0.0.1&perHost=2&zoom=2`,
  );
  await waitForImagery(page);
  await jump(page, { ...ROME, zoom: 9 });
  await waitForImagery(page);
  const log = await requestLog(page, session, HTTP1);
  const hosts = new Map<string, LoggedRequest[]>();
  for (const request of log) hosts.set(request.host ?? '', [...(hosts.get(request.host ?? '') ?? []), request]);
  expect([...hosts.keys()].sort()).toEqual(['127.0.0.1:5177', 'localhost:5177']);
  for (const requests of hosts.values()) expect(maxInFlight(requests)).toBeLessThanOrEqual(2);
  // Both hosts busy at the same time, each at its limit: four requests in flight together (KB-072).
  expect(maxInFlight(log)).toBe(4);
});

test('requests for tiles passed on the way from Milan to Tokyo are cancelled, and the destination loads at once (F090)', async ({
  page,
}) => {
  const session = await fixtureSession(page, [{ minLevel: 4, latencyMs: 1500 }]);
  await openGlobe(page, `imagery=levels&session=${session}&zoom=7&lon=9.19&lat=45.46&scenario=path-milan-tokyo`);
  await page.waitForFunction(() => document.body.dataset['scenario'] === 'done', undefined, { timeout: 60_000 });
  const pathEnd = Date.now();
  await waitForImagery(page);
  // Without the stale requests in the way, Tokyo loads within a few latencies of the path's end.
  expect(Date.now() - pathEnd).toBeLessThan(20_000);
  const log = await requestLog(page, session);
  const aborted = log.filter((request) => request.aborted);
  expect(aborted.length).toBeGreaterThan(0);
  // Every aborted request is for a tile away from Tokyo (passed on the way).
  const tokyo = mercatorTile(7, 139.7, 35.7);
  for (const request of aborted.filter((r) => r.level === 7)) expect(Math.abs(request.x - tokyo.x)).toBeGreaterThan(1);
});

/** Rules for the tile under Rome at each level a zoom-9.6 view may want there (the view decides which). */
function romeRules(rule: object, dx = 0): object[] {
  return [9, 10, 11].map((level) => {
    const { x, y } = mercatorTile(level, ROME.lon, ROME.lat);
    return { minLevel: level, maxLevel: level, xRange: [x + dx, x + dx], yRange: [y, y], ...rule };
  });
}

/** The requests of the tile under Rome at the level the center tile draws, `dx` columns east. */
async function romeAttempts(page: Page, session: string, dx = 0): Promise<LoggedRequest[]> {
  const level = (await centerTile(page)).level;
  const { x, y } = mercatorTile(level, ROME.lon, ROME.lat);
  return (await requestLog(page, session)).filter((r) => r.level === level && r.x === x + dx && r.y === y);
}

test('failed requests are retried with growing delays until they load, and a tile failing for good stops (F091)', async ({
  page,
}) => {
  const session = await fixtureSession(page, [
    ...romeRules({ status: 503, failTimes: 3 }),
    ...romeRules({ status: 500 }, 1),
  ]);
  await openGlobe(page, `imagery=levels&session=${session}&zoom=8&lon=${ROME.lon}&lat=${ROME.lat}`);
  await jump(page, { zoom: 9.6 });
  // The 503s: three failures then the tile. The backoff draws each delay below a cap that doubles per retry
  // (full jitter; the caps are checked in failure-policy.test.ts).
  await expect.poll(async () => (await romeAttempts(page, session)).at(-1)?.status, { timeout: 60_000 }).toBe(200);
  expect((await romeAttempts(page, session)).map((r) => r.status)).toEqual([503, 503, 503, 200]);
  // The 500s: the first request and four retries, then nothing more, and a tile-error.
  await expect.poll(async () => (await romeAttempts(page, session, 1)).length, { timeout: 90_000 }).toBe(5);
  await page.waitForTimeout(3000);
  expect(await romeAttempts(page, session, 1)).toHaveLength(5);
  const level = (await centerTile(page)).level;
  const { x, y } = mercatorTile(level, ROME.lon, ROME.lat);
  const events = await page.evaluate(() => window.vibeglobePlayground?.events.filter((e) => e.type === 'tile-error'));
  expect(events?.map((e) => e.payload)).toContainEqual({
    sourceId: 'fixture-levels',
    level,
    x: x + 1,
    y,
    reason: 'failed',
  });
});

test('requests that never answer time out, free their slot and are retried; other tiles keep loading (F092)', async ({
  page,
}) => {
  const session = await fixtureSession(page, romeRules({ hang: true }));
  await openGlobe(page, `imagery=levels&session=${session}&zoom=8&lon=${ROME.lon}&lat=${ROME.lat}&timeoutMs=1500`);
  await jump(page, { zoom: 9.6 });
  await expect
    .poll(async () => (await romeAttempts(page, session)).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  const [first] = await romeAttempts(page, session);
  expect(first?.aborted).toBe(true);
  // Aborted after the 1.5 s timeout, not before and not much later.
  expect((first?.endMs ?? 0) - (first?.startMs ?? 0)).toBeGreaterThanOrEqual(1400);
  expect((first?.endMs ?? 0) - (first?.startMs ?? 0)).toBeLessThan(4000);
  // Every other tile of the view loaded meanwhile: only the hanging tile shows an ancestor.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).filter(
              (t) => t.root === 'mercator' && t.imageryLevel !== t.level,
            ).length,
        ),
      { timeout: 30_000 },
    )
    .toBe(1);
});

test('404 tiles are requested once, the parent stays drawn, and they are not requested again (F093)', async ({
  page,
}) => {
  const session = await fixtureSession(page, [{ minLevel: 9, status: 404 }]);
  await openGlobe(page, `imagery=levels&session=${session}&zoom=7&lon=${ROME.lon}&lat=${ROME.lat}`);
  await waitForImagery(page);
  await jump(page, { zoom: 10 });
  await expect.poll(async () => (await centerTile(page)).imageryLevel, { timeout: 30_000 }).toBe(8);
  await completeFramesUntil(page, async () => true);
  const missing = (await requestLog(page, session)).filter((r) => r.level >= 9);
  expect(missing.length).toBeGreaterThan(0);
  expect(new Set(missing.map((r) => r.path)).size).toBe(missing.length);
  // Away and back: the known-missing tiles are not requested again.
  await jump(page, { lon: 30, zoom: 7 });
  await waitForImagery(page);
  await jump(page, { ...ROME, zoom: 10 });
  await expect.poll(async () => (await centerTile(page)).imageryLevel, { timeout: 30_000 }).toBe(8);
  const after = (await requestLog(page, session)).filter((r) => r.level >= 9);
  expect(after.filter((r) => missing.some((m) => m.path === r.path))).toHaveLength(missing.length);
});

test('a source covering only Italy and levels 2–11 is never asked for anything else (F094)', async ({ page }) => {
  const session = await fixtureSession(page);
  await openGlobe(page, `imagery=levels&session=${session}&coverage=italy&imageryMin=2&imageryMax=11&zoom=2`);
  await waitForStreaming(page);
  for (const view of [
    { ...ROME, zoom: 10 },
    { lon: 2.35, lat: 48.86, zoom: 9 },
    { lon: -74, lat: 40.7, zoom: 8 },
    { ...ROME, zoom: 14 },
  ]) {
    await jump(page, view);
    await completeFramesUntil(page, async () => true);
    await waitForStreaming(page);
  }
  // Rome at zoom 14 shows level 11 imagery, the finest the source serves.
  expect((await centerTile(page)).imageryLevel).toBe(11);
  const rad = Math.PI / 180;
  for (const request of await requestLog(page, session)) {
    expect(request.level).toBeGreaterThanOrEqual(2);
    expect(request.level).toBeLessThanOrEqual(11);
    const n = 2 ** request.level;
    const west = (request.x / n) * 360 - 180;
    const east = ((request.x + 1) / n) * 360 - 180;
    const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * request.y) / n))) / rad;
    const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (request.y + 1)) / n))) / rad;
    expect(west < 19 && east > 6 && south < 47.5 && north > 36, request.path).toBe(true);
  }
});

test('no tile is downloaded twice: shared needs share a request, and returning reuses the cache (F095)', async ({
  page,
}) => {
  const session = await fixtureSession(page, [{ minLevel: 4, latencyMs: 300 }]);
  await openGlobe(page, `imagery=levels&session=${session}&zoom=7&lon=${ROME.lon}&lat=${ROME.lat}`);
  await waitForImagery(page);
  for (const view of [
    { lon: 14, zoom: 8 },
    { lon: 30, zoom: 7 },
    { ...ROME, zoom: 7 },
    { lon: 14, zoom: 8 },
  ]) {
    await jump(page, view);
    await waitForImagery(page);
  }
  // Many surface tiles want the same coarse tiles at once; each URL is downloaded once (cancelled requests aside).
  const downloads = (await requestLog(page, session)).filter((r) => !r.aborted);
  expect(downloads.length).toBeGreaterThan(30);
  expect(new Set(downloads.map((r) => r.path)).size).toBe(downloads.length);
});

test.describe('over HTTP/2', () => {
  test.use({ ignoreHTTPSErrors: true });

  test('tile requests share one connection per host and compressed responses decode (F096)', async ({ page }) => {
    const session = await fixtureSession(page, [{ minLevel: 5, gzip: true }], HTTP2);
    await openGlobe(
      page,
      `imagery=levels&session=${session}&tileBase=${HTTP2}/&multiplexed=1&zoom=7&lon=12.5&lat=41.9`,
    );
    await waitForImagery(page);
    const log = await requestLog(page, session, HTTP2);
    expect(log.length).toBeGreaterThan(20);
    expect(new Set(log.map((r) => r.connection)).size).toBe(1);
    // The gzip-encoded tiles were decoded and drawn like the others.
    const tiles = await page.evaluate(() => window.vibeglobePlayground?.globe.surfaceTiles() ?? []);
    expect(tiles.some((t) => t.level >= 5 && t.imageryLevel === t.level)).toBe(true);
  });
});

test('corrupt tiles keep their parent drawn, are reported, and never blank a frame (F112)', async ({ page }) => {
  const session = await fixtureSession(page, [
    { minLevel: 9, maxLevel: 10, truncateBytes: 200 },
    { minLevel: 11, maxLevel: 12, randomBytes: 4000 },
    { minLevel: 13, truncateBytes: 1 },
  ]);
  await openGlobe(page, `imagery=levels&session=${session}&zoom=7&lon=${ROME.lon}&lat=${ROME.lat}`);
  await waitForImagery(page);
  for (const zoom of [8.5, 9.5, 10.5]) {
    await jump(page, { zoom });
    await completeFramesUntil(page, async () => (await centerTile(page)).imageryLevel === 8, 30_000);
    expect((await centerTile(page)).imageryLevel).toBe(8);
  }
  const errors = await page.evaluate(() =>
    window.vibeglobePlayground?.events.filter((e) => e.type === 'tile-error').map((e) => e.payload),
  );
  expect(errors?.length).toBeGreaterThan(0);
  expect(errors?.every((e) => (e as { reason: string }).reason === 'corrupt')).toBe(true);
});
