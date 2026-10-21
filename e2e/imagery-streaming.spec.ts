import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasImage, emptyPixelsInside, nextFrame, openGlobe, silhouetteRadiusPx } from './support/globe.js';
import {
  centerTile,
  fixtureSession,
  mercatorTile,
  requestLog,
  waitForImagery,
  type LoggedRequest,
} from './support/imagery.js';

// Streaming over the software GPU is slow: the context set-up counts against the timeout too.
test.describe.configure({ timeout: 120_000 });

/** M3's streaming slice (docs/plan/m3-imagery-streaming.md, increment 3b) against the playground's fixture tiles. */

const ROME = { lon: 12.5, lat: 41.9 };

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
      // The tiles of the frame drawn for the tilted camera, not those of the last flat frame.
      await nextFrame(page);
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
      const session = await fixtureSession(page);
      const query = `backend=${backend}&imagery=levels&session=${session}&lon=${ROME.lon}&lat=${ROME.lat}&zoom=7`;
      // A first visit finds the center tile's level; the second one holds every tile under the center below it
      // (Playwright route interception, as the step asks), in place before the page opens because the next level under
      // the center is prefetched at once (F088).
      await openGlobe(page, query);
      await waitForImagery(page);
      const { level } = await centerTile(page);
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      await page.route(/\/levels\/mercator\/\d+\/\d+\/\d+\.png/, async (route) => {
        const [z = 0, x, y] = (new URL(route.request().url()).pathname.match(/(\d+)\/(\d+)\/(\d+)\.png$/) ?? [])
          .slice(1)
          .map(Number);
        const center = mercatorTile(z, ROME.lon, ROME.lat);
        if (z > level && x === center.x && y === center.y) await released;
        await route.continue();
      });
      await openGlobe(page, query);
      await waitForImagery(page);
      const parent = await centerTile(page);
      expect(parent.imageryLevel).toBe(parent.level);
      const child = { level: parent.level + 1 };
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
      const session = await fixtureSession(page, [{ source: 'levels', latencyMs: 250 }]);
      await openGlobe(page, `backend=${backend}&imagery=levels&session=${session}&zoom=2`);
      await waitForImagery(page);
      const before = (await requestLog(page, session)).length;
      // The page records the level and the imagery level of the center tile at every drawn frame.
      await page.evaluate(() => {
        const globe = window.vibeglobePlayground?.globe;
        const host = document.querySelector('#globe');
        const record: [number, number][] = [];
        (window as unknown as { centerLevels: [number, number][] }).centerLevels = record;
        globe?.on('frame', () => {
          const center = globe.screenToGeo({ xPx: (host?.clientWidth ?? 0) / 2, yPx: (host?.clientHeight ?? 0) / 2 });
          const tile = globe
            .surfaceTiles()
            .find(
              (t) =>
                center &&
                t.westDeg <= center.longitudeDeg &&
                center.longitudeDeg <= t.eastDeg &&
                t.southDeg <= center.latitudeDeg &&
                center.latitudeDeg <= t.northDeg,
            );
          if (tile) record.push([tile.level, tile.imageryLevel ?? -1]);
        });
      });
      await page.evaluate(
        ({ lon, lat }) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: lon, latitudeDeg: lat, zoom: 13 }),
        ROME,
      );
      // Frames are captured while the detail arrives: every one is complete.
      const radius = await silhouetteRadiusPx(page);
      const recorded = (): Promise<[number, number][]> =>
        page.evaluate(() => (window as unknown as { centerLevels: [number, number][] }).centerLevels);
      const deadline = Date.now() + 90_000;
      for (;;) {
        expect(emptyPixelsInside(await canvasImage(page), radius)).toBe(0);
        const last = (await recorded()).at(-1);
        if ((last && last[0] === last[1]) || Date.now() > deadline) break;
      }
      const frames = await recorded();
      const target = frames.at(-1)?.[0] ?? -1;
      const shown = frames.map(([, imageryLevel]) => imageryLevel);
      // Progressive: never coarser than a level already shown, and the target reached through intermediate levels.
      for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1] ?? -1);
      expect(shown[0]).toBeLessThan(target - 4);
      expect(shown.at(-1)).toBe(target);
      expect(new Set(shown.filter((level) => level >= 0 && level < target)).size).toBeGreaterThanOrEqual(2);
      // Request order after the jump (F088): coarser levels first, and at the target level the center tile first. The
      // prefetch of the next level starts after the visible tiles, so the log is read once it has started.
      await expect
        .poll(async () => (await requestLog(page, session)).slice(before).some((r) => r.level === target + 1))
        .toBe(true);
      const after = (await requestLog(page, session)).slice(before).sort((a, b) => a.startMs - b.startMs);
      expect(after[0]?.level).toBe(Math.min(...after.map((request) => request.level)));
      const firstTarget = after.findIndex((request) => request.level === target);
      expect(after.slice(0, firstTarget).every((request) => request.level < target)).toBe(true);
      const center = mercatorTile(target, ROME.lon, ROME.lat);
      const targets = after.filter((request) => request.level === target);
      const distance = (r: Pick<LoggedRequest, 'x' | 'y'>): number => Math.hypot(r.x - center.x, r.y - center.y);
      expect(distance(targets[0] ?? { x: Infinity, y: Infinity })).toBeLessThanOrEqual(
        Math.min(...targets.slice(1).map(distance)) + 1,
      );
      // Visible before prefetch: the next level under the center (ADR 0007 class 4) starts after every visible tile.
      const prefetch = after.filter((request) => request.level === target + 1);
      expect(prefetch.length).toBeGreaterThan(0);
      const lastVisible = Math.max(...after.filter((request) => request.level <= target).map((r) => r.startMs));
      for (const request of prefetch) expect(request.startMs).toBeGreaterThanOrEqual(lastVisible);
    });
  });
}

