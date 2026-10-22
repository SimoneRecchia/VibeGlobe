// Milestone 2 acceptance (F078): a scripted wheel zoom from orbit to about 1 m above Milan on each backend, checking
// every frame for complete imagery and, along the way, frame stability, sub-pixel jitter and drag anchoring.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { DebugShape } from '@vibeglobe/core';
import {
  canvasImage,
  expectCompleteGlobe,
  geoToScreen,
  nextFrame,
  openGlobe,
  screenToGeo,
  waitForIdle,
} from './support/globe.ts';
import { parallelQuad, type Quad } from './support/geodesy.ts';
import { measureShift } from './support/image.ts';

const MILAN = { longitudeDeg: 9.19, latitudeDeg: 45.46 };
const WHEEL_STEPS = 80;

/** Renders a few more frames of an unchanged view and checks that every pixel stays the same. */
async function expectStableFrames(page: Page): Promise<void> {
  await waitForIdle(page);
  const first = await canvasImage(page);
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.vibeglobePlayground?.globe.requestRender());
    await waitForIdle(page);
    expect(Buffer.compare((await canvasImage(page)).data, first.data)).toBe(0);
  }
}

/**
 * Lays two quads under the camera target, red above blue, `gapMeters` apart along their common normal, the red one
 * larger, and counts blue pixels in the frame and after each of three camera moves of about a tenth of a pixel. The
 * blue quad is drawn last, so where the two depths come out equal the lower quad wins: any blue pixel means the depth
 * buffer could not keep them apart. Clears the quads and returns the counts.
 */
async function bluePixelsUnderRed(page: Page, gapMeters: number): Promise<number[]> {
  await waitForIdle(page);
  const camera = await page.evaluate(() => {
    const state = window.vibeglobePlayground?.globe.camera;
    return {
      longitudeDeg: state?.longitudeDeg ?? NaN,
      latitudeDeg: state?.latitudeDeg ?? NaN,
      altitudeMeters: state?.altitudeMeters ?? NaN,
    };
  });
  const metersPerDegree = 111320 * Math.cos((camera.latitudeDeg * Math.PI) / 180);
  const halfWidthMeters = camera.altitudeMeters / 4;
  // The red quad's corners lie this high, so its center, a chord sag lower, stays above the ground with the blue one.
  const heightMeters =
    (2 * halfWidthMeters) ** 2 / (8 * 6371000) + gapMeters + Math.min(1, camera.altitudeMeters / 100);
  const dLat = halfWidthMeters / 111320;
  const dLon = halfWidthMeters / metersPerDegree;
  const { longitudeDeg: lon, latitudeDeg: lat } = camera;
  const red: Quad = [
    { longitudeDeg: lon - dLon, latitudeDeg: lat - dLat, heightMeters },
    { longitudeDeg: lon + dLon, latitudeDeg: lat - dLat, heightMeters },
    { longitudeDeg: lon + dLon, latitudeDeg: lat + dLat, heightMeters },
    { longitudeDeg: lon - dLon, latitudeDeg: lat + dLat, heightMeters },
  ];
  // The blue quad lies in the red quad's plane moved down along its normal by the gap, inset to 80%.
  const blue = parallelQuad(red, 0.8, gapMeters);
  await page.evaluate((shapes) => window.vibeglobePlayground?.globe.setDebugShapes(shapes), [
    { corners: red, colorRgb: [1, 0, 0] },
    { corners: blue, colorRgb: [0, 0, 1] },
  ] satisfies DebugShape[]);
  const bluePixels = async (): Promise<number> => {
    const image = await canvasImage(page);
    let count = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if ((image.data[i + 2] ?? 0) > 200 && (image.data[i] ?? 0) < 40 && (image.data[i + 1] ?? 0) < 40) count++;
    return count;
  };
  const counts = [await bluePixels()];
  const target = { longitudeDeg: camera.longitudeDeg, latitudeDeg: camera.latitudeDeg };
  const baseScreen = await geoToScreen(page, target);
  const east = await geoToScreen(page, { ...target, longitudeDeg: target.longitudeDeg + 1 / metersPerDegree });
  const stepMeters = 0.1 / Math.hypot(east.xPx - baseScreen.xPx, east.yPx - baseScreen.yPx);
  for (let step = 1; step <= 3; step++) {
    await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), {
      longitudeDeg: camera.longitudeDeg + (step * stepMeters) / metersPerDegree,
      latitudeDeg: camera.latitudeDeg,
    });
    counts.push(await bluePixels());
  }
  await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), target);
  await page.evaluate(() => window.vibeglobePlayground?.globe.setDebugShapes([]));
  await waitForIdle(page);
  return counts;
}

