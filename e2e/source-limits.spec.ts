// A source's declared limits (M7): its zoom range (F221) and its rate limit (F222).
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession, requestLog } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** Pixels darker than any fixture color and than the page background: a hole. */
function blackPixels(image: PNG): number {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if ((image.data[i] ?? 0) < 20 && (image.data[i + 1] ?? 0) < 20 && (image.data[i + 2] ?? 0) < 20) count++;
  return count;
}

/** Waits until no imagery tile is queued, loading or decoding and the engine is idle. */
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

/** The imagery level the surface tile at the screen center shows (null for the world base image). */
async function centerImageryLevel(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const center = globe?.screenToGeo({ xPx: 160, yPx: 120 });
    if (!globe || !center) return Number.NaN;
    const tile = globe
      .surfaceTiles()
      .filter(
        (t) =>
          center.longitudeDeg >= t.westDeg &&
          center.longitudeDeg <= t.eastDeg &&
          center.latitudeDeg >= t.southDeg &&
          center.latitudeDeg <= t.northDeg,
      )
      .sort((a, b) => b.level - a.level)[0];
    return tile ? tile.imageryLevel : Number.NaN;
  });
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`a source limited to zoom 3–12 is never asked outside them, is magnified above and lets the base show below, on ${backend} (F221)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const session = await fixtureSession(page);
    await openGlobe(
      page,
      `backend=${backend}&imagery=levels&imageryMin=3&imageryMax=12&session=${session}&lon=12.5&lat=41.9&zoom=0.5`,
    );
    await settle(page);
    // Below zoom 3 the world base image shows.
    expect(await centerImageryLevel(page)).toBeNull();
    for (const zoom of [2, 4, 7, 10, 12, 14, 16]) {
      await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
      await settle(page);
      expect(blackPixels(await canvasImage(page)), `zoom ${zoom}`).toBe(0);
    }
    // Above zoom 12, level 12 magnified.
    expect(await centerImageryLevel(page)).toBe(12);
    const levels = (await requestLog(page, session)).filter((r) => r.path.includes('/levels/')).map((r) => r.level);
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.filter((level) => level < 3 || level > 12)).toEqual([]);
  });
}

test('a source declaring 10 requests per second never gets more in any second, and the other source is not slowed (F222)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const session = await fixtureSession(page);
  await openGlobe(
    page,
    `backend=webgl2&imagery=levels&rateLimit=10&overlays=tiles:0.5&session=${session}&lon=12.5&lat=41.9&zoom=7&clockStepMs=16.666666666666668`,
  );
  // A fast pan and a long flight, sampling frames for holes while the limited source is throttled.
  let holes = 0;
  for (const [lon, lat] of [
    [14, 42],
    [16, 43],
    [18, 44],
  ] as const) {
    await page.evaluate(
      ([longitudeDeg, latitudeDeg]) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg, latitudeDeg }),
      [lon, lat] as const,
    );
    holes += blackPixels(await canvasImage(page));
  }
  await page.evaluate(() =>
    window.vibeglobePlayground?.globe.flyTo({ longitudeDeg: -0.13, latitudeDeg: 51.5, zoom: 9 }, { durationMs: 3000 }),
  );
  holes += blackPixels(await canvasImage(page));
  await settle(page);
  expect(holes).toBe(0);
  const log = await requestLog(page, session);
  const limited = log.filter((r) => r.path.includes('/levels/')).map((r) => r.startMs);
  const free = log.filter((r) => r.path.includes('/tiles/')).map((r) => r.startMs);
  expect(limited.length).toBeGreaterThan(30);
  for (const at of limited) expect(limited.filter((t) => t >= at && t < at + 1000).length).toBeLessThanOrEqual(10);
  // The other source is not held to the limit: it started more than 10 requests within some second.
  expect(free.some((at) => free.filter((t) => t >= at && t < at + 1000).length > 10)).toBe(true);
});
