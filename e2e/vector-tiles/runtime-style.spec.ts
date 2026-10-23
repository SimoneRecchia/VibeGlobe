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

/** Captures frames until `done` holds; returns the time it took. */
async function until(page: Page, done: () => Promise<boolean>): Promise<number> {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > 10_000) throw new Error('change never showed');
    await colorAt(page, ROAD);
  }
  return Date.now() - start;
}

test('paint, layout, filter and layer changes at runtime (F450)', async ({ page }) => {
  await openVector(page, 'scenario=mvt-labels&backend=webgl2&zoom=14&lon=9.18&lat=45.468');
  const requested = await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.requestLog().length);
  const style = 'window.vibeglobeVectorTiles.layer.style';

  // Paint: the next frame (road names hidden meanwhile, so they cover no probed pixel).
  await page.evaluate(`${style}.setVisibility('road-label', false)`);
  await settleFrames(page);
  await page.evaluate(`${style}.setPaintProperty('road', 'line-color', '#00ff00')`);
  expect(near(await colorAt(page, ROAD), [0, 255, 0], 24)).toBe(true);
  await page.evaluate(`${style}.setVisibility('road-label', true)`);

  // Layout: road names upper-cased, laid out again from the kept tiles.
  await page.evaluate(`${style}.setLayoutProperty('road-label', 'text-field', ['upcase', ['get', 'name']])`);
  const layoutMs = await until(page, () =>
    page.evaluate(() =>
      (window.vibeglobeVectorTiles?.layer?.placedLabels() ?? []).some((l) => l.text === 'CORSO BUENOS AIRES'),
    ),
  );
  expect(layoutMs).toBeLessThan(LAYOUT_MS);

  // Filter: only the park's fill passes, then the park disappears.
  await page.evaluate(`${style}.setFilter('park', ['==', ['get', 'class'], 'none'])`);
  const filterMs = await until(page, async () => !near(await colorAt(page, PARK), hex('#c8e6b0'), 10));
  expect(filterMs).toBeLessThan(LAYOUT_MS);

  // A layer added on top, then removed.
  await page.evaluate(
    `${style}.addLayer({ id: 'extra', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse', paint: { 'fill-color': '#0000ff' } })`,
  );
  const addMs = await until(page, async () => near(await colorAt(page, PARK), [0, 0, 255], 24));
  expect(addMs).toBeLessThan(LAYOUT_MS);
  await page.evaluate(`${style}.removeLayer('extra')`);
  await until(page, async () => !near(await colorAt(page, PARK), [0, 0, 255], 24));

  // Nothing was downloaded again.
  expect(await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.requestLog().length)).toBe(requested);
});
