import { expect, test, type Page } from '@playwright/test';
import { canvasImage, emptyPixelsInside, openGlobe, silhouetteRadiusPx, waitForIdle } from './support/globe.js';

/** M3's streaming slice (docs/plan/m3-imagery-streaming.md, increment 3b) against the playground's fixture tiles. */

const ROME = { lon: 12.5, lat: 41.9 };

/** A fresh fixture-server session with its own fault rules and request log (M3 plan §4.1). */
async function fixtureSession(page: Page, rules: unknown[] = []): Promise<string> {
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const response = await page.request.post(`/_fixture/${id}/rules`, { data: JSON.stringify(rules) });
  expect(response.status()).toBe(204);
  return id;
}

interface LoggedRequest {
  level: number;
  x: number;
  y: number;
  startMs: number;
}

async function requestLog(page: Page, session: string): Promise<LoggedRequest[]> {
  return (await (await page.request.get(`/_fixture/${session}/log`)).json()) as LoggedRequest[];
}

/**
 * Waits until every Mercator tile of the view shows imagery of its own level (the polar caps keep the base image),
 * then for the engine to go idle.
 */
async function waitForImagery(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const globe = window.vibeglobePlayground?.globe;
          const tiles = globe?.surfaceTiles() ?? [];
          return tiles.length > 0 && tiles.every((t) => t.root !== 'mercator' || t.imageryLevel === t.level);
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
  await waitForIdle(page);
}

/** The Web Mercator tile at a level that contains a position. */
function mercatorTile(level: number, lonDeg: number, latDeg: number): { x: number; y: number } {
  const n = 2 ** level;
  const lat = (latDeg * Math.PI) / 180;
  return {
    x: Math.floor(((lonDeg + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n),
  };
}

/** The drawn surface tile under the screen center, with the imagery level it shows. */
async function centerTile(page: Page): Promise<{ level: number; imageryLevel: number | null }> {
  return page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const host = document.querySelector('#globe');
    const center = globe?.screenToGeo({ xPx: (host?.clientWidth ?? 0) / 2, yPx: (host?.clientHeight ?? 0) / 2 });
    const tile = globe
      ?.surfaceTiles()
      .find(
        (t) =>
          center &&
          t.westDeg <= center.longitudeDeg &&
          center.longitudeDeg <= t.eastDeg &&
          t.southDeg <= center.latitudeDeg &&
          center.latitudeDeg <= t.northDeg,
      );
    if (!tile) throw new Error('no tile under the center');
    return { level: tile.level, imageryLevel: tile.imageryLevel };
  });
}

