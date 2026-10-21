import { expect, test, type Page } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;
const EARTH_RADIUS_METERS = 6371008.8;
const DEG = Math.PI / 180;

/** Pixels the frame left empty (alpha 0): the engine clears to transparent, so these show no surface. */
async function emptyPixels(page: Page, belowHorizonOnly = false): Promise<number> {
  return page.evaluate(async (below) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const { widthPx, heightPx, rgba } = await globe.captureFrame();
    let empty = 0;
    for (let x = 0; x < widthPx; x++) {
      // The horizon in this column: the first row from the top that shows the surface.
      let top = 0;
      if (below) while (top < heightPx && (rgba[(top * widthPx + x) * 4 + 3] ?? 0) === 0) top++;
      for (let y = top; y < heightPx; y++) if ((rgba[(y * widthPx + x) * 4 + 3] ?? 0) === 0) empty++;
    }
    return empty;
  }, belowHorizonOnly);
}

/** Great-circle distance between two positions in degrees, meters. */
function distanceMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const h =
    Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

for (const backend of BACKENDS) {
  test(`frustum culling skips tiles outside the view and never a visible one on ${backend} (F086)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&debug=1&lon=12&lat=45&zoom=4`);
    await waitForIdle(page);
    const result = await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const canvas = document.querySelector<HTMLCanvasElement>('#globe');
      if (!globe || !canvas) throw new Error('no globe');
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      // A selected tile has some point within the view, or within half a screen of it: bounding spheres are
      // conservative, never more than that at this scale.
      const offscreen = globe.surfaceTiles().filter((tile) => {
        for (let i = 0; i <= 16; i++) {
          for (let j = 0; j <= 16; j++) {
            const point = globe.geoToScreen({
              longitudeDeg: tile.westDeg + ((tile.eastDeg - tile.westDeg) * i) / 16,
              latitudeDeg: tile.southDeg + ((tile.northDeg - tile.southDeg) * j) / 16,
            });
            if (
              point &&
              point.xPx > -width / 2 &&
              point.xPx < 1.5 * width &&
              point.yPx > -height / 2 &&
              point.yPx < 1.5 * height
            )
              return false;
          }
        }
        return true;
      });
      return { stats: globe.surfaceStats(), offscreen: offscreen.length };
    });
    expect(result.offscreen).toBe(0);
    expect(result.stats.culledByFrustum).toBeGreaterThan(0);
    // The debug overlay reports the same selection.
    await expect(page.locator('[data-metric="surface"]')).toContainText(
      `culled: frustum ${result.stats.culledByFrustum}`,
    );
    // Quick rotation: every frame fills the view, so no visible tile was culled.
    for (let heading = 0; heading < 360; heading += 30) {
      await page.evaluate((h) => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: h }), heading);
      expect(await emptyPixels(page), `heading ${heading}°`).toBe(0);
    }
  });

  test(`horizon culling skips tiles behind the curve of the Earth and never a visible one on ${backend} (F087)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&lon=9.19&lat=45.46&zoom=14&tilt=80`);
    await waitForIdle(page);
    const result = await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      return { camera: globe.camera, tiles: globe.surfaceTiles(), stats: globe.surfaceStats() };
    });
    const { camera, tiles, stats } = result;
    expect(stats.culledByHorizon).toBeGreaterThan(0);
    // The eye's nadir: the target moved back along the view direction by the horizontal part of the range.
    const back = camera.rangeMeters * Math.sin(camera.tiltDeg * DEG);
    const bearing = (camera.headingDeg + 180) * DEG;
    const angular = back / EARTH_RADIUS_METERS;
    const lat0 = camera.latitudeDeg * DEG;
    const nadirLat = Math.asin(
      Math.sin(lat0) * Math.cos(angular) + Math.cos(lat0) * Math.sin(angular) * Math.cos(bearing),
    );
    const nadirLon =
      camera.longitudeDeg * DEG +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat0),
        Math.cos(angular) - Math.sin(lat0) * Math.sin(nadirLat),
      );
    const horizonMeters = Math.sqrt(2 * EARTH_RADIUS_METERS * camera.altitudeMeters);
    for (const tile of tiles) {
      // The tile's nearest point to the nadir lies within the horizon distance, widened by what a bounding sphere of
      // the tile's size can show beyond it: its top stands up to its radius r above the ground, visible from up to
      // √(2·R·r) farther. A tile wholly beyond that is never selected.
      const lon = Math.min(Math.max(nadirLon / DEG, tile.westDeg), tile.eastDeg);
      const lat = Math.min(Math.max(nadirLat / DEG, tile.southDeg), tile.northDeg);
      const extent = distanceMeters(tile.westDeg, tile.southDeg, tile.eastDeg, tile.northDeg);
      const reach = horizonMeters + Math.sqrt(2 * EARTH_RADIUS_METERS * extent) + extent;
      expect(distanceMeters(nadirLon / DEG, nadirLat / DEG, lon, lat), JSON.stringify(tile)).toBeLessThan(reach);
    }
    // Nothing visible was culled: below the horizon line every pixel shows the surface.
    expect(await emptyPixels(page, true)).toBe(0);
  });
}
