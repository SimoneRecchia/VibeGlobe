// F452: fills and lines draped on terrain in the 3D view. Every pixel of the ring road around the fixture peak, taken
// back to the ground through the terrain's depth (`screenToGeo`), lies on the road: a road floating above the relief
// or cut into it would show over other ground. Across several terrain levels the road stays there, and a still view
// draws the same frame twice (no shimmer). The baselines wait for hook request D (3).
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { expectMatchesBaseline } from '../support/visual.ts';
import { BACKENDS, capture, hex, near, openVector, rgbAt, settle } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

const VIEW = 'scenario=mvt-terrain&terrain=terrarium';
const PRIMARY = hex('#fcd6a4');
/** The ring road of e2e/vector-tiles/fixtures/city.ts: an ellipse around the peak. */
const RING = { lon: 6.86, lat: 45.7, aLon: 0.04, aLat: 0.025 };

/** Ground distance in meters from a point to the ring road (sampled finely). */
function ringDistanceMeters(lon: number, lat: number): number {
  let best = Infinity;
  for (let a = 0; a < 360; a += 0.25) {
    const r = (a * Math.PI) / 180;
    const dx = (lon - RING.lon - RING.aLon * Math.cos(r)) * 111_320 * Math.cos((lat * Math.PI) / 180);
    const dy = (lat - RING.lat - RING.aLat * Math.sin(r)) * 110_540;
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

async function hideLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const layer = window.vibeglobeVectorTiles?.layer;
    for (const l of layer?.style.layers ?? []) if (l.type === 'symbol') layer?.style.setVisibility(l.id, false);
  });
  await settle(page);
}

/** Road pixels (the avenue's fill) of a frame, every one. */
function roadPixels(image: PNG): { xPx: number; yPx: number }[] {
  const out: { xPx: number; yPx: number }[] = [];
  for (let y = 1; y < image.height - 1; y++)
    for (let x = 1; x < image.width - 1; x++) if (near(rgbAt(image, x, y), PRIMARY, 10)) out.push({ xPx: x, yPx: y });
  return out;
}

/** The ground distances to the ring road of the road pixels' points on the terrain. */
async function offsets(page: Page, pixels: { xPx: number; yPx: number }[]): Promise<number[]> {
  const geo = await page.evaluate(
    (points) => points.map((p) => window.vibeglobePlayground?.globe.screenToGeo(p)),
    pixels,
  );
  return geo.flatMap((g) => (g === undefined ? [] : [ringDistanceMeters(g.longitudeDeg, g.latitudeDeg)]));
}

for (const backend of BACKENDS) {
  test(`road pixels lie on the terrain surface at every terrain level (${backend}, F452)`, async ({ page }) => {
    test.setTimeout(180_000);
    await openVector(page, `${VIEW}&backend=${backend}`);
    await hideLabels(page);
    for (const zoom of [10.5, 11, 11.5, 12]) {
      await page.evaluate(
        (z) =>
          window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 6.86, latitudeDeg: 45.7, zoom: z, tiltDeg: 45 }),
        zoom,
      );
      await settle(page);
      const image = await capture(page);
      const pixels = roadPixels(image);
      expect(pixels.length, `road pixels at zoom ${zoom}`).toBeGreaterThan(20);
      const distances = (await offsets(page, pixels)).sort((a, b) => a - b);
      // Half the road's drawn width (a few pixels) plus a pixel's footprint on steep ground: about 15 m at zoom 12.
      const tolerance = 20 * 2 ** (12 - zoom) + 10;
      const p95 = distances[Math.floor(distances.length * 0.95)] ?? Infinity;
      expect(p95, `zoom ${zoom}: ${distances.length} pixels`).toBeLessThan(tolerance);
      // A still view: the next frame draws the same pixels.
      await page.evaluate(() => window.vibeglobePlayground?.globe.requestRender());
      const again = await capture(page);
      let changed = 0;
      for (let i = 0; i < image.data.length; i++)
        if (Math.abs((image.data[i] ?? 0) - (again.data[i] ?? 0)) > 8) changed++;
      expect(changed, `zoom ${zoom}`).toBe(0);
    }
  });

  test(`the draped view matches its baseline (${backend}, F452) @baseline`, async ({ page }, testInfo) => {
    await openVector(page, `${VIEW}&backend=${backend}`);
    await expectMatchesBaseline(page, testInfo, `mvt-terrain-${backend}.png`, await capture(page));
  });
}
