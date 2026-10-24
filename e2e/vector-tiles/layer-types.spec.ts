// F445: every layer type of the pinned style specification (26.4.4, v8; ADR 0041) renders, from one fixture style per
// type (apps/playground/public/vector-tiles/styles/type-*.json): views compared with their baselines on both backends
// (hook request D (3)), and line (width, dasharray, cap, join, gradient) and fill (pattern, outline, opacity)
// properties checked as specified, with the raster, hillshade and heatmap images (ADR 0133).
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { expectMatchesBaseline } from '../support/visual.ts';
import { BACKENDS, capture, countColor, hex, near, openVector, rgbAt } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** One view per layer type: the flat map over the fixture data that type draws. */
const VIEWS: Readonly<Record<string, string>> = {
  background: 'zoom=12&lon=9.19&lat=45.465',
  fill: 'zoom=14&lon=9.176&lat=45.47',
  line: 'zoom=13&lon=9.185&lat=45.468',
  symbol: 'zoom=14.6&lon=9.218&lat=45.4568',
  circle: 'zoom=13.5&lon=9.19&lat=45.465',
  'fill-extrusion': 'zoom=15&lon=9.19&lat=45.465',
  raster: 'zoom=3.5&lon=10&lat=45',
  hillshade: 'zoom=11&lon=6.86&lat=45.7',
  heatmap: 'zoom=13.5&lon=9.19&lat=45.465',
};

async function open(page: Page, type: string, backend = 'webgl2', view = VIEWS[type] ?? ''): Promise<PNG> {
  await openVector(page, `vectorStyle=type-${type}&backend=${backend}&viewMode=2d&${view}`);
  return capture(page);
}

async function screenOf(page: Page, longitudeDeg: number, latitudeDeg: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((g) => window.vibeglobePlayground?.globe.geoToScreen(g), { longitudeDeg, latitudeDeg });
  if (p === undefined) throw new Error('off screen');
  return { x: Math.round(p.xPx), y: Math.round(p.yPx) };
}

const WHITE = [255, 255, 255];

for (const backend of BACKENDS) {
  test(`every layer type renders and matches its baseline (${backend}, F445) @baseline`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    for (const type of Object.keys(VIEWS)) {
      const image = await open(page, type, backend);
      await expectMatchesBaseline(page, testInfo, `mvt-type-${type}-${backend}.png`, image);
    }
  });

  test(`every layer type draws (${backend}, F445)`, async ({ page }) => {
    test.setTimeout(240_000);
    for (const type of Object.keys(VIEWS)) {
      const image = await open(page, type, backend);
      const problems = await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.style.problems ?? []);
      expect(problems, type).toEqual([]);
      // More than the background: a tenth of the view at least differs from its first pixel's color.
      const first = rgbAt(image, 0, 0);
      expect(image.width * image.height - countColor(image, first, 6), type).toBeGreaterThan(
        type === 'background' ? -1 : image.width * image.height * 0.02,
      );
    }
  });
}

test('line width, dasharray, round caps and a line-gradient render as specified (F445)', async ({ page }) => {
  const image = await open(page, 'line');
  // The gradient runs from blue at its start to red at its end (GeoJSON source with lineMetrics).
  // Points at about 36 % and 76 % of the route.
  const start = await screenOf(page, 9.1775, 45.471);
  const end = await screenOf(page, 9.195, 45.4687);
  const a = rgbAt(image, start.x, start.y);
  const b = rgbAt(image, end.x, end.y);
  expect((a[2] ?? 0) > (a[0] ?? 0), `start ${a.join()}`).toBe(true);
  expect((b[0] ?? 0) > (b[2] ?? 0), `end ${b.join()}`).toBe(true);
  // 8 px wide: across it, about 8 pixels of the gradient's colors.
  let across = 0;
  const mid = await screenOf(page, 9.1825, 45.469);
  for (let dy = -12; dy <= 12; dy++) if (!near(rgbAt(image, mid.x, mid.y + dy), WHITE, 40)) across++;
  expect(across).toBeGreaterThanOrEqual(7);
  expect(across).toBeLessThanOrEqual(12);
  // Dashes: along a dashed path (#606060) gray and white alternate, so some row or column crosses many dash ends.
  const gray = (x: number, y: number) => near(rgbAt(image, x, y), [96, 96, 96], 30);
  let most = 0;
  for (let y = 0; y < image.height; y++) {
    let switches = 0;
    for (let x = 1; x < image.width; x++) if (gray(x, y) !== gray(x - 1, y)) switches++;
    most = Math.max(most, switches);
  }
  for (let x = 0; x < image.width; x++) {
    let switches = 0;
    for (let y = 1; y < image.height; y++) if (gray(x, y) !== gray(x, y - 1)) switches++;
    most = Math.max(most, switches);
  }
  expect(most).toBeGreaterThan(8);
});

