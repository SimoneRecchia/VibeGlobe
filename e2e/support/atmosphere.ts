// Node-side helpers of the atmosphere track's end-to-end tests: open the harness page (e2e/support/atmosphere.html),
// start it on a backend, set views and options, read frames, and measure them.
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';

const PAGE = `/@fs${resolve('e2e/support/atmosphere.html')}`;

export interface HarnessConfig {
  readonly backend: 'webgpu' | 'webgl2';
  readonly depth?: 'auto' | 'fragment';
  readonly atmosphere?: boolean;
  readonly tileSteps?: boolean;
}

export interface HarnessPose {
  readonly lonDeg: number;
  readonly latDeg: number;
  readonly heightM?: number;
  readonly rangeM: number;
  readonly headingDeg?: number;
  readonly tiltDeg?: number;
}

export interface HarnessOptions {
  readonly sunLighting?: boolean;
  readonly timeUtc?: string;
  readonly haze?: number;
  readonly quality?: 'low' | 'medium' | 'high' | 'ultra';
  readonly dither?: boolean;
}

/** The harness the page installs (`packages/renderer/src/atmosphere/harness.ts`), as the tests call it. */
interface PageHarness {
  start(config: HarnessConfig): Promise<{ backend: string; depthPath: string }>;
  setView(pose: HarnessPose): void;
  setOptions(options: HarnessOptions): void;
  setFlatness(flatness: number): void;
  frame(): Promise<{ widthPx: number; heightPx: number; base64: string }>;
  project(lonDeg: number, latDeg: number): { x: number; y: number } | null;
  visibility(lonDeg: number, latDeg: number): number;
  subsolar(timeUtc: string): { latitudeDeg: number; longitudeDeg: number };
}

declare global {
  interface Window {
    atmosphereHarness?: PageHarness;
  }
}

/** Opens the harness page at a fixed size and starts it; resolves with the backend and depth path in use. */
export async function startAtmosphere(
  page: Page,
  config: HarnessConfig,
): Promise<{ backend: string; depthPath: string }> {
  await page.setViewportSize({ width: 480, height: 320 });
  await page.goto(PAGE);
  await page.waitForFunction(() => window.atmosphereHarness !== undefined, undefined, { timeout: 60_000 });
  return page.evaluate((c) => {
    const h = window.atmosphereHarness;
    if (!h) throw new Error('no harness');
    return h.start(c);
  }, config);
}

/** Sets the view and options, renders a frame and returns it (alpha composited over black, as space). */
export async function renderFrame(page: Page, pose: HarnessPose, options: HarnessOptions = {}): Promise<PNG> {
  const frame = await page.evaluate(
    async ({ p, o }) => {
      const h = window.atmosphereHarness;
      if (!h) throw new Error('no harness');
      h.setView(p);
      h.setOptions(o);
      return h.frame();
    },
    { p: pose, o: options },
  );
  return toPng(frame);
}

/** Sets the morph's flatness for the next frames (F393). */
export async function setFlatness(page: Page, flatness: number): Promise<void> {
  await page.evaluate((f) => window.atmosphereHarness?.setFlatness(f), flatness);
}

/** Screen position of a point on the ellipsoid in the current view. */
export async function project(page: Page, lonDeg: number, latDeg: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(({ lon, lat }) => window.atmosphereHarness?.project(lon, lat) ?? null, {
    lon: lonDeg,
    lat: latDeg,
  });
}

/** The fog visibility of a point in the current view (F395). */
export async function visibility(page: Page, lonDeg: number, latDeg: number): Promise<number> {
  return page.evaluate(({ lon, lat }) => window.atmosphereHarness?.visibility(lon, lat) ?? Number.NaN, {
    lon: lonDeg,
    lat: latDeg,
  });
}

/** The sub-solar point the harness computes for a time (F396). */
export async function subsolar(page: Page, timeUtc: string): Promise<{ latitudeDeg: number; longitudeDeg: number }> {
  return page.evaluate((t) => {
    const h = window.atmosphereHarness;
    if (!h) throw new Error('no harness');
    return h.subsolar(t);
  }, timeUtc);
}

function toPng(frame: { widthPx: number; heightPx: number; base64: string }): PNG {
  const rgba = Buffer.from(frame.base64, 'base64');
  const image = new PNG({ width: frame.widthPx, height: frame.heightPx });
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] ?? 0;
    for (let channel = 0; channel < 3; channel++) image.data[i + channel] = ((rgba[i + channel] ?? 0) * alpha) / 255;
    image.data[i + 3] = 255;
  }
  return image;
}

/** RGB of a pixel. */
function pixel(image: PNG, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
}

/** Rec. 709 luma of a pixel, 0 to 255. */
export function luma(image: PNG, x: number, y: number): number {
  const [r, g, b] = pixel(image, x, y);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Pixels whose channels are all at most `level`: black or near black. */
export function darkPixels(image: PNG, region: { x0: number; y0: number; x1: number; y1: number }, level = 4): number {
  let count = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const [r, g, b] = pixel(image, x, y);
      if (r <= level && g <= level && b <= level) count++;
    }
  }
  return count;
}

/** Mean absolute per-channel difference between two frames over a region, 0 to 255. */
export function meanDifference(a: PNG, b: PNG, region = { x0: 0, y0: 0, x1: a.width, y1: a.height }): number {
  let sum = 0;
  let count = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0));
      count += 3;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * The longest run of identical values along each column of a region, averaged over the columns where the region's
 * values change from top to bottom by at least `minRange` levels: a smooth gradient quantized to 8 bits without
 * dithering shows long flat runs (bands), a dithered one only short runs (F392).
 */
export function bandRunPx(
  image: PNG,
  region: { x0: number; y0: number; x1: number; y1: number },
  minRange = 6,
): number {
  let total = 0;
  let columns = 0;
  for (let x = region.x0; x < region.x1; x++) {
    let longest = 0;
    let run = 0;
    let previous = -1;
    let low = 255;
    let high = 0;
    for (let y = region.y0; y < region.y1; y++) {
      const [, , b] = pixel(image, x, y);
      low = Math.min(low, b);
      high = Math.max(high, b);
      run = b === previous ? run + 1 : 1;
      previous = b;
      longest = Math.max(longest, run);
    }
    if (high - low < minRange) continue;
    total += longest;
    columns++;
  }
  return columns === 0 ? Number.NaN : total / columns;
}
