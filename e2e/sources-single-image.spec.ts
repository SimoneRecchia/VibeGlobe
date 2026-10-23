// Single georeferenced images (F234): PNG images placed by bounds or by a world file and GeoTIFFs placed by their tags,
// in EPSG:4326, EPSG:3857 and EPSG:32632, show their ground control markers within half a pixel of their coordinates on
// both backends; an image wider than the device's maximum texture size shows completely, without a seam.
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { transformCoordinates } from '@vibeglobe/gis';
import {
  geoImagePng,
  geoImageTiff,
  worldFileOf,
  type GeoImageSpec,
} from '../packages/sources/src/__fixtures__/georeferenced.ts';
import { nextFrame } from './support/globe.ts';
import { mountSource, openSources, sourceFrame } from './support/sources.ts';

test.use({ viewport: { width: 320, height: 240 } });

const IMAGES = 'https://images.test/';
const CORS = { 'Access-Control-Allow-Origin': '*' };
const fsUrl = (path: string): string => `/@fs${resolve(path)}`;
const mercator = (lon: number, lat: number) => transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', 'EPSG:3857');
const SW = mercator(4.5, 40.5);
const NE = mercator(13.5, 49.5);
const SPECS: readonly GeoImageSpec[] = [
  { crs: 'EPSG:4326', box: [4.5, 40.5, 13.5, 49.5], widthPx: 512, heightPx: 512 },
  { crs: 'EPSG:3857', box: [SW.x, SW.y, NE.x, NE.y], widthPx: 512, heightPx: 512 },
  { crs: 'EPSG:32632', box: [300_000, 4_550_000, 820_000, 5_400_000], widthPx: 512, heightPx: 512 },
];
/** Crossings inside every fixture image. */
const MARKERS = [
  { longitudeDeg: 9, latitudeDeg: 45 },
  { longitudeDeg: 12, latitudeDeg: 45 },
] as const;

/** Serves files by name under {@link IMAGES}. */
async function serveImages(page: Page, files: Map<string, Uint8Array | ArrayBuffer>): Promise<void> {
  await page.route(`${IMAGES}**`, (route) => {
    const body = files.get(new URL(route.request().url()).pathname.slice(1));
    return body
      ? route.fulfill({
          status: 200,
          headers: CORS,
          body: Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body),
        })
      : route.fulfill({ status: 404, headers: CORS, body: '' });
  });
}

/** Waits until no imagery tile is queued, loading, decoding or waiting for its upload. */
async function settle(page: Page): Promise<void> {
  await nextFrame(page);
  for (let pass = 0; pass < 2; pass++) {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const stats = window.vibeglobeSources?.globe?.imageryStats();
            return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : 1;
          }),
        { timeout: 120_000 },
      )
      .toBe(0);
    await page.waitForTimeout(400);
  }
}

function magenta(image: PNG, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  const [r, g, b] = [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
  return Math.max(0, Math.min(r, b) - g) / 255;
}

function markerCentroid(image: PNG, near: { xPx: number; yPx: number }, radiusPx = 9) {
  let [sx, sy, total] = [0, 0, 0];
  for (let y = Math.max(0, Math.round(near.yPx - radiusPx)); y < Math.min(image.height, near.yPx + radiusPx); y++)
    for (let x = Math.max(0, Math.round(near.xPx - radiusPx)); x < Math.min(image.width, near.xPx + radiusPx); x++) {
      const w = magenta(image, x, y);
      sx += (x + 0.5) * w;
      sy += (y + 0.5) * w;
      total += w;
    }
  return total < 3 ? undefined : { xPx: sx / total, yPx: sy / total };
}

/**
 * Imports the GeoTIFF entry once and waits: on its first import the dev server optimizes the `geotiff` dependency and
 * reloads the page, which must not happen in the middle of the test.
 */
async function warmGeotiff(page: Page): Promise<void> {
  await openSources(page, 'lon=9&lat=45&zoom=3');
  await page
    .evaluate((url) => import(/* @vite-ignore */ url).then(() => undefined), fsUrl('packages/sources/src/geotiff.ts'))
    .catch(() => undefined);
  await page.waitForTimeout(3000);
}

const SOURCE_BODY = `async (s, v) => {
  const gis = await import(v.gis);
  const transforms = (crs) => crs === 'EPSG:32632' ? {
    toSource: (lon, lat) => { const p = gis.transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', crs); return [p.x, p.y]; },
    fromSource: (x, y) => { const p = gis.transformCoordinates({ x, y }, crs, 'EPSG:4326'); return [p.x, p.y]; },
  } : undefined;
  if (v.by === 'GeoTIFF') {
    const geotiff = await import(v.geotiff);
    return geotiff.geotiffImage({ id: 'image', image: v.url, transforms });
  }
  return s.singleImage({ id: 'image', image: v.url, crs: v.crs, transforms,
    ...(v.by === 'bounds' ? { bounds: v.box } : { worldFile: v.worldFile }) });
}`;

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`single images by bounds, world file and GeoTIFF in three systems put their markers within half a pixel on ${backend} (F234)`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const files = new Map<string, Uint8Array | ArrayBuffer>();
    for (const spec of SPECS) {
      files.set(`${spec.crs}.png`, geoImagePng(spec));
      files.set(`${spec.crs}.tif`, geoImageTiff(spec));
    }
    await serveImages(page, files);
    await warmGeotiff(page);
    await openSources(page, `backend=${backend}&lon=9&lat=45&zoom=7`);
    const offsets: string[] = [];
    for (const spec of SPECS)
      for (const by of ['bounds', 'world file', 'GeoTIFF'] as const) {
        await mountSource(page, SOURCE_BODY, {
          by,
          url: `${IMAGES}${spec.crs}.${by === 'GeoTIFF' ? 'tif' : 'png'}`,
          crs: spec.crs,
          box: spec.box,
          worldFile: worldFileOf(spec),
          gis: fsUrl('packages/gis/src/index.ts'),
          geotiff: fsUrl('packages/sources/src/geotiff.ts'),
        });
        for (const marker of MARKERS) {
          const offsetDeg = (30 * 360) / (256 * 2 ** 7);
          await page.evaluate(
            ([lon, lat]) => window.vibeglobeSources?.globe?.jumpTo({ longitudeDeg: lon, latitudeDeg: lat, zoom: 7 }),
            [marker.longitudeDeg + offsetDeg, marker.latitudeDeg + offsetDeg / 2] as const,
          );
          await settle(page);
          const image = await sourceFrame(page);
          const expected = await page.evaluate((p) => window.vibeglobeSources?.globe?.geoToScreen(p), marker);
          const label = `${by} ${spec.crs} ${String(marker.longitudeDeg)},${String(marker.latitudeDeg)}`;
          if (!expected) {
            offsets.push(`${label}: not on screen`);
            continue;
          }
          const found = markerCentroid(image, expected);
          if (!found) offsets.push(`${label}: no marker near ${expected.xPx.toFixed(1)}, ${expected.yPx.toFixed(1)}`);
          else if (Math.max(Math.abs(found.xPx - expected.xPx), Math.abs(found.yPx - expected.yPx)) > 0.5)
            offsets.push(
              `${label}: ${(found.xPx - expected.xPx).toFixed(2)}, ${(found.yPx - expected.yPx).toFixed(2)}`,
            );
        }
      }
    expect(offsets).toEqual([]);
  });

