// Pipeline outputs in the playground (F336, F338): a build from fixture sources is served by a plain static
// HTTP server and loaded through the engine's XYZ adapter and as its pinned base image. With
// VIBEGLOBE_TOOLS_FALLBACK=<folder> the base-image check also runs on a real global fallback build.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type { BuildConfig, DatasetConfig } from '../config/schema.js';
import { startFixtureServer } from '../fixtures/server.js';
import { readMbtiles } from '../output/mbtiles.js';
import { PmtilesReader } from '../output/pmtiles.js';
import { runBuild } from '../pipeline/build.js';

/** The playground page background behind its transparent canvas. */
const BACKGROUND = [11, 16, 32];
const SAMPLE: [number, number, number, number] = [6.6796875, 45.82879925192134, 7.03125, 46.07323062540836];

let server: Server;
let base = '';
let root = '';
let requests: string[] = [];

function dataset(fixture: string): DatasetConfig[] {
  const common = { profile: 'fixture', dataYear: 2016, sourceVersion: 'fixture', bytesPerTile: 30_000 };
  return [
    {
      ...common,
      id: 'imagery',
      kind: 'imagery',
      source: { type: 'geotiff', url: `${fixture}/world.tif` },
      minZoom: 10,
      maxZoom: 14,
      encoding: 'jpeg',
      quality: 90,
      downloadBytesPerFile: 790_000,
      outputs: { static: true, pmtiles: true, mbtiles: true },
    },
    {
      ...common,
      id: 'fallback',
      kind: 'imagery',
      area: { bbox: [-180, -85.0511287798066, 180, 85.0511287798066] },
      source: { type: 'geotiff', url: `${fixture}/world.tif` },
      minZoom: 0,
      maxZoom: 2,
      encoding: 'png',
      downloadBytesPerFile: 6_300_000,
      outputs: { static: true, pmtiles: false, mbtiles: false },
      baseImage: { widthPx: 2048, quality: 90 },
    },
  ];
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'vg-tools-browser-'));
  const started = await startFixtureServer({ port: 0, staticFolder: root });
  server = started.server;
  base = started.url;
  const config: BuildConfig = {
    configVersion: '1.0.0',
    name: 'browser-fixture',
    description: 'fixture build for the browser checks',
    region: { bbox: SAMPLE },
    sampleArea: { bbox: SAMPLE },
    prices: {
      currency: 'USD',
      readDate: '2026-10-21',
      sourceUrl: 'https://example.test',
      requesterPaysTransferPerGB: 0,
      requesterPaysGetPer1000: 0,
      freeTransferPerGB: 0,
    },
    tools: { gdal: `ghcr.io/osgeo/gdal@sha256:${'a'.repeat(64)}` },
    datasets: dataset(base),
  };
  writeFileSync(join(root, 'config.json'), JSON.stringify(config));
  await runBuild({
    configPath: join(root, 'config.json'),
    outDir: root,
    sample: false,
    yes: true,
    interactive: false,
    until: 'package',
    fetch,
    ask: () => Promise.resolve(false),
    report: () => undefined,
  });
  started.log.length = 0;
  requests = started.log;
});

test.afterAll(() => server.close());

