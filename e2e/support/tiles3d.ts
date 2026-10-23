// Helpers of the 3D Tiles specs (track E): open the `3dtiles-city` scenario, wait for its tiles, and measure holes
// in the fixture city's footprint by casting a grid of rays against the drawn tiles every frame.
import { expect, type Page } from '@playwright/test';
import type { RequestEvent, Tiles3DExtension, Tiles3DPick } from '@vibeglobe/sources/tiles3d';
import { openGlobe, waitForIdle } from './globe.ts';

declare global {
  interface Window {
    /** The 3D Tiles scenario's hooks (apps/playground/src/tiles3d-demo.ts). */
    vibeglobeTiles3d?: {
      readonly extension: Tiles3DExtension;
      readonly requests: RequestEvent[];
      readonly picks: (Tiles3DPick | undefined)[];
      readonly errors: string[];
    };
  }
}

/** The fixture city (`e2e/fixtures/tiles3d/city.ts`): center and half size in meters. */
export const CITY = { longitudeDeg: 12.4922, latitudeDeg: 41.8902, halfMeters: 512 } as const;

/**
 * Opens the scenario (`3dtiles-city` unless the query names one) and waits for the tileset JSON. Tiled fixture imagery (`imagery=world`) gives the globe its
 * request pool and worker pool, which render extensions receive (`context.network`, `context.workers`).
 */
export async function openCity(page: Page, query: string): Promise<void> {
  const scenario = query.includes('scenario=') ? '' : 'scenario=3dtiles-city&';
  await openGlobe(page, `${scenario}${query.includes('imagery=') ? '' : 'imagery=world&'}${query}`);
  await page.waitForFunction(() => window.vibeglobeTiles3d?.extension.stats().ready === true, undefined, {
    timeout: 30_000,
  });
}

/** Waits until no tile loads and the engine is idle. */
export async function settleTiles(page: Page, timeoutMs = 45_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await waitForIdle(page);
    const loading = await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats().loading ?? -1);
    if (loading === 0) {
      await waitForIdle(page);
      if ((await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats().loading)) === 0) return;
    }
    expect(Date.now(), 'tiles still loading').toBeLessThan(end);
    await page.waitForTimeout(100);
  }
}

/** A point `east` and `north` meters from the city center, at a height. */
export function cityPoint(east: number, north: number, heightMeters = 0) {
  return {
    longitudeDeg: CITY.longitudeDeg + east / (111_320 * Math.cos((CITY.latitudeDeg * Math.PI) / 180)),
    latitudeDeg: CITY.latitudeDeg + north / 110_950,
    heightMeters,
  };
}

/**
 * Starts recording, every drawn frame, the canvas points of a grid inside the city's footprint (inset by `insetM`)
 * that no drawn tile covers: a ray from each finds no tile. `stopCoverage` returns the frames and their holes.
 */
export async function startCoverage(page: Page, step = 24, insetM = 12): Promise<void> {
  await page.evaluate(
    ({ city, step, insetM }) => {
      const hooks = window.vibeglobeTiles3d;
      const globe = window.vibeglobePlayground?.globe;
      if (!hooks || !globe) throw new Error('no 3D Tiles scenario');
      const cos = Math.cos((city.latitudeDeg * Math.PI) / 180);
      const half = city.halfMeters - insetM;
      const record: { frames: number; holes: number; samples: number; worst: [number, number][] } = {
        frames: 0,
        holes: 0,
        samples: 0,
        worst: [],
      };
      // A canvas point is in the footprint when the ground it shows is inside the city's square.
      const inside = (x: number, y: number): boolean => {
        const ground = globe.screenToGeo({ xPx: x, yPx: y });
        if (!ground) return false;
        const east = (ground.longitudeDeg - city.longitudeDeg) * 111_320 * cos;
        const north = (ground.latitudeDeg - city.latitudeDeg) * 110_950;
        return Math.abs(east) < half && Math.abs(north) < half;
      };
      const off = globe.on('frame', () => {
        if (!hooks.extension.stats().drawn) return;
        const canvas = document.querySelector('canvas');
        const width = canvas?.clientWidth ?? 0;
        const height = canvas?.clientHeight ?? 0;
        record.frames++;
        for (let y = step / 2; y < height; y += step)
          for (let x = step / 2; x < width; x += step) {
            if (!inside(x, y)) continue;
            record.samples++;
            if (hooks.extension.pick(x, y) === undefined) {
              record.holes++;
              if (record.worst.length < 10) record.worst.push([x, y]);
            }
          }
      });
      (window as unknown as { tiles3dCoverage: { record: typeof record; off: () => void } }).tiles3dCoverage = {
        record,
        off,
      };
    },
    { city: CITY, step, insetM },
  );
}

/** Draws one more frame of the current view (a jump to where the camera is). */
export async function redraw(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) return;
    const { longitudeDeg, latitudeDeg, zoom, headingDeg, tiltDeg } = globe.camera;
    await globe.jumpTo({ longitudeDeg: longitudeDeg + 1e-9, latitudeDeg, zoom, headingDeg, tiltDeg });
  });
  await waitForIdle(page);
}

/** Stops recording and returns what {@link startCoverage} counted. */
export async function stopCoverage(page: Page) {
  return page.evaluate(() => {
    const coverage = (
      window as unknown as {
        tiles3dCoverage: {
          record: { frames: number; holes: number; samples: number; worst: [number, number][] };
          off: () => void;
        };
      }
    ).tiles3dCoverage;
    coverage.off();
    return coverage.record;
  });
}

/** Moves the camera in `steps` jumps from zoom `from` to `to` over the city, one drawn frame each. */
export async function zoomSteps(page: Page, from: number, to: number, steps: number, tiltDeg = 30): Promise<void> {
  for (let i = 0; i <= steps; i++) {
    const zoom = from + ((to - from) * i) / steps;
    await page.evaluate(
      async ({ city, zoom, tiltDeg }) => {
        const globe = window.vibeglobePlayground?.globe;
        await globe?.jumpTo({ longitudeDeg: city.longitudeDeg, latitudeDeg: city.latitudeDeg, zoom, tiltDeg });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      },
      { city: CITY, zoom, tiltDeg },
    );
  }
}
