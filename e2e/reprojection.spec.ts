// Client-side reprojection (M7, F226): fixture rasters served in UTM zones 32N and 33N line up with the Web Mercator
// view in the globe, 2D and 3D phases, and meet at 12°E without gap or seam.
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { canvasImage, geoToScreen, openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

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

/** How magenta a pixel is (the fixture's ground control markers), 0–1. */
function magenta(image: PNG, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  const r = image.data[at] ?? 0;
  const g = image.data[at + 1] ?? 0;
  const b = image.data[at + 2] ?? 0;
  return Math.max(0, Math.min(r, b) - g) / 255;
}

/** The magenta-weighted centroid of the pixels within `radiusPx` of a point, pixel centers at +0.5. */
function markerCentroid(
  image: PNG,
  near: { xPx: number; yPx: number },
  radiusPx = 6,
): { xPx: number; yPx: number } | undefined {
  let [sx, sy, total] = [0, 0, 0];
  for (let y = Math.max(0, Math.round(near.yPx - radiusPx)); y < Math.min(image.height, near.yPx + radiusPx); y++)
    for (let x = Math.max(0, Math.round(near.xPx - radiusPx)); x < Math.min(image.width, near.xPx + radiusPx); x++) {
      const w = magenta(image, x, y);
      sx += (x + 0.5) * w;
      sy += (y + 0.5) * w;
      total += w;
    }
  if (total < 20) return undefined;
  return { xPx: sx / total, yPx: sy / total };
}

/**
 * The largest color step between neighboring pixels away from the markers, and the count of base-layer (red) pixels.
 * The fixture rasters are a smooth color field, so a seam or a gap shows as a step or as red.
 */
function seams(image: PNG): { maxStep: number; atPx: string; red: number } {
  let [maxStep, red] = [0, 0];
  let atPx = '';
  const near = (x: number, y: number): boolean => {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < image.width && ny < image.height && magenta(image, nx, ny) > 0.05) return true;
      }
    return false;
  };
  for (let y = 0; y < image.height - 1; y++)
    for (let x = 0; x < image.width - 1; x++) {
      const at = (y * image.width + x) * 4;
      const [r, g, b] = [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
      if (r > 180 && g < 100 && b < 100) red++;
      if (near(x, y)) continue;
      for (const next of [at + 4, at + image.width * 4])
        for (let c = 0; c < 3; c++) {
          const step = Math.abs((image.data[at + c] ?? 0) - (image.data[next + c] ?? 0));
          if (step > maxStep) [maxStep, atPx] = [step, `${String(x)},${String(y)}`];
        }
    }
  return { maxStep, atPx, red };
}

/** Ground control markers of the fixture (every 3°): on the zone boundary, in zone 32N and in zone 33N. */
const MARKERS = [
  { longitudeDeg: 12, latitudeDeg: 42 },
  { longitudeDeg: 9, latitudeDeg: 45 },
  { longitudeDeg: 15, latitudeDeg: 39 },
] as const;

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`UTM 32N and 33N rasters line up with the Web Mercator view in the globe, 2D and 3D phases on ${backend} (F226)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const session = await fixtureSession(page);
    // A red base below the two zones: any gap between them shows red.
    await openGlobe(page, `backend=${backend}&imagery=red&utm=32632,32633&session=${session}&lon=12.4&lat=42.2&zoom=7`);
    const offsets: string[] = [];
    for (const [phase, mode, zoom, tiltDeg] of [
      ['globe', 'auto', 3, 0],
      ['2d', '2d', 7, 0],
      ['3d', '3d', 7, 30],
    ] as const) {
      for (const marker of MARKERS) {
        // The marker a little off the view's center, so that it is not where the view's own rounding hides an offset.
        await page.evaluate(
          ([m, z, t, lon, lat]) => {
            const globe = window.vibeglobePlayground?.globe;
            globe?.setViewMode(m);
            globe?.jumpTo({ longitudeDeg: lon + 0.37, latitudeDeg: lat + 0.21, zoom: z, tiltDeg: t });
          },
          [mode, zoom, tiltDeg, marker.longitudeDeg, marker.latitudeDeg] as const,
        );
        await settle(page);
        expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.phase), phase).toBe(phase);
        const expected = await geoToScreen(page, marker);
        const label = `${phase} ${String(marker.longitudeDeg)},${String(marker.latitudeDeg)}`;
        const found = markerCentroid(await canvasImage(page), expected);
        if (!found) {
          offsets.push(`${label}: no marker near ${expected.xPx.toFixed(1)}, ${expected.yPx.toFixed(1)}`);
          continue;
        }
        const dx = found.xPx - expected.xPx;
        const dy = found.yPx - expected.yPx;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > 0.5) offsets.push(`${label}: ${dx.toFixed(2)}, ${dy.toFixed(2)}`);
      }
    }
    // Every ground control marker within half a pixel of where the Web Mercator view puts its coordinates.
    expect(offsets).toEqual([]);
  });
}

test('panning across 12°E shows no gap, seam or overlap between the zones (F226)', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const session = await fixtureSession(page);
  await openGlobe(page, `backend=webgl2&imagery=red&utm=32632,32633&session=${session}&lon=11.4&lat=42.6&zoom=8`);
  for (let lon = 11.4; lon <= 12.6; lon += 0.2) {
    await page.evaluate((l) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: l, latitudeDeg: 42.6 }), lon);
    await settle(page);
    const image = await canvasImage(page);
    const { maxStep, atPx, red } = seams(image);
    if (red > 0 || maxStep > 6)
      await testInfo.attach(`frame-${lon.toFixed(1)}.png`, { body: PNG.sync.write(image), contentType: 'image/png' });
    expect(red, `gap at ${lon.toFixed(1)}°E`).toBe(0);
    expect(maxStep, `seam at ${lon.toFixed(1)}°E, pixel ${atPx}`).toBeLessThanOrEqual(6);
  }
});
