// The loading switches acting in the engine (M8): memory reuse keeps tiles that left the view in GPU and RAM memory
// (F281) or releases them at once (F282), tiles on screen stay whatever is switched off (F283), prefetch loads the ring
// around the view ahead of a pan (F284), and without it only the view's tiles are requested, per source (F285).
import { expect, test, type Page } from '@playwright/test';
import { canvasImage, nextFrame } from './support/globe.ts';
import {
  emptyPixels,
  emptyPixelsNow,
  openHarness,
  recordTileRequests,
  startHarness,
  type HarnessConfig,
} from './support/offline.ts';

test.beforeEach(() => test.setTimeout(150_000));

const ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 };
const FAR = { longitudeDeg: -70, latitudeDeg: -20, zoom: 6 };

const jump = (page: Page, view: Record<string, number>) =>
  page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), view);

const stats = (page: Page) =>
  page.evaluate(() => {
    const s = window.offlineHarness?.globe?.imageryStats();
    if (!s) throw new Error('no imagery stats');
    return s;
  });

/** A requested tile's level, column and row, from its fixture path (`…/{z}/{x}/{y}.png`). */
function tileOf(path: string): [number, number, number] {
  const [z = 0, x = 0, y = 0] = path
    .replace(/\.png$/, '')
    .split('/')
    .slice(-3)
    .map(Number);
  return [z, x, y];
}

/** A Web Mercator tile's bounds in degrees (west, south, east, north). */
function boundsOf([z, x, y]: [number, number, number]): [number, number, number, number] {
  const n = 2 ** z;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

/** The bounds of the surface tiles the last frame drew: the view, tile by tile. */
const drawnBounds = (page: Page) =>
  page.evaluate(() =>
    (window.offlineHarness?.globe?.surfaceTiles() ?? []).map(
      (t) => [t.westDeg, t.southDeg, t.eastDeg, t.northDeg] as [number, number, number, number],
    ),
  );

/** Whether two bounds share an area (touching edges do not count). */
const overlaps = (a: number[], b: number[]): boolean =>
  (a[0] ?? 0) < (b[2] ?? 0) - 1e-9 &&
  (b[0] ?? 0) < (a[2] ?? 0) - 1e-9 &&
  (a[1] ?? 0) < (b[3] ?? 0) - 1e-9 &&
  (b[1] ?? 0) < (a[3] ?? 0) - 1e-9;

async function start(page: Page, config: Partial<HarnessConfig>): Promise<string[]> {
  await openHarness(page);
  const requests = recordTileRequests(page);
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: 'f281' }], view: ROME, ...config });
  expect(await emptyPixels(page)).toBe(0);
  return requests;
}

test('with memory reuse, tiles that left the view come back from memory on the first frame, within the budgets (F281)', async ({
  page,
}) => {
  const requests = await start(page, { switches: { persistentCache: false } });
  await jump(page, FAR);
  expect(await emptyPixels(page)).toBe(0);
  requests.length = 0;
  await jump(page, ROME);
  await nextFrame(page);
  expect(await emptyPixelsNow(page), 'first frame back').toBe(0);
  expect(await emptyPixels(page)).toBe(0);
  expect(requests, 'requests on the way back').toEqual([]);
  const s = await stats(page);
  expect(s.gpuBytes).toBeLessThanOrEqual(s.gpuBudgetBytes);
  expect(s.ramBytes).toBeLessThanOrEqual(s.ramBudgetBytes);
});

test('without memory reuse, GPU and RAM hold the working set only, and panning back reloads with no black pixels (F282)', async ({
  page,
}) => {
  const requests = await start(page, { switches: { persistentCache: false, memoryReuse: false } });
  const atRome = await stats(page);
  await jump(page, FAR);
  expect(await emptyPixels(page)).toBe(0);
  const away = await stats(page);
  // Rome's tiles left the GPU and RAM: what is held is the new view's working set, not both views.
  expect(away.ready, 'GPU tiles').toBeLessThanOrEqual(atRome.ready * 1.5);
  expect(away.ramBytes, 'RAM bytes').toBeLessThanOrEqual(atRome.ramBytes * 1.5);
  expect(away.evicted, 'tiles released').toBeGreaterThan(0);
  requests.length = 0;
  await jump(page, ROME);
  await nextFrame(page);
  expect(await emptyPixelsNow(page), 'first frame back: coarser parents').toBe(0);
  expect(await emptyPixels(page)).toBe(0);
  expect(requests.length, 'tiles loaded again').toBeGreaterThan(0);
});

