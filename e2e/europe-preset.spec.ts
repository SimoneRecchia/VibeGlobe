// The Europe preset in the playground (F617): its selector switches base maps and overlays, the imagery layers and the
// composed vector style follow, with no console error. The fixture streets style (the OpenMapTiles schema) stands in for
// OpenFreeMap's; the terrain is left out, as tests reach no outside host.
import { expect, test } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';

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

test('the selector switches the preset’s base maps and overlays, the imagery and the style following (F617)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
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
  // Map: the whole style, its background included; 3D buildings over Satellite: only the extruded buildings.
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
