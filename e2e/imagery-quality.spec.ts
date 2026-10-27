import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import {
  GLOBE_GEOMETRY,
  canvasImage,
  nextFrame,
  openGlobe,
  waitForIdle,
  type ScenarioReport,
} from './support/globe.js';
import { fixtureSession, waitForImagery } from './support/imagery.js';

/** M3 increment 7: visual quality of tiled imagery, checked frame by frame in the page (plan §4.2). */

test.describe.configure({ timeout: 300_000 });
test.use({ viewport: { width: 1280, height: 720 } });

/** Mean change per channel and frame allowed under a slow turn (F107): measured clean runs stay far below it. */
const SHIMMER_LIMIT = 4;
/**
 * The `tiles`, `smooth` and base imagery have a channel of at least this everywhere; a pixel inside the globe darker in
 * every channel is a seam line or a gap (F106, F110, F111). The page background is (11, 16, 32).
 */
const DARK_BELOW = 50;

/** Plays a frame-stepped scenario at a fixed 60 Hz engine clock and returns what its detectors found. */
async function record(page: Page, query: string, scenario: string, darkBelow = 0): Promise<ScenarioReport> {
  const session = await fixtureSession(page);
  await openGlobe(page, `session=${session}&clockStepMs=16.666666666666668&${query}`);
  const report = await page.evaluate(([name, dark]) => window.vibeglobePlayground?.recordScenario(name, dark), [
    scenario,
    darkBelow,
  ] as const);
  if (!report) throw new Error('no report');
  console.log(`${scenario} ${query}: ${JSON.stringify(report)}`);
  return report;
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`imagery refinements cross-fade with no pop, hole or black pixel from orbit to street, turning and tilting, on ${backend} (F105, F562, F563)`, async ({
    page,
  }) => {
    // Fixture `levels` pixels have every channel at 40 or more: darker is black or the background (F562).
    const report = await record(page, `backend=${backend}&imagery=levels`, 'zoom-orbit-to-street', 35);
    expect(report.staticFrames).toBeGreaterThan(100);
    expect(report.pops).toBe(0);
    expect(report.holes).toBe(0);
    expect(report.dark).toBe(0);
  });
}

/** Fractional zooms, tilted views and both backends, at device pixel ratios 1 and 2 (F106). */
const SEAM_VIEWS = [
  { lon: 12.5, lat: 41.9, zoom: 3.5, tilt: 0, heading: 0 },
  { lon: 12.5, lat: 41.9, zoom: 6.3, tilt: 0, heading: 20 },
  { lon: -74, lat: 40.7, zoom: 8.7, tilt: 55, heading: 40 },
  { lon: 139.7, lat: 35.7, zoom: 10.4, tilt: 70, heading: 300 },
];

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`tile edges with contrasting colors show no line or seam at fractional zooms, tilts and DPR 2 on ${backend} (F106)`, async ({
    browser,
  }) => {
    // Six views at two pixel ratios on a software GPU: 3.4 min for WebGPU in CI's image, over 5 min on a slow runner.
    test.setTimeout(600_000);
    for (const deviceScaleFactor of [1, 2]) {
      // At DPR 2 a smaller canvas keeps the pixel count, and so the cost, of the DPR 1 run.
      const viewport = deviceScaleFactor === 1 ? { width: 800, height: 600 } : { width: 400, height: 300 };
      const context = await browser.newContext({ deviceScaleFactor, viewport });
      const page = await context.newPage();
      try {
        const session = await fixtureSession(page);
        await openGlobe(page, `backend=${backend}&imagery=tiles&session=${session}`);
        for (const view of SEAM_VIEWS) {
          await page.evaluate(
            (v) =>
              window.vibeglobePlayground?.globe.jumpTo({
                longitudeDeg: v.lon,
                latitudeDeg: v.lat,
                zoom: v.zoom,
                tiltDeg: v.tilt,
                headingDeg: v.heading,
              }),
            view,
          );
          await nextFrame(page);
          await waitForImagery(page);
          const tiles = await page.evaluate(() => window.vibeglobePlayground?.globe.surfaceTiles().length ?? 0);
          // Every pixel of the `tiles` fixture has a channel of 130 or more, its edges blended included: a darker
          // pixel inside the globe is a line, a gap or the background showing through.
          const report = await page.evaluate((dark) => window.vibeglobePlayground?.checkFrame(dark), DARK_BELOW);
          console.log(
            `${backend} DPR ${deviceScaleFactor} zoom ${view.zoom} tilt ${view.tilt}: ${tiles} tiles, ${JSON.stringify(report)}`,
          );
          expect(tiles).toBeGreaterThan(4);
          const where = `zoom ${view.zoom}, tilt ${view.tilt}, DPR ${deviceScaleFactor}`;
          expect([report?.holes, report?.dark], where).toEqual([0, 0]);
        }
      } finally {
        await context.close();
      }
    }
  });
}

