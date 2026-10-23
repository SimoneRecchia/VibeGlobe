// Data-driven styles of data layers in the browser (M10, F369): color, size, width, opacity, icon and text from feature
// properties through expressions, and a live property update restyling a feature in the next frame without a rebuild.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, nextFrame, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const CLOCK = 'clockStepMs=16.666666666666668';

type Rgb = [number, number, number];
const isRed = ([r, g, b]: Rgb): boolean => r > 180 && g < 90 && b < 90;
const isBlue = ([r, g, b]: Rgb): boolean => b > 180 && r < 90 && g < 120;
const isGreen = ([r, g, b]: Rgb): boolean => g > 140 && r < 120 && b < 120;
const isYellow = ([r, g, b]: Rgb): boolean => r > 200 && g > 170 && b < 90;

function pixel(image: PNG, xPx: number, yPx: number): Rgb {
  const at = (Math.round(yPx) * image.width + Math.round(xPx)) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

function count(image: PNG, x0: number, y0: number, x1: number, y1: number, test: (rgb: Rgb) => boolean): number {
  let n = 0;
  for (let y = Math.round(y0); y <= Math.round(y1); y++)
    for (let x = Math.round(x0); x <= Math.round(x1); x++) if (test(pixel(image, x, y))) n++;
  return n;
}

async function screen(page: Page, lon: number, lat: number): Promise<{ xPx: number; yPx: number }> {
  const point = await page.evaluate(
    ([longitudeDeg, latitudeDeg]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: longitudeDeg ?? 0, latitudeDeg: latitudeDeg ?? 0 }),
    [lon, lat],
  );
  if (!point) throw new Error(`${lon}, ${lat} off screen`);
  return point;
}

for (const backend of BACKENDS) {
  test(`color, size, width, opacity, icon and text follow each feature's properties, and a property update restyles it in the next frame on ${backend} (F369)`, async ({
    page,
  }) => {
    await openGlobe(page, `${CLOCK}&backend=${backend}&scenario=data-styled`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      globe?.setViewMode('2d');
      globe?.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.7, zoom: 7 });
    });
    for (let i = 0; i < 30; i++) await nextFrame(page);
    await waitForIdle(page);
    const image = await canvasImage(page);
    // Color by category, radius from a number (pop / 2 = 5 and 15 px), opacity from a number (40 %).
    const s1 = await screen(page, 12.0, 42.3);
    const s2 = await screen(page, 12.6, 42.3);
    const s3 = await screen(page, 13.2, 42.3);
    expect(isRed(pixel(image, s1.xPx, s1.yPx)), 'hot is red').toBe(true);
    expect(isBlue(pixel(image, s2.xPx, s2.yPx)), 'cold is blue').toBe(true);
    expect(isRed(pixel(image, s1.xPx + 8, s1.yPx)), 'radius 5 px').toBe(false);
    expect(isBlue(pixel(image, s2.xPx + 12, s2.yPx)), 'radius 15 px').toBe(true);
    const opaque = pixel(image, s1.xPx, s1.yPx);
    const faded = pixel(image, s3.xPx, s3.yPx);
    expect(
      Math.abs(opaque[0] - faded[0]) + Math.abs(opaque[1] - faded[1]),
      `40 % opacity: ${String(faded)}`,
    ).toBeGreaterThan(60);
    // Width from a number: green pixels across each line, 2 and 10 px.
    const thin = await screen(page, 12.1, 41.7);
    const wide = await screen(page, 13.1, 41.7);
    const across = (at: { xPx: number; yPx: number }) =>
      count(image, at.xPx, at.yPx - 12, at.xPx, at.yPx + 12, isGreen);
    expect(across(thin), 'thin line').toBeGreaterThanOrEqual(1);
    expect(across(thin), 'thin line').toBeLessThanOrEqual(3);
    expect(across(wide), 'wide line').toBeGreaterThanOrEqual(9);
    expect(across(wide), 'wide line').toBeLessThanOrEqual(11);
    // Icon from a category (the red pin, the blue square, anchored at their centers), text from a string.
    const m1 = await screen(page, 12.0, 41.1);
    const m2 = await screen(page, 12.6, 41.1);
    const t1 = await screen(page, 13.2, 41.1);
    expect(count(image, m1.xPx - 12, m1.yPx - 12, m1.xPx + 12, m1.yPx + 12, isRed), 'pin').toBeGreaterThan(40);
    expect(count(image, m1.xPx - 12, m1.yPx - 12, m1.xPx + 12, m1.yPx + 12, isBlue), 'no square at the pin').toBe(0);
    expect(count(image, m2.xPx - 12, m2.yPx - 12, m2.xPx + 12, m2.yPx + 12, isBlue), 'square').toBeGreaterThan(200);
    expect(count(image, t1.xPx - 40, t1.yPx - 15, t1.xPx + 40, t1.yPx + 15, isYellow), 'text').toBeGreaterThan(20);
    // A live update: s1 becomes cold, shown in the next frame without rebuilding the layer.
    const rebuilds = () => page.evaluate(() => window.vibeglobePlayground?.globe.layerTarget()?.stats?.().rebuilds);
    const before = await rebuilds();
    await page.evaluate(() =>
      window.vibeglobeLayers?.layers['styled-points']?.updateFeature('s1', {
        properties: { kind: 'cold', pop: 10, op: 100 },
      }),
    );
    await nextFrame(page);
    await nextFrame(page);
    const updated = await canvasImage(page);
    expect(isBlue(pixel(updated, s1.xPx, s1.yPx)), 'restyled').toBe(true);
    expect(await rebuilds()).toBe(before);
  });
}
