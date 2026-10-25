// Helpers for end-to-end tests that drive the engine through the playground's test hooks (public API only).
import { expect, type Page } from '@playwright/test';
import type { Globe } from '@vibeglobe/core';
import type { GpuProbeResult } from '@vibeglobe/renderer';
import { PNG } from 'pngjs';
import { hardwareGpu } from '../../scripts/browser/gpu-args.ts';

/** The Chromium build Playwright 1.64.1 pins (its browsers.json), which CI runs and the baselines come from. */
const PINNED_CHROMIUM = '156.0.8078.4';

/** What the scenario harness reports (apps/playground/src/scenario-harness.ts). */
export interface ScenarioReport {
  frames: number;
  staticFrames: number;
  holes: number;
  firstHoleFrame: number;
  dark: number;
  firstDarkFrame: number;
  firstHole?: { xPx: number; yPx: number; latitudeDeg: number; longitudeDeg: number };
  pops: number;
  firstPopFrame: number;
  terrainDrops: number;
  firstTerrainDropFrame: number;
  minReliefAboveHorizonPx: number;
  maxChangedShare: number;
  maxChangedFrame: number;
  /**
   * Per frame: zoom, morph factor, relief factor, applied tilt (degrees), view mode, phase, heading (degrees) and the
   * eye's height above the ellipsoid (meters).
   */
  samples: [number, number, number, number, string, string, number, number][];
}

declare global {
  interface Window {
    /** The playground's test hooks (apps/playground/src/test-hooks.ts). */
    vibeglobePlayground?: {
      readonly globe: Globe;
      readonly globes: readonly Globe[];
      readonly events: { readonly type: string; readonly payload: unknown }[];
      cpuFrameTimesMs(): number[];
      resetCpuSamples(): void;
      mount(
        canvas?: HTMLCanvasElement,
        backend?: 'auto' | 'webgpu' | 'webgl2',
      ): { globe: Globe; canvas: HTMLCanvasElement; unmount(): void };
      workerTask(task: string, input: unknown, transfer: Transferable[]): Promise<string>;
      recordScenario(name: string, darkBelow?: number): Promise<ScenarioReport>;
      checkFrame(darkBelow?: number): Promise<ScenarioReport>;
      showHud(on: boolean): void;
      loggedLevels(): string[];
      loggedEntries(): { level: string; message: string; timeMs: number }[];
      clearLog(): void;
      geodesicDistanceMeters(
        from: { longitudeDeg: number; latitudeDeg: number },
        to: { longitudeDeg: number; latitudeDeg: number },
      ): number;
    };
    /** The GPU probes' result on `?experiment=gpu-probes` (apps/playground/src/gpu-probes.ts). */
    vibeglobeGpuProbes?: GpuProbeResult | { readonly error: string };
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
  // A test that names a backend runs on it: a forced backend never falls back (KB-019).
  const forced = /backend=(webgpu|webgl2)/.exec(query)?.[1];
  if (forced) expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe(forced);
  await expectTestEnvironment(page);
}

/**
 * Waits for the next display frame: the engine applies input recorded by its controls at the start of a frame (ADR
 * 0009), so a camera query right after a mouse event needs it. The engine's frame callback, requested by the event,
 * runs before this one.
 */
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

/**
 * Waits until the engine has drawn every requested frame and gone idle: no frame for 300 ms, and none in the next two
 * animation frames. A frame the engine requested (a running cross-fade, for one) is drawn in the same animation frame
 * as a callback registered after it, so a slow frame of a software GPU, longer than 300 ms, is not taken for idle.
 */
export async function waitForIdle(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const globe = window.vibeglobePlayground?.globe;
        if (!globe) throw new Error('no globe');
        let last = globe.frameNumber;
        const again = (): void => {
          last = globe.frameNumber;
          check();
        };
        const check = (): void => {
          setTimeout(() => {
            if (globe.frameNumber !== last) return again();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => (globe.frameNumber === last ? resolve(last) : again())),
            );
          }, 300);
        };
        check();
      }),
  );
}

/**
 * The globe's current frame, read back by the engine (ADR 0012, Capture: never a page screenshot) and composited over
 * the page background the canvas is transparent against. `index` picks the instance on pages with several. The one
 * exception: the engine refuses to read back display-only content (Google, F323), so a frame showing it comes from the
 * browser's screenshot of the globe's canvas.
 */
