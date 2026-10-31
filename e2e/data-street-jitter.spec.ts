// Data primitives at street level show no vertex jitter (F367): under sub-meter camera moves each primitive moves on
// screen exactly as the ground under it, within a pixel, in cities far from the origin, on both backends.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

type Rgb = readonly [number, number, number];

/** The primitives of `?scenario=data-street`: their anchor (meters east and north of the URL position) and color. */
const PRIMITIVES: readonly { name: string; east: number; north: number; is: (c: Rgb) => boolean }[] = [
  { name: 'point', east: 0.15, north: -0.05, is: ([r, g, b]) => r > 180 && b > 180 && g < 90 },
  { name: 'line', east: 0, north: -0.15, is: ([r, g, b]) => b > 180 && r < 90 && g < 120 },
  { name: 'polygon', east: -0.15, north: 0.05, is: ([r, g, b]) => g > 150 && r < 90 && b < 90 },
  { name: 'label', east: 0.1, north: 0.08, is: ([r, g, b]) => r > 200 && g > 180 && b < 90 },
  { name: 'model', east: 0, north: 0, is: ([r, g, b]) => r > 150 && r - g > 80 && r - b > 80 },
];

/** The Mercator zoom that puts a straight-down camera about 0.94 m above the ground at a latitude. */
function zoomForOneMeter(latitudeDeg: number): number {
  const cos = (deg: number): number => Math.cos((deg * Math.PI) / 180);
  return 25.5 + Math.log2(cos(latitudeDeg) / cos(45.46));
}

/** The centroid of the pixels of a color within `radius` pixels of a point; undefined when there are too few. */
function centroid(image: PNG, center: { xPx: number; yPx: number }, radius: number, is: (c: Rgb) => boolean) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = Math.max(0, Math.round(center.yPx - radius)); y < Math.min(image.height, center.yPx + radius); y++)
    for (let x = Math.max(0, Math.round(center.xPx - radius)); x < Math.min(image.width, center.xPx + radius); x++) {
      const i = (y * image.width + x) * 4;
      if (!is([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0])) continue;
      sx += x;
      sy += y;
      n++;
    }
  return n < 10 ? undefined : { xPx: sx / n, yPx: sy / n };
}

/** Screen points of the primitives' anchors, each at its height (the model's: the height of its picture's center). */
async function anchors(page: Page, lon: number, lat: number, heights: readonly number[] = []) {
  const metersPerDegree = 111_320 * Math.cos((lat * Math.PI) / 180);
  const at = (east: number, north: number, heightMeters = 0) => ({
    longitudeDeg: lon + east / metersPerDegree,
    latitudeDeg: lat + north / 110_574,
    heightMeters,
  });
  // The square's corners (scenario: -0.2 to -0.1 m east, 0 to 0.1 m north): the center of its picture is the area
  // centroid of the projected quadrilateral, not the projection of its center (perspective).
  const square = [at(-0.2, 0), at(-0.1, 0), at(-0.1, 0.1), at(-0.2, 0.1)];
  const [points, corners] = await page.evaluate(
    ([anchorPoints, cornerPoints]) => {
      const globe = window.vibeglobePlayground?.globe;
      return [anchorPoints.map((q) => globe?.geoToScreen(q)), cornerPoints.map((q) => globe?.geoToScreen(q))];
    },
    [PRIMITIVES.map((p, i) => at(p.east, p.north, heights[i] ?? 0)), square] as const,
  );
  const polygon = PRIMITIVES.findIndex((p) => p.name === 'polygon');
  if (corners.every((c) => c !== undefined)) points[polygon] = { ...areaCentroid(corners), behindGlobe: false };
  return points;
}