/**
 * No z-fighting at this distance: a quad pair a few millionths of the eye's distance apart (about 50 times the depth
 * resolution there) shows no blue pixel, still or under sub-pixel moves.
 */
async function expectNoZFighting(page: Page): Promise<void> {
  const altitude = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters ?? NaN);
  const counts = await bluePixelsUnderRed(page, Math.max(0.01, 3e-6 * altitude));
  expect(counts, `z-fighting at ${altitude} m (blue pixels, still and after three sub-pixel moves)`).toEqual([
    0, 0, 0, 0,
  ]);
}

/** The detector's own check (ADR 0012): the same quads with no gap show blue, so a depth failure would not go unseen. */
async function expectZFightingDetected(page: Page): Promise<void> {
  const counts = await bluePixelsUnderRed(page, 0);
  expect(Math.min(...counts), 'blue pixels of a coplanar quad pair').toBeGreaterThan(0);
}

/** Drags from the canvas center and checks the grabbed point stays under the pointer, then drags back. */
async function expectAnchoredDrag(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const from = { xPx: box.width / 2, yPx: box.height / 2 };
  const to = { xPx: from.xPx + 60, yPx: from.yPx + 25 };
  const grabbed = await screenToGeo(page, from);
  if (!grabbed) throw new Error('center off the globe');
  await page.mouse.move(box.x + from.xPx, box.y + from.yPx);
  await page.mouse.down();
  await page.mouse.move(box.x + to.xPx, box.y + to.yPx, { steps: 4 });
  await nextFrame(page);
  const shown = await geoToScreen(page, grabbed);
  expect(Math.hypot(shown.xPx - to.xPx, shown.yPx - to.yPx)).toBeLessThan(1);
  await page.mouse.move(box.x + from.xPx, box.y + from.yPx, { steps: 4 });
  await page.mouse.up();
}

/**
 * Lays a checkered quad as wide as the eye is high under the camera (its vertices are float32 offsets of the same
 * magnitude as a surface tile's at this altitude, and its pattern gives the shift estimate something to follow where
 * the pinned imagery is smooth), moves the camera east in steps of about a tenth of a pixel and checks that the image
 * follows the projected motion within 0.1 px (no vertex jitter), then returns to the starting view.
 */
