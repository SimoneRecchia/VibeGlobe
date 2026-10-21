// Milestone 2 acceptance (F078): a scripted wheel zoom from orbit to about 1 m above Milan on each backend, checking
// every frame for complete imagery and, along the way, frame stability, drag anchoring and finally sub-pixel jitter.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  canvasImage,
  expectCompleteGlobe,
  geoToScreen,
  nextFrame,
  openGlobe,
  screenToGeo,
  waitForIdle,
} from './support/globe.ts';
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

test('no known bug is open at the end of milestone 2 (F078)', () => {
  const rows = readFileSync(new URL('../docs/known-bugs.md', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => /^\| KB-\d+/.test(line));
  expect(rows.length).toBeGreaterThan(0);
  const open = rows.filter((row) => !/^\s*Fixed\b/.test(row.split('|')[4] ?? ''));
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
        await expectAnchoredDrag(page, box);
        await page.mouse.move(box.x + center.xPx, box.y + center.yPx);
      }
    }
    const altitude = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters ?? NaN);
    expect(altitude).toBeGreaterThanOrEqual(0.5);
    expect(altitude).toBeLessThan(1.5);
    await expectStableFrames(page);

    // Sub-millimeter moves at about 1 m: the image follows the projected motion within 0.1 px. The step scales with the
    // altitude so each one moves the image by about a tenth of a pixel, where the shift estimate is linear (as in F057).
    const stepMeters = 0.0002 * (altitude / 0.94);
    const camera = await page.evaluate(() => {
      const state = window.vibeglobePlayground?.globe.camera;
      return { longitudeDeg: state?.longitudeDeg ?? NaN, latitudeDeg: state?.latitudeDeg ?? NaN };
    });
    const base = await canvasImage(page);
    const baseScreen = await geoToScreen(page, camera);
    const metersPerDegree = 111320 * Math.cos((camera.latitudeDeg * Math.PI) / 180);
    for (let step = 1; step <= 4; step++) {
      await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), {
        longitudeDeg: camera.longitudeDeg + (step * stepMeters) / metersPerDegree,
        latitudeDeg: camera.latitudeDeg,
      });
      await waitForIdle(page);
      const shown = await geoToScreen(page, camera);
      const measured = measureShift(base, await canvasImage(page));
      expect(
        Math.hypot(measured.dx - (shown.xPx - baseScreen.xPx), measured.dy - (shown.yPx - baseScreen.yPx)),
      ).toBeLessThan(0.1);
    }
  });
}
