// Source chains (M7, ADR 0038): each tile from the first source of a layer's chain that has it (F247), and failover to
// the next source while the first fails, back to the first once it recovers (F248).
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession, requestLog, type LoggedRequest } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

const DEG = Math.PI / 180;
/** The playground's `ITALY` coverage (`apps/playground/src/main.ts`). */
const ITALY = { west: 6, south: 36, east: 19, north: 47.5 };

/** The bounds of a Web Mercator tile, degrees. */
function bounds(level: number, x: number, y: number): { west: number; south: number; east: number; north: number } {
  const n = 2 ** level;
  const lat = (row: number): number => Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) / DEG;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) };
}

const inItaly = (r: LoggedRequest): boolean => {
  const b = bounds(r.level, r.x, r.y);
  return b.west < ITALY.east && b.east > ITALY.west && b.south < ITALY.north && b.north > ITALY.south;
};

/** Pixels darker than any fixture color (every channel at least 40) and than the page background: a hole. */
function blackPixels(image: PNG): number {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if ((image.data[i] ?? 0) < 20 && (image.data[i + 1] ?? 0) < 20 && (image.data[i + 2] ?? 0) < 20) count++;
  return count;
}

function center(image: PNG): [number, number, number] {
  const at = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

/**
 * Waits until no imagery tile is queued, loading or decoding and the engine is idle. (Every tile showing its own level,
 * `waitForImagery`, does not apply: beyond a source's levels or coverage a coarser tile is magnified on purpose.)
 */
async function settle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = window.vibeglobePlayground?.globe.imageryStats();
          return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : 1;
        }),
      { timeout: 60_000 },
    )
    .toBe(0);
  await waitForIdle(page);
}

/** Jumps to a view and returns its frame once its tiles have loaded. */
async function view(page: Page, longitudeDeg: number, latitudeDeg: number, zoom: number): Promise<PNG> {
  await page.evaluate(
    ([lon, lat, z]) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: lon, latitudeDeg: lat, zoom: z }),
    [longitudeDeg, latitudeDeg, zoom] as const,
  );
  await settle(page);
  return canvasImage(page);
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`each tile comes from the first source of the chain that has it, the detail source only inside its coverage, on ${backend} (F247)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const session = await fixtureSession(page);
    // A package of the world to zoom 8 first, an online source of Italy to zoom 18 second.
    await openGlobe(
      page,
      `backend=${backend}&imagery=world&imageryMax=8&chain=levels:18:italy&session=${session}&lon=12.5&lat=41.9&zoom=4`,
    );
    await settle(page);
    // A zoom into Rome, then a pan to Paris at the same zoom.
    for (const zoom of [6, 8, 10, 12]) expect(blackPixels(await view(page, 12.48, 41.89, zoom))).toBe(0);
    for (const [lon, lat] of [
      [10.5, 43.5],
      [7.5, 46],
      [5, 47.5],
      [2.35, 48.85],
    ] as const)
      expect(blackPixels(await view(page, lon, lat, 12))).toBe(0);
    const log = await requestLog(page, session);
    const packaged = log.filter((r) => r.path.includes('/world/'));
    const online = log.filter((r) => r.path.includes('/levels/'));
    expect(packaged.length).toBeGreaterThan(0);
    expect(online.length).toBeGreaterThan(0);
    // The package serves to zoom 8; above it, inside Italy, the online source; outside Italy it is never asked.
    expect(packaged.filter((r) => r.level > 8)).toEqual([]);
    expect(online.filter((r) => r.level <= 8)).toEqual([]);
    expect(online.filter((r) => !inItaly(r))).toEqual([]);
  });

  test(`while the first source fails or times out the next one serves, and the first serves again once it recovers, on ${backend} (F248)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const session = await fixtureSession(page);
    const setRules = async (rules: unknown[]): Promise<void> => {
      expect((await page.request.post(`/_fixture/${session}/rules`, { data: JSON.stringify(rules) })).status()).toBe(
        204,
      );
    };
    // Two sources of the same area: red first, green second, each in its own color (no tone matching, F249).
    await openGlobe(
      page,
      `backend=${backend}&imagery=red&chain=green&harmonize=0&timeoutMs=1500&session=${session}&lon=12.5&lat=41.9&zoom=7`,
    );
    await settle(page);
    const red = (rgb: number[]): boolean => (rgb[0] ?? 0) > 180 && (rgb[1] ?? 0) < 100;
    const green = (rgb: number[]): boolean => (rgb[1] ?? 0) > 160 && (rgb[0] ?? 0) < 100;
    const frame = await canvasImage(page);
    expect(red(center(frame))).toBe(true);
    // Errors, then timeouts (requests that never answer, retried while the source fails): new tiles come from the
    // second source; then, recovered, from the first again. A failing source keeps retrying, so the views wait for
    // the expected color rather than for loading to end.
    for (const [rules, lon, lat, expected, label] of [
      [[{ source: 'red', status: 500 }], 20, 45, green, 'errors'],
      [[{ source: 'red', hang: true }], 30, 40, green, 'timeouts'],
      [[], 40, 35, red, 'recovered'],
    ] as const) {
      await setRules([...rules]);
      await page.evaluate(
        ([longitudeDeg, latitudeDeg]) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg, latitudeDeg }),
        [lon, lat] as const,
      );
      await expect
        .poll(async () => expected(center(await canvasImage(page))), { message: label, timeout: 60_000 })
        .toBe(true);
      expect(blackPixels(await canvasImage(page)), label).toBe(0);
    }
  });
}
