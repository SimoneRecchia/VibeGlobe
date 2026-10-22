// Node-side helpers of the M6 input track's end-to-end tests: open the controls harness page, record frames, and
// dispatch multi-touch input through the Chrome DevTools Protocol.
import { resolve } from 'node:path';
import { expect, type CDPSession, type Page } from '@playwright/test';
import type { CameraState, GeoPosition, ScreenPoint } from '@vibeglobe/core';
import type { RecordedFrame } from './controls-page.ts';

export type { RecordedFrame };

const PAGE = `/@fs${resolve('e2e/support/controls.html')}`;
/** The harness canvas's top-left corner in the page (no margins, unless `embed`). */
export const CANVAS = { widthPx: 800, heightPx: 600 } as const;

/** Opens the harness with a query string and waits for the first complete frame. */
export async function openControls(page: Page, query = ''): Promise<void> {
  await page.goto(`${PAGE}?${query}`);
  await page.waitForFunction(() => window.controlsHarness !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(async () => window.controlsHarness?.globe.ready);
  const forced = /backend=(webgpu|webgl2)/.exec(query)?.[1];
  if (forced) expect(await page.evaluate(() => window.controlsHarness?.globe.backend)).toBe(forced);
}

/** The canvas's top-left corner in page coordinates (the page may scroll in `embed` mode). */
export async function canvasOrigin(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const rect = document.querySelector('#globe')?.getBoundingClientRect();
    return { x: rect?.left ?? 0, y: rect?.top ?? 0 };
  });
}

/** The position under a canvas point, or null off the globe. */
export async function positionAt(page: Page, point: ScreenPoint): Promise<GeoPosition | null> {
  return page.evaluate((p) => window.controlsHarness?.globe.screenToGeo(p) ?? null, point);
}

/** Starts recording frames with positions and screen points tracked. */
export async function record(page: Page, positions: GeoPosition[], points: ScreenPoint[] = []): Promise<void> {
  await page.evaluate(([g, p]) => window.controlsHarness?.record(g, p), [positions, points] as const);
}

/** Stops recording and returns the frames. */
export async function frames(page: Page): Promise<RecordedFrame[]> {
  return page.evaluate(() => window.controlsHarness?.frames() ?? []);
}

/** The applied camera. */
export async function camera(page: Page): Promise<CameraState> {
  return page.evaluate(() => {
    const globe = window.controlsHarness?.globe;
    if (!globe) throw new Error('The harness has no globe');
    return { ...globe.camera };
  });
}

/**
 * Waits until no frame was drawn for 1.5 s (inertia and animations are over): software GPUs in CI draw a frame in up
 * to about half a second.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolveSettled) => {
        const globe = window.controlsHarness?.globe;
        let timer = setTimeout(done, 1500);
        const off = globe?.on('frame', () => {
          clearTimeout(timer);
          timer = setTimeout(done, 1500);
        });
        function done(): void {
          off?.();
          resolveSettled();
        }
      }),
  );
}

/** A touch point in canvas pixels. */
export interface TouchPoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** Multi-touch input through CDP (Chromium): each call is one touch event with every active point. */
export class Touch {
  private readonly cdp: CDPSession;
  private readonly origin: { x: number; y: number };

  private constructor(cdp: CDPSession, origin: { x: number; y: number }) {
    this.cdp = cdp;
    this.origin = origin;
  }

  static async create(page: Page): Promise<Touch> {
    const cdp = await page.context().newCDPSession(page);
    return new Touch(cdp, await canvasOrigin(page));
  }

  private points(points: readonly TouchPoint[]) {
    return points.map((p) => ({ x: this.origin.x + p.x, y: this.origin.y + p.y, id: p.id, radiusX: 1, radiusY: 1 }));
  }

  async start(points: readonly TouchPoint[]): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: this.points(points) });
  }

  async move(points: readonly TouchPoint[]): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: this.points(points) });
  }

  /** Lifts every point not in `remaining`. */
  async end(remaining: readonly TouchPoint[] = []): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: this.points(remaining) });
  }
}

/** Largest distance in pixels between where a tracked position shows and where it should, over recorded frames. */
export function maxDrift(
  recordedFrames: RecordedFrame[],
  expected: (frame: RecordedFrame) => ScreenPoint | null,
  index = 0,
): number {
  let worst = 0;
  for (const frame of recordedFrames) {
    const want = expected(frame);
    const got = frame.screens[index];
    if (!want || !got) continue;
    worst = Math.max(worst, Math.hypot(got.xPx - want.xPx, got.yPx - want.yPx));
  }
  return worst;
}

/** Ground-scale zoom from the camera range (the public Mercator zoom also moves with the target latitude). */
export function groundZoom(state: CameraState): number {
  return -Math.log2(state.rangeMeters);
}