/** The area centroid of a simple polygon given by its vertices. */
function areaCentroid(vertices: readonly { xPx: number; yPx: number }[]): { xPx: number; yPx: number } {
  let area = 0;
  let cx = 0;
  let cy = 0;
  vertices.forEach((a, i) => {
    const b = vertices[(i + 1) % vertices.length] ?? a;
    const cross = a.xPx * b.yPx - b.xPx * a.yPx;
    area += cross;
    cx += (a.xPx + b.xPx) * cross;
    cy += (a.yPx + b.yPx) * cross;
  });
  return { xPx: cx / (3 * area), yPx: cy / (3 * area) };
}

/**
 * The height above the model's anchor whose projection is nearest the model's picture center: a 3D object moves on
 * screen with the parallax of its own height, not of the ground under it.
 */
async function modelHeight(page: Page, lon: number, lat: number, center: { xPx: number; yPx: number }) {
  let best = 0;
  let bestDistance = Infinity;
  const model = PRIMITIVES.findIndex((p) => p.name === 'model');
  for (let h = 0; h <= 0.3; h += 0.005) {
    const heights = PRIMITIVES.map((_, i) => (i === model ? h : 0));
    const point = (await anchors(page, lon, lat, heights))[model];
    const distance = point ? Math.hypot(point.xPx - center.xPx, point.yPx - center.yPx) : Infinity;
    if (distance < bestDistance) [best, bestDistance] = [h, distance];
  }
  return PRIMITIVES.map((_, i) => (i === model ? best : 0));
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`data primitives at street level move with the ground within a pixel, far from the origin, on ${backend} (F367)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    for (const [lon, lat] of [
      [139.69, 35.68],
      [151.21, -33.87],
      [15.63, 78.22],
      [179.99, -17.8],
      [-122.42, 37.77],
    ] as const) {
      await openGlobe(
        page,
        `backend=${backend}&scenario=data-street&lon=${lon}&lat=${lat}&zoom=${zoomForOneMeter(lat)}`,
      );
      await page.waitForFunction(() => document.body.dataset['street'] === 'ready');
      await waitForIdle(page);
      expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters)).toBeLessThan(1.5);
      const metersPerDegree = 111_320 * Math.cos((lat * Math.PI) / 180);
      const groundAnchors = await anchors(page, lon, lat);
      const first = await canvasImage(page);
      const firstCentroids = PRIMITIVES.map((p, i) =>
        centroid(first, groundAnchors[i] ?? { xPx: 0, yPx: 0 }, 70, p.is),
      );
      const modelCenter = firstCentroids[PRIMITIVES.findIndex((p) => p.name === 'model')];
      const heights = modelCenter ? await modelHeight(page, lon, lat, modelCenter) : [];
      const firstAnchors = await anchors(page, lon, lat, heights);
      // Sub-meter moves: 1 cm east and 7 mm north per step, with a slow turn.
      for (let step = 1; step <= 3; step++) {
        await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), {
          longitudeDeg: lon + (step * 0.01) / metersPerDegree,
          latitudeDeg: lat + (step * 0.007) / 110_574,
          headingDeg: step * 0.5,
        });
        await waitForIdle(page);
        const moved = await anchors(page, lon, lat, heights);
        const image = await canvasImage(page);
        PRIMITIVES.forEach((p, i) => {
          const before = firstCentroids[i];
          const now = centroid(image, moved[i] ?? { xPx: 0, yPx: 0 }, 70, p.is);
          const a0 = firstAnchors[i];
          const a1 = moved[i];
          expect(before && now && a0 && a1, `${p.name} at ${String(lon)}, ${String(lat)}`).toBeTruthy();
          if (!before || !now || !a0 || !a1) return;
          // The primitive's own motion on screen, less the motion of the ground point it is anchored to.
          // Along the (east–west) line its motion is not observable: only across it.
          const errorX = p.name === 'line' ? 0 : now.xPx - before.xPx - (a1.xPx - a0.xPx);
          const error = Math.hypot(errorX, now.yPx - before.yPx - (a1.yPx - a0.yPx));
          expect(error, `${p.name} at ${String(lon)}, ${String(lat)}, step ${String(step)}`).toBeLessThan(1);
        });
      }
    }
  });
}
