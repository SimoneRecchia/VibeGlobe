// Compressed 3D Tiles content (F463): the fixture city compressed with Draco and meshopt and textured with KTX2
// (ETC1S) draws without holes; decoder files load only when a tileset needs them, from the URL the page configures;
// decoding runs on workers.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CITY, openCity, redraw, settleTiles, startCoverage, stopCoverage } from './support/tiles3d.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.setTimeout(120_000);

const VIEW = `lon=${CITY.longitudeDeg}&lat=${CITY.latitudeDeg}&zoom=16.5&tilt=30`;

/** Every requested URL of the page, from now on. */
function requestLog(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  page.on('worker', (worker) => worker.on('console', () => undefined));
  return urls;
}

for (const variant of ['draco', 'meshopt', 'ktx2'] as const)
  test(`the ${variant} fixture city draws completely (F463)`, async ({ page }) => {
    await openCity(page, `backend=webgl2&tiles3d=${variant}&${VIEW}`);
    await settleTiles(page);
    await startCoverage(page);
    await redraw(page);
    const coverage = await stopCoverage(page);
    expect(coverage.samples).toBeGreaterThan(20);
    expect(coverage.holes).toBe(0);
    const stats = await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats());
    expect(stats?.failed).toBe(0);
    expect(stats?.drawn).toBeGreaterThan(4);
    expect(await page.evaluate(() => window.vibeglobeTiles3d?.errors)).toEqual([]);
  });

test('decoder files load only once a tileset needs them (F463)', async ({ page }) => {
  const urls = requestLog(page);
  await openCity(page, `backend=webgl2&tiles3d=plain&${VIEW}`);
  await settleTiles(page);
  expect(urls.filter((u) => /draco_decoder\.wasm$|basis\.wasm$/.test(u))).toEqual([]);
  await openCity(page, `backend=webgl2&tiles3d=draco&${VIEW}`);
  await settleTiles(page);
  expect(urls.filter((u) => /draco_decoder\.wasm$/.test(u)).length).toBeGreaterThan(0);
  expect(urls.filter((u) => /basis\.wasm$/.test(u))).toEqual([]);
  await openCity(page, `backend=webgl2&tiles3d=ktx2&${VIEW}`);
  await settleTiles(page);
  expect(urls.filter((u) => /vibeglobe-basis\.wasm$/.test(u)).length).toBeGreaterThan(0);
});

test('the Draco decoder loads from the URL the page configures (F463)', async ({ page }) => {
  const wasm = readFileSync(resolve('node_modules/draco3d/draco_decoder.wasm'));
  const served: string[] = [];
  await page.route('**/custom-decoders/**', async (route) => {
    served.push(route.request().url());
    await route.fulfill({ body: wasm, contentType: 'application/wasm' });
  });
  const custom = 'http://localhost:5173/custom-decoders/draco_decoder.wasm';
  await openCity(page, `backend=webgl2&tiles3d=draco&decoders=${encodeURIComponent(custom)}&${VIEW}`);
  await settleTiles(page);
  expect(served).toEqual([custom]);
  expect(await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats().failed)).toBe(0);
});

test('models decode on the engine workers, never on the main thread (F463)', async ({ page }) => {
  // Fails until the worker program registers parse-model (docs/parallel-tracks.md, hook request E (1)): meanwhile
  // the loader decodes with its own task table on the main thread (KTX2 already transcodes on the workers).
  test.fail();
  await openCity(page, `backend=webgl2&tiles3d=draco&${VIEW}`);
  await settleTiles(page);
  const stats = await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats());
  expect(stats?.decodedInWorkers).toBeGreaterThan(0);
  expect(stats?.decodedInline).toBe(0);
});
