// F364, F365: lines and polygons draped over the fixture peak stay on the terrain drawn in every frame of a zoom from
// the globe to the street and of an orbit in the tilted view, through terrain level changes and geomorphing: the frames
// are captured right after each step, without waiting for the terrain to settle.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe } from './support/globe.ts';

type Rgb = readonly [number, number, number];
const BACKENDS = ['webgpu', 'webgl2'] as const;
test.use({ viewport: { width: 480, height: 360 } });
const isBlue = ([r, g, b]: Rgb): boolean => b > 150 && r < 100 && g < 130;
const isGreen = ([r, g, b]: Rgb): boolean => g > 140 && r < 120 && b < 120;

function near(image: PNG, xPx: number, yPx: number, radius: number, match: (rgb: Rgb) => boolean): boolean {
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.round(xPx) + dx;
      const y = Math.round(yPx) + dy;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * 4;
      if (match([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0])) return true;
    }
  return false;
}

/**
 * Screen positions of positions (degrees) at the height of the terrain under them, kept only where the terrain
 * drawn at that pixel is the position itself (within `within` degrees): elsewhere the peak hides it.
 */
async function visibleOnTerrain(page: Page, positions: readonly (readonly [number, number])[], within: number) {
  return page.evaluate(
    ([list, tolerance]) => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      return list.flatMap(([lon = 0, lat = 0]) => {
        const position = { longitudeDeg: lon, latitudeDeg: lat };
        const point = globe.geoToScreen({ ...position, heightMeters: globe.elevationAt(position).heightMeters });
        if (!point || point.xPx < 4 || point.yPx < 4 || point.xPx > 476 || point.yPx > 356) return [];
        const shown = globe.screenToGeo(point);
        if (!shown) return [];
        const apart = Math.hypot(shown.longitudeDeg - lon, shown.latitudeDeg - lat);
        return apart < tolerance ? [point] : [];
      });
    },
    [positions, within] as const,
  );
}

/** Moves the camera in one frame, then returns the next frame drawn, before the terrain settles. */
async function step(page: Page, view: Record<string, number>): Promise<PNG> {
  await page.evaluate(async (target) => {
    const globe = window.vibeglobePlayground?.globe;
    globe?.jumpTo({ longitudeDeg: 6.86, latitudeDeg: 45.75, ...target });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, view);
  return canvasImage(page);
}

/** The views of the recording: a zoom from the globe (zoom 4) to the street at 55°, then an orbit at zoom 12. */
function path(): Record<string, number>[] {
  const views: Record<string, number>[] = [];
  for (let zoom = 4; zoom <= 14.01; zoom += 0.25) views.push({ zoom, tiltDeg: 55, headingDeg: 0 });
  for (let heading = 0; heading < 360; heading += 20) views.push({ zoom: 12, tiltDeg: 55, headingDeg: heading });
  return views;
}

for (const backend of BACKENDS)
  for (const kind of ['lines', 'polygons'] as const)
    test(`draped ${kind} stay on the terrain in every frame of a zoom to the street and an orbit on ${backend} (${kind === 'lines' ? 'F364' : 'F365'})`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      // KB-221: between its subdivision points (about 1 km apart) the fill is flat, and finer terrain shows through it.
      test.fail(kind === 'polygons', 'KB-221');
      await openGlobe(page, `backend=${backend}&terrain=terrarium&scenario=draped-${kind}&lon=6.86&lat=45.75&zoom=4`);
      await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
      // Samples along the line (45.83° N), and inside the polygon (6.7–7.0° E, 45.72–45.95° N) away from its edges.
      const samples: [number, number][] = [];
      if (kind === 'lines') for (let lon = 6.55; lon <= 7.15; lon += 0.01) samples.push([lon, 45.83]);
      else
        for (let lon = 6.72; lon <= 6.98; lon += 0.04)
          for (let lat = 45.74; lat <= 45.93; lat += 0.04) samples.push([lon, lat]);
      const match = kind === 'lines' ? isBlue : isGreen;
      let checked = 0;
      for (const view of path()) {
        const image = await step(page, view);
        const points = await visibleOnTerrain(page, samples, 0.004);
        const label = `${kind} at zoom ${view['zoom']?.toFixed(2)}, heading ${view['headingDeg']}`;
        // A line 5 px wide lies within 3 px of its centerline's projection; the fill covers its own pixel.
        const missed = points.filter((point) => !near(image, point.xPx, point.yPx, kind === 'lines' ? 3 : 1, match));
        if (missed.length > 0 && process.env['DRAPED_DEBUG']) {
          const { PNG: Png } = await import('pngjs');
          const fs = await import('node:fs');
          fs.writeFileSync(`${process.env['DRAPED_DEBUG']}/${backend}-${kind}.png`, Png.sync.write(image));
          fs.writeFileSync(
            `${process.env['DRAPED_DEBUG']}/${backend}-${kind}.json`,
            JSON.stringify({ view, missed, points }),
          );
        }
        for (const point of points)
          expect(near(image, point.xPx, point.yPx, kind === 'lines' ? 3 : 1, match), label).toBe(true);
        checked += points.length;
      }
      console.log(`[draped] ${backend} ${kind}: ${checked} visible samples checked over ${path().length} frames`);
      expect(checked).toBeGreaterThan(path().length * 4);
    });
