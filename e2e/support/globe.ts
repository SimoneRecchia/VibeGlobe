// Helpers for end-to-end tests that drive the engine through the playground's test hooks (public API only).
import { expect, type Page } from '@playwright/test';
import type { Globe } from '@vibeglobe/core';
import { PNG } from 'pngjs';

declare global {
  interface Window {
    /** The playground's test hooks (apps/playground/src/test-hooks.ts). */
    vibeglobePlayground?: {
      readonly globe: Globe;
      readonly globes: readonly Globe[];
      readonly events: { readonly type: string; readonly payload: unknown }[];
      cpuFrameTimesMs(): number[];
      resetCpuSamples(): void;
    };
  }
}

/** The playground page background behind a transparent canvas (index.html `background: #0b1020`). */
export const BACKGROUND_RGB: readonly [number, number, number] = [11, 16, 32];
const FOV_Y_RAD = 0.6435011087932844;
const WGS84_B = 6356752.314245179;

/** Opens the playground with a query string and waits for the first complete frame. */
export async function openGlobe(page: Page, query = ''): Promise<void> {
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
  await page.evaluate(async () => window.vibeglobePlayground?.globe.ready);
}

/** Waits until the engine has drawn every requested frame and gone idle. */
export async function waitForIdle(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const globe = window.vibeglobePlayground?.globe;
        if (!globe) throw new Error('no globe');
        let last = globe.frameNumber;
        const check = (): void => {
          setTimeout(() => {
            if (globe.frameNumber === last) resolve(last);
            else {
              last = globe.frameNumber;
              check();
            }
          }, 300);
        };
        check();
      }),
  );
}

/** Decodes a screenshot of the globe canvas. */
export async function canvasImage(page: Page, selector = '#globe'): Promise<PNG> {
  return PNG.sync.read(await page.locator(selector).screenshot());
}

/** Counts background-colored (or black) pixels inside a circle around the image center. */
export function emptyPixelsInside(image: PNG, radiusPx: number): number {
  let empty = 0;
  const cx = image.width / 2;
  const cy = image.height / 2;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > radiusPx * radiusPx) continue;
      const i = (y * image.width + x) * 4;
      const r = image.data[i] ?? 0;
      const g = image.data[i + 1] ?? 0;
      const b = image.data[i + 2] ?? 0;
      const isBackground =
        Math.abs(r - BACKGROUND_RGB[0]) + Math.abs(g - BACKGROUND_RGB[1]) + Math.abs(b - BACKGROUND_RGB[2]) < 12;
      if (isBackground || r + g + b < 15) empty++;
    }
  }
  return empty;
}

/**
 * The radius in CSS pixels inside which a straight-down view must show the globe: the projected silhouette of the
 * ellipsoid's polar-radius sphere, which the ellipsoid always contains, shrunk by 1.5 px for anti-aliasing.
 */
export async function silhouetteRadiusPx(page: Page): Promise<number> {
  const { rangeMeters, heightPx } = await page.evaluate(() => ({
    rangeMeters: window.vibeglobePlayground?.globe.camera.rangeMeters ?? NaN,
    heightPx: document.querySelector('#globe')?.clientHeight ?? NaN,
  }));
  const distance = rangeMeters + WGS84_B;
  const angular = Math.asin(WGS84_B / distance);
  return (Math.tan(angular) / Math.tan(FOV_Y_RAD / 2)) * (heightPx / 2) - 1.5;
}

/** Asserts that every pixel inside the globe's silhouette shows imagery. */
export async function expectCompleteGlobe(page: Page): Promise<void> {
  await waitForIdle(page);
  const radius = await silhouetteRadiusPx(page);
  expect(emptyPixelsInside(await canvasImage(page), radius)).toBe(0);
}

/** The screen point of a geographic position, through the engine's public API. */
export async function geoToScreen(
  page: Page,
  position: { longitudeDeg: number; latitudeDeg: number },
): Promise<{ xPx: number; yPx: number }> {
  const point = await page.evaluate((p) => window.vibeglobePlayground?.globe.geoToScreen(p), position);
  if (!point) throw new Error('position not on screen');
  return point;
}

/** The geographic position under a canvas point, through the engine's public API. */
export async function screenToGeo(
  page: Page,
  point: { xPx: number; yPx: number },
): Promise<{ longitudeDeg: number; latitudeDeg: number } | undefined> {
  return page.evaluate((p) => window.vibeglobePlayground?.globe.screenToGeo(p), point);
}
