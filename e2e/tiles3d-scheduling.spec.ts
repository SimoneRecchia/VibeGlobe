// 3D Tiles requests through the engine's request pool (F462): screen-center tiles first, at most the host's limit in
// flight, requests the view stops needing cancelled during a flight, and loaded content kept within its budget by
// LRU eviction during randomized navigation, evicted tiles loading again on return. The navigation runs
// `TILES3D_NAVIGATION_S` seconds (default 60; the 10-minute run is in docs/internal/hardening-backlog.md).
import { expect, test, type Page } from '@playwright/test';
import { CITY, cityPoint, openCity, redraw, settleTiles, startCoverage, stopCoverage } from './support/tiles3d.ts';

test.use({ viewport: { width: 320, height: 240 } });

const NAVIGATION_S = Number(process.env['TILES3D_NAVIGATION_S'] ?? 60);
const HOST_LIMIT = 6;

/** Delays every fixture tile by `ms`, so requests are still in flight while the camera moves. */
async function slowLink(page: Page, ms: number): Promise<void> {
  await page.route('**/tiles3d/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => undefined);
  });
}

const requests = (page: Page) => page.evaluate(() => [...(window.vibeglobeTiles3d?.requests ?? [])]);

test('screen-center tiles are requested first, within the host limit (F462)', async ({ page }) => {
  await slowLink(page, 300);
  await openCity(page, `backend=webgl2&lon=${CITY.longitudeDeg}&lat=${CITY.latitudeDeg}&zoom=14&tilt=0`);
  await settleTiles(page);
  const before = (await requests(page)).length;
  await page.evaluate(async (city) => {
    await window.vibeglobePlayground?.globe.jumpTo({ ...city, zoom: 15.8, tiltDeg: 0 });
  }, CITY);
  await settleTiles(page);
  const log = (await requests(page)).slice(before);
  // Each started content's distance from the city center (the screen center), in meters, by level.
  const byLevel = new Map<number, number[]>();
  for (const e of log) {
    const match = /tiles\/(\d)\/(\d+)\/(\d+)/.exec(e.url);
    if (e.kind !== 'start' || !match) continue;
    const [level, x, y] = match.slice(1).map(Number) as [number, number, number];
    const size = 1024 / 2 ** level;
    const distance = Math.hypot(-512 + (x + 0.5) * size, -512 + (y + 0.5) * size);
    byLevel.set(level, [...(byLevel.get(level) ?? []), distance]);
  }
  const [, distances = []] = [...byLevel].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  expect(distances.length).toBeGreaterThanOrEqual(8);
  const half = Math.ceil(distances.length / 2);
  const mean = (a: number[]): number => a.reduce((sum, v) => sum + v, 0) / a.length;
  expect(distances[0]).toBe(Math.min(...distances));
  expect(mean(distances.slice(0, half))).toBeLessThan(mean(distances.slice(half)));
  let inFlight = 0;
  let most = 0;
  for (const e of log) {
    if (e.kind === 'start') inFlight++;
    if ((e.kind === 'done' || e.kind === 'cancel') && e.result !== undefined) inFlight--;
    most = Math.max(most, inFlight);
  }
  expect(most).toBeLessThanOrEqual(HOST_LIMIT);
});

test('a flight across the city cancels requests the view no longer needs (F462)', async ({ page }) => {
  await slowLink(page, 600);
  const west = cityPoint(-450, 0);
  await openCity(page, `backend=webgl2&lon=${west.longitudeDeg}&lat=${west.latitudeDeg}&zoom=17.5&tilt=40`);
  await settleTiles(page);
  const before = (await requests(page)).length;
  const east = cityPoint(450, 0);
  await page.evaluate(
    async (to) => {
      await window.vibeglobePlayground?.globe.flyTo({ ...to, zoom: 17.5, tiltDeg: 40 }, { durationMs: 4000 });
    },
    { longitudeDeg: east.longitudeDeg, latitudeDeg: east.latitudeDeg },
  );
  await settleTiles(page);
  const log = (await requests(page)).slice(before);
  const cancelled = log.filter((e) => e.kind === 'cancel');
  console.log(`${log.filter((e) => e.kind === 'start').length} started, ${cancelled.length} cancelled`);
  expect(cancelled.length).toBeGreaterThan(0);
  // Nothing cancelled was needed at the end: every drawn tile's content is loaded.
  expect(await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats().loading)).toBe(0);
});

test('randomized navigation keeps content within its budget, and evicted tiles load again (F462)', async ({ page }) => {
  test.setTimeout(NAVIGATION_S * 1000 + 120_000);
  const budgetMb = 0.6;
  await openCity(
    page,
    `backend=webgl2&budgetMb=${budgetMb}&lon=${CITY.longitudeDeg}&lat=${CITY.latitudeDeg}&zoom=16.5&tilt=30`,
  );
  await settleTiles(page);
  const start = await page.evaluate(() =>
    window.vibeglobeTiles3d?.extension
      .debugTiles()
      .map((t) => t.id)
      .sort(),
  );
  let seed = 7;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const end = Date.now() + NAVIGATION_S * 1000;
  let stops = 0;
  while (Date.now() < end) {
    const to = cityPoint((random() - 0.5) * 1000, (random() - 0.5) * 1000);
    await page.evaluate(
      async (view) => {
        await window.vibeglobePlayground?.globe.jumpTo(view);
      },
      { longitudeDeg: to.longitudeDeg, latitudeDeg: to.latitudeDeg, zoom: 15 + random() * 3, tiltDeg: random() * 50 },
    );
    await settleTiles(page);
    const stats = await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats());
    expect(stats?.bytes, JSON.stringify(stats)).toBeLessThanOrEqual(budgetMb * 1024 * 1024);
    stops++;
  }
  const stats = await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats());
  console.log(`${stops} stops, ${stats?.evicted} evictions`);
  expect(stats?.evicted).toBeGreaterThan(0);
  // Back at the start: the same tiles, loaded again, and no holes.
  await page.evaluate(async (city) => {
    await window.vibeglobePlayground?.globe.jumpTo({ ...city, zoom: 16.5, tiltDeg: 30 });
  }, CITY);
  await settleTiles(page);
  await startCoverage(page);
  await redraw(page);
  const coverage = await stopCoverage(page);
  expect(coverage.holes).toBe(0);
  expect(
    await page.evaluate(() =>
      window.vibeglobeTiles3d?.extension
        .debugTiles()
        .map((t) => t.id)
        .sort(),
    ),
  ).toEqual(start);
});
