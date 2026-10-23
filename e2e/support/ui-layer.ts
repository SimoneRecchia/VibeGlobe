// The ui package mounted on the playground's globe, for the UI and GIS utilities track's end-to-end tests. The
// playground stays as it is: the tests import the package's sources through the Vite dev server and use the engine
// through its public API only (docs/parallel-tracks.md).
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type * as GisModule from '@vibeglobe/gis';
import type * as LayersModule from '@vibeglobe/layers';
import type * as UiModule from '@vibeglobe/ui';
import { openGlobe } from './globe.ts';

/** What the tests reach on the page (`window.vibeglobeUi`). */
interface UiTestHandle {
  readonly ui: typeof UiModule;
  readonly gis: typeof GisModule;
  readonly layer: UiModule.Ui;
  /** `@vibeglobe/layers`, loaded on demand by {@link loadLayers}. */
  layers?: typeof LayersModule;
}

declare global {
  interface Window {
    vibeglobeUi?: UiTestHandle;
  }
}

const UI_ENTRY = `/@fs${resolve('packages/ui/src/index.ts')}`;
const GIS_ENTRY = `/@fs${resolve('packages/gis/src/index.ts')}`;
const LAYERS_ENTRY = `/@fs${resolve('packages/layers/src/index.ts')}`;

/** Loads `@vibeglobe/layers` into the page as `window.vibeglobeUi.layers`. */
export async function loadLayers(page: Page): Promise<void> {
  await page.evaluate(async (entry) => {
    const handle = window.vibeglobeUi;
    if (handle === undefined) throw new Error('no ui');
    handle.layers = (await import(/* @vite-ignore */ entry)) as typeof LayersModule;
  }, LAYERS_ENTRY);
}

/** Options of {@link openUi}. */
export interface OpenUiOptions {
  /** Playground query string. */
  readonly query?: string;
  readonly debug?: boolean;
  readonly theme?: 'light' | 'dark';
  readonly language?: string;
  /** Adds the default controls (default true); 'all' adds every navigation control (`addAllControls`). */
  readonly defaults?: boolean | 'all';
}

/** Opens the playground, waits for its first frame and adds a UI layer with the default controls. */
export async function openUi(page: Page, options: OpenUiOptions = {}): Promise<void> {
  await openGlobe(page, options.query ?? '');
  await page.evaluate(
    async ({ uiEntry, gisEntry, debug, theme, language, defaults }) => {
      const ui = (await import(/* @vite-ignore */ uiEntry)) as typeof UiModule;
      const gis = (await import(/* @vite-ignore */ gisEntry)) as typeof GisModule;
      const globe = window.vibeglobePlayground?.globe;
      const container = document.getElementById('app');
      if (globe === undefined || container === null) throw new Error('no playground globe');
      const layer = ui.createUi(globe, container, { theme, ...(language === undefined ? {} : { language }) });
      if (defaults === 'all') ui.addAllControls(layer, { debug });
      else if (defaults) ui.addDefaultControls(layer, { debug });
      window.vibeglobeUi = { ui, gis, layer };
    },
    {
      uiEntry: UI_ENTRY,
      gisEntry: GIS_ENTRY,
      debug: options.debug ?? false,
      theme: options.theme ?? 'light',
      language: options.language,
      defaults: options.defaults ?? true,
    },
  );
}

/** The camera's zoom and heading. */
export async function cameraOf(
  page: Page,
): Promise<{ zoom: number; headingDeg: number; tiltDeg: number; lon: number; lat: number }> {
  return page.evaluate(() => {
    const camera = window.vibeglobePlayground?.globe.camera;
    if (camera === undefined) throw new Error('no globe');
    return {
      zoom: camera.zoom,
      headingDeg: camera.headingDeg,
      tiltDeg: camera.tiltDeg,
      lon: camera.longitudeDeg,
      lat: camera.latitudeDeg,
    };
  });
}

/** A camera value on one drawn frame, at the engine time of that frame. */
export interface Sample {
  readonly timeMs: number;
  readonly value: number;
}

/**
 * Records a camera value on every display frame while `action` runs and for `settleMs` after; used to see that a
 * control's movement is animated (several distinct intermediate values) and continuous.
 */
export async function recordCamera(
  page: Page,
  field: 'zoom' | 'headingDeg',
  action: () => Promise<void>,
  settleMs = 0,
): Promise<Sample[]> {
  await page.evaluate((name) => {
    const globe = window.vibeglobePlayground?.globe;
    if (globe === undefined) throw new Error('no globe');
    const samples: Sample[] = [{ timeMs: globe.timeMs, value: globe.camera[name] }];
    const recorder = { samples, idle: false, stop: (): void => undefined };
    const stopFrames = globe.on('frame', () => samples.push({ timeMs: globe.timeMs, value: globe.camera[name] }));
    // The engine goes idle after the first frame that asks for no other: once the camera has moved, the animation has
    // ended (an idle of frames drawn before the action does not count).
    const stopIdle = globe.on('idle', () => {
      if (samples.some(({ value }) => value !== samples[0]?.value)) recorder.idle = true;
    });
    recorder.stop = () => {
      stopFrames();
      stopIdle();
    };
    (window as { vibeglobeSamples?: typeof recorder }).vibeglobeSamples = recorder;
  }, field);
  await action();
  await page.waitForFunction(
    () => (window as { vibeglobeSamples?: { idle: boolean } }).vibeglobeSamples?.idle === true,
  );
  await page.waitForTimeout(settleMs);
  return page.evaluate(() => {
    const holder = window as { vibeglobeSamples?: { samples: Sample[]; stop: () => void } | undefined };
    const recorded = holder.vibeglobeSamples;
    recorded?.stop();
    holder.vibeglobeSamples = undefined;
    return recorded?.samples ?? [];
  });
}

/** Touches a point with a real touch sequence (Chromium's touch events through CDP): a tap, or a drag by `dxPx`. */
export async function touch(page: Page, xPx: number, yPx: number, dxPx = 0, holdMs = 0): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const point = (x: number): { x: number; y: number }[] => [{ x, y: yPx }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(xPx) });
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  const steps = dxPx === 0 ? 0 : 10;
  for (let i = 1; i <= steps; i++)
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(xPx + (dxPx * i) / steps) });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}
