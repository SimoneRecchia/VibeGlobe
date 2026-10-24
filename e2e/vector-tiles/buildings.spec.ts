// Buildings of the vector tiles: F458 (heights on the flat map scale with the projection, measurements stay true),
// F455 (heights from height, min_height, building:levels, building parts), F456 (documented defaults, the same in
// every tile), F457 (shading, no z-fighting, growing in instead of popping).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { expectMatchesBaseline } from '../support/visual.ts';
import { BACKENDS, capture, near, openVector, settle } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

const WHITE = [255, 255, 255];

/** The bounding box of the red pixels (the buildings, lit or shaded). */
function inkBox(image: PNG): { width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (!((image.data[i] ?? 0) > 100 && (image.data[i + 1] ?? 0) < 60 && (image.data[i + 2] ?? 0) < 60)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function pickAt(page: Page, at: { longitudeDeg: number; latitudeDeg: number; heightMeters?: number }) {
  return page.evaluate((g) => {
    const p = window.vibeglobePlayground?.globe.geoToScreen(g);
    return p === undefined ? [] : (window.vibeglobeVectorTiles?.layer?.queryRenderedFeatures(p) ?? []);
  }, at);
}

test.describe('heights on the flat map', () => {
  // Large enough that the 60° tower, twice as large on the screen as the equator's, is not clipped.
  test.use({ viewport: { width: 480, height: 400 } });

  test('flat-map heights scale with the Mercator scale factor; measured heights stay true (F458)', async ({ page }) => {
    await openVector(page, 'vectorStyle=buildings&backend=webgl2&zoom=15.5&lon=10&lat=0');
    await page.evaluate(() => window.vibeglobePlayground?.globe.setViewMode('3d'));
    const ratios: number[] = [];
    for (const lat of [0, 45, 60]) {
      // The same zoom: the ground scale differs by 1 / cos(lat), so the tower's footprint does too.
      await page.evaluate(
        (l) =>
          window.vibeglobePlayground?.globe.jumpTo({
            longitudeDeg: 10,
            latitudeDeg: l,
            zoom: 15.5,
            tiltDeg: 60,
            headingDeg: 0,
          }),
        lat,
      );
      await settle(page);
      expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.morphFactor)).toBe(1);
      const box = inkBox(await capture(page));
      ratios.push(box.height / box.width);
      const picked = (await pickAt(page, { longitudeDeg: 10, latitudeDeg: lat })).find((f) => f.layerId === 'building');
      expect(picked?.building?.heightMeters, `lat ${lat}`).toBe(100);
    }
    // The rendered height keeps its proportion to the rendered ground at every latitude, within the 10% a pixel makes
    // on a tower 27 px wide (heights left unscaled would halve the proportion at 60°).
    for (const ratio of ratios) expect(Math.abs(ratio / (ratios[0] ?? 1) - 1), ratios.join()).toBeLessThan(0.1);
  });
});

/** The grid buildings of the fixture city (e2e/vector-tiles/fixtures/city.ts): row i, column j. */
const gridBuilding = (i: number, j: number) => ({ longitudeDeg: 9.1625 + j * 0.009, latitudeDeg: 45.4495 + i * 0.005 });
const UNTAGGED = ['house', 'apartments', 'commercial', 'industrial', 'church', 'garage'];
/** Degrees of longitude per meter at the parts' latitude. */
const LON_PER_M = 1 / (111_320 * Math.cos((45.4605 * Math.PI) / 180));

async function buildingAt(page: Page, at: { longitudeDeg: number; latitudeDeg: number }, zoom = 16.5) {
  await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), { ...at, zoom });
  await settle(page);
  return (await pickAt(page, at)).find((f) => f.layerId === 'building');
}

test('extruded heights come from height, min_height, building:levels and building parts (F455)', async ({ page }) => {
  test.setTimeout(180_000);
  await openVector(page, 'vectorStyle=buildings&backend=webgl2&zoom=16&lon=9.19&lat=45.465');
  for (const [i, j] of [
    [0, 0],
    [1, 1],
    [2, 3],
    [3, 4],
    [4, 2],
  ] as const) {
    const k = (i * 7 + j) % 4;
    const picked = await buildingAt(page, gridBuilding(i, j));
    expect(picked, `building ${i},${j}`).toBeDefined();
    const height = picked?.building;
    if (k === 0) expect(height).toEqual({ heightMeters: 18 + ((i + j) % 5) * 6, baseMeters: 0, source: 'height' });
    if (k === 1) expect(height).toEqual({ heightMeters: (3 + ((i * j) % 6)) * 3, baseMeters: 0, source: 'levels' });
    if (k === 3) expect(height).toEqual({ heightMeters: 30, baseMeters: 10, source: 'height' });
  }
  // The outline (60 m) is replaced by its parts: 80 m from the ground and 40 m raised to 12 m.
  const left = await buildingAt(page, { longitudeDeg: 9.2 - 20 * LON_PER_M, latitudeDeg: 45.4605 });
  const right = await buildingAt(page, { longitudeDeg: 9.2 + 20 * LON_PER_M, latitudeDeg: 45.4605 });
  expect(left?.building).toEqual({ heightMeters: 80, baseMeters: 0, source: 'height' });
  expect(right?.building).toEqual({ heightMeters: 40, baseMeters: 12, source: 'height' });
  expect(left?.properties['building:part']).toBe('yes');
});