async function expectNoJitter(page: Page): Promise<void> {
  await waitForIdle(page);
  const camera = await page.evaluate(() => {
    const state = window.vibeglobePlayground?.globe.camera;
    return {
      longitudeDeg: state?.longitudeDeg ?? NaN,
      latitudeDeg: state?.latitudeDeg ?? NaN,
      altitudeMeters: state?.altitudeMeters ?? NaN,
    };
  });
  const metersPerDegree = 111320 * Math.cos((camera.latitudeDeg * Math.PI) / 180);
  const halfWidthMeters = camera.altitudeMeters / 2;
  // Raised by its chord sag plus a margin, so the planar quad lies above the curved ground everywhere.
  const heightMeters = (2 * halfWidthMeters) ** 2 / (8 * 6371000) + Math.min(1, camera.altitudeMeters / 100);
  const dLat = halfWidthMeters / 111320;
  const dLon = halfWidthMeters / metersPerDegree;
  await page.evaluate(
    ({ lon, lat, dLon, dLat, heightMeters, checkerMeters }) =>
      window.vibeglobePlayground?.globe.setDebugShapes([
        {
          corners: [
            { longitudeDeg: lon - dLon, latitudeDeg: lat - dLat, heightMeters },
            { longitudeDeg: lon + dLon, latitudeDeg: lat - dLat, heightMeters },
            { longitudeDeg: lon + dLon, latitudeDeg: lat + dLat, heightMeters },
            { longitudeDeg: lon - dLon, latitudeDeg: lat + dLat, heightMeters },
          ],
          colorRgb: [0.95, 0.9, 0.2],
          checkerMeters,
        },
      ]),
    {
      lon: camera.longitudeDeg,
      lat: camera.latitudeDeg,
      dLon,
      dLat,
      heightMeters,
      checkerMeters: (2 * halfWidthMeters) / 30,
    },
  );
  await waitForIdle(page);
  const target = { longitudeDeg: camera.longitudeDeg, latitudeDeg: camera.latitudeDeg };
  const baseScreen = await geoToScreen(page, target);
  const east = await geoToScreen(page, { ...target, longitudeDeg: target.longitudeDeg + 1 / metersPerDegree });
  const pxPerMeter = Math.hypot(east.xPx - baseScreen.xPx, east.yPx - baseScreen.yPx);
  const stepMeters = 0.1 / pxPerMeter;
  const base = await canvasImage(page);
  for (let step = 1; step <= 3; step++) {
    await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), {
      longitudeDeg: camera.longitudeDeg + (step * stepMeters) / metersPerDegree,
      latitudeDeg: camera.latitudeDeg,
    });
    await waitForIdle(page);
    const shown = await geoToScreen(page, target);
    const measured = measureShift(base, await canvasImage(page));
    expect(
      Math.hypot(measured.dx - (shown.xPx - baseScreen.xPx), measured.dy - (shown.yPx - baseScreen.yPx)),
      `jitter at step ${step}, ${JSON.stringify(await page.evaluate(() => window.vibeglobePlayground?.globe.camera))}, measured ${JSON.stringify(measured)}, expected ${shown.xPx - baseScreen.xPx}, ${shown.yPx - baseScreen.yPx}`,
    ).toBeLessThan(0.1);
  }
  await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), {
    longitudeDeg: camera.longitudeDeg,
    latitudeDeg: camera.latitudeDeg,
  });
  await waitForIdle(page);
}

test('no known bug is open at the end of milestone 2 (F078)', () => {
  const rows = readFileSync(new URL('../docs/known-bugs.md', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => /^\| KB-\d+/.test(line));
  expect(rows.length).toBeGreaterThan(0);
  // A bug found in a later milestone stays open until that milestone ends: its status names it, "Open (M5)".
  const open = rows.filter((row) => {
    const status = row.split('|')[4] ?? '';
    const later = /^\s*Open \(M(\d+)\)/.exec(status);
    return !/^\s*Fixed\b/.test(status) && !(later && Number(later[1]) > 2);
  });
  expect(open).toEqual([]);
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`zooming from orbit to about 1 m shows no jitter, no z-fighting and complete imagery on ${backend} (F078)`, async ({
    page,
  }) => {
    // Every wheel step is drawn and checked by a software rasterizer in CI.
    test.setTimeout(420_000);
    // The checkered street-level quad is placed under the initial target, where the zoom ends.
    await openGlobe(
      page,
      `backend=${backend}&scenario=street-level-jitter&lon=${MILAN.longitudeDeg}&lat=${MILAN.latitudeDeg}&zoom=2`,
    );
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    const center = { xPx: box.width / 2, yPx: box.height / 2 };
    await page.mouse.move(box.x + center.xPx, box.y + center.yPx);
    for (let step = 1; step <= WHEEL_STEPS; step++) {
      await page.mouse.wheel(0, -100);
      // Every frame of the zoom: the imagery is complete.
      await expectCompleteGlobe(page);
      if (step % 20 === 0) {
        await expectStableFrames(page);
        await expectNoZFighting(page);
        if (step === 20) await expectZFightingDetected(page);
        // Along the zoom, where large tiles make the low part of the eye offset matter (ADR 0004).
        await expectNoJitter(page);
        await expectAnchoredDrag(page, box);
        await page.mouse.move(box.x + center.xPx, box.y + center.yPx);
      }
    }
    const altitude = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters ?? NaN);
    expect(altitude).toBeGreaterThanOrEqual(0.5);
    expect(altitude).toBeLessThan(1.5);
    await expectStableFrames(page);
    await expectNoZFighting(page);
    // Sub-millimeter moves at about 1 m, over the checkered quad: the image follows within 0.1 px.
    await expectNoJitter(page);
  });
}
