// Packages written by the offline package builder CLI (packages/tools, `vibeglobe-data pack`) load through the M7
// PMTiles and MBTiles adapters in offline-only mode and navigate their area with no empty pixel and no request
// (F304, F305, offline track). The CLI's tile selection is asserted in packages/tools/src/pack/pack.test.ts. It runs
// the built CLI (npm run build) against the playground's fixture tile server.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { createManifest as CreateManifest } from '@vibeglobe/offline';
import { openHarness, servePackages, startHarness, viewAt } from './support/offline.ts';

// One shared setup (beforeAll) for the file's tests: they run in order on one worker, together in one shard
// (playwright.config.ts runs everything else fully parallel, ADR 0035).
test.describe.configure({ mode: 'default' });

const BIN = 'packages/tools/dist/bin.js';
const DEV = `http://localhost:${process.env['PLAYGROUND_PORT'] ?? 5173}`;

let dir = '';
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vibeglobe-cli-packages-'));
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `vibeglobe-data pack` on the fixture source with the area arguments, and returns the package file. */
function pack(session: string, area: string[], format: 'pmtiles' | 'mbtiles'): Buffer {
  const out = join(dir, `${session}.${format}`);
  const run = spawnSync(
    process.execPath,
    [
      BIN,
      'pack',
      '--source',
      `${DEV}/fixture-tiles/${session}/world/mercator/{z}/{x}/{y}.png`,
      '--profile',
      'fixture',
      ...area,
      '--zooms',
      '0-14',
      '--format',
      format,
      '--out',
      out,
      '--yes',
    ],
    { encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
  return readFileSync(out);
}

/** Installs a CLI package from local files in an offline-only engine and restarts the globe on it. */
async function installOffline(page: Page, file: Buffer, format: 'pmtiles' | 'mbtiles'): Promise<string[]> {
  const server = await servePackages(page);
  server.files.set(`cli/package.${format}`, file);
  await openHarness(page);
  await startHarness(page, {
    network: 'offline',
    sources: [{ id: 'world', pattern: 'world', session: 'cli-online', maxLevel: 14 }],
    view: { longitudeDeg: 12.49, latitudeDeg: 41.9, zoom: 3 },
  });
  const installed = await page.evaluate(async (format) => {
    const repo = location.pathname.replace(/\/e2e\/support\/[^/]*$/, '');
    const { createManifest } = (await import(/* @vite-ignore */ `${repo}/packages/offline/src/index.ts`)) as {
      createManifest: typeof CreateManifest;
    };
    const data = await (await fetch(`/offline-fixtures/cli/package.${format}`)).blob();
    const path = `package.${format}`;
    const manifest = await createManifest({
      id: 'cli',
      version: '1',
      area: { westDeg: 12.4, southDeg: 41.82, eastDeg: 12.6, northDeg: 41.98 },
      sources: [
        {
          sourceId: 'world',
          file: path,
          minLevel: 0,
          maxLevel: 14,
          license: 'CC-BY-4.0',
          attribution: { text: 'VibeGlobe test fixture' },
        },
      ],
      files: [{ path, format, data }],
    });
    const result = await window.offlineHarness?.manager?.install({ manifest, files: { [path]: data } });
    return result?.id;
  }, format);
  expect(installed).toBe('cli');
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  const requests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(`${DEV}/@`) && !request.url().includes('/node_modules/'))
      requests.push(request.url());
  });
  return requests;
}

/** Package tiles served at a level. */
async function packageTilesAt(page: Page, level: number): Promise<number> {
  return page.evaluate(
    (l) => (window.offlineHarness?.served ?? []).filter((e) => e.tier === 'package' && e.coord.level === l).length,
    level,
  );
}

test('a PMTiles package from the CLI (bounding box around Rome, zooms 0–14) navigates offline-only with no empty pixel (F304)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const file = pack('cli-f304', ['--bbox', '12.40,41.82,12.58,41.97'], 'pmtiles');
  const requests = await installOffline(page, file, 'pmtiles');
  for (const [lon, lat, zoom] of [
    [12.49, 41.9, 4],
    [12.49, 41.9, 8],
    [12.49, 41.9, 11],
    [12.45, 41.86, 13],
    [12.49, 41.9, 14],
    [12.54, 41.94, 14],
  ] as const)
    expect(await viewAt(page, lon, lat, zoom), `${lon}, ${lat}, zoom ${zoom}`).toBe(0);
  expect(await packageTilesAt(page, 14)).toBeGreaterThan(0);
  expect(requests).toEqual([]);
});

test('an MBTiles package from the CLI (a polygon) navigates offline-only inside the polygon with no empty pixel (F305)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const polygon = join(dir, 'triangle.geojson');
  writeFileSync(
    polygon,
    JSON.stringify({
      type: 'Polygon',
      coordinates: [
        [
          [12.4, 41.85],
          [12.6, 41.82],
          [12.55, 41.98],
          [12.4, 41.85],
        ],
      ],
    }),
  );
  const file = pack('cli-f305', ['--polygon', polygon], 'mbtiles');
  const requests = await installOffline(page, file, 'mbtiles');
  for (const [lon, lat, zoom] of [
    [12.52, 41.88, 4],
    [12.52, 41.88, 8],
    [12.52, 41.88, 11],
    [12.52, 41.88, 13],
    [12.52, 41.88, 14],
    [12.55, 41.9, 14],
  ] as const)
    expect(await viewAt(page, lon, lat, zoom), `${lon}, ${lat}, zoom ${zoom}`).toBe(0);
  expect(await packageTilesAt(page, 14)).toBeGreaterThan(0);
  expect(requests).toEqual([]);
});