test('buildings without height tags get the documented defaults, the same from every tile (F456)', async ({ page }) => {
  test.setTimeout(180_000);
  const { DEFAULT_BUILDING_HEIGHTS } = await import('@vibeglobe/layers/vector-tiles');
  const guide = readFileSync(new URL('../../docs/guides/data-layers.md', import.meta.url), 'utf8');
  await openVector(page, 'vectorStyle=buildings&backend=webgl2&zoom=16&lon=9.19&lat=45.465');
  const seen = new Set<string>();
  for (let i = 0; i < 7 && seen.size < UNTAGGED.length; i++) {
    for (let j = 0; j < 7; j++) {
      if ((i * 7 + j) % 4 !== 2) continue;
      const type = UNTAGGED[Math.floor((i * 7 + j) / 4) % UNTAGGED.length] ?? 'house';
      if (seen.has(type)) continue;
      seen.add(type);
      const expected = DEFAULT_BUILDING_HEIGHTS[type];
      // From a zoom-14 tile, then from its zoom-13 parent after a reload of the page.
      const fine = await buildingAt(page, gridBuilding(i, j), 16.5);
      expect(fine?.building, type).toEqual({ heightMeters: expected, baseMeters: 0, source: 'default' });
      await page.reload();
      await openVector(page, 'vectorStyle=buildings&backend=webgl2&zoom=13.4&lon=9.19&lat=45.465');
      const coarse = await buildingAt(page, gridBuilding(i, j), 13.4);
      expect(coarse?.building, type).toEqual(fine?.building);
      // The guide's defaults table lists this height.
      expect(guide).toMatch(new RegExp(`\`${type}\`[^\\n]*\\|\\s+${String(expected)} \\|`));
    }
  }
  expect([...seen].sort()).toEqual([...UNTAGGED].sort());
});

/** Pixels that are not the white background: the buildings. */
function buildingPixels(image: PNG): number {
  let n = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (!near([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0], WHITE, 30)) n++;
  return n;
}

/** Distinct shades of the building color (red), quantized: roofs and walls facing different ways. */
function shades(image: PNG): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b] = [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
    if (r > 60 && g < 30 && b < 30) out.add(Math.round(r / 12));
  }
  return out;
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`buildings shade by facing, show no z-fighting through a zoom, and grow in (${backend}, F457)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openVector(page, `vectorStyle=buildings&backend=${backend}&zoom=15&lon=9.19&lat=45.465`);
    await page.evaluate(() => window.vibeglobePlayground?.globe.setViewMode('3d'));
    const city = { longitudeDeg: 9.1895, latitudeDeg: 45.4645, headingDeg: 30, tiltDeg: 55 };
    await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo({ ...v, zoom: 16 }), city);
    await settle(page);
    // Roof and two walls facing different ways: three shades at least.
    expect(shades(await capture(page)).size).toBeGreaterThanOrEqual(3);
    // City to street: a slow zoom. A pixel that changes and changes back between three successive frames, a hundredth
    // of a zoom level apart, is z-fighting shimmer (the view itself moves far less than a pixel per step there).
    const frames: PNG[] = [];
    let shimmer = 0;
    let pixels = 0;
    for (let k = 0; k <= 60; k++) {
      await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), { ...city, zoom: 15 + k * 0.03 });
      const frame = await capture(page);
      frames.push(frame);
      if (frames.length > 3) frames.shift();
      const [a, b, c] = frames;
      if (a === undefined || b === undefined || c === undefined) continue;
      pixels += buildingPixels(c);
      for (let i = 0; i < c.data.length; i += 4) {
        const ab =
          Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) + Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
        const bc =
          Math.abs((b.data[i] ?? 0) - (c.data[i] ?? 0)) + Math.abs((b.data[i + 1] ?? 0) - (c.data[i + 1] ?? 0));
        const ac =
          Math.abs((a.data[i] ?? 0) - (c.data[i] ?? 0)) + Math.abs((a.data[i + 1] ?? 0) - (c.data[i + 1] ?? 0));
        if (ab > 60 && bc > 60 && ac < 20) shimmer++;
      }
    }
    expect(shimmer / Math.max(1, pixels), `${shimmer} shimmering of ${pixels}`).toBeLessThan(0.002);
    // Across minzoom 13 the buildings grow from the ground over several frames instead of popping in.
    await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo({ ...v, zoom: 12.95 }), city);
    await settle(page);
    expect(buildingPixels(await capture(page))).toBe(0);
    await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo({ ...v, zoom: 13.05 }), city);
    const counts: number[] = [];
    for (let k = 0; k < 10; k++) counts.push(buildingPixels(await capture(page)));
    const final = counts.at(-1) ?? 0;
    expect(final).toBeGreaterThan(0);
    expect(counts.filter((n) => n > 0 && n < final * 0.9).length, counts.join()).toBeGreaterThanOrEqual(1);
  });
}

for (const backend of BACKENDS) {
  test(`a Milan view with extrusions matches its baseline (${backend}, F455) @baseline`, async ({ page }, testInfo) => {
    await openVector(page, `scenario=mvt-city&backend=${backend}`);
    await expectMatchesBaseline(page, testInfo, `mvt-city-${backend}.png`, await capture(page));
  });
}
