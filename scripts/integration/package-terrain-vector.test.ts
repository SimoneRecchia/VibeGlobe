// F328: PMTiles and MBTiles packages of terrain (Terrarium heightmaps, quantized-mesh) and Mapbox Vector Tiles load
// through the package adapters over HTTP (a LAN-style range server), from a local file and from browser storage
// (installed packages), deliver identical tiles that pass the terrain and MVT conformance checks, and go through the
// persistent cache like imagery.
import { readFileSync } from 'node:fs';
import type { TileCoord, TileSource, TransportResult } from '@vibeglobe/core';
import {
  createManifest,
  createOffline,
  createPackageManager,
  memoryStore,
  type ArchiveAdapters,
} from '@vibeglobe/offline';
import { heightmapTerrain, pmtilesArchive, pmtilesTerrain, pmtilesVector, xyzImagery } from '@vibeglobe/sources';
import { failures, runParserConformance, runTerrainConformance } from '@vibeglobe/sources/conformance';
import { mbtilesArchive, mbtilesTerrain, mbtilesVector } from '@vibeglobe/sources/mbtiles';
import { decodeMvt, type MvtTile } from '@vibeglobe/sources/vector';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { writeMbtiles } from '../../packages/sources/src/__fixtures__/mbtiles-writer.ts';
import { rangeServer, writePmtiles } from '../../packages/sources/src/__fixtures__/pmtiles-writer.ts';
import { fixturePosition, type FixtureTile } from '../fixtures/tiles/generate.ts';
import { fixtureHeightMeters, terrainTile } from '../fixtures/tiles/terrain.ts';

const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const fixtureTile = (c: TileCoord): FixtureTile => ({
  pattern: 'terrain' as FixtureTile['pattern'],
  scheme: 'mercator',
  ...c,
});
/** Tiles of the eastern hemisphere over rolling hills, and their ancestors down to level 3. */
const TILES = [coord(3, 5, 3), coord(4, 10, 7), coord(5, 20, 14), coord(6, 40, 28)];
const MISSING = coord(6, 41, 28);
const OUTSIDE = coord(6, 10, 28);
const EAST: [number, number, number, number] = [0, 0, 180, 85];
const key = (c: TileCoord): string => `${c.level}/${c.x}/${c.y}`;

const MVT_DIR = new URL('../../packages/sources/src/__fixtures__/mvt/', import.meta.url);
const MVT = [
  'real-bangkok-12-3188-1888.mvt',
  'real-chicago-13-2098-3045.mvt',
  'real-sanfrancisco-15-5238-12666.mvt',
].map((name) => new Uint8Array(readFileSync(new URL(name, MVT_DIR))));

function terrainTiles(encoding: 'terrarium' | 'quantized-mesh'): Map<string, Uint8Array> {
  return new Map(TILES.map((c) => [key(c), new Uint8Array(terrainTile(fixtureTile(c), encoding))]));
}

function vectorTiles(): Map<string, Uint8Array> {
  return new Map(TILES.slice(0, MVT.length).map((c, i) => [key(c), MVT[i] ?? new Uint8Array()]));
}

function decodePng(bytes: Uint8Array): { rgba: Uint8Array; sizePx: number } {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { rgba: new Uint8Array(png.data), sizePx: png.width };
}

function heights(toleranceMeters: number) {
  return TILES.slice(-2).map((c) => {
    const { lonRad, latRad } = fixturePosition(fixtureTile(c), 0.5, 0.5);
    return { coord: c, u: 0.5, v: 0.5, meters: fixtureHeightMeters(lonRad, latRad), toleranceMeters };
  });
}

/** Reads one tile through a source's own request and transport. */
function read(source: TileSource, c: TileCoord): Promise<Uint8Array | string> {
  const request = source.request(c, { url: '', hostIndex: 0 });
  if (request === 'noData' || request === 'unknown') return Promise.resolve('noData');
  return new Promise<TransportResult>((done) =>
    source.transport.start(request, { firstByteMs: 2000, totalMs: 4000 }, done),
  ).then((r) => (r.kind === 'ok' ? new Uint8Array(r.bytes) : r.kind));
}

async function expectSameTiles(source: TileSource, tiles: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [k, bytes] of tiles) {
    const [z = 0, x = 0, y = 0] = k.split('/').map(Number);
    expect(await read(source, coord(z, x, y)), k).toEqual(bytes);
  }
}

