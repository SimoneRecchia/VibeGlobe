// Support of the vector tile specs (ADR 0131): open a `mvt-*` scenario of the playground, wait until its tiles are
// laid out and the engine is idle, and read the layer through `window.vibeglobeVectorTiles`.
import { expect, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import type { VectorTileLayer } from '@vibeglobe/layers/vector-tiles';
import { canvasImage, openGlobe, waitForIdle } from '../support/globe.ts';

declare global {
  interface Window {
    vibeglobeVectorTiles?: { layer: VectorTileLayer | undefined; error: string | undefined; ready: Promise<unknown> };
  }
}

/** Both backends, as every vector tile feature must render the same on them. */
export const BACKENDS = ['webgpu', 'webgl2'] as const;

/** Opens a playground URL with a vector style and waits for its layer. */
export async function openVector(page: Page, query: string): Promise<void> {
  await openGlobe(page, query);
  await page.waitForFunction(
    () => window.vibeglobeVectorTiles?.layer !== undefined || window.vibeglobeVectorTiles?.error !== undefined,
  );
  expect(await page.evaluate(() => window.vibeglobeVectorTiles?.error)).toBeUndefined();
  await settle(page);
}

/** Waits until no vector tile loads and the engine is idle (fades done). */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.vibeglobeVectorTiles?.layer?.loadingTiles() === 0, null, { timeout: 60_000 });
  await waitForIdle(page);
  await page.waitForFunction(() => window.vibeglobeVectorTiles?.layer?.loadingTiles() === 0, null, { timeout: 60_000 });
  await waitForIdle(page);
}

/** The frame as the engine draws it now. */
export function capture(page: Page): Promise<PNG> {
  return canvasImage(page);
}

/** The RGB of a pixel. */
export function rgbAt(image: PNG, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
}

/** Whether two colors differ by at most `tolerance` per channel. */
export function near(a: readonly number[], b: readonly number[], tolerance = 8): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tolerance);
}

/** Counts the pixels of an image within `tolerance` of a color. */
export function countColor(image: PNG, rgb: readonly number[], tolerance = 8): number {
  let n = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (near([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0], rgb, tolerance)) n++;
  }
  return n;
}

/** A hex color as RGB. */
export function hex(color: string): [number, number, number] {
  const v = Number.parseInt(color.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Counts the pixels whose whole 3 × 3 neighborhood is within `tolerance` of a color: areas of it (holes), not the
 * anti-aliased edges of other colors that pass through it.
 */
export function countArea(image: PNG, rgb: readonly number[], tolerance = 8): number {
  const match = (x: number, y: number) => {
    const i = (y * image.width + x) * 4;
    return near([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0], rgb, tolerance);
  };
  let n = 0;
  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      let all = true;
      for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1 && all; dx++) all = match(x + dx, y + dy);
      if (all) n++;
    }
  }
  return n;
}