/**
 * Mean absolute change per channel between two captures, over the far, minified part of a tilted view (the top third
 * of the canvas): there one pixel covers several texels, so aliasing would show as shimmer.
 */
function meanChange(a: PNG, b: PNG): number {
  let sum = 0;
  let count = 0;
  const end = Math.floor(a.data.length / 12) * 4;
  for (let i = 0; i < end; i += 4) {
    for (let c = 0; c < 3; c++) sum += Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0));
    count += 3;
  }
  return sum / count;
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`minified one-texel stripes do not shimmer while the camera turns slowly on ${backend} (F107)`, async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    // On the globe, as before M5: at this zoom M5's curves show the flat map, where the stripes near the camera are not
    // minified.
    await openGlobe(
      page,
      `backend=${backend}&imagery=stripes&session=${session}&lon=12.5&lat=41.9&zoom=6&tilt=70&${GLOBE_GEOMETRY}`,
    );
    await waitForImagery(page);
    // A slow turn: a twentieth of a degree per frame, so the content moves by under a pixel near the center.
    const changes: number[] = [];
    let previous = await canvasImage(page);
    for (let frame = 1; frame <= 20; frame++) {
      await page.evaluate((h) => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: h }), frame * 0.05);
      await nextFrame(page);
      await waitForIdle(page);
      const image = await canvasImage(page);
      changes.push(meanChange(previous, image));
      previous = image;
    }
    const worst = Math.max(...changes);
    console.log(`${backend} stripes: mean change per frame ${changes.map((c) => c.toFixed(2)).join(' ')}`);
    expect(worst).toBeLessThan(SHIMMER_LIMIT);
  });
}

