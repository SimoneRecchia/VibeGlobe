// 3D Tiles at street level without jitter and aligned with WGS84 (F464), on both backends: with the camera 2 m above
// a roof edge of the fixture city, 1,500 km from the ECEF origin's axes, sub-centimeter camera steps move the edge on
// screen smoothly (frame differencing: each step changes the picture by the same small amount, no jumps); and the
// roofs' surveyed corners, projected from their WGS84 coordinates, fall on the roofs' drawn edges.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { buildingHeight } from './fixtures/tiles3d/city.ts';
import { canvasImage, waitForIdle } from './support/globe.ts';
import { cityPoint, openCity, settleTiles } from './support/tiles3d.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.setTimeout(180_000);

/** Roof pixels: the buildings' warm beige, red clearly above green (the ground plate is green-grey). */
const isRoof = (image: PNG, x: number, y: number): boolean => {
  const i = (Math.round(y) * image.width + Math.round(x)) * 4;
  const r = image.data[i] ?? 0;
  const g = image.data[i + 1] ?? 0;
  const b = image.data[i + 2] ?? 0;
  return r > g + 12 && g > b + 12;
};

/** Building pixels in the picture (roofs and walls). */
const buildingCount = (image: PNG): number => {
  let n = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (isRoof(image, x, y)) n++;
  return n;
};

/** The zoom that puts a straight-down camera `heightM` above the ellipsoid, from the camera's own altitude. */
async function zoomForHeight(page: Page, heightM: number): Promise<number> {
  const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
  if (!camera) throw new Error('no camera');
  return camera.zoom + Math.log2(camera.altitudeMeters / heightM);
}

async function jump(page: Page, east: number, north: number, zoom: number): Promise<void> {
  const at = cityPoint(east, north);
  await page.evaluate(
    async (view) => {
      await window.vibeglobePlayground?.globe.jumpTo(view);
    },
    { longitudeDeg: at.longitudeDeg, latitudeDeg: at.latitudeDeg, zoom, tiltDeg: 0 },
  );
  await waitForIdle(page);
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`sub-centimeter camera steps 2 m above a roof move it smoothly, without jitter (${backend}) (F464)`, async ({
    page,
  }) => {
    // Building (16, 16): center 16 m east and north of the city center, 20 m footprint; its east edge is at 26 m. The
    // camera is 1 m east of it over the street, 2 m above the roof, looking down: the building fills the left of the
    // view, down its east wall to the street, whose edge crosses the view top to bottom.
    const roof = buildingHeight(16, 16);
    const start = cityPoint(27, 16);
    await openCity(page, `backend=${backend}&lon=${start.longitudeDeg}&lat=${start.latitudeDeg}&zoom=19&tilt=0`);
    const zoom = await zoomForHeight(page, roof + 2);
    await jump(page, 27, 16, zoom);
    await settleTiles(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters)).toBeCloseTo(roof + 2, 1);
    const counts: number[] = [];
    const stepM = 0.009;
    const steps = 30;
    for (let i = 0; i <= steps; i++) {
      await jump(page, 27 + i * stepM, 16, zoom);
      const frame = await canvasImage(page);
      counts.push(buildingCount(frame));
    }
    console.log(`${backend}: building pixels ${counts.join(' ')}`);
    expect(counts[0]).toBeGreaterThan(0.2 * 320 * 240);
    expect(counts[0]).toBeLessThan(0.8 * 320 * 240);
    // The edge moves west on screen with the camera: never back, never more than one pixel column a step.
    const changes = counts.slice(1).map((c, i) => c - (counts[i] ?? 0));
    for (const change of changes) expect(change, `changes ${changes.join(' ')}`).toBeLessThanOrEqual(0);
    for (const change of changes) expect(-change, `changes ${changes.join(' ')}`).toBeLessThanOrEqual(240 + 2);
    // In all, by the distance the camera moved, in pixels at the street's depth, within a pixel.
    const pxPerMeter = await page.evaluate(
      ([a, b]) => {
        const globe = window.vibeglobePlayground?.globe;
        if (!a || !b) return 0;
        return (globe?.geoToScreen(b)?.xPx ?? 0) - (globe?.geoToScreen(a)?.xPx ?? 0);
      },
      [cityPoint(26, 16, 1), cityPoint(27, 16, 1)],
    );
    const expected = steps * stepM * pxPerMeter;
    expect(Math.abs(((counts[0] ?? 0) - (counts[steps] ?? 0)) / 240 - expected)).toBeLessThanOrEqual(1);
  });

  test(`roof corners projected from WGS84 fall on the drawn roof edges (${backend}) (F464)`, async ({ page }) => {
    const center = cityPoint(16, 16);
    await openCity(page, `backend=${backend}&lon=${center.longitudeDeg}&lat=${center.latitudeDeg}&zoom=18&tilt=0`);
    await settleTiles(page);
    const image = await canvasImage(page);
    let checked = 0;
    for (const [i, j] of [
      [16, 16],
      [15, 16],
      [16, 15],
      [17, 16],
      [16, 17],
    ] as const) {
      const h = buildingHeight(i, j);
      const e0 = -512 + 32 * i + 6;
      const n0 = -512 + 32 * j + 6;
      const corners = await page.evaluate(
        (points) => points.map((p) => window.vibeglobePlayground?.globe.geoToScreen(p)),
        [cityPoint(e0, n0, h), cityPoint(e0 + 20, n0, h), cityPoint(e0 + 20, n0 + 20, h), cityPoint(e0, n0 + 20, h)],
      );
      if (corners.some((c) => c === undefined)) continue;
      const ring = corners as { xPx: number; yPx: number }[];
      const middle = {
        x: ring.reduce((sum, c) => sum + c.xPx, 0) / 4,
        y: ring.reduce((sum, c) => sum + c.yPx, 0) / 4,
      };
      // Along each edge, where on the canvas: 2 px inside (toward the roof's middle) is roof; for the building below
      // the camera, whose walls its roof hides, 2 px outside is not (its neighbors show the walls facing the camera).
      for (let k = 0; k < 4; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % 4];
        if (!a || !b) continue;
        for (let t = 0.1; t <= 0.9; t += 0.1) {
          const p = { x: a.xPx + (b.xPx - a.xPx) * t, y: a.yPx + (b.yPx - a.yPx) * t };
          if (p.x < 4 || p.y < 4 || p.x > 315 || p.y > 235) continue;
          const d = Math.hypot(middle.x - p.x, middle.y - p.y);
          const dx = (2 * (middle.x - p.x)) / d;
          const dy = (2 * (middle.y - p.y)) / d;
          expect(isRoof(image, p.x + dx, p.y + dy), `inside edge ${k} of ${i},${j} at ${t.toFixed(1)}`).toBe(true);
          if (i === 16 && j === 16)
            expect(isRoof(image, p.x - dx, p.y - dy), `outside edge ${k} at ${t.toFixed(1)}`).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
}