/** Captures `frames` successive frames (nadir views) and returns the empty-pixel count of each and its center tile. */
async function recordFrames(page: Page, frames: number) {
  const radius = await silhouetteRadiusPx(page);
  const records: { empty: number; level: number; imageryLevel: number | null }[] = [];
  for (let i = 0; i < frames; i++) {
    const image = await canvasImage(page);
    records.push({ empty: emptyPixelsInside(image, radius), ...(await centerTile(page)) });
  }
  return records;
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test.describe(`tiled imagery on ${backend}`, () => {
    test(`every drawn tile's texels stay within 1.5 px, and a tilted view is finer near the camera (F081)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const session = await fixtureSession(page);
      await openGlobe(
        page,
        `backend=${backend}&imagery=levels&session=${session}&lon=${ROME.lon}&lat=${ROME.lat}&zoom=8&debug=1`,
      );
      await waitForImagery(page);
      const flat = await page.evaluate(() => window.vibeglobePlayground?.globe.surfaceTiles() ?? []);
      expect(flat.length).toBeGreaterThan(0);
      for (const tile of flat) expect(tile.texelErrorPx).toBeLessThanOrEqual(1.5);
      await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ tiltDeg: 70 }));
      await waitForImagery(page);
      const tilted = await page.evaluate(() => window.vibeglobePlayground?.globe.surfaceTiles() ?? []);
      for (const tile of tilted) expect(tile.texelErrorPx).toBeLessThanOrEqual(1.5);
      // The debug overlay reports the same bound.
      const texel = /texel ≤ ([\d.]+) px/.exec((await page.locator('.vibeglobe-debug-overlay').textContent()) ?? '');
      expect(Number(texel?.[1])).toBeLessThanOrEqual(1.5);
      const near = (await centerTile(page)).level;
      expect(near - Math.min(...tilted.map((tile) => tile.level))).toBeGreaterThanOrEqual(3);
    });

    test('a refining tile keeps its parent drawn until its own child arrives, with no hole in any frame (F082)', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const session = await fixtureSession(page);
      await openGlobe(
        page,
        `backend=${backend}&imagery=levels&session=${session}&lon=${ROME.lon}&lat=${ROME.lat}&zoom=7`,
      );
      await waitForImagery(page);
      const parent = await centerTile(page);
      expect(parent.imageryLevel).toBe(parent.level);
      // Delay the child of the center tile one level down (Playwright route interception, as the step asks).
      const child = { level: parent.level + 1, ...mercatorTile(parent.level + 1, ROME.lon, ROME.lat) };
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      await page.route(`**/levels/mercator/${child.level}/${child.x}/${child.y}.png`, async (route) => {
        await released;
        await route.continue();
      });
      await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 8 }));
      const during = await recordFrames(page, 8);
      for (const frame of during) {
        expect(frame.empty).toBe(0);
        expect(frame.level).toBe(child.level);
        // The parent's imagery, upsampled: never the base image and never a hole.
        expect(frame.imageryLevel).toBe(parent.level);
      }
      release();
      await expect.poll(async () => (await centerTile(page)).imageryLevel, { timeout: 10_000 }).toBe(child.level);
      expect((await recordFrames(page, 1))[0]?.empty).toBe(0);
    });

    test('tiles whose levels never arrive show their best ancestor upsampled, marked in the overlay (F083)', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      // Level 9 and finer never answer; level 8 and coarser load normally (zoom 7 draws level-8 tiles here).
      const session = await fixtureSession(page, [{ source: 'levels', minLevel: 9, hang: true }]);
      await openGlobe(
        page,
        `backend=${backend}&imagery=levels&session=${session}&lon=${ROME.lon}&lat=${ROME.lat}&zoom=7&debug=1`,
      );
      await waitForImagery(page);
      for (const zoom of [9, 10, 11, 12]) {
        await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
        for (const frame of await recordFrames(page, 3)) {
          expect(frame.empty).toBe(0);
          expect(frame.imageryLevel).toBe(8);
          expect(frame.level).toBeGreaterThan(8);
        }
      }
      const stats = await page.evaluate(() => window.vibeglobePlayground?.globe.surfaceStats());
      expect(stats?.fromAncestor).toBeGreaterThan(0);
      await expect(page.locator('.vibeglobe-debug-overlay')).toContainText(/imagery from ancestor [1-9]/);
    });

    test('after a jump to a city, the base shows first, then intermediate levels, then the target (F085, F088)', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const session = await fixtureSession(page, [{ source: 'levels', latencyMs: 250 }]);
      await openGlobe(page, `backend=${backend}&imagery=levels&session=${session}&zoom=2`);
      await waitForImagery(page);
      const before = (await requestLog(page, session)).length;
      await page.evaluate(
        ({ lon, lat }) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: lon, latitudeDeg: lat, zoom: 13 }),
        ROME,
      );
      // Record what the center shows, frame by frame, until it shows its own level; every frame complete.
      const shown: number[] = [];
      let target = -1;
      const radius = await silhouetteRadiusPx(page);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        expect(emptyPixelsInside(await canvasImage(page), radius)).toBe(0);
        const center = await centerTile(page);
        target = center.level;
        shown.push(center.imageryLevel ?? -1);
        if (center.imageryLevel === center.level) break;
      }
      // Progressive: never coarser than a level already shown, and the target reached through intermediate levels.
      for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1] ?? -1);
      expect(shown.at(-1)).toBe(target);
      expect(new Set(shown.filter((level) => level >= 0 && level < target)).size).toBeGreaterThanOrEqual(2);
      // Request order after the jump (F088): coarser levels first, and at the target level the center tile first.
      const after = (await requestLog(page, session)).slice(before).sort((a, b) => a.startMs - b.startMs);
      expect(after[0]?.level).toBe(Math.min(...after.map((request) => request.level)));
      const firstTarget = after.findIndex((request) => request.level === target);
      expect(after.slice(0, firstTarget).every((request) => request.level < target)).toBe(true);
      const center = mercatorTile(target, ROME.lon, ROME.lat);
      const targets = after.filter((request) => request.level === target);
      const distance = (r: LoggedRequest): number => Math.hypot(r.x - center.x, r.y - center.y);
      expect(distance(targets[0] ?? { level: 0, x: Infinity, y: Infinity, startMs: 0 })).toBeLessThanOrEqual(
        Math.min(...targets.slice(1).map(distance)) + 1,
      );
    });
  });
}
