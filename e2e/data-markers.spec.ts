// Markers (M10, F352): images face the screen under any heading and tilt, with their anchors on their coordinates
// within a pixel, their sizes and pixel offsets, and every image of a layer drawn from one atlas in one draw call.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const BUDGET = (
  JSON.parse(readFileSync('quality/budgets.json', 'utf8')) as { dataLayers: { markerDrawCallsPerLayer: number } }
).dataLayers;

type Rgb = [number, number, number];
const isRed = ([r, g, b]: Rgb): boolean => r > 180 && g < 90 && b < 90;
const isBlue = ([r, g, b]: Rgb): boolean => b > 180 && r < 90 && g < 120;

/** The box of pixels passing `test` within `half` pixels of a point. */
function boxOf(image: PNG, at: { xPx: number; yPx: number }, half: number, test: (c: Rgb) => boolean) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = Math.round(at.yPx) - half; y <= Math.round(at.yPx) + half; y++)
    for (let x = Math.round(at.xPx) - half; x <= Math.round(at.xPx) + half; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * 4;
      if (!test([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0])) continue;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
    }
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

async function screen(page: Page, lon: number, lat: number) {
  const p = await page.evaluate(
    ([longitudeDeg, latitudeDeg]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: longitudeDeg ?? 0, latitudeDeg: latitudeDeg ?? 0 }),
    [lon, lat],
  );
  if (!p) throw new Error(`${lon}, ${lat} off screen`);
  return p;
}

for (const backend of BACKENDS) {
  test(`markers face the screen with their anchors, sizes and offsets on their coordinates under any heading and tilt, in one draw call per layer, on ${backend} (F352)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&scenario=data-markers`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    for (const [headingDeg, tiltDeg] of [
      [0, 0],
      [120, 0],
      [0, 50],
      [250, 45],
    ] as const) {
      const label = `heading ${headingDeg}°, tilt ${tiltDeg}°`;
      await page.evaluate(
        ({ headingDeg, tiltDeg }) => {
          const globe = window.vibeglobePlayground?.globe;
          globe?.setViewMode(tiltDeg > 0 ? '3d' : '2d');
          globe?.jumpTo({ longitudeDeg: 13.3, latitudeDeg: 41.3, zoom: 7, headingDeg, tiltDeg });
        },
        { headingDeg, tiltDeg },
      );
      await page.waitForTimeout(500);
      await waitForIdle(page);
      const image = await canvasImage(page);
      // m3: a 24 px square anchored at its center, upright on the screen whatever the heading and tilt.
      const m3 = await screen(page, 13.0, 40.9);
      const square = boxOf(image, m3, 30, isBlue);
      expect(Math.abs((square.x0 + square.x1) / 2 - m3.xPx), `${label}: m3 center x`).toBeLessThanOrEqual(1);
      expect(Math.abs((square.y0 + square.y1) / 2 - m3.yPx), `${label}: m3 center y`).toBeLessThanOrEqual(1);
      expect(Math.abs(square.width - 24), `${label}: m3 width ${square.width}`).toBeLessThanOrEqual(1);
      expect(Math.abs(square.height - 24), `${label}: m3 height ${square.height}`).toBeLessThanOrEqual(1);
      // m5: a 48 px square anchored at its top-left corner.
      const m5 = await screen(page, 12.9, 41.5);
      const big = boxOf(image, { xPx: m5.xPx + 24, yPx: m5.yPx + 24 }, 30, isBlue);
      expect(Math.abs(big.x0 - m5.xPx), `${label}: m5 left`).toBeLessThanOrEqual(1);
      expect(Math.abs(big.y0 - m5.yPx), `${label}: m5 top`).toBeLessThanOrEqual(1);
      expect(Math.abs(big.width - 48), `${label}: m5 width ${big.width}`).toBeLessThanOrEqual(1);
      // m4: a 16 px pin anchored at its bottom: its tip on the coordinate.
      const m4 = await screen(page, 13.6, 41.8);
      const pin = boxOf(image, { xPx: m4.xPx, yPx: m4.yPx - 8 }, 14, isRed);
      // Its round top 15.5 px above the tip (31 of the image's 32 rows, at half size): the tip is a sharp,
      // antialiased point, so the top is measured.
      expect(Math.abs(pin.y0 - (m4.yPx - 15.5)), `${label}: m4 top ${pin.y0}`).toBeLessThanOrEqual(1);
      expect(Math.abs(pin.height - 16), `${label}: m4 height ${pin.height}`).toBeLessThanOrEqual(2);
      // m6: a 32 px pin raised 12 px by its offset.
      const m6 = await screen(page, 14.0, 41.5);
      const raised = boxOf(image, { xPx: m6.xPx, yPx: m6.yPx - 28 }, 26, isRed);
      // The pin's round top is 31 px above its tip at 32 px (the image's circle starts one row down); the tip itself
      // is a sharp, antialiased point, so the top is measured.
      expect(Math.abs(raised.y0 - (m6.yPx - 12 - 31)), `${label}: m6 offset top ${raised.y0}`).toBeLessThanOrEqual(1);
    }
    // Every image of the layer comes from one atlas: the whole layer is one draw call.
    const drawCalls = async (visible: boolean) => {
      await page.evaluate((v) => window.vibeglobeLayers?.layers['markers']?.setVisible(v), visible);
      await page.waitForTimeout(300);
      await waitForIdle(page);
      return page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats().drawCalls ?? NaN);
    };
    const hidden = await drawCalls(false);
    const shown = await drawCalls(true);
    expect(shown - hidden).toBeLessThanOrEqual(BUDGET.markerDrawCallsPerLayer);
    expect(shown - hidden).toBeGreaterThan(0);
  });
}