test('an image wider than the maximum texture size shows completely, without a seam (F234)', async ({ page }) => {
  test.setTimeout(600_000);
  await openSources(page, 'backend=webgl2&lon=15&lat=41&zoom=4');
  // Mount a placeholder first to learn the device's limit, then serve an image wider than it.
  const files = new Map<string, Uint8Array | ArrayBuffer>();
  files.set('small.png', geoImagePng({ crs: 'EPSG:4326', box: [0, 40, 30, 42], widthPx: 64, heightPx: 8 }));
  await serveImages(page, files);
  await mountSource(page, `(s, v) => s.singleImage({ id: 'image', image: v.url, bounds: [0, 40, 30, 42] })`, {
    url: `${IMAGES}small.png`,
  });
  const maxTexturePx = await page.evaluate(() => window.vibeglobeSources?.globe?.capabilities?.maxTextureSize ?? 0);
  expect(maxTexturePx).toBeGreaterThan(0);
  const wide: GeoImageSpec = {
    crs: 'EPSG:4326',
    box: [0, 40, 30, 42],
    widthPx: maxTexturePx + 512,
    heightPx: 256,
    markers: false,
  };
  files.set('wide.png', geoImagePng(wide));
  await mountSource(page, `(s, v) => s.singleImage({ id: 'wide', image: v.url, bounds: [0, 40, 30, 42] })`, {
    url: `${IMAGES}wide.png`,
  });
  const problems: string[] = [];
  for (const longitudeDeg of [5, 15, 25]) {
    await page.evaluate(
      (lon) => window.vibeglobeSources?.globe?.jumpTo({ longitudeDeg: lon, latitudeDeg: 41, zoom: 6 }),
      longitudeDeg,
    );
    await settle(page);
    const image = await sourceFrame(page);
    // The screen rectangle of the image, 2 px inside its edges.
    const corner = (lon: number, lat: number) =>
      page.evaluate((p) => window.vibeglobeSources?.globe?.geoToScreen(p), { longitudeDeg: lon, latitudeDeg: lat });
    const nw = await corner(Math.max(0, longitudeDeg - 10), 42);
    const se = await corner(Math.min(30, longitudeDeg + 10), 40);
    const x0 = Math.max(0, Math.ceil((nw?.xPx ?? 0) + 2));
    const x1 = Math.min(image.width, Math.floor((se?.xPx ?? image.width) - 2));
    const y0 = Math.max(0, Math.ceil((nw?.yPx ?? 0) + 2));
    const y1 = Math.min(image.height, Math.floor((se?.yPx ?? image.height) - 2));
    let missing = 0;
    let step = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const at = (y * image.width + x) * 4;
        const [r, g, b] = [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
        // The fixture's field has green above red and blue everywhere; a marker is magenta.
        if (!(g > r && g > b) && magenta(image, x, y) < 0.3) missing++;
        if (x + 1 < x1 && magenta(image, x, y) === 0 && magenta(image, x + 1, y) === 0)
          for (let c = 0; c < 3; c++)
            step = Math.max(step, Math.abs((image.data[at + c] ?? 0) - (image.data[at + 4 + c] ?? 0)));
      }
    if ((x1 - x0) * (y1 - y0) < 500) problems.push(`${String(longitudeDeg)}°E: the image's rectangle is not on screen`);
    if (missing > 0) problems.push(`${String(longitudeDeg)}°E: ${String(missing)} pixels without the image`);
    if (step > 8) problems.push(`${String(longitudeDeg)}°E: a seam (step ${String(step)})`);
  }
  expect(problems).toEqual([]);
});