/** Tile colors of the `patches` fixture (scripts/fixtures/tiles/generate.ts, PATCH_COLORS). */
const PATCH_COLORS = [
  [230, 40, 40],
  [40, 200, 60],
  [50, 70, 230],
  [128, 128, 128],
  [240, 220, 60],
  [60, 200, 220],
  [200, 70, 200],
  [64, 64, 64],
];

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`imagery colors match the sRGB source on ${backend} (F108)`, async ({ page }) => {
    const session = await fixtureSession(page);
    await openGlobe(page, `backend=${backend}&imagery=patches&session=${session}&lon=12.5&lat=41.9&zoom=9`);
    for (const [lon, lat] of [
      [12.5, 41.9],
      [12.9, 41.6],
      [13.3, 42.2],
      [11.8, 42.4],
      [12.2, 41.2],
      [13.6, 41.5],
      [11.5, 41.8],
      [12.7, 42.6],
    ] as const) {
      await page.evaluate(
        ([longitudeDeg, latitudeDeg]) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg, latitudeDeg }),
        [lon, lat] as const,
      );
      await nextFrame(page);
      await waitForImagery(page);
      // The imagery tile under the center pixel, at the level its surface tile draws.
      const center = await page.evaluate(() => {
        const globe = window.vibeglobePlayground?.globe;
        return { tiles: globe?.surfaceTiles() ?? [], position: globe?.screenToGeo({ xPx: 640, yPx: 360 }) };
      });
      const lonDeg = center.position?.longitudeDeg ?? lon;
      const latRad = ((center.position?.latitudeDeg ?? lat) * Math.PI) / 180;
      const mercatorY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
      const surface = center.tiles.find(
        (t) =>
          t.root === 'mercator' &&
          Math.floor(((lonDeg + 180) / 360) * 2 ** t.level) === t.x &&
          Math.floor(mercatorY * 2 ** t.level) === t.y,
      );
      const n = 2 ** (surface?.imageryLevel ?? 0);
      const x = Math.floor(((lonDeg + 180) / 360) * n);
      const y = Math.floor(mercatorY * n);
      const expected = PATCH_COLORS[(x + 3 * y) % PATCH_COLORS.length] ?? [0, 0, 0];
      const image = await canvasImage(page);
      const at = (360 * image.width + 640) * 4;
      const shown = [image.data[at], image.data[at + 1], image.data[at + 2]];
      for (let c = 0; c < 3; c++)
        expect(Math.abs((shown[c] ?? 0) - (expected[c] ?? 0)), `${shown} vs ${expected}`).toBeLessThanOrEqual(3);
    }
  });
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`at device pixel ratio 2 the canvas renders at full resolution with sharper imagery, and a resolution scale of 0.5 halves it without a blank frame on ${backend} (F109)`, async ({
    browser,
  }) => {
    const centerLevels: number[] = [];
    for (const deviceScaleFactor of [1, 2]) {
      const context = await browser.newContext({ deviceScaleFactor, viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      try {
        const session = await fixtureSession(page);
        await openGlobe(page, `backend=${backend}&imagery=world&session=${session}&lon=12.5&lat=41.9&zoom=6.5`);
        await waitForImagery(page);
        const backing = (): Promise<number[]> =>
          page.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>('#globe');
            return [canvas?.width ?? 0, canvas?.height ?? 0, canvas?.clientWidth ?? 0];
          });
        const [width = 0, height = 0, cssWidth = 0] = await backing();
        expect([width, height]).toEqual([cssWidth * deviceScaleFactor, 600 * deviceScaleFactor]);
        // Imagery texels are judged in device pixels: the center shows a finer level at DPR 2.
        centerLevels.push(
          await page.evaluate(() => {
            const tiles = window.vibeglobePlayground?.globe.surfaceTiles() ?? [];
            return Math.max(...tiles.map((t) => t.imageryLevel ?? -1));
          }),
        );
        if (deviceScaleFactor !== 2) continue;
        await page.evaluate(() => window.vibeglobePlayground?.globe.setResolutionScale(0.5));
        // The first frame drawn after the change is complete: the view covers the canvas and no pixel is transparent.
        const image = await canvasImage(page);
        expect([image.width, image.height]).toEqual([cssWidth, 600]);
        expect(await backing()).toEqual([cssWidth, 600, cssWidth]);
        let transparent = 0;
        for (let i = 3; i < image.data.length; i += 4) if ((image.data[i] ?? 0) < 255) transparent++;
        expect(transparent).toBe(0);
      } finally {
        await context.close();
      }
    }
    expect(centerLevels[1]).toBe((centerLevels[0] ?? 0) + 1);
  });
}

test.describe('poles and antimeridian', () => {
  // A smaller canvas: every frame of the scenario is checked pixel by pixel.
  test.use({ viewport: { width: 800, height: 600 } });

  for (const backend of ['webgpu', 'webgl2'] as const) {
    test(`the polar caps join the imagery at ±85° with no gap or seam while circling both poles on ${backend} (F110)`, async ({
      page,
    }) => {
      const report = await record(page, `backend=${backend}&imagery=smooth`, 'pole-orbit', DARK_BELOW);
      expect(report.holes).toBe(0);
      expect(report.dark).toBe(0);
    });

    test(`the antimeridian shows no gap or seam while panning across it at several zooms and tilts on ${backend} (F111)`, async ({
      page,
    }) => {
      const report = await record(page, `backend=${backend}&imagery=smooth`, 'antimeridian-pan', DARK_BELOW);
      expect(report.holes).toBe(0);
      expect(report.dark).toBe(0);
    });
  }
});
