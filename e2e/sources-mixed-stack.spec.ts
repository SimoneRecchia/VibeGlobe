// M7 acceptance (F269): a mixed stack switches sources without seams or jumps. Bottom first: an offline package base
// (a PMTiles package the CLI built from the fixture world, zooms 0–5), the online detail chain over Italy (`smooth` to
// zoom 14, then `world` to 12), the UTM zone 32 raster reprojected on the client, and a transparent WMS overlay, over
// the fixture terrain within a box across the Alps (the ellipsoid outside it). Every
// frame of a zoom, a pan and a flight across their boundaries is checked on both backends. The adapters' conformance
// suites run in Vitest (`packages/sources`).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 320, height: 240 } });

const DEV = `http://localhost:${process.env['PLAYGROUND_PORT'] ?? 5173}`;
const H = 20037508.342789244;
/** WMS labels: dark blue boxes at these places, the rest transparent. */
const LABELS = [
  { longitudeDeg: 12.5, latitudeDeg: 41.9 },
  { longitudeDeg: 9.19, latitudeDeg: 45.46 },
  { longitudeDeg: 7.5, latitudeDeg: 45.5 },
  { longitudeDeg: 2.35, latitudeDeg: 48.85 },
];

let packageFile = Buffer.alloc(0);
let wmsRequests = 0;
let dir = '';
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vibeglobe-mixed-stack-'));
  const out = join(dir, 'base.pmtiles');
  const run = spawnSync(
    process.execPath,
    [
      'packages/tools/dist/bin.js',
      'pack',
      '--source',
      `${DEV}/fixture-tiles/mixed-package/world/mercator/{z}/{x}/{y}.png`,
      '--profile',
      'fixture',
      '--bbox',
      '-180,-85,180,85',
      '--zooms',
      '0-5',
      '--format',
      'pmtiles',
      '--out',
      out,
      '--yes',
    ],
    { encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
  packageFile = readFileSync(out);
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Serves the package with range requests, as a static host does. */
function servePackage(route: Route): Promise<void> {
  const range = /bytes=(\d+)-(\d+)/.exec(route.request().headers()['range'] ?? '');
  if (!range) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: packageFile });
  const start = Number(range[1]);
  const end = Math.min(packageFile.length - 1, Number(range[2]));
  return route.fulfill({
    status: 206,
    contentType: 'application/octet-stream',
    headers: { 'Content-Range': `bytes ${start}-${end}/${packageFile.length}` },
    body: packageFile.subarray(start, end + 1),
  });
}

/** A WMS GetMap answer in Web Mercator: transparent, with a 24 × 10 px label box at each label's place. */
function renderGetMap(url: string): Buffer {
  const params = new URL(url).searchParams;
  const [minx = 0, miny = 0, maxx = 0, maxy = 0] = (params.get('BBOX') ?? '').split(',').map(Number);
  const width = Number(params.get('WIDTH'));
  const height = Number(params.get('HEIGHT'));
  const image = new PNG({ width, height });
  for (const label of LABELS) {
    const x = ((label.longitudeDeg / 180) * H - minx) / (maxx - minx);
    const my = (H * Math.log(Math.tan(Math.PI / 4 + (label.latitudeDeg * Math.PI) / 360))) / Math.PI;
    const y = (maxy - my) / (maxy - miny);
    const [ci, cj] = [Math.round(x * width), Math.round(y * height)];
    for (let j = Math.max(0, cj - 5); j < Math.min(height, cj + 5); j++)
      for (let i = Math.max(0, ci - 12); i < Math.min(width, ci + 12); i++)
        image.data.set([20, 20, 110, 255], (j * width + i) * 4);
  }
  return PNG.sync.write(image);
}

/** Adds the package base under the playground's layers and the WMS overlay on top, and waits for them. */
async function addStackEnds(page: Page): Promise<void> {
  await page.route('**/mixed-stack/base.pmtiles', servePackage);
  await page.route('https://wms.test/map**', (route) => {
    wmsRequests++;
    return route.fulfill({
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/png' },
      body: renderGetMap(route.request().url()),
    });
  });
  await page.evaluate(async (repo) => {
    const sources = (await import(
      /* @vite-ignore */ `${repo}/packages/sources/src/index.ts`
    )) as typeof import('@vibeglobe/sources');
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const base = await sources.pmtilesImagery({
      id: 'package-base',
      archive: `${location.origin}/mixed-stack/base.pmtiles`,
    });
    globe.imageryLayers.add(base, 0);
    const wms = await sources.wmsImagery({
      id: 'wms-labels',
      url: 'https://wms.test/map',
      version: '1.3.0',
      layers: ['labels'],
      transparent: true,
      preferredCrs: 'EPSG:3857',
      maxLevel: 18,
    });
    globe.imageryLayers.add({ sources: [wms], opacity: 1 });
  }, `/@fs${process.cwd()}`);
  await waitForIdle(page);
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`a mixed stack of an offline package base, an online detail chain, a reprojected UTM layer and a WMS overlay switches sources with no black pixel, seam or jump on ${backend} (F269)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openGlobe(
      page,
      `backend=${backend}&session=mixed-${backend}&clockStepMs=16.666666666666668&lon=4&lat=46&zoom=3` +
        '&imagery=smooth&coverage=italy&imageryMax=14&chain=world:12:italy&utm=32632' +
        '&terrain=terrarium&terrainCoverage=alps',
    );
    await addStackEnds(page);
    const layers = await page.evaluate(() => window.vibeglobePlayground?.globe.imageryLayers.list().map((l) => l.id));
    expect(layers?.[0]).toBe('package-base');
    expect(layers?.length).toBe(4);
    // Every frame: no hole or black pixel, no pop, no terrain drop, no frame changed by a jump where a source switches.
    const report = await page.evaluate(() => window.vibeglobePlayground?.recordScenario('mixed-stack', 0));
    if (!report) throw new Error('no report');
    console.log(`[mixed-stack] ${backend}: ${JSON.stringify({ ...report, samples: undefined })}`);
    expect([report.holes, report.dark, report.pops, report.terrainDrops]).toEqual([0, 0, 0, 0]);
    expect(report.maxChangedShare).toBeLessThan(0.25);
    // The WMS overlay draws its labels over the layers below and lets them show around the labels.
    expect(wmsRequests).toBeGreaterThan(0);
    await page.evaluate(() =>
      window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 8 }),
    );
    await waitForIdle(page);
    const image = await canvasImage(page);
    const at = (x: number, y: number): number[] => [
      ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3),
    ];
    const label = await page.evaluate(() =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: 12.5, latitudeDeg: 41.9 }),
    );
    if (!label) throw new Error('Rome is not in view');
    const [lx, ly] = [Math.round(label.xPx), Math.round(label.yPx)];
    expect(at(lx, ly), 'the label').toEqual([20, 20, 110]);
    // Beside the label: the layers below, as they show with the overlay hidden (not the base image under them).
    const beside = at(lx, ly + 30);
    await page.evaluate(() => window.vibeglobePlayground?.globe.imageryLayers.set('wms-labels', { visible: false }));
    await waitForIdle(page);
    const hidden = await canvasImage(page);
    const below = [
      ...hidden.data.subarray(((ly + 30) * hidden.width + lx) * 4, ((ly + 30) * hidden.width + lx) * 4 + 3),
    ];
    expect(
      beside.every((value, c) => Math.abs(value - (below[c] ?? 0)) <= 8),
      `${beside} over ${below}`,
    ).toBe(true);
  });