export async function canvasImage(page: Page, index = 0): Promise<PNG> {
  const frame = await page.evaluate(async (i) => {
    const globe = window.vibeglobePlayground?.globes[i];
    // A capture that never completes (no frame could be drawn) fails with the engine's state, to investigate in CI.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const state = globe && {
          frames: globe.frameNumber,
          renderer: globe.rendererStats(),
          resources: globe.resourceCounts(),
          terrain: globe.terrainStats(),
          imagery: globe.imageryStats(),
          size: [globe.camera.zoom, document.querySelector('canvas')?.width, document.querySelector('canvas')?.height],
        };
        reject(new Error(`captureFrame did not complete in 60 s: ${JSON.stringify(state)}`));
      }, 60_000);
    });
    const capture = await Promise.race([globe?.captureFrame(), stalled])
      .catch((error: unknown) => {
        if ((error as { code?: string }).code !== 'display-only') throw error;
        // Marks the instance's canvas (the largest in its container) for the screenshot.
        const canvases = [...document.querySelectorAll('canvas')].sort(
          (a, b) => b.width * b.height - a.width * a.height,
        );
        canvases[i]?.setAttribute('data-vg-capture', String(i));
        return null;
      })
      .finally(() => clearTimeout(timer));
    if (capture === null) return null;
    if (!capture) throw new Error(`no globe ${i}`);
    const bytes = new Uint8Array(capture.rgba.buffer, capture.rgba.byteOffset, capture.rgba.byteLength);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { widthPx: capture.widthPx, heightPx: capture.heightPx, base64: btoa(binary) };
  }, index);
  if (frame === null)
    return PNG.sync.read(await page.locator(`canvas[data-vg-capture="${String(index)}"]`).screenshot());
  const rgba = Buffer.from(frame.base64, 'base64');
  const image = new PNG({ width: frame.widthPx, height: frame.heightPx });
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] ?? 0;
    for (let channel = 0; channel < 3; channel++) {
      const color = rgba[i + channel] ?? 0;
      image.data[i + channel] = Math.round((color * alpha + (BACKGROUND_RGB[channel] ?? 0) * (255 - alpha)) / 255);
    }
    image.data[i + 3] = 255;
  }
  return image;
}

/** A screenshot of an element as the page shows it: for DOM behavior (what the browser composites), not frames. */
export async function pageImage(page: Page, selector: string): Promise<PNG> {
  return PNG.sync.read(await page.locator(selector).screenshot());
}

/**
 * ADR 0012's start-up assertions: on Chromium with the software GPU the renderer is SwiftShader, and in CI the browser
 * is the pinned build. A mismatch fails the test; it is never a skip.
 */
async function expectTestEnvironment(page: Page): Promise<void> {
  const browser = page.context().browser();
  if (browser?.browserType().name() !== 'chromium' || hardwareGpu()) return;
  const adapter = await page.evaluate(() => window.vibeglobePlayground?.globe.capabilities?.adapter ?? '');
  expect(adapter, 'the software GPU').toMatch(/swiftshader/i);
  if (process.env['CI']) expect(browser.version(), 'the pinned Chromium').toBe(PINNED_CHROMIUM);
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
export async function silhouetteRadiusPx(page: Page, index = 0, selector = '#globe'): Promise<number> {
  const { rangeMeters, heightPx } = await page.evaluate(
    ([i, s]) => ({
      rangeMeters: window.vibeglobePlayground?.globes[i]?.camera.rangeMeters ?? NaN,
      heightPx: document.querySelector(s)?.clientHeight ?? NaN,
    }),
    [index, selector] as const,
  );
  const distance = rangeMeters + WGS84_B;
  const angular = Math.asin(WGS84_B / distance);
  return (Math.tan(angular) / Math.tan(FOV_Y_RAD / 2)) * (heightPx / 2) - 1.5;
}

/** Asserts that every pixel inside the globe's silhouette shows imagery. */
export async function expectCompleteGlobe(page: Page, index = 0, selector = '#globe'): Promise<void> {
  await waitForIdle(page);
  const radius = await silhouetteRadiusPx(page, index, selector);
  expect(emptyPixelsInside(await canvasImage(page, index), radius)).toBe(0);
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

/**
 * A playground query that keeps M3 and M4's view geometry (`?curves=`): the globe never flattens and relief is full at
 * every zoom. For tests of imagery and terrain rendering whose views M5's Auto curves would otherwise turn into the flat
 * map or flat terrain (ADR 0034).
 */
export const GLOBE_GEOMETRY = `curves=${encodeURIComponent(
  JSON.stringify({
    morph: { startGroundZoom: 40, endGroundZoom: 41 },
    relief: { startGroundZoom: -2, endGroundZoom: -1 },
    tilt: { startGroundZoom: 41, endGroundZoom: 42 },
  }),
)}`;