/** Serves the playground's fixture imagery from the static folder of a dataset (through the static HTTP server). */
async function serveStatic(page: Page, folder: string, extension: string): Promise<void> {
  await page.route('**/fixture-tiles/**/mercator/*/*/*.png', async (route) => {
    const [, z, x, y] = /mercator\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(route.request().url()) ?? [];
    const response = await fetch(`${base}/static/output/${folder}/${z}/${x}/${y}.${extension}`);
    if (!response.ok) return route.fulfill({ status: 404 });
    return route.fulfill({
      status: 200,
      contentType: response.headers.get('content-type') ?? '',
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}

async function openGlobe(page: Page, query: string): Promise<void> {
  await page.goto(`/?${query}`);
  await page.waitForFunction(
    () => (globalThis as unknown as { vibeglobePlayground?: unknown }).vibeglobePlayground !== undefined,
  );
}

type Tile = {
  root: string;
  level: number;
  imageryLevel: number | null;
  texelErrorPx: number;
  westDeg: number;
  eastDeg: number;
  southDeg: number;
  northDeg: number;
};

/**
 * Waits until the engine has drawn the same frame for 600 ms and every Mercator tile lying inside `bbox` (the built
 * area) shows imagery fine enough for the view (texels within 1.5 px, or the highest built level `maxZoom`); tiles
 * outside it may show coarser data.
 */
async function waitForSettled(page: Page, bbox: readonly number[] | null, maxZoom = 22): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async ([box, max]) => {
            const globe = (
              globalThis as unknown as {
                vibeglobePlayground: { globe: { ready: Promise<void>; frameNumber: number; surfaceTiles(): Tile[] } };
              }
            ).vibeglobePlayground.globe;
            await globe.ready;
            const before = globe.frameNumber;
            await new Promise((r) => setTimeout(r, 600));
            const tiles = globe.surfaceTiles();
            const inside = (t: Tile): boolean =>
              box !== null &&
              t.root === 'mercator' &&
              t.westDeg >= (box[0] ?? 0) &&
              t.eastDeg <= (box[2] ?? 0) &&
              t.southDeg >= (box[1] ?? 0) &&
              t.northDeg <= (box[3] ?? 0);
            const own = tiles.filter(inside);
            const complete =
              box === null ||
              (own.length > 0 &&
                own.every((t) => t.imageryLevel !== null && (t.imageryLevel === max || t.texelErrorPx <= 1.5)));
            return before === globe.frameNumber && tiles.length > 0 && complete;
          },
          [bbox, maxZoom] as const,
        ),
      { timeout: 120_000 },
    )
    .toBe(true);
}

/** Pixels of the captured frame that are background-colored or black. */
async function emptyPixels(page: Page): Promise<{ empty: number; total: number }> {
  return page.evaluate(async (background) => {
    const globe = (
      globalThis as unknown as { vibeglobePlayground: { globe: { captureFrame(): Promise<{ rgba: Uint8Array }> } } }
    ).vibeglobePlayground.globe;
    const { rgba } = await globe.captureFrame();
    let empty = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const [r = 0, g = 0, b = 0, a = 0] = [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
      const bg =
        a < 255 ||
        Math.abs(r - (background[0] ?? 0)) + Math.abs(g - (background[1] ?? 0)) + Math.abs(b - (background[2] ?? 0)) <
          12;
      if (bg || r + g + b < 24) empty++;
    }
    return { empty, total: rgba.length / 4 };
  }, BACKGROUND);
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`the static imagery folder loads through the XYZ adapter with no empty pixel at its highest level (F336, F340, ${backend})`, async ({
    page,
  }) => {
    await serveStatic(page, 'imagery', 'jpg');
    for (const zoom of [12, 15]) {
      await openGlobe(page, `backend=${backend}&imagery=world&session=tools&lon=6.86&lat=45.95&zoom=${zoom}`);
      await waitForSettled(page, SAMPLE, 14);
      expect(await emptyPixels(page)).toMatchObject({ empty: 0 });
    }
    expect(requests.some((line) => /^GET \/static\/output\/imagery\/14\//.test(line))).toBe(true);
  });

  test(`the global fallback is the pinned base: no empty pixel from any direction, poles included (F338, ${backend})`, async ({
    page,
  }) => {
    const real = process.env['VIBEGLOBE_TOOLS_FALLBACK'];
    const image = real ? join(real, 'output', 'fallback-base.jpg') : join(root, 'output', 'fallback-base.jpg');
    expect(existsSync(image)).toBe(true);
    await page.route('**/imagery/natural-earth-4096.jpg', (route) =>
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: readFileSync(image) }),
    );
    const views = [
      [0, 0],
      [90, 20],
      [180, -20],
      [-90, 45],
      [30, 89],
      [-150, -89],
    ];
    for (const [lon, lat] of views) {
      await openGlobe(page, `backend=${backend}&lon=${lon}&lat=${lat}&zoom=5`);
      await waitForSettled(page, null);
      expect(await emptyPixels(page), `view ${lon}, ${lat}`).toMatchObject({ empty: 0 });
    }
  });
}

test('PMTiles and MBTiles packages hold the same tile bytes as the static folder (F336)', () => {
  const pmtiles = PmtilesReader.open(join(root, 'output', 'imagery.pmtiles'));
  const mbtiles = readMbtiles(join(root, 'output', 'imagery.mbtiles'));
  const entries = pmtiles.entries();
  expect(entries.reduce((n, e) => n + e.runLength, 0)).toBe(mbtiles.count());
  for (const [z, x, y] of [
    [10, 531, 364],
    [12, 2126, 1458],
    [14, 8505, 5834],
    [14, 8511, 5839],
  ] as const) {
    const file = new Uint8Array(readFileSync(join(root, 'output', 'imagery', `${z}/${x}/${y}.jpg`)));
    expect(pmtiles.tile(z, x, y)).toEqual(file);
    expect(mbtiles.tile(z, x, y)).toEqual(file);
  }
  pmtiles.close();
  mbtiles.close();
});

test('a globe-to-street session on the default configuration requests only the self-hosted origin (F344)', async ({
  page,
  baseURL,
}) => {
  const origins = new Set<string>();
  page.on('request', (request) => origins.add(new URL(request.url()).origin));
  await serveStatic(page, 'imagery', 'jpg');
  await page.route('**/imagery/natural-earth-4096.jpg', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: readFileSync(join(root, 'output', 'fallback-base.jpg')),
    }),
  );
  await openGlobe(page, 'backend=webgl2&imagery=world&session=tools&lon=6.86&lat=45.95&zoom=2');
  for (const zoom of [2, 5, 8, 11, 14, 17]) {
    await page.evaluate(
      (z) =>
        (
          globalThis as unknown as { vibeglobePlayground: { globe: { jumpTo(v: { zoom: number }): void } } }
        ).vibeglobePlayground.globe.jumpTo({ zoom: z }),
      zoom,
    );
    await waitForSettled(page, null);
  }
  expect([...origins]).toEqual([new URL(baseURL ?? '').origin]);
});