test('with every cache feature off, tiles on screen stay while visible: no re-request and no blank frame (F283)', async ({
  page,
}) => {
  const requests = await start(page, { switches: { persistentCache: false, memoryReuse: false, prefetch: false } });
  // Held still: nothing is evicted and requested again, and the frames do not change.
  requests.length = 0;
  const before = await canvasImage(page);
  for (let i = 0; i < 30; i++) await jump(page, ROME);
  for (let i = 0; i < 5; i++) await nextFrame(page);
  const after = await canvasImage(page);
  let changed = 0;
  for (let i = 0; i < before.data.length; i++) if (before.data[i] !== after.data[i]) changed++;
  expect(changed, 'pixels changed while still').toBe(0);
  expect(requests, 'requests while still').toEqual([]);
  // A slow pan: every frame covered, and no tile requested twice while it stays on screen.
  for (let k = 1; k <= 30; k++) {
    await jump(page, { ...ROME, longitudeDeg: ROME.longitudeDeg + k * 0.05 });
    await nextFrame(page);
    expect(await emptyPixelsNow(page), `frame ${String(k)}`).toBe(0);
  }
  expect(requests.length - new Set(requests).size, 'tiles requested twice').toBe(0);
});

test('prefetch loads the tiles around the view, so half a screen of pan shows full detail on its first frame (F284)', async ({
  page,
}) => {
  const requests = await start(page, { switches: { persistentCache: false } });
  const view = await drawnBounds(page);
  // Tiles outside the drawn view were requested: the ring around it.
  const outside = requests.map(tileOf).filter((t) => t[0] >= 5 && !view.some((b) => overlaps(boundsOf(t), b)));
  expect(outside.length, 'prefetched tiles').toBeGreaterThan(0);
  // Half a screen east at normal speed (30 frames): every tile drawn shows its own imagery level from the first frame
  // it appears, never a coarser fallback, and no frame has a black pixel.
  const half = view.reduce((w, b) => Math.max(w, b[2] - ROME.longitudeDeg), 0) / 2;
  const coarse: string[] = [];
  for (let k = 1; k <= 30; k++) {
    await jump(page, { ...ROME, longitudeDeg: ROME.longitudeDeg + (half * k) / 30 });
    await nextFrame(page);
    const tiles = await page.evaluate(() =>
      (window.offlineHarness?.globe?.surfaceTiles() ?? []).map((t) => [t.level, t.x, t.y, t.imageryLevel ?? -1]),
    );
    for (const [level, x, y, shown] of tiles) if (shown !== level) coarse.push(`${k}: ${level}/${x}/${y} at ${shown}`);
    expect(await emptyPixelsNow(page), `frame ${String(k)}`).toBe(0);
  }
  expect(coarse, 'tiles drawn below full detail during the pan').toEqual([]);
});

test('without prefetch only the tiles of the view are requested, and a source left on still prefetches (F285)', async ({
  page,
}) => {
  await openHarness(page);
  const requests = recordTileRequests(page);
  await startHarness(page, {
    sources: [
      { id: 'quiet', pattern: 'world', session: 'f285-quiet' },
      { id: 'eager', pattern: 'world', session: 'f285-eager' },
    ],
    view: ROME,
    switches: { persistentCache: false },
    switchScopes: [{ switches: { prefetch: false }, scope: { sourceId: 'quiet' } }],
  });
  const seen: number[][] = [];
  for (const lon of [12.5, 14, 15.5]) {
    await jump(page, { ...ROME, longitudeDeg: lon });
    expect(await emptyPixels(page)).toBe(0);
    seen.push(...(await drawnBounds(page)));
  }
  const beyond = (session: string) =>
    requests
      .filter((p) => p.includes(`/${session}/`))
      .map(tileOf)
      // The pinned base (the coarsest levels) loads whatever the view: it is the fallback of every tile (F084).
      .filter((t) => t[0] >= 5 && !seen.some((b) => overlaps(boundsOf(t), b)));
  expect(beyond('f285-quiet'), 'tiles of the quiet source outside every view').toEqual([]);
  expect(beyond('f285-eager').length, 'tiles the other source prefetched').toBeGreaterThan(0);
});
