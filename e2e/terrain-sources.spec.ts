import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fixtureHeightMeters } from '../scripts/fixtures/tiles/terrain.ts';
import { canvasImage, expectCompleteGlobe, openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession, requestLog, type LoggedRequest } from './support/imagery.ts';
import { compareImages } from './support/visual.ts';

/**
 * Terrain sources end to end (M4 increment 1): quantized-mesh availability and extensions (F128), corrupt terrain
 * (F131), third-party adapters (F132) and geoid-referenced heights (F133), against the fixture tile server's analytic
 * terrain (a 4,000 m peak at 6.86° E, 45.83° N).
 */

test.describe.configure({ timeout: 180_000 });
test.use({ viewport: { width: 800, height: 600 } });

const DEG = Math.PI / 180;

/** The terrain requests of a session's log. */
async function terrainRequests(page: Page, session: string): Promise<LoggedRequest[]> {
  return (await requestLog(page, session)).filter((r) => r.path.includes('/terrain'));
}

/** Waits until no terrain or imagery tile is loading and the engine is idle. */
async function settle(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.imageryStats()?.loading ?? 0), {
      timeout: 60_000,
    })
    .toBe(0);
  await waitForIdle(page);
}

/** Elevation queries at positions, answered in the page. */
async function elevations(
  page: Page,
  positions: readonly (readonly [number, number])[],
): Promise<{ heightMeters: number; level: number; noData: boolean }[]> {
  return page.evaluate(
    (points) =>
      points.map(([longitudeDeg, latitudeDeg]) => {
        const globe = window.vibeglobePlayground?.globe;
        return globe
          ? globe.elevationAt({ longitudeDeg, latitudeDeg })
          : { heightMeters: NaN, level: -1, noData: true };
      }),
    positions,
  );
}

/** A geographic tile range at a level, rows counted from the south (TMS), as layer.json lists them. */
interface Range {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

const inRanges = (ranges: readonly Range[] | undefined, x: number, y: number): boolean =>
  (ranges ?? []).some((r) => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY);

test.describe('quantized-mesh availability (F128)', () => {
  // Geographic levels 0–6 listed in full except the subtree of tiles 66–67 × 48–49 at level 6 (the Alps), which has
  // no data; levels 7 and 8 exist only under tile 6/65/48 and only its metadata extension says so.
  const omitted = { startX: 66, startY: 48, endX: 67, endY: 49 };
  const fullLevel = (z: number): Range[] => [{ startX: 0, startY: 0, endX: 2 * 2 ** z - 1, endY: 2 ** z - 1 }];
  const level6: Range[] = [
    { startX: 0, startY: 0, endX: 65, endY: 63 },
    { startX: 68, startY: 0, endX: 127, endY: 63 },
    { startX: 66, startY: 0, endX: 67, endY: 47 },
    { startX: 66, startY: 50, endX: 67, endY: 63 },
  ];
  const deeper: Range[][] = [
    [{ startX: 130, startY: 96, endX: 131, endY: 97 }],
    [{ startX: 260, startY: 192, endX: 263, endY: 195 }],
  ];
  const layer = (extensions: string[]) => ({
    tilejson: '2.1.0',
    format: 'quantized-mesh-1.0',
    version: '1.0.0',
    scheme: 'tms',
    tiles: ['{z}/{x}/{y}.terrain'],
    projection: 'EPSG:4326',
    minzoom: 0,
    maxzoom: 10,
    extensions,
    metadataAvailability: 6,
    available: [0, 1, 2, 3, 4, 5].map(fullLevel).concat([level6]),
    'x-fixtureMetadata': { '6/65/48': { available: deeper } },
  });

  for (const backend of ['webgpu', 'webgl2'] as const) {
    test(`never requests a tile outside the declared availability, and draws ancestors there, on ${backend}`, async ({
      page,
    }) => {
      const session = await fixtureSession(page);
      const posted = await page.request.post(`/_fixture/${session}/layer`, {
        data: JSON.stringify(layer(['metadata'])),
      });
      expect(posted.status()).toBe(204);
      // Over the subtree whose availability only tile 6/65/48 declares, then over the omitted Alps subtree.
      await openGlobe(page, `backend=${backend}&terrain=quantized-mesh&session=${session}&lon=4.2&lat=46.4&zoom=12`);
      await settle(page);
      await expectCompleteGlobe(page);
      const [over] = await elevations(page, [[4.2, 46.4]]);
      // Level 8 comes only from the metadata of tile 6/65/48.
      expect(over?.level).toBe(8);
      await page.evaluate(() =>
        window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 6.86, latitudeDeg: 45.83, zoom: 12 }),
      );
      await settle(page);
      await expectCompleteGlobe(page);
      const [alps] = await elevations(page, [[6.86, 45.83]]);
      // The omitted subtree shows its level-5 ancestor.
      expect(alps).toMatchObject({ level: 5, noData: false });
      const requests = await terrainRequests(page, session);
      expect(requests.length).toBeGreaterThan(10);
      for (const r of requests) {
        const declared = r.level <= 6 ? (r.level === 6 ? level6 : fullLevel(r.level)) : deeper[r.level - 7];
        expect(inRanges(declared, r.x, r.y), `request ${r.level}/${r.x}/${r.y}`).toBe(true);
        expect(r.level === 6 && inRanges([omitted], r.x, r.y)).toBe(false);
      }
    });
  }

