// The Europe preset in the playground (F617): its selector switches base maps and overlays, the imagery layers and the
// composed vector style follow, with no console error. The fixture streets style (the OpenMapTiles schema) stands in for
// OpenFreeMap's; the terrain is left out, as tests reach no outside host.
import { expect, test, type Page } from '@playwright/test';
import { canvasImage, geoToScreen, openGlobe, waitForIdle } from './support/globe.ts';

declare global {
  interface Window {
    vibeglobeEuropePreset?: {
      base: string;
      overlays: readonly string[];
      layer?: { style: { layers: { id: string; type: string }[] } };
      select(base: string, overlays: readonly string[]): Promise<void>;
    };
  }
}

test.use({ viewport: { width: 480, height: 360 } });

/**
 * NASA's Blue Marble (GIBS) answers every request with one red tile, and Mapterhorn's terrain with the fixture's DEM
 * tiles, as tests reach no outside host.
 */
async function routeOnlineSources(page: Page): Promise<void> {
  const red = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
  );
  await page.route('https://gibs.earthdata.nasa.gov/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: red }),
  );
  await page.route('https://tiles.mapterhorn.com/**', async (route) => {
    const tile = /\/(\d+)\/(\d+)\/(\d+)\.webp$/.exec(route.request().url());
    const fixture = tile && (await page.request.get(`/vector-tiles/dem/${tile[1]}/${tile[2]}/${tile[3]}.png`));
    if (!fixture?.ok()) return route.fulfill({ status: 404 });
    return route.fulfill({ status: 200, contentType: 'image/png', body: await fixture.body() });
  });
}

/** The RGB of the canvas pixel at a geographic position. */
async function colorAt(page: Page, longitudeDeg: number, latitudeDeg: number): Promise<number[]> {
  const { xPx, yPx } = await geoToScreen(page, { longitudeDeg, latitudeDeg });
  const image = await canvasImage(page);
  const at = (Math.round(yPx) * image.width + Math.round(xPx)) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

test('the selector switches the preset’s base maps and overlays, the imagery and the style following (F617)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await routeOnlineSources(page);
  await openGlobe(
    page,
    'preset=europe&presetStyle=/vector-tiles/styles/streets.json&presetExclude=europe-terrain&lon=10&lat=45&zoom=4',
  );
  await page.waitForFunction(() => window.vibeglobeEuropePreset !== undefined);
  const layers = () =>
    page.evaluate(() => window.vibeglobeEuropePreset?.layer?.style.layers.map((l) => `${l.type}:${l.id}`) ?? []);
  // Satellite, the start: no vector layer (online only, no orthophoto yet: the base image shows).
  await expect.poll(layers).toEqual([]);
  // Hybrid through the selector: roads, borders and names over the imagery, no background.
  await page.getByRole('radio', { name: 'Hybrid' }).check();
  await expect.poll(() => page.evaluate(() => window.vibeglobeEuropePreset?.base)).toBe('hybrid');
  await expect.poll(async () => (await layers()).length).toBeGreaterThan(0);
  const hybrid = await layers();
  expect(hybrid.some((l) => l.startsWith('background:') || l.startsWith('fill:'))).toBe(false);
  expect(hybrid.some((l) => l.startsWith('line:'))).toBe(true);
  // Map: the political map, its land color a background; 3D buildings over Satellite: only the extruded buildings.
  await page.getByRole('radio', { name: 'Map', exact: true }).check();
  await expect.poll(async () => (await layers()).some((l) => l.startsWith('background:'))).toBe(true);
  await page.getByRole('radio', { name: 'Satellite' }).check();
  await page.getByRole('checkbox', { name: '3D buildings' }).check();
  await expect.poll(async () => (await layers()).every((l) => l.startsWith('fill-extrusion:'))).toBe(true);
  expect((await layers()).length).toBeGreaterThan(0);
  // No relief and no 3D terrain without the terrain source.
  await expect(page.getByRole('radio', { name: 'Relief' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '3D terrain' })).toHaveCount(0);
  await waitForIdle(page);
  expect(errors).toEqual([]);
});

test('Map is a political map with roads only on request, Relief adds a tint and a hillshade, and the polar caps look like the surface around them (KB-214, KB-216)', async ({
  page,
}) => {
  await routeOnlineSources(page);
  await openGlobe(
    page,
    'preset=europe&presetStyle=/vector-tiles/styles/streets.json&presetBase=map&lon=10&lat=45&zoom=4',
  );
  await page.waitForFunction(() => window.vibeglobeEuropePreset !== undefined);
  const layers = () =>
    page.evaluate(() => window.vibeglobeEuropePreset?.layer?.style.layers.map((l) => `${l.type}:${l.id}`) ?? []);
  await expect.poll(async () => (await layers())[0]).toBe('background:political-land');
  // No land cover, land use or buildings of the fixture style (its land, park and building layers), and no roads until
  // their overlay is on.
  const style = await layers();
  for (const absent of ['fill:land', 'fill:italy', 'fill:park', 'fill:building', 'line:road'])
    expect(style).not.toContain(absent);
  await page.getByRole('checkbox', { name: 'Roads' }).check();
  await expect.poll(layers).toContain('line:road');
  await page.getByRole('checkbox', { name: 'Roads' }).uncheck();
  // Relief: the same map over a tint by elevation and a hillshade.
  await page.getByRole('radio', { name: 'Relief' }).check();
  await expect
    .poll(layers)
    .toEqual(expect.arrayContaining(['color-relief:europe-relief-tint', 'hillshade:europe-hillshade']));
  // Over the north pole the cap shows the map's water, in Map and Relief alike.
  const north = async () => {
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 0, latitudeDeg: 89, zoom: 3 }));
    await waitForIdle(page);
    return colorAt(page, 0, 88);
  };
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= 6);
  expect(near(await north(), [0xa9, 0xcf, 0xe8])).toBe(true);
  // Satellite: Natural Earth's colors fill the cap, those of the base image shown far away (F636).
  await page.getByRole('radio', { name: 'Satellite' }).check();
  await expect.poll(async () => near(await north(), [0x7a, 0xac, 0xd0])).toBe(true);
});
