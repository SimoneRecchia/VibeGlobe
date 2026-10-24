// The sample builds of both shipped configurations as source chains (F551): Italy at high detail (z10–14) over the
// world at low detail (z6–8) and its fallback (z5), across Italy's border near Mont Blanc (the Italy sample is the
// sample box's Italian part), in the playground. Builds their imagery from the public buckets when the outputs are
// missing (`vibeglobe-data build <config> --sample`). Their vector outputs pass the MVT conformance suite in
// scripts/integration/osm-vector-tiles.test.ts. VIBEGLOBE_TOOLS_SAMPLES=<folder> holds `world-low-sample/` and
// `italy-high-sample/` from elsewhere.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { PNG } from 'pngjs';
import type { createManifest as CreateManifest } from '@vibeglobe/offline';
import { runBuild } from '../pipeline/build.js';
import { openHarness, servePackages, startHarness, viewAt } from '../../../../e2e/support/offline.ts';

const CONFIGS = join(import.meta.dirname, '../../configs');
const SAMPLES =
  process.env['VIBEGLOBE_TOOLS_SAMPLES'] ?? join(import.meta.dirname, '../../node_modules/.vibeglobe-data');
const output = (config: string, dataset: string): string => join(SAMPLES, `${config}-sample`, 'output', dataset);
/**
 * A tile the Italy sample holds whole (z13 4253/2918), whose western neighbour lies outside Italy: the view is centred on
 * its west edge, where the chain switches from high to low detail (the sample is the sample box's Italian part).
 */
const INSIDE_TILE = {
  westDeg: 6.8994140625,
  eastDeg: 6.943359375,
  northDeg: 45.89000815866183,
  southDeg: 45.859412127907554,
};
const EDGE_DEG = INSIDE_TILE.westDeg;
const LAT_DEG = (INSIDE_TILE.northDeg + INSIDE_TILE.southDeg) / 2;
/** The playground page background behind its transparent canvas. */
const BACKGROUND = [11, 16, 32];
/** Largest mean difference (of 255) between the band inside the edge and the same band from the low-detail data. */
const TONE_THRESHOLD = 12;

test.beforeAll(async () => {
  test.setTimeout(1_800_000);
  for (const [config, datasets] of [
    ['world-low', ['imagery', 'fallback']],
    ['italy-high', ['imagery']],
  ] as const) {
    if (datasets.every((d) => existsSync(join(output(config, d), 'metadata.json')))) continue;
    await runBuild({
      configPath: join(CONFIGS, `${config}.json`),
      outDir: join(SAMPLES, `${config}-sample`),
      sample: true,
      yes: true,
      interactive: false,
      until: 'package',
      datasets: [...datasets],
      fetch,
      ask: () => Promise.resolve(false),
      report: () => undefined,
    });
  }
});

/**
 * Answers the playground's fixture patterns from the static folders: `italy` (the primary source), `world` and
 * `fallback` (the chain behind it); 404 where a build has no tile.
 */
async function serveChain(page: Page): Promise<Map<string, number>> {
  const folders: Record<string, string> = {
    italy: output('italy-high', 'imagery'),
    world: output('world-low', 'imagery'),
    fallback: output('world-low', 'fallback'),
  };
  const served = new Map<string, number>();
  await page.route('**/fixture-tiles/**/mercator/*/*/*.png', async (route) => {
    const [, pattern = '', z, x, y] = /\/(\w+)\/mercator\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(route.request().url()) ?? [];
    const folder = folders[pattern];
    const file = [`${String(y)}.jpg`, `${String(y)}.png`]
      .map((name) => join(folder ?? '', String(z), String(x), name))
      .find((path) => folder !== undefined && existsSync(path));
    if (!file) return route.fulfill({ status: 404 });
    served.set(pattern, (served.get(pattern) ?? 0) + 1);
    return route.fulfill({
      status: 200,
      contentType: file.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
      body: readFileSync(file),
    });
  });
  return served;
}

/** Waits until no imagery tile is waiting, loading or decoding, once streaming has started. */
async function settle(page: Page): Promise<void> {
  type Stats = { requested: number; queued: number; loading: number; decoding: number; uploadsPending: number };
  const stats = (): Promise<Stats | undefined> =>
    page.evaluate(() =>
      (
        globalThis as unknown as { vibeglobePlayground?: { globe: { imageryStats(): Stats | undefined } } }
      ).vibeglobePlayground?.globe.imageryStats(),
    );
  await expect.poll(async () => (await stats())?.requested ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const s = await stats();
        return s ? s.queued + s.loading + s.decoding + s.uploadsPending : -1;
      },
      { timeout: 60_000 },
    )
    .toBe(0);
  await page.waitForTimeout(600);
}

