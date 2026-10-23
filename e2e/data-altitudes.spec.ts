// Absolute altitudes of data-layer primitives (M10, F362): points, markers, lines and glTF models at 0, 1,000 and
// 10,000 m above the ellipsoid draw where their positions project, within a pixel, in the globe, 2D and tilted phases.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const ALTITUDES = [0, 1000, 10_000] as const;

type Rgb = [number, number, number];
const isRed = ([r, g, b]: Rgb): boolean => r > 180 && g < 100 && b < 100;
const isBlue = ([r, g, b]: Rgb): boolean => b > 180 && r < 90 && g < 120;
const isGreen = ([r, g, b]: Rgb): boolean => g > 140 && r < 120 && b < 120;

function near(image: PNG, xPx: number, yPx: number, test: (rgb: Rgb) => boolean): boolean {
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const at = ((Math.round(yPx) + dy) * image.width + Math.round(xPx) + dx) * 4;
      if (test([image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0])) return true;
    }
  return false;
}

/** Each primitive of `?scenario=data-altitudes-all` at altitude index i: where it stands and its color. */
const PRIMITIVES = [
  { kind: 'point', at: (i: number) => [12.5 + i * 0.05, 41.9], color: isRed },
  { kind: 'marker', at: (i: number) => [12.5 + i * 0.05, 41.93], color: isBlue },
  { kind: 'line', at: (i: number) => [12.5 + i * 0.05, 41.87], color: isGreen },
  // The pyramid model (red, about 226, 82, 82), anchored inside its base.
  { kind: 'model', at: (i: number) => [12.5 + i * 0.05, 41.84], color: isRed },
] as const;

async function project(page: Page, lon: number, lat: number, heightMeters: number) {
  return page.evaluate(
    ([longitudeDeg, latitudeDeg, h]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg, latitudeDeg, heightMeters: h }),
    [lon, lat, heightMeters] as const,
  );
}

const PHASES = [
  // The globe kept unflattened up to street zoom by the view curves, so the primitives are pixels apart.
  { name: 'globe', mode: 'auto', curves: true, view: { longitudeDeg: 12.55, latitudeDeg: 41.88, zoom: 10 } },
  { name: '2D', mode: '2d', curves: false, view: { longitudeDeg: 12.55, latitudeDeg: 41.88, zoom: 10 } },
  {
    name: 'tilted',
    mode: '3d',
    curves: false,
    view: { longitudeDeg: 12.55, latitudeDeg: 41.84, zoom: 9.5, tiltDeg: 45 },
  },
] as const;

for (const backend of BACKENDS) {
  test(`points, markers, lines and models at 0, 1,000 and 10,000 m draw where their positions project in every phase on ${backend} (F362)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&scenario=data-altitudes-all`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    for (const phase of PHASES) {
      const camera = await page.evaluate(({ mode, curves, view }) => {
        const globe = window.vibeglobePlayground?.globe;
        if (!globe) throw new Error('no globe');
        document.querySelector<HTMLElement>('#camera-controls')?.style.setProperty('display', 'none');
        globe.setViewCurves(
          curves
            ? { morph: { startGroundZoom: 40, endGroundZoom: 41 }, tilt: { startGroundZoom: 41, endGroundZoom: 42 } }
            : {},
        );
        globe.setViewMode(mode);
        globe.jumpTo(view);
        return { phase: globe.camera.phase };
      }, phase);
      await page.waitForTimeout(500);
      await waitForIdle(page);
      const state = await page.evaluate(() => {
        const c = window.vibeglobePlayground?.globe.camera;
        return { phase: c?.phase, relief: c?.reliefFactor ?? NaN };
      });
      expect(state.phase, `${phase.name} (was ${String(camera.phase)})`).toBe(
        phase.name === 'globe' ? 'globe' : phase.name === '2D' ? '2d' : state.phase,
      );
      const image = await canvasImage(page);
      for (const primitive of PRIMITIVES)
        for (const [i, altitude] of ALTITUDES.entries()) {
          const [lon = 0, lat = 0] = primitive.at(i);
          const point = await project(page, lon, lat, altitude);
          if (!point) throw new Error(`${phase.name}: ${primitive.kind} at ${altitude} m off screen`);
          expect(
            near(image, point.xPx, point.yPx, primitive.color),
            `${phase.name}: ${primitive.kind} at ${altitude} m`,
          ).toBe(true);
        }
      // On the flat map heights are scaled like the terrain's relief (ADR 0008): the 10,000 m point is offset from
      // its ground point by exactly the relief factor's share of its height, as the terrain under it would be.
      if (phase.name === '2D') {
        const ground = await project(page, 12.6, 41.9, 0);
        const raised = await project(page, 12.6, 41.9, 10_000);
        const offset = Math.hypot((raised?.xPx ?? 0) - (ground?.xPx ?? 0), (raised?.yPx ?? 0) - (ground?.yPx ?? 0));
        if (state.relief === 0) expect(offset).toBeLessThan(0.01);
        else expect(offset).toBeGreaterThan(0);
      }
    }
  });
}
