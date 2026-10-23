// A WMTS layer with a custom tile matrix set in EPSG:25832 (non-standard origin, non-power-of-two scale ratios,
// partial matrices, 512-pixel tiles) reprojected over the Web Mercator view (F228): its ground control markers land
// within half a pixel of their coordinates at several zooms on both backends, and neighboring tiles and levels meet
// without a seam.
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { customCapabilities, tileBox, TILE_PX } from '../packages/sources/src/__fixtures__/wmts-custom.ts';
import { encodeUtmPng } from '../scripts/fixtures/tiles/utm.ts';
import { nextFrame } from './support/globe.ts';
import { mountSource, openSources, sourceFrame } from './support/sources.ts';

test.use({ viewport: { width: 320, height: 240 } });

const BASE = 'https://wmts25832.test/';
const CORS = { 'Access-Control-Allow-Origin': '*' };

/** Serves the capabilities and the tiles, each tile the UTM 32N fixture image of its box (markers every 3°). */
async function serveCustom(page: Page): Promise<string[]> {
  const tiles: string[] = [];
  const cache = new Map<string, Buffer>();
  await page.route(`${BASE}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/WMTSCapabilities.xml')
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'Content-Type': 'text/xml' },
        body: customCapabilities(BASE),
      });
    const [, matrix = '', row = '', col = ''] = /^\/(\w+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname) ?? [];
    const box = tileBox(matrix, Number(row), Number(col));
    if (!box) return route.fulfill({ status: 404, headers: CORS, body: '' });
    tiles.push(url.pathname);
    let body = cache.get(url.pathname);
    if (!body) {
      body = encodeUtmPng({ zone: 32, bbox: box, widthPx: TILE_PX, heightPx: TILE_PX });
      cache.set(url.pathname, body);
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'image/png' }, body });
  });
  return tiles;
}

/** Waits until no imagery tile is queued, loading, decoding or waiting for its upload, twice around idle. */
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
        // Each composed tile renders several 512-pixel fixture tiles in Node first.
        { timeout: 180_000 },
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

/** The magenta-weighted centroid within `radiusPx` of a point, pixel centres at +0.5. */
function markerCentroid(image: PNG, near: { xPx: number; yPx: number }, radiusPx = 6) {
  let [sx, sy, total] = [0, 0, 0];
  for (let y = Math.max(0, Math.round(near.yPx - radiusPx)); y < Math.min(image.height, near.yPx + radiusPx); y++)
    for (let x = Math.max(0, Math.round(near.xPx - radiusPx)); x < Math.min(image.width, near.xPx + radiusPx); x++) {
      const w = magenta(image, x, y);
      sx += (x + 0.5) * w;
      sy += (y + 0.5) * w;
      total += w;
    }
  // A marker of 9 matrix pixels shows 2 to 5 screen pixels wide, depending on the matrix chosen for the zoom.
  return total < 1.5 ? undefined : { xPx: sx / total, yPx: sy / total };
}

/** The largest step between neighboring pixels in the view's centre, away from the markers (a smooth color field). */
function maxStep(image: PNG): number {
  let worst = 0;
  const near = (x: number, y: number): boolean => {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const [nx, ny] = [x + dx, y + dy];
        if (nx >= 0 && ny >= 0 && nx < image.width && ny < image.height && magenta(image, nx, ny) > 0.05) return true;
      }
    return false;
  };
  // The central part of the view, inside the data at every tested view (the data's edges show the base beyond them).
  for (let y = Math.round(image.height * 0.25); y < Math.round(image.height * 0.75); y++)
    for (let x = Math.round(image.width * 0.25); x < Math.round(image.width * 0.75); x++) {
      if (near(x, y)) continue;
      const at = (y * image.width + x) * 4;
      for (const next of [at + 4, at + image.width * 4])
        for (let c = 0; c < 3; c++)
          worst = Math.max(worst, Math.abs((image.data[at + c] ?? 0) - (image.data[next + c] ?? 0)));
    }
  return worst;
}

/** Ground control markers inside the data (every 3°, in the zone's part of Italy). */
const MARKERS = [
  { longitudeDeg: 9, latitudeDeg: 45 },
  { longitudeDeg: 12, latitudeDeg: 42 },
  { longitudeDeg: 6, latitudeDeg: 45 },
] as const;

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`a custom EPSG:25832 tile matrix set lines up with the Web Mercator view and has no seam on ${backend} (F228)`, async ({
    page,
  }) => {
    test.setTimeout(900_000);
    const tiles = await serveCustom(page);
    await openSources(page, `backend=${backend}&lon=9&lat=45&zoom=6`);
    await mountSource(
      page,
      `async (s, v) => {
        const gis = await import(v.gis);
        const transforms = (crs) => crs === 'EPSG:25832' ? {
          toSource: (lon, lat) => { const p = gis.transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', crs); return [p.x, p.y]; },
          fromSource: (x, y) => { const p = gis.transformCoordinates({ x, y }, crs, 'EPSG:4326'); return [p.x, p.y]; },
        } : undefined;
        return s.wmtsImagery({ id: 'custom', capabilities: v.url, layer: 'ortho25832', transforms });
      }`,
      { url: `${BASE}WMTSCapabilities.xml`, gis: `/@fs${resolve('packages/gis/src/index.ts')}` },
    );
    const offsets: string[] = [];
    const seams: string[] = [];
    // Zooms whose chosen matrix is close to the screen's resolution (L0, L1 and L3): the fixture's markers are 9 pixels
    // of the matrix, so where a much finer matrix is chosen (zoom 8 takes L2) they shrink below 3 screen pixels.
    for (const zoom of [6, 7, 10]) {
      for (const marker of MARKERS) {
        // About 30 px off the view's centre, so the view's own rounding cannot hide an offset.
        const offsetDeg = (30 * 360) / (256 * 2 ** zoom);
        await page.evaluate(
          ([lon, lat, z]) => window.vibeglobeSources?.globe?.jumpTo({ longitudeDeg: lon, latitudeDeg: lat, zoom: z }),
          [marker.longitudeDeg + offsetDeg, marker.latitudeDeg + offsetDeg / 2, zoom] as const,
        );
        await settle(page);
        const image = await sourceFrame(page);
        const expected = await page.evaluate((p) => window.vibeglobeSources?.globe?.geoToScreen(p), marker);
        if (!expected) throw new Error('marker not on screen');
        const label = `zoom ${String(zoom)} ${String(marker.longitudeDeg)},${String(marker.latitudeDeg)}`;
        const found = markerCentroid(image, expected);
        if (!found) offsets.push(`${label}: no marker near ${expected.xPx.toFixed(1)}, ${expected.yPx.toFixed(1)}`);
        else if (Math.max(Math.abs(found.xPx - expected.xPx), Math.abs(found.yPx - expected.yPx)) > 0.5)
          offsets.push(`${label}: ${(found.xPx - expected.xPx).toFixed(2)}, ${(found.yPx - expected.yPx).toFixed(2)}`);
        const step = maxStep(image);
        if (step > 6) seams.push(`${label}: step ${String(step)}`);
      }
    }
    expect(offsets).toEqual([]);
    expect(seams).toEqual([]);
    // The tiles of several matrices were composed, never a tile outside a partial matrix.
    expect(new Set(tiles.map((t) => t.split('/')[1])).size).toBeGreaterThanOrEqual(3);
  });