async function frame(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.locator('canvas').first().screenshot());
}

/** Background-colored or black pixels between 15% and 90% of the height (below the controls, above the credits). */
function holes(image: PNG): number {
  let count = 0;
  for (let y = Math.floor(image.height * 0.15); y < Math.floor(image.height * 0.9); y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const [r = 0, g = 0, b = 0] = [image.data[i], image.data[i + 1], image.data[i + 2]];
      const background =
        Math.abs(r - (BACKGROUND[0] ?? 0)) + Math.abs(g - (BACKGROUND[1] ?? 0)) + Math.abs(b - (BACKGROUND[2] ?? 0)) <
        12;
      if (background || r + g + b < 15) count++;
    }
  return count;
}

/** The mean color of a rectangle of the frame, clamped to the measured rows. */
function bandMean(image: PNG, fromX: number, toX: number, fromY: number, toY: number): [number, number, number] {
  const sum = [0, 0, 0];
  let n = 0;
  const top = Math.max(Math.floor(image.height * 0.15), Math.round(fromY));
  const bottom = Math.min(Math.floor(image.height * 0.9), Math.round(toY));
  for (let y = top; y < bottom; y++)
    for (let x = Math.max(0, Math.round(fromX)); x < Math.min(image.width, Math.round(toX)); x++) {
      for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (image.data[(y * image.width + x) * 4 + c] ?? 0);
      n++;
    }
  return sum.map((v) => v / Math.max(1, n)) as [number, number, number];
}