test('fill pattern, outline and opacity render as specified (F445)', async ({ page }) => {
  // Opacity: the park's green at 0.5 over white, blended in linear light as the engine composes every layer.
  let image = await open(page, 'fill');
  const park = await screenOf(page, 9.176, 45.473);
  const linear = (c: number) => ((c / 255 + 0.055) / 1.055) ** 2.4;
  const srgb = (c: number) => Math.round((1.055 * c ** (1 / 2.4) - 0.055) * 255);
  const blended = hex('#2e9e4f').map((c) => srgb(linear(c) * 0.5 + 0.5));
  expect(near(rgbAt(image, park.x, park.y), blended, 14), String(rgbAt(image, park.x, park.y))).toBe(true);
  // Outline: the fills' dark outlines (#402000 around buildings, #0b3d1a around the park), one pixel wide.
  let dark = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) if (rgbAt(image, x, y).reduce((a, b) => a + b, 0) < 300) dark++;
  expect(dark).toBeGreaterThan(40);
  expect(dark).toBeLessThan(image.width * image.height * 0.1);
  // Pattern: the canal shows the sprite's stripes, blue and white in turn along it.
  image = await open(page, 'fill', 'webgl2', 'zoom=16.5&lon=9.185&lat=45.4523');
  const canal = await screenOf(page, 9.185, 45.452);
  let stripes = 0;
  let wasBlue: boolean | undefined;
  for (let x = 0; x < image.width; x++) {
    const blue = near(rgbAt(image, x, canal.y), [40, 110, 200], 40);
    if (wasBlue !== undefined && blue !== wasBlue) stripes++;
    wasBlue = blue;
  }
  expect(stripes).toBeGreaterThan(6);
});

test('raster tiles, hillshade and heatmap images are drawn where they belong (F445)', async ({ page }) => {
  // Raster: the fixture's color field (red with longitude, green with latitude).
  let image = await open(page, 'raster');
  const at = await screenOf(page, 12.5, 43.5);
  const expected = [Math.round(((12.5 + 180) / 360) * 255), Math.round(((43.5 + 90) / 180) * 255), 160];
  expect(near(rgbAt(image, at.x, at.y), expected, 16), String(rgbAt(image, at.x, at.y))).toBe(true);
  // Hillshade: lit from the north-west, so the mountain's north-western flank is brighter than its south-eastern one.
  image = await open(page, 'hillshade');
  const lum = (p: { x: number; y: number }) => rgbAt(image, p.x, p.y).reduce((s, c) => s + c, 0);
  const nw = await screenOf(page, 6.84, 45.715);
  const se = await screenOf(page, 6.88, 45.685);
  expect(lum(nw)).toBeGreaterThan(lum(se) + 150);
  // Heatmap: hot at the dense city center, nothing far from the points.
  image = await open(page, 'heatmap', 'webgl2', 'zoom=12&lon=9.19&lat=45.465');
  const center = await screenOf(page, 9.19, 45.465);
  const c = rgbAt(image, center.x, center.y);
  expect((c[0] ?? 0) > 150 && (c[2] ?? 255) < 120, `center ${c.join()}`).toBe(true);
  const away = await screenOf(page, 9.29, 45.465);
  expect(near(rgbAt(image, Math.min(away.x, 319), away.y), WHITE, 10)).toBe(true);
});
