import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { BACKGROUND_RGB, canvasImage, nextFrame, openGlobe, silhouetteRadiusPx, waitForIdle } from './support/globe.ts';
import { waitForImagery } from './support/imagery.ts';

/**
 * M5's three phases in Auto mode (ADR 0008, ADR 0034) on both backends: the globe at world scale (F151), the flat
 * Web Mercator map at city scale (F153) and the rise of tilt and relief from city to street scale (F154). Their
 * screenshots are compared with baselines in e2e/visual.spec.ts (views globe-world, map-2d-city, street-tilted).
 */
const BACKENDS = ['webgpu', 'webgl2'] as const;
const WGS84_A = 6378137;
const FOV_Y_RAD = 0.6435011087932844;

test.use({ viewport: { width: 320, height: 240 } });

async function cameraOf(page: Page): Promise<{
  phase: string;
  tiltDeg: number;
  reliefFactor: number;
  morphFactor: number;
  zoom: number;
  rangeMeters: number;
}> {
  return page.evaluate(() => {
    const camera = window.vibeglobePlayground?.globe.camera;
    if (!camera) throw new Error('no globe');
    const { phase, tiltDeg, reliefFactor, morphFactor, zoom, rangeMeters } = camera;
    return { phase, tiltDeg, reliefFactor, morphFactor, zoom, rangeMeters };
  });
}

function isBackground(image: PNG, x: number, y: number): boolean {
  const i = (y * image.width + x) * 4;
  return (
    Math.abs((image.data[i] ?? 0) - BACKGROUND_RGB[0]) +
      Math.abs((image.data[i + 1] ?? 0) - BACKGROUND_RGB[1]) +
      Math.abs((image.data[i + 2] ?? 0) - BACKGROUND_RGB[2]) <
    12
  );
}

/**
 * Lines of the fixture `world` imagery's grid that run straight through a band of the frame: columns (`vertical`) or
 * rows whose mean luminance over the band lies well below the median, which only a line along its whole length makes.
 */
function straightLines(image: PNG, vertical: boolean, from: number, to: number): number {
  const count = vertical ? image.width : image.height;
  const means: number[] = [];
  for (let k = 0; k < count; k++) {
    let sum = 0;
    for (let t = from; t < to; t++) {
      const x = vertical ? k : t;
      const y = vertical ? t : k;
      const i = (y * image.width + x) * 4;
      sum += 0.299 * (image.data[i] ?? 0) + 0.587 * (image.data[i + 1] ?? 0) + 0.114 * (image.data[i + 2] ?? 0);
    }
    means.push(sum / (to - from));
  }
  const median = [...means].sort((p, q) => p - q)[Math.floor(count / 2)] ?? 0;
  return means.filter((mean) => mean < median - 15).length;
}

for (const backend of BACKENDS) {
  test.describe(backend, () => {
    test(`at world scale the surface is the ellipsoid, untilted and without relief, its limb where WGS84 projects on ${backend} (F151)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await openGlobe(page, `backend=${backend}&scenario=globe-world`);
      await waitForImagery(page);
      await waitForIdle(page);
      const camera = await cameraOf(page);
      expect([camera.phase, camera.tiltDeg, camera.reliefFactor]).toEqual(['globe', 0, 0]);
      const image = await canvasImage(page);
      // Inside the polar-radius sphere's silhouette everything is drawn; outside the equatorial one, nothing: the
      // ellipsoid's limb lies between, within a pixel of each (1.5 px of anti-aliasing on either side).
      const inner = await silhouetteRadiusPx(page);
      const distance = camera.rangeMeters + WGS84_A;
      const outer = (Math.tan(Math.asin(WGS84_A / distance)) / Math.tan(FOV_Y_RAD / 2)) * (image.height / 2) + 1.5;
      let missing = 0;
      let outside = 0;
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          const r = Math.hypot(x + 0.5 - image.width / 2, y + 0.5 - image.height / 2);
          if (r < inner && isBackground(image, x, y)) missing++;
          if (r > outer && !isBackground(image, x, y)) outside++;
        }
      expect([missing, outside]).toEqual([0, 0]);
    });

    test(`at city scale the view is a flat Web Mercator map at 0° with straight perpendicular grid lines on ${backend} (F153)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await openGlobe(page, `backend=${backend}&scenario=map-2d-city`);
      await waitForImagery(page);
      await waitForIdle(page);
      const camera = await cameraOf(page);
      expect([camera.phase, camera.morphFactor, camera.tiltDeg]).toEqual(['2d', 1, 0]);
      // Relief stays subtle: the relief curve's value (smootherstep from ground zoom 10 to 15) at this ground zoom.
      const t = Math.min(1, Math.max(0, (camera.zoom - Math.log2(Math.cos((41.9 * Math.PI) / 180)) - 10) / 5));
      expect(camera.reliefFactor).toBeCloseTo(t * t * t * (t * (t * 6 - 15) + 10), 6);
      expect(camera.reliefFactor).toBeLessThan(0.2);
      const image = await canvasImage(page);
      // The imagery's meridian and parallel grid lines run straight down the whole frame and straight across the
      // right half (where one imagery level shows): whole columns and rows of darker pixels, several of each.
      expect(straightLines(image, true, 0, image.height)).toBeGreaterThanOrEqual(2);
      expect(straightLines(image, false, Math.floor(image.width / 2), image.width)).toBeGreaterThanOrEqual(2);
    });

    test(`zooming from city to street, the tilt rises monotonically to the automatic tilt and relief reaches full height on ${backend} (F154)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openGlobe(page, `backend=${backend}&scenario=zoom-city-to-street`);
      const box = await page.locator('#globe').boundingBox();
      if (!box) throw new Error('no canvas');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const tilts: number[] = [];
      let last = await cameraOf(page);
      // Wheel steps of a third of a level from zoom 12 to past 17 (ground zoom 17.4 at Rome).
      for (let step = 0; step < 16; step++) {
        await page.mouse.wheel(0, -100);
        await nextFrame(page);
        await nextFrame(page);
        last = await cameraOf(page);
        tilts.push(last.tiltDeg);
      }
      expect(last.zoom).toBeGreaterThan(17);
      expect(tilts.every((tilt, i) => i === 0 || tilt >= (tilts[i - 1] ?? 0) - 1e-6)).toBe(true);
      // The tilt eases toward the curve: a few more frames settle it at the automatic tilt.
      for (let i = 0; i < 30; i++) await nextFrame(page);
      last = await cameraOf(page);
      expect(last.tiltDeg).toBeCloseTo(50, 3);
      expect(last.reliefFactor).toBe(1);
      expect(last.phase).toBe('3d');
    });
  });
}