const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`the sample builds as a source chain: high detail inside, seamless fallback outside, on ${backend} (F551)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 320 });
    const served = await serveChain(page);
    const query = (chain: boolean, zoom: number): string =>
      `/?backend=${backend}&session=samples&lon=${EDGE_DEG}&lat=${LAT_DEG}&zoom=${zoom}&` +
      (chain
        ? 'imagery=italy&imageryMin=10&imageryMax=14&chain=world:8,fallback:5'
        : 'imagery=world&imageryMax=8&chain=fallback:5');
    for (const zoom of [9, 10, 11, 12, 13]) {
      await page.goto(query(true, zoom));
      await settle(page);
      const image = await frame(page);
      expect(holes(image), `zoom ${String(zoom)}`).toBe(0);
      if (zoom < 11) continue;
      // The tone of the high-detail band just inside the edge matches the same band drawn from the low-detail data.
      const screen = (longitudeDeg: number, latitudeDeg: number): Promise<{ xPx: number; yPx: number } | undefined> =>
        page.evaluate(
          (p) =>
            (
              globalThis as unknown as {
                vibeglobePlayground: { globe: { geoToScreen(p: object): { xPx: number; yPx: number } | undefined } };
              }
            ).vibeglobePlayground.globe.geoToScreen(p),
          { longitudeDeg, latitudeDeg },
        );
      // The tone of the high-detail tile matches the same area drawn from the low-detail data.
      const corner = await screen(INSIDE_TILE.westDeg, INSIDE_TILE.northDeg);
      const opposite = await screen(INSIDE_TILE.eastDeg, INSIDE_TILE.southDeg);
      if (!corner || !opposite) throw new Error('the tile is not in view');
      const rect = [corner.xPx + 2, opposite.xPx - 2, corner.yPx + 2, opposite.yPx - 2] as const;
      const inside = bandMean(image, ...rect);
      await page.goto(query(false, zoom));
      await settle(page);
      const low = bandMean(await frame(page), ...rect);
      console.log(
        `[samples] ${backend} zoom ${String(zoom)}: inside ${inside.map(Math.round).join(',')}, low ${low.map(Math.round).join(',')}`,
      );
      expect(distance(inside, low), `tone at zoom ${String(zoom)}`).toBeLessThan(TONE_THRESHOLD);
    }
    expect(served.get('italy') ?? 0, 'high-detail tiles').toBeGreaterThan(0);
    expect(served.get('world') ?? 0, 'low-detail tiles').toBeGreaterThan(0);
  });

/** Globe to street over the Italian sample (F554): the views, from the whole globe down to the Italy sample's z14. */
const GLOBE_TO_STREET = [2, 5, 8, 11, 14] as const;

/** Installs the three sample packages for one source in the offline harness, offline only, and restarts its globe. */
async function installSamplePackages(page: Page, backend: 'webgpu' | 'webgl2'): Promise<void> {
  const packages = [
    {
      id: 'fallback',
      file: join(SAMPLES, 'world-low-sample', 'output', 'fallback.pmtiles'),
      dataset: output('world-low', 'fallback'),
    },
    {
      id: 'world',
      file: join(SAMPLES, 'world-low-sample', 'output', 'imagery.pmtiles'),
      dataset: output('world-low', 'imagery'),
    },
    {
      id: 'italy',
      file: join(SAMPLES, 'italy-high-sample', 'output', 'imagery.pmtiles'),
      dataset: output('italy-high', 'imagery'),
    },
  ].map((p) => {
    const metadata = JSON.parse(readFileSync(join(p.dataset, 'metadata.json'), 'utf8')) as {
      minzoom: number;
      maxzoom: number;
      bounds: [number, number, number, number];
      license: string;
      attribution: string;
    };
    return { id: p.id, bytes: readFileSync(p.file), metadata };
  });
  const server = await servePackages(page);
  for (const p of packages) server.files.set(`samples/${p.id}.pmtiles`, p.bytes);
  await openHarness(page);
  await startHarness(page, {
    network: 'offline',
    backend,
    // Offline only: every tile comes from the packages, the pinned base image elsewhere.
    sources: [{ id: 'imagery', url: 'https://tiles.example.test/{z}/{x}/{y}.jpg', maxLevel: 14 }],
    view: { longitudeDeg: EDGE_DEG + 0.02, latitudeDeg: LAT_DEG, zoom: 2 },
  });
  const installed = await page.evaluate(
    async (list) => {
      const repo = location.pathname.replace(/\/e2e\/support\/[^/]*$/, '');
      const { createManifest } = (await import(/* @vite-ignore */ `${repo}/packages/offline/src/index.ts`)) as {
        createManifest: typeof CreateManifest;
      };
      const ids: (string | undefined)[] = [];
      for (const p of list) {
        const data = await (await fetch(`/offline-fixtures/samples/${p.id}.pmtiles`)).blob();
        const path = `${p.id}.pmtiles`;
        const [westDeg, southDeg, eastDeg, northDeg] = p.metadata.bounds;
        const manifest = await createManifest({
          id: p.id,
          version: '1',
          area: { westDeg, southDeg, eastDeg, northDeg },
          sources: [
            {
              sourceId: 'imagery',
              file: path,
              minLevel: p.metadata.minzoom,
              maxLevel: p.metadata.maxzoom,
              license: p.metadata.license,
              attribution: { text: p.metadata.attribution },
            },
          ],
          files: [{ path, format: 'pmtiles', data }],
        });
        ids.push((await window.offlineHarness?.manager?.install({ manifest, files: { [path]: data } }))?.id);
      }
      return ids;
    },
    packages.map((p) => ({ id: p.id, metadata: p.metadata })),
  );
  expect(installed).toEqual(['fallback', 'world', 'italy']);
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`the sample outputs, as static folders and as packages, run globe to street over Italy with no black pixel on ${backend} (F554)`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 480, height: 320 });
    // Static folders: the playground's source chain over the three folders.
    const served = await serveChain(page);
    for (const zoom of GLOBE_TO_STREET) {
      await page.goto(
        `/?backend=${backend}&session=samples-f554&lon=${EDGE_DEG + 0.02}&lat=${LAT_DEG}&zoom=${zoom}&` +
          'imagery=italy&imageryMin=10&imageryMax=14&chain=world:8,fallback:5',
      );
      await settle(page);
      expect(holes(await frame(page)), `static folders, zoom ${String(zoom)}`).toBe(0);
    }
    expect(served.get('italy') ?? 0).toBeGreaterThan(0);
    // Packages: the same outputs' PMTiles installed in an offline-only engine.
    await page.unrouteAll();
    await installSamplePackages(page, backend);
    for (const zoom of GLOBE_TO_STREET)
      expect(await viewAt(page, EDGE_DEG + 0.02, LAT_DEG, zoom), `packages, zoom ${String(zoom)}`).toBe(0);
    const fromPackages = await page.evaluate(
      () => (window.offlineHarness?.served ?? []).filter((e) => e.tier === 'package' && e.coord.level === 14).length,
    );
    expect(fromPackages, 'z14 tiles from the Italy package').toBeGreaterThan(0);
  });
