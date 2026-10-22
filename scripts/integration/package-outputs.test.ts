// F336's package steps, across the two tracks' packages: one build writes the static folder, a PMTiles and an MBTiles
// package, and every tile read through the engine's PMTiles and MBTiles adapters is byte-identical to the static folder.
// Both packages then pass the offline package integrity check of `@vibeglobe/offline` (F309) when installed.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createManifest, createOffline, createPackageManager, memoryStore } from '@vibeglobe/offline';
import type { ImagerySource } from '@vibeglobe/core';
import { pmtilesImagery, xyzImagery } from '@vibeglobe/sources';
import { mbtilesImagery } from '@vibeglobe/sources/mbtiles';
import { runBuild } from '@vibeglobe/tools';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { afterAll, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'vg-packages-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const DEM = new Uint8Array(
  readFileSync(new URL('../../packages/tools/src/fixtures/copernicus-dem-mont-blanc.tif', import.meta.url)),
);

function staticTiles(root: string): { z: number; x: number; y: number; bytes: Uint8Array }[] {
  const out: { z: number; x: number; y: number; bytes: Uint8Array }[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.png')) {
        const [z = 0, x = 0, y = 0] = relative(root, full)
          .replace(/\.png$/, '')
          .split(/[\\/]/)
          .map(Number);
        out.push({ z, x, y, bytes: new Uint8Array(readFileSync(full)) });
      }
    }
  };
  walk(root);
  return out;
}

function read(source: ImagerySource, z: number, x: number, y: number): Promise<Uint8Array | string> {
  const request = source.request({ root: 0, level: z, x, y }, { url: '', hostIndex: 0 });
  if (request === 'noData') return Promise.resolve('noData');
  return new Promise((resolve) =>
    source.transport.start(request, { firstByteMs: 5000, totalMs: 10_000 }, (result) =>
      resolve(result.kind === 'ok' ? new Uint8Array(result.bytes) : JSON.stringify(result)),
    ),
  );
}

it(
  'the PMTiles and MBTiles packages of a build hold the static folder’s tiles byte for byte (F336)',
  { timeout: 60_000 },
  async () => {
    const config = {
      configVersion: '1.0.0',
      name: 'packages',
      description: 'a terrain build with every output',
      region: { bbox: [6.845, 45.815, 6.875, 45.845] },
      sampleArea: { bbox: [6.845, 45.815, 6.875, 45.845] },
      prices: {
        currency: 'USD',
        readDate: '2026-10-21',
        sourceUrl: 'https://example.test',
        requesterPaysTransferPerGB: 0.09,
        requesterPaysGetPer1000: 0.0004,
        freeTransferPerGB: 0,
      },
      tools: { gdal: `ghcr.io/osgeo/gdal@sha256:${'a'.repeat(64)}` },
      datasets: [
        {
          id: 'terrain',
          kind: 'terrain',
          profile: 'copernicus-dem-glo30',
          dataYear: 2021,
          sourceVersion: '2021_1',
          source: { type: 'copernicus-dem', baseUrl: 'https://dem.fixture.test', release: '2021_1', arcSeconds: 1 },
          minZoom: 12,
          maxZoom: 14,
          encoding: 'terrarium',
          bytesPerTile: 100_000,
          downloadBytesPerFile: DEM.length,
          outputs: { static: true, pmtiles: true, mbtiles: true },
        },
      ],
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    await runBuild({
      configPath: join(dir, 'config.json'),
      outDir: join(dir, 'out'),
      sample: false,
      yes: true,
      interactive: false,
      until: 'package',
      fetch: ((url: string) =>
        Promise.resolve(
          url.includes('N45_00_E006') ? new Response(DEM.slice()) : new Response('', { status: 404 }),
        )) as typeof fetch,
      ask: () => Promise.resolve(false),
      report: () => undefined,
    });
    const output = join(dir, 'out', 'output');
    const tiles = staticTiles(join(output, 'terrain'));
    expect(tiles.length).toBeGreaterThan(5);
    const pmtiles = await pmtilesImagery({
      id: 'pm',
      archive: new Blob([readFileSync(join(output, 'terrain.pmtiles'))]),
    });
    const mbtiles = await mbtilesImagery({
      id: 'mb',
      package: new Blob([readFileSync(join(output, 'terrain.mbtiles'))]),
    });
    expect([pmtiles.minLevel, pmtiles.maxLevel, mbtiles.minLevel, mbtiles.maxLevel]).toEqual([12, 14, 12, 14]);
    for (const tile of tiles) {
      expect(await read(pmtiles, tile.z, tile.x, tile.y)).toEqual(tile.bytes);
      expect(await read(mbtiles, tile.z, tile.x, tile.y)).toEqual(tile.bytes);
    }
    // The offline package integrity check: each package installs with every chunk verified against its manifest, and
    // the installed copy serves the static folder's bytes.
    for (const format of ['pmtiles', 'mbtiles'] as const) {
      const path = `terrain.${format}`;
      const data = new Blob([readFileSync(join(output, path))]);
      const manifest = await createManifest({
        id: `terrain-${format}`,
        version: '1',
        area: { westDeg: 6.845, southDeg: 45.815, eastDeg: 6.875, northDeg: 45.845 },
        sources: [
          {
            sourceId: 'terrain',
            file: path,
            minLevel: 12,
            maxLevel: 14,
            license: 'CC-BY-4.0',
            attribution: { text: 'Copernicus DEM' },
          },
        ],
        files: [{ path, format, data }],
      });
      const offline = createOffline({ store: memoryStore(), mode: 'offline' });
      const errors: string[] = [];
      const manager = createPackageManager(offline, {
        adapters: { pmtiles: pmtilesImagery, mbtiles: mbtilesImagery },
        indexedDB: new IDBFactory(),
        localStorage: { getItem: () => null, setItem: () => undefined },
        onIntegrityError: (event) => errors.push(event.message),
      });
      await manager.install({ manifest, files: { [path]: data } });
      const [first] = tiles;
      if (!first) throw new Error('no tile');
      const tiered = offline.source(
        xyzImagery({ id: 'terrain', url: 'https://unreachable.test/{z}/{x}/{y}.png', minLevel: 12, maxLevel: 14 }),
      );
      expect(await read(tiered, first.z, first.x, first.y)).toEqual(first.bytes);
      expect(errors).toEqual([]);
      manager.destroy();
      offline.destroy();
    }
  },
);
