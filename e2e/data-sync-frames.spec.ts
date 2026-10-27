// F366: points, a line, a polygon, a label and a model over Rome stay on their map positions in every frame of a
// continuous zoom from the globe to the oblique street view (Auto mode: the globe flattens from ground zoom 4 to 6.5
// and tilts in from 14, ADR 0034). Each frame is captured right after its step of 0.1 zoom levels, as a wheel zoom
// draws them, and every primitive is looked for at the screen position of its coordinates in that same frame.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe } from './support/globe.ts';

type Rgb = readonly [number, number, number];
const BACKENDS = ['webgpu', 'webgl2'] as const;
test.use({ viewport: { width: 480, height: 360 } });

const isRed = ([r, g, b]: Rgb): boolean => r > 180 && g < 90 && b < 90;
const isBlue = ([r, g, b]: Rgb): boolean => b > 150 && r < 100 && g < 130;
const isGreen = ([r, g, b]: Rgb): boolean => g > 140 && r < 120 && b < 120;
const isYellow = ([r, g, b]: Rgb): boolean => r > 200 && g > 170 && b < 90;
const isModel = ([r, g, b]: Rgb): boolean => r > 90 && r > 2.5 * g && r > 2.5 * b;

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

/** Zooms to `zoom` in one step, then returns the next frame drawn with the screen positions of the primitives. */
async function frameAt(page: Page, zoom: number) {
  const where = await page.evaluate(async (z) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.89, zoom: z });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const at = (lon: number, lat: number, heightMeters = 0) => {
      const point = globe.geoToScreen({ longitudeDeg: lon, latitudeDeg: lat, heightMeters });
      return point && point.xPx >= 3 && point.yPx >= 3 && point.xPx < 477 && point.yPx < 357 ? point : undefined;
    };
    return {
      point: at(12.51, 41.89),
      line: at(12.505, 41.89),
      polygon: at(12.495, 41.89),
      label: at(12.495, 41.9),
      apex: at(12.515, 41.89, 50),
      camera: globe.camera,
    };
  }, zoom);
  return { image: await canvasImage(page), where };
}

for (const backend of BACKENDS) {
  test(`layers stay on their positions in every frame of a continuous zoom from the globe to the street on ${backend} (F366)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openGlobe(page, `backend=${backend}&scenario=data-sync&lon=12.5&lat=41.89&zoom=3`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    let frames = 0;
    for (let zoom = 3; zoom <= 15.51; zoom += 0.1) {
      const { image, where } = await frameAt(page, zoom);
      const camera = where.camera;
      const label = `zoom ${zoom.toFixed(1)}, morph ${camera.morphFactor.toFixed(2)}, tilt ${camera.tiltDeg.toFixed(1)}`;
      frames++;
      if (zoom < 10.5) {
        // Within a few pixels of each other, the primitives overlap there (the label on top).
        const drawn = (rgb: Rgb): boolean => isRed(rgb) || isYellow(rgb) || isBlue(rgb) || isGreen(rgb);
        if (where.point) expect(near(image, where.point.xPx, where.point.yPx, 3, drawn), `${label}: layers`).toBe(true);
        continue;
      }
      // Once they lie apart on the screen: each primitive within a pixel of its own position.
      if (where.point) expect(near(image, where.point.xPx, where.point.yPx, 1, isRed), `${label}: point`).toBe(true);
      if (where.line) expect(near(image, where.line.xPx, where.line.yPx, 1, isBlue), `${label}: line`).toBe(true);
      if (where.polygon)
        expect(near(image, where.polygon.xPx, where.polygon.yPx, 1, isGreen), `${label}: polygon`).toBe(true);
      if (where.label) expect(near(image, where.label.xPx, where.label.yPx, 6, isYellow), `${label}: label`).toBe(true);
      if (where.apex) expect(near(image, where.apex.xPx, where.apex.yPx, 2, isModel), `${label}: model`).toBe(true);
    }
    console.log(`[sync] ${backend}: ${frames} frames checked`);
  });
}
