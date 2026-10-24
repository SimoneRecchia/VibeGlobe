// The atmosphere (M11, F391–F396) on the atmosphere harness (e2e/support/atmosphere.html), on WebGPU and forced WebGL2:
// sky, limb glow, continuity with altitude, tilt and morph, haze, fog visibility, sun lighting. The engine's own views
// follow once the main session wires the atmosphere into the frame loop (docs/parallel-tracks.md, "Atmosphere hook").
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import {
  bandRunPx,
  darkPixels,
  luma,
  meanDifference,
  project,
  renderFrame,
  setFlatness,
  startAtmosphere,
  subsolar,
  visibility,
  type HarnessPose,
} from './support/atmosphere.ts';
import { CROSS_BACKEND, compareImages, expectMatchesBaseline, viewName } from './support/visual.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;
const WIDTH = 480;
const HEIGHT = 320;
const FULL = { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT };
/** The top quarter of a tilted view: sky only. */
const SKY = { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT / 4 };

/** The canonical views of F391: the globe from orbit and tilted views showing the horizon at several altitudes. */
const VIEWS: Record<string, HarnessPose> = {
  orbit: { lonDeg: 10, latDeg: 30, rangeM: 2.2e7 },
  'orbit-low': { lonDeg: 10, latDeg: 45, rangeM: 3e6, tiltDeg: 40 },
  'tilted-100km': { lonDeg: 8, latDeg: 46, rangeM: 400_000, tiltDeg: 75 },
  'tilted-10km': { lonDeg: 8, latDeg: 46, rangeM: 60_000, tiltDeg: 80 },
  'tilted-ground': { lonDeg: 8, latDeg: 46, rangeM: 3000, tiltDeg: 85 },
};

/** A flight from orbit to the ground along a geometric range, tilting as it descends (F392, F393). */
function flight(frames: number): HarnessPose[] {
  const poses: HarnessPose[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1);
    const rangeM = 2.2e7 * (3000 / 2.2e7) ** t;
    poses.push({ lonDeg: 8, latDeg: 46, rangeM, tiltDeg: 85 * Math.min(1, t * 1.25) });
  }
  return poses;
}

/** The largest frame-to-frame change that is not explained by its neighbors: a glitch, in 8-bit levels (F392, F393). */
const JUMP_LEVELS = 3;
/**
 * A tile boundary whose brightness step stays under this many 8-bit luma levels is not distinguishable from its
 * neighbors (F394): about 1%, below what the seam detector of docs/plan/quality.md flags on imagery.
 */
const SEAM_LEVELS = 3;

/** The mean frame difference between consecutive poses over a region. */
async function frameSteps(page: Page, poses: readonly HarnessPose[], region: typeof FULL): Promise<number[]> {
  const steps: number[] = [];
  let previous: PNG | undefined;
  for (const pose of poses) {
    const image = await renderFrame(page, pose);
    if (previous) steps.push(meanDifference(previous, image, region));
    previous = image;
  }
  return steps;
}

/**
 * Temporal glitch detection: by how much a step exceeds the larger of its two neighbors. A smooth motion changes the
 * frame by similar amounts from step to step, however large; a jump at a phase boundary is an isolated spike.
 */
function largestJump(steps: readonly number[]): number {
  let largest = 0;
  for (let i = 0; i < steps.length; i++) {
    const neighbors = Math.max(steps[i - 1] ?? 0, steps[i + 1] ?? 0);
    largest = Math.max(largest, (steps[i] ?? 0) - neighbors);
  }
  return largest;
}

/** The mean color of a region, per channel. */
function meanColor(image: PNG, region: typeof FULL): [number, number, number] {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const i = (y * image.width + x) * 4;
      for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (image.data[i + c] ?? 0);
      count++;
    }
  }
  return [(sum[0] ?? 0) / count, (sum[1] ?? 0) / count, (sum[2] ?? 0) / count];
}