test('image decoding runs off the main thread while imagery streams, with no long decode task there (F099)', async ({
  page,
  browser,
}, testInfo) => {
  const session = await fixtureSession(page);
  const tracePath = testInfo.outputPath('trace.json');
  await browser.startTracing(page, {
    path: tracePath,
    categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', '__metadata'],
  });
  await openGlobe(page, `imagery=levels&session=${session}&lon=${ROME.lon}&lat=${ROME.lat}&zoom=7`);
  await waitForImagery(page);
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 9 }));
  await waitForImagery(page);
  // Prefetched tiles (F088) may still be on their way: trace until every request has ended, then count the tiles that
  // arrived (a request cancelled on the way decodes nothing).
  await expect.poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.imageryStats().loading)).toBe(0);
  await browser.stopTracing();
  const tiles = (await requestLog(page, session)).filter((r) => r.status === 200 && !r.aborted).length;
  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as {
    traceEvents: { name: string; pid: number; tid: number; dur?: number; args?: { name?: string } }[];
  };
  const threads = new Map<string, string>();
  for (const event of trace.traceEvents)
    if (event.name === 'thread_name') threads.set(`${event.pid}:${event.tid}`, event.args?.name ?? '');
  const thread = (event: { pid: number; tid: number }): string => threads.get(`${event.pid}:${event.tid}`) ?? '';
  const decodes = trace.traceEvents.filter((event) => event.name === 'Decode Image');
  // Every tile was decoded somewhere off the main thread, and the decode tasks were run by the engine's worker.
  expect(decodes.filter((event) => thread(event) !== 'CrRendererMain').length).toBeGreaterThanOrEqual(tiles);
  const workerCalls = trace.traceEvents.filter(
    (event) => event.name === 'FunctionCall' && thread(event).startsWith('DedicatedWorker'),
  );
  expect(workerCalls.length).toBeGreaterThanOrEqual(tiles);
  // Nothing decodes on the main thread, the world base image included.
  expect(decodes.filter((event) => thread(event) === 'CrRendererMain').map((event) => event.dur)).toEqual([]);
});
