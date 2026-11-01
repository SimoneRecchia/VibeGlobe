// F450: paint, layout and filters change at runtime, and layers are added and removed, without downloading a tile again
// and without a blank or black frame: paint shows on the next frame, layout and filters within the documented time
// (docs/guides/vector-tiles.md: 1 s, a new layout of the kept tiles in the workers).
import { expect, test, type Page } from '@playwright/test';
import { capture, countArea, hex, near, openVector, rgbAt } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

const LAYOUT_MS = 1000;
const ROAD = { longitudeDeg: 9.1795, latitudeDeg: 45.465 };
const PARK = { longitudeDeg: 9.178, latitudeDeg: 45.471 };

async function colorAt(page: Page, at: { longitudeDeg: number; latitudeDeg: number }): Promise<number[]> {
  const p = await page.evaluate((g) => window.vibeglobePlayground?.globe.geoToScreen(g), at);
  if (p === undefined) throw new Error('off screen');
  const image = await capture(page);
  // Never blank or black while styles change.
  expect(countArea(image, hex('#a8cfe0'), 6), 'empty area').toBe(0);
  expect(countArea(image, [0, 0, 0], 12), 'black area').toBe(0);
  return rgbAt(image, p.xPx, p.yPx);
}

/** Draws frames until fades end. */
async function settleFrames(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) await capture(page);
}

/**
 * Runs `change` in the page and returns the milliseconds until the first frame whose pixel at `at` is `rgb` (within
 * `tolerance`), or is no longer it with `matches: false` (TD-02): the frames are read in the page with
 * `globe.captureFrame()`, so the time is the engine's and not that of moving screenshots to the test.
 */
async function msUntilColor(
  page: Page,
  change: string,
  at: { longitudeDeg: number; latitudeDeg: number },
  rgb: readonly number[],
  tolerance: number,
  matches = true,
): Promise<number> {
  return page.evaluate(
    async ({ code, position, color, within, wanted }) => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      const start = performance.now();
      (0, eval)(code);
      for (;;) {
        // A frame of the page first: on WebGL2 a capture settles without yielding, which would starve the workers.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const frame = await globe.captureFrame();
        const point = globe.geoToScreen(position);
        if (!point) throw new Error('off screen');
        const i = (Math.round(point.yPx) * frame.widthPx + Math.round(point.xPx)) * 4;
        const near = [0, 1, 2].every((c) => Math.abs((frame.rgba[i + c] ?? 0) - (color[c] ?? 0)) <= within);
        if (near === wanted) return performance.now() - start;
        if (performance.now() - start > 10_000) throw new Error('change never showed');
      }
    },
    { code: change, position: at, color: rgb, within: tolerance, wanted: matches },
  );
}

/** Runs `change` in the page and returns the milliseconds until `done` holds on a frame drawn after it (TD-02). */
async function msUntil(page: Page, change: string, done: string): Promise<number> {
  return page.evaluate(
    async ({ code, check }) => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      const start = performance.now();
      (0, eval)(code);
      for (;;) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await globe.captureFrame();
        if ((0, eval)(check) === true) return performance.now() - start;
        if (performance.now() - start > 10_000) throw new Error('change never showed');
      }
    },
    { code: change, check: done },
  );
}

test('paint, layout, filter and layer changes at runtime (F450)', async ({ page }) => {
  // Tiles laid out in the engine's workers, which it shares with extensions on a globe with tiled imagery (D (4)).
  await openVector(page, 'scenario=mvt-labels&backend=webgl2&zoom=14&lon=9.18&lat=45.468&imagery=world');
  const requested = await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.requestLog().length);
  const style = 'window.vibeglobeVectorTiles.layer.style';

  // Paint: the next frame (road names hidden meanwhile, so they cover no probed pixel).
  await page.evaluate(`${style}.setVisibility('road-label', false)`);
  await settleFrames(page);
  await page.evaluate(`${style}.setPaintProperty('road', 'line-color', '#00ff00')`);
  expect(near(await colorAt(page, ROAD), [0, 255, 0], 24)).toBe(true);
  await page.evaluate(`${style}.setVisibility('road-label', true)`);

  // Layout: road names upper-cased, laid out again from the kept tiles.
  const layoutMs = await msUntil(
    page,
    `${style}.setLayoutProperty('road-label', 'text-field', ['upcase', ['get', 'name']])`,
    `window.vibeglobeVectorTiles.layer.placedLabels().some((l) => l.text === 'CORSO BUENOS AIRES')`,
  );
  expect(layoutMs).toBeLessThan(LAYOUT_MS);

  // Filter: only the park's fill passes, then the park disappears.
  const filterMs = await msUntilColor(
    page,
    `${style}.setFilter('park', ['==', ['get', 'class'], 'none'])`,
    PARK,
    hex('#c8e6b0'),
    10,
    false,
  );
  expect(filterMs).toBeLessThan(LAYOUT_MS);
  // Never blank or black meanwhile, and the park gone in the frames the test sees too.
  expect(near(await colorAt(page, PARK), hex('#c8e6b0'), 10)).toBe(false);

  // A layer added on top, then removed.
  const addMs = await msUntilColor(
    page,
    `${style}.addLayer({ id: 'extra', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse', paint: { 'fill-color': '#0000ff' } })`,
    PARK,
    [0, 0, 255],
    24,
  );
  expect(addMs).toBeLessThan(LAYOUT_MS);
  console.log(
    `[F450] layout ${Math.round(layoutMs)} ms, filter ${Math.round(filterMs)} ms, new layer ${Math.round(addMs)} ms`,
  );
  expect(near(await colorAt(page, PARK), [0, 0, 255], 24)).toBe(true);
  await msUntilColor(page, `${style}.removeLayer('extra')`, PARK, [0, 0, 255], 24, false);
  expect(near(await colorAt(page, PARK), [0, 0, 255], 24)).toBe(false);

  // Nothing was downloaded again.
  expect(await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.requestLog().length)).toBe(requested);
});
