// Anti-aliasing (M11, F397): terrain silhouettes, thin lines and extruded buildings have smooth edges on WebGPU and
// forced WebGL2 (multisampling, ADR 0010), and a slow pan shows no edge shimmer. The cost of anti-aliasing within the
// per-frame GPU budget is measured on real GPUs only (docs/hardening-backlog.md).
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 320 } });

/**
 * The documented threshold: of the steep steps across slanted edges, at least 15% have a blended pixel between their
 * two sides with anti-aliasing (MSAA draws about 25% on thin lines, 45% on extrusions, 90% on the globe's limb), and
 * under 5% without it (`?antialias=0`): an aliased edge jumps from one side's color to the other's in one pixel.
 */
const SMOOTH_SHARE = 0.15;
const ALIASED_SHARE = 0.05;
/** A frame-to-frame change this many times its neighbors' during a slow pan is shimmer (temporal glitch detection). */
const SHIMMER_JUMP = 3;

const luminance = (image: PNG, x: number, y: number): number => {
  const i = (y * image.width + x) * 4;
  return 0.2126 * (image.data[i] ?? 0) + 0.7152 * (image.data[i + 1] ?? 0) + 0.0722 * (image.data[i + 2] ?? 0);
};

/** Slanted steps found, and the share of them smoothed. */
interface Edges {
  readonly steps: number;
  readonly share: number;
}

/**
 * Steps along rows: a step of at least 60 luminance levels over three pixels whose edge is slanted (the step one row
 * below or above moved), smoothed when a pixel lies between 20% and 80% of the way across it.
 */
function rowSteps(image: PNG): Edges {
  let steps = 0;
  let smooth = 0;
  const stepAt = (x: number, y: number): boolean => Math.abs(luminance(image, x + 3, y) - luminance(image, x, y)) >= 60;
  for (let y = 1; y + 1 < image.height; y++)
    for (let x = 0; x + 3 < image.width; x++) {
      if (!stepAt(x, y) || stepAt(x, y + 1) === stepAt(x, y - 1)) continue;
      const a = luminance(image, x, y);
      const b = luminance(image, x + 3, y);
      steps++;
      for (let k = 1; k < 3; k++) {
        const t = (luminance(image, x + k, y) - a) / (b - a);
        if (t > 0.2 && t < 0.8) {
          smooth++;
          break;
        }
      }
      x += 2;
    }
  return { steps, share: steps === 0 ? 0 : smooth / steps };
}

/**
 * The silhouette against the background (the top-left pixel's color), column by column from the top: where it moves
 * between columns its edge is slanted, smoothed when its first pixel is a blend of the background and what lies below.
 */
function silhouette(image: PNG): Edges {
  const background = luminance(image, 0, 0);
  let previous = -1;
  let steps = 0;
  let smooth = 0;
  for (let x = 0; x < image.width; x++) {
    let top = -1;
    for (let y = 0; y + 3 < image.height; y++)
      if (Math.abs(luminance(image, x, y) - background) > 4) {
        top = y;
        break;
      }
    if (top > 0 && previous > 0 && top !== previous) {
      steps++;
      const t = (luminance(image, x, top) - background) / (luminance(image, x, top + 2) - background);
      if (t > 0.05 && t < 0.8) smooth++;
    }
    previous = top;
  }
  return { steps, share: steps === 0 ? 0 : smooth / steps };
}

/** The mean absolute difference between two frames. */
function difference(a: PNG, b: PNG): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++) sum += Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0));
  return sum / ((a.data.length / 4) * 3);
}

const SCENES = [
  // The terrain's silhouette at the globe's limb, seen from orbit.
  ['terrain silhouettes', 'scenario=terrain-alps&lon=7&lat=20&zoom=2.2', silhouette],
  ['thin lines', 'scenario=data-lines&lon=12.5&lat=41.9&zoom=10.5&tilt=30&heading=15', rowSteps],
  ['extruded buildings', 'scenario=data-extrusions&lon=12.4975&lat=41.889&zoom=13.3&tilt=35&heading=25', rowSteps],
] as const;

async function frame(page: Page): Promise<PNG> {
  await waitForIdle(page);
  return canvasImage(page);
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`terrain silhouettes, thin lines and extruded buildings have smooth edges, and a slow pan does not shimmer, on ${backend} (F397)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    for (const [name, query, measure] of SCENES) {
      await openGlobe(page, `backend=${backend}&${query}&antialias=0`);
      const aliased = measure(await frame(page));
      await openGlobe(page, `backend=${backend}&${query}`);
      const { steps, share } = measure(await frame(page));
      console.log(
        `[antialiasing] ${backend} ${name}: ${steps} slanted steps, ${(share * 100).toFixed(0)}% smoothed (${(aliased.share * 100).toFixed(0)}% without)`,
      );
      expect(steps, `${name}: slanted edges in view`).toBeGreaterThan(20);
      expect(share, `${name}: smoothed edges`).toBeGreaterThanOrEqual(SMOOTH_SHARE);
      expect(aliased.share, `${name}: smoothed edges without anti-aliasing (the measure)`).toBeLessThan(ALIASED_SHARE);
      // A slow pan, a fraction of a pixel per frame: edges move smoothly, no frame changes far more than its neighbors.
      const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
      if (!camera) throw new Error('no camera');
      const changes: number[] = [];
      let previous = await frame(page);
      for (let i = 1; i <= 12; i++) {
        await page.evaluate(
          ({ c, step }) =>
            window.vibeglobePlayground?.globe.jumpTo({
              longitudeDeg: c.longitudeDeg + step,
              latitudeDeg: c.latitudeDeg,
            }),
          { c: camera, step: i * 2e-5 * 2 ** (13.3 - camera.zoom) },
        );
        const next = await frame(page);
        changes.push(difference(previous, next));
        previous = next;
      }
      for (let i = 0; i < changes.length; i++) {
        const neighbors = Math.max(changes[i - 1] ?? 0, changes[i + 1] ?? 0, 0.05);
        expect(
          changes[i] ?? 0,
          `${name}: pan step ${String(i)} (${changes.map((c) => c.toFixed(2)).join(', ')})`,
        ).toBeLessThan(neighbors * SHIMMER_JUMP);
      }
    }
  });

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`the antialias quality setting changes the edges at run time: none aliased, msaa4 and fxaa smoothed, on ${backend} (KB-140, F398)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const [, query, measure] = SCENES[1];
    await openGlobe(page, `backend=${backend}&${query}`);
    const shares: Record<string, number> = {};
    for (const antialias of ['none', 'msaa4', 'fxaa', 'none'] as const) {
      await page.evaluate(
        (mode) => window.vibeglobePlayground?.globe.setQualitySettings({ antialias: mode }),
        antialias,
      );
      // The change rebuilds the renderer or its passes: wait until the frames show it.
      await expect
        .poll(
          async () => (await page.evaluate(() => window.vibeglobePlayground?.globe.qualitySettings.antialias)) ?? '',
        )
        .toBe(antialias);
      const { steps, share } = measure(await frame(page));
      shares[antialias] = share;
      console.log(
        `[antialiasing] ${backend} ${antialias}: ${steps} slanted steps, ${(share * 100).toFixed(0)}% smoothed`,
      );
      expect(steps, `${antialias}: slanted edges in view`).toBeGreaterThan(20);
      if (antialias === 'none') expect(share, 'none: aliased').toBeLessThan(ALIASED_SHARE);
      else expect(share, `${antialias}: smoothed`).toBeGreaterThanOrEqual(SMOOTH_SHARE);
    }
  });