function mvtConformance(name: string, delivered: readonly Uint8Array[]) {
  return runParserConformance({
    name,
    parse: (input: Uint8Array) => decodeMvt(input),
    fuzzRuns: 20,
    fixtures: delivered.map((input, i) => ({
      name: `package tile ${String(i)}`,
      input,
      expect: (tile: MvtTile | undefined) => {
        const original = decodeMvt(MVT[i] ?? new Uint8Array());
        return JSON.stringify(tile?.layers.map((l) => [l.name, l.features.length])) ===
          JSON.stringify(original?.layers.map((l) => [l.name, l.features.length]))
          ? undefined
          : 'layers differ from the original tile';
      },
    })),
  });
}

describe('terrain and vector tiles in packages (F328)', { timeout: 60_000 }, () => {
  it('a PMTiles terrain package over HTTP passes the terrain conformance suite, and as a local file gives identical tiles', async () => {
    for (const encoding of ['terrarium', 'quantized-mesh'] as const) {
      const tiles = terrainTiles(encoding);
      const archive = writePmtiles(tiles, { tileType: encoding === 'terrarium' ? 2 : 0, bounds: EAST });
      const url = 'https://lan.test/terrain.pmtiles';
      const results = await runTerrainConformance({
        name: `pmtiles ${encoding}`,
        create: (fetchImpl) => pmtilesTerrain({ id: 'dem', archive: url, fetch: fetchImpl, encoding }),
        fixture: rangeServer(url, archive).fetch,
        tiles: TILES.map((c) => ({ coord: c, bytes: tiles.get(key(c)) })),
        missing: [MISSING],
        outside: [OUTSIDE],
        heights: heights(0.5),
        decodeImage: decodePng,
      });
      expect(failures(results)).toEqual([]);
      const local = await pmtilesTerrain({ id: 'dem', archive: new Blob([archive]), encoding });
      await expectSameTiles(local, tiles);
    }
  });

  it('an MBTiles terrain package over HTTP passes the terrain conformance suite, and as a local file gives identical tiles', async () => {
    const tiles = terrainTiles('terrarium');
    const bytes = await writeMbtiles(tiles, { format: 'png', minzoom: '3', maxzoom: '6', bounds: EAST.join(',') });
    const url = 'https://lan.test/terrain.mbtiles';
    const results = await runTerrainConformance({
      name: 'mbtiles terrarium',
      create: (fetchImpl) => mbtilesTerrain({ id: 'dem', package: url, fetch: fetchImpl, encoding: 'terrarium', downloadTimeoutMs: 300 }),
      fixture: rangeServer(url, bytes).fetch,
      network: 'on-open',
      tiles: TILES.map((c) => ({ coord: c, bytes: tiles.get(key(c)) })),
      missing: [MISSING],
      outside: [OUTSIDE],
      heights: heights(0.5),
      decodeImage: decodePng,
    });
    expect(failures(results)).toEqual([]);
    await expectSameTiles(
      await mbtilesTerrain({ id: 'dem', package: new Blob([bytes]), encoding: 'terrarium' }),
      tiles,
    );
  });

  it('PMTiles and MBTiles vector packages over HTTP and as local files deliver tiles that pass the MVT conformance checks', async () => {
    const tiles = vectorTiles();
    const pm = writePmtiles(tiles, { tileType: 1, bounds: EAST });
    const mb = await writeMbtiles(tiles, { format: 'pbf', minzoom: '3', maxzoom: '5', bounds: EAST.join(',') });
    const sources = [
      await pmtilesVector({
        id: 'roads',
        archive: 'https://lan.test/v.pmtiles',
        fetch: rangeServer('https://lan.test/v.pmtiles', pm).fetch,
      }),
      await pmtilesVector({ id: 'roads', archive: new Blob([pm]) }),
      await mbtilesVector({
        id: 'roads',
        package: 'https://lan.test/v.mbtiles',
        fetch: rangeServer('https://lan.test/v.mbtiles', mb).fetch,
      }),
      await mbtilesVector({ id: 'roads', package: new Blob([mb]) }),
    ];
    for (const source of sources) {
      expect(source.format).toBe('mvt');
      await expectSameTiles(source, tiles);
      const delivered = await Promise.all(TILES.slice(0, MVT.length).map((c) => read(source, c)));
      expect(failures(await mvtConformance('package mvt', delivered as Uint8Array[]))).toEqual([]);
    }
  });

  it('installed in browser storage, terrain and vector packages serve identical tiles offline', async () => {
    const terrain = terrainTiles('terrarium');
    const vector = vectorTiles();
    const files = {
      'dem.pmtiles': writePmtiles(terrain, { bounds: EAST }),
      'roads.mbtiles': await writeMbtiles(vector, { format: 'pbf' }),
    };
    const manifest = await createManifest({
      id: 'east',
      version: '1',
      area: { westDeg: 0, southDeg: 0, eastDeg: 180, northDeg: 85 },
      sources: [
        {
          sourceId: 'dem',
          file: 'dem.pmtiles',
          minLevel: 3,
          maxLevel: 6,
          license: 'CC0-1.0',
          attribution: { text: 'DEM' },
        },
        {
          sourceId: 'roads',
          file: 'roads.mbtiles',
          minLevel: 3,
          maxLevel: 5,
          license: 'ODbL-1.0',
          attribution: { text: 'Roads' },
        },
      ],
      files: Object.entries(files).map(([path, data]) => ({
        path,
        format: path.endsWith('.pmtiles') ? 'pmtiles' : 'mbtiles',
        data: new Blob([data]),
      })),
    });
    const offline = createOffline({ store: memoryStore(), mode: 'offline' });
    const adapters: ArchiveAdapters = {
      pmtiles: (o) => pmtilesArchive(o, 'any'),
      mbtiles: (o) => mbtilesArchive(o, 'any'),
    };
    const memory = new Map<string, string>();
    const manager = createPackageManager(offline, {
      adapters,
      indexedDB: new IDBFactory(),
      localStorage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) },
    });
    await manager.install({
      manifest: new Blob([JSON.stringify(manifest)]),
      files: Object.fromEntries(Object.entries(files).map(([path, data]) => [path, new Blob([data])])),
    });
    // The engine's own sources, unreachable here: every tile must come from the installed package.
    const dem = offline.source(
      heightmapTerrain({ id: 'dem', url: 'https://unreachable.test/{z}/{x}/{y}.png', encoding: 'terrarium' }),
    );
    const roads = offline.source(xyzImagery({ id: 'roads', url: 'https://unreachable.test/{z}/{x}/{y}.pbf' }));
    await expectSameTiles(dem, terrain);
    await expectSameTiles(roads, vector);
    expect(offline.stats('dem').package).toBe(terrain.size);
    expect(offline.stats('roads').package).toBe(vector.size);
    manager.destroy();
    offline.destroy();
  });

  it('terrain and vector tiles are written to and read from the persistent cache like imagery', async () => {
    const terrain = terrainTiles('terrarium');
    const memory = memoryStore();
    // Both sessions share the store, which outlives the first engine as browser storage does.
    const store = {
      get: (k: string) => memory.get(k),
      put: (k: string, t: Parameters<typeof memory.put>[1]) => memory.put(k, t),
      delete: (k: string) => memory.delete(k),
      deletePrefix: (p: string) => memory.deletePrefix(p),
      usage: () => memory.usage(),
      close: () => undefined,
    };
    const served = (url: string): Response => {
      const k = /\/(\d+\/\d+\/\d+)\.png$/.exec(url)?.[1] ?? '';
      const bytes = terrain.get(k);
      return bytes
        ? new Response(bytes.slice(), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' } })
        : new Response(null, { status: 404 });
    };
    const online = createOffline({ store, fetch: (input) => Promise.resolve(served(String(input))) });
    const url = 'https://dem.test/{z}/{x}/{y}.png';
    const first = online.source(heightmapTerrain({ id: 'dem', url, encoding: 'terrarium' }));
    await expectSameTiles(first, terrain);
    expect(online.stats('dem').network).toBe(terrain.size);
    online.destroy();
    // A new session with the network gone: the stored tiles come back from the persistent tier.
    const offline = createOffline({ store, mode: 'offline' });
    await expectSameTiles(offline.source(heightmapTerrain({ id: 'dem', url, encoding: 'terrarium' })), terrain);
    expect(offline.stats('dem').persistent).toBe(terrain.size);
    offline.destroy();
  });
});