  test('asks for the extensions layer.json declares, and only those', async ({ page }) => {
    for (const [declared, expected] of [
      [[], 'application/vnd.quantized-mesh,'],
      [['octvertexnormals', 'metadata'], 'application/vnd.quantized-mesh;extensions=octvertexnormals-metadata,'],
      [['watermask', 'unknown-extension'], 'application/vnd.quantized-mesh;extensions=watermask,'],
    ] as const) {
      const session = await fixtureSession(page);
      await page.request.post(`/_fixture/${session}/layer`, { data: JSON.stringify(layer([...declared])) });
      await openGlobe(page, `terrain=quantized-mesh&session=${session}&lon=4.2&lat=46.4&zoom=6`);
      await settle(page);
      const requests = await terrainRequests(page, session);
      expect(requests.length).toBeGreaterThan(0);
      for (const r of requests) expect(r.accept?.startsWith(expected), r.accept).toBe(true);
    }
  });
});

test.describe('corrupt terrain (F131)', () => {
  for (const backend of ['webgpu', 'webgl2'] as const) {
    test(`truncated, random and gzip-damaged tiles never blank the view; their ancestors cover them, on ${backend}`, async ({
      page,
    }) => {
      const session = await fixtureSession(page, [
        { source: 'terrain', minLevel: 6, maxLevel: 6, truncateBytes: 100 },
        { source: 'terrain', minLevel: 7, maxLevel: 7, randomBytes: 5000 },
        { source: 'terrain', minLevel: 8, contentType: 'image/png', randomBytes: 300 },
      ]);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openGlobe(page, `backend=${backend}&scenario=terrain-alps&session=${session}&tilt=0&zoom=12`);
      await settle(page);
      await expectCompleteGlobe(page);
      const [sample] = await elevations(page, [[6.86, 45.7]]);
      // Every level from 6 on is corrupt: the heights come from level 5.
      expect(sample).toMatchObject({ level: 5, noData: false });
      expect(errors).toEqual([]);
    });
  }
});

test.describe('third-party terrain adapters (F132)', () => {
  test('adapters for a custom RGB formula and raw float32 tiles render and answer the fixture heights', async ({
    page,
  }, testInfo) => {
    const points = [
      [6.6, 45.6],
      [7.3, 46.1],
      [8.0, 45.2],
    ] as const;
    const results: { heights: number[]; image: Awaited<ReturnType<typeof canvasImage>> }[] = [];
    for (const encoding of ['rgb24', 'float32'] as const) {
      await openGlobe(page, `backend=webgl2&scenario=terrain-terrarium&terrain=${encoding}&session=adapters`);
      await settle(page);
      const samples = await elevations(page, points);
      for (const [i, sample] of samples.entries()) {
        const [lon = 0, lat = 0] = points[i] ?? [];
        expect(sample.noData).toBe(false);
        // The grid interpolates the analytic hills (±300 m over ~200 km) between samples a few hundred meters apart.
        expect(Math.abs(sample.heightMeters - fixtureHeightMeters(lon * DEG, lat * DEG))).toBeLessThan(1);
      }
      results.push({ heights: samples.map((s) => s.heightMeters), image: await canvasImage(page) });
    }
    const [rgb, float] = results;
    if (!rgb || !float) throw new Error('missing results');
    // The two encodings carry the same heights to 1 cm, so they answer and draw the same relief.
    for (const [i, h] of rgb.heights.entries()) expect(Math.abs(h - (float.heights[i] ?? NaN))).toBeLessThan(0.02);
    const diff = compareImages(rgb.image, float.image, 0.1);
    await testInfo.attach('adapters-diff', {
      body: (await import('pngjs')).PNG.sync.write(diff.diff),
      contentType: 'image/png',
    });
    expect(diff.ratio).toBeLessThan(0.001);
  });

  test('the test adapters import only published entry points', () => {
    const source = readFileSync(new URL('../apps/playground/src/terrain-adapters.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(['@vibeglobe/core', '@vibeglobe/sources']).toContain(specifier);
  });
});

test.describe('vertical datums (F133)', () => {
  test('a geoid-referenced source agrees with the same terrain referenced to the ellipsoid', async ({
    page,
  }, testInfo) => {
    const points = [
      [6.86, 45.83],
      [6.5, 45.4],
      [7.4, 46.2],
      [8.2, 45.9],
    ] as const;
    const runs: { heights: number[]; image: Awaited<ReturnType<typeof canvasImage>> }[] = [];
    for (const datum of ['ellipsoid', 'geoid'] as const) {
      await openGlobe(page, `backend=webgl2&scenario=terrain-alps&terrainDatum=${datum}&session=datum`);
      await settle(page);
      const samples = await elevations(page, points);
      runs.push({ heights: samples.map((s) => s.heightMeters), image: await canvasImage(page) });
    }
    const [ellipsoid, geoid] = runs;
    if (!ellipsoid || !geoid) throw new Error('missing runs');
    // The geoid source's heights plus the 1° geoid grid's undulation: within the grid's interpolation and the
    // encoding's rounding.
    for (const [i, h] of ellipsoid.heights.entries())
      expect(Math.abs(h - (geoid.heights[i] ?? NaN))).toBeLessThan(0.05);
    const diff = compareImages(ellipsoid.image, geoid.image, 0.1);
    await testInfo.attach('datum-diff', {
      body: (await import('pngjs')).PNG.sync.write(diff.diff),
      contentType: 'image/png',
    });
    expect(diff.ratio).toBeLessThan(0.002);
  });
});