for (const backend of BACKENDS) {
  test.describe(`atmosphere on ${backend}`, () => {
    test.beforeEach(async ({ page }) => {
      const started = await startAtmosphere(page, { backend });
      expect(started.backend).toBe(backend);
    });

    test(`F391: a sky renders behind the globe and above the horizon (${backend})`, async ({ page }, testInfo) => {
      for (const [name, pose] of Object.entries(VIEWS)) {
        const image = await renderFrame(page, pose);
        if (name === 'tilted-10km' || name === 'tilted-ground') {
          // Inside the atmosphere: no clear color and no black anywhere, the sky fills everything above the horizon.
          expect(darkPixels(image, FULL), `${name}: dark pixels`).toBe(0);
          const [r, g, b] = meanColor(image, SKY);
          expect(b, `${name}: the sky is blue`).toBeGreaterThan(r);
          expect(g + b, `${name}: the sky is bright`).toBeGreaterThan(120);
        }
        await expectMatchesBaseline(page, testInfo, viewName(backend, `atmosphere-${name}`), image);
      }
      // From orbit, the glow lights the pixels just outside the globe's disc, where the clear color showed before.
      const orbit = await renderFrame(page, VIEWS['orbit-low'] ?? { lonDeg: 0, latDeg: 0, rangeM: 1e7 });
      let glow = 0;
      for (let x = 0; x < WIDTH; x += 4) {
        // Down each column from the top: the first non-black pixel is the glow above the limb.
        for (let y = 0; y < HEIGHT; y++) {
          if (luma(orbit, x, y) > 8) {
            glow++;
            break;
          }
        }
      }
      expect(glow).toBeGreaterThan(WIDTH / 4 / 2);
    });

    test(`F392: the glow changes continuously from orbit to the ground, without banding (${backend})`, async ({
      page,
    }) => {
      // 62 frames rendered and read back one by one: 30-40 s on CI's software WebGPU (CI run 636).
      test.setTimeout(120_000);
      const steps = await frameSteps(page, flight(60), SKY);
      expect(largestJump(steps)).toBeLessThan(JUMP_LEVELS);
      // Banding: the same smooth sky gradient quantized without and with dithering.
      // The sky just above the horizon seen from the ground, where its gradient is gentlest.
      const view = VIEWS['tilted-ground'] ?? { lonDeg: 0, latDeg: 0, rangeM: 3000 };
      const banded = await renderFrame(page, view, { dither: false });
      const dithered = await renderFrame(page, view);
      const region = { x0: 0, y0: HEIGHT / 4, x1: WIDTH, y1: (HEIGHT * 3) / 8 };
      const bandedRun = bandRunPx(banded, region, 2);
      const ditheredRun = bandRunPx(dithered, region, 2);
      test.info().annotations.push({
        type: 'measure',
        description: `longest flat run per column: ${bandedRun.toFixed(1)} px undithered, ${ditheredRun.toFixed(1)} px dithered`,
      });
      expect(ditheredRun).toBeLessThan(bandedRun / 2);
      expect(ditheredRun).toBeLessThan(8);
    });

    test(`F393: sky and haze stay continuous through the tilt and the morph to flat (${backend})`, async ({ page }) => {
      // 69 frames: about 21 s locally, more than the default 30 s on CI's runner (docs/test-changes.md).
      test.setTimeout(60_000);
      // The tilt into the 3D view at 20 km, by 2° steps.
      const tilts: HarnessPose[] = [];
      for (let tilt = 0; tilt <= 84; tilt += 2) tilts.push({ lonDeg: 8, latDeg: 46, rangeM: 20_000, tiltDeg: tilt });
      expect(largestJump(await frameSteps(page, tilts, SKY))).toBeLessThan(JUMP_LEVELS);
      // The morph from globe to flat (flatness 0 → 1 in 4% steps), in a tilted view where sky and haze both show.
      const morph: number[] = [];
      let previous: PNG | undefined;
      for (let i = 0; i <= 25; i++) {
        await setFlatness(page, i / 25);
        const image = await renderFrame(page, VIEWS['tilted-100km'] ?? { lonDeg: 0, latDeg: 0, rangeM: 1e5 });
        if (previous) morph.push(meanDifference(previous, image, FULL));
        previous = image;
      }
      await setFlatness(page, 0);
      // The camera stands still: every step is the morph's own, and none stands out.
      expect(Math.max(...morph)).toBeLessThan(3);
      expect(largestJump(morph)).toBeLessThan(JUMP_LEVELS);
    });

    test(`F394: haze fades distant imagery and hides tile steps near the horizon (${backend})`, async ({ page }) => {
      // Looking north along 10° E, the boundary between two 10° tiles of the checker (35% brightness step), at the
      // maximum tilt: the step across the boundary, near the camera and toward the horizon, with and without haze.
      const pose: HarnessPose = { lonDeg: 10, latDeg: 45, rangeM: 30_000, tiltDeg: 85 };
      const measure = async (atmosphere: boolean): Promise<{ near: number; far: number; image: PNG }> => {
        await startAtmosphere(page, { backend, tileSteps: true, atmosphere });
        const image = await renderFrame(page, pose);
        const step = async (latDeg: number): Promise<number> => {
          const at = await project(page, 10, latDeg);
          if (!at) throw new Error(`10° E ${latDeg}° N is behind the camera`);
          return Math.abs(luma(image, at.x + 3, at.y) - luma(image, at.x - 3, at.y));
        };
        return { near: await step(45.3), far: await step(49.5), image };
      };
      const clear = await measure(false);
      const hazed = await measure(true);
      test.info().annotations.push({
        type: 'measure',
        description: `tile step near/far: ${clear.near.toFixed(1)}/${clear.far.toFixed(1)} clear, ${hazed.near.toFixed(1)}/${hazed.far.toFixed(1)} hazed`,
      });
      // Near the camera the step stays visible; toward the horizon the haze brings it below the seam threshold.
      expect(clear.far).toBeGreaterThan(SEAM_LEVELS);
      expect(hazed.near).toBeGreaterThan(SEAM_LEVELS);
      expect(hazed.far).toBeLessThan(SEAM_LEVELS);
      // Distant imagery blends into the haze color: just below the horizon it matches the sky just above it.
      const horizon = (await project(page, 10, 52)) ?? { x: WIDTH / 2, y: HEIGHT / 3 };
      const row = Math.round(horizon.y);
      const below = meanColor(hazed.image, { x0: 0, y0: row + 1, x1: WIDTH, y1: row + 4 });
      const above = meanColor(hazed.image, { x0: 0, y0: Math.max(0, row - 6), x1: WIDTH, y1: Math.max(1, row - 3) });
      for (let c = 0; c < 3; c++) expect(Math.abs((below[c] ?? 0) - (above[c] ?? 0))).toBeLessThan(25);
      expect(darkPixels(hazed.image, FULL)).toBe(0);
    });

    test(`F395: fully hazed ground near the horizon reports near-zero visibility (${backend})`, async ({ page }) => {
      await renderFrame(page, { lonDeg: 5, latDeg: 45, rangeM: 3000, tiltDeg: 85 });
      // Near the camera the ground is clear; 150 km away along the view it is hidden, so its tiles stay coarse.
      expect(await visibility(page, 5, 45)).toBeGreaterThan(0.9);
      expect(await visibility(page, 5, 46.4)).toBeLessThan(0.1);
    });

    test(`F396: sun lighting places the terminator where the Sun's position puts it (${backend})`, async ({ page }) => {
      const pose: HarnessPose = { lonDeg: 0, latDeg: 0, rangeM: 2e7 };
      const unlit = await renderFrame(page, pose);
      // Off unless enabled: the same view lit by the Sun at the March equinox, 18:00 UTC, when the sub-solar point is
      // near 92° W on the equator (sun-position.test.ts checks the ephemeris itself).
      const time = '2024-03-20T18:00:00Z';
      const lit = await renderFrame(page, pose, { sunLighting: true, timeUtc: time });
      expect(meanDifference(unlit, lit, FULL)).toBeGreaterThan(5);
      // Along the equator, the shading crosses from day to night within a few degrees of 90° east of the sub-solar
      // longitude.
      const terminatorDeg = (await subsolar(page, time)).longitudeDeg + 90;
      const samples: { lonDeg: number; luma: number }[] = [];
      for (let lon = -30; lon <= 30; lon += 1) {
        const at = await project(page, lon, 0);
        if (at) samples.push({ lonDeg: lon, luma: luma(lit, at.x, at.y) });
      }
      const day = samples.filter((s) => s.lonDeg <= -20).map((s) => s.luma);
      const night = samples.filter((s) => s.lonDeg >= 15).map((s) => s.luma);
      // Lambert shading falls to the night level exactly at the terminator: the first sample that reaches it.
      expect(Math.min(...day)).toBeGreaterThan(Math.max(...night) + 20);
      const nightLevel = Math.max(...night) + 3;
      const crossing = samples.find((s) => s.luma <= nightLevel)?.lonDeg ?? Number.NaN;
      expect(Math.abs(crossing - terminatorDeg)).toBeLessThan(3);
      // Changing the time moves the terminator without a reload: six hours later the whole band is lit differently.
      const later = await renderFrame(page, pose, { sunLighting: true, timeUtc: '2024-03-21T00:00:00Z' });
      expect(meanDifference(lit, later, FULL)).toBeGreaterThan(5);
    });
  });
}

test('F391: the sky looks the same on WebGPU and forced WebGL2', async ({ browser }) => {
  const images: PNG[] = [];
  for (const backend of BACKENDS) {
    const page = await browser.newPage();
    await startAtmosphere(page, { backend });
    images.push(await renderFrame(page, VIEWS['tilted-10km'] ?? { lonDeg: 0, latDeg: 0, rangeM: 1e5 }));
    await page.close();
  }
  const [webgpu, webgl2] = images;
  if (!webgpu || !webgl2) throw new Error('missing frame');
  expect(compareImages(webgpu, webgl2, CROSS_BACKEND.threshold).ratio).toBeLessThanOrEqual(CROSS_BACKEND.maxDiffRatio);
});
