import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DatasetConfig } from '../config/schema.js';
import { COMPRESSION, TILE_TYPES, writePmtiles } from '../output/pmtiles.js';
import { LandMask } from '../tiles/land.js';
import { extractTiles } from './pmtiles-extract.js';
import { StepLog } from './step-log.js';

const root = mkdtempSync(join(tmpdir(), 'vg-extract-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Serves a local file with HTTP range requests, counting the bytes read. */
function rangeFetch(path: string): { fetch: typeof fetch; read: () => number } {
  const bytes = readFileSync(path);
  let read = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const [, from = '0', to = '0'] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '') ?? [];
    const part = bytes.subarray(Number(from), Number(to) + 1);
    read += part.byteLength;
    return new Response(part, { status: 206 });
  }) as typeof fetch;
  return { fetch: fetchImpl, read: () => read };
}

describe('tiles copied from a PMTiles archive (F614)', () => {
  it('copies only the area’s tiles, land only beyond the sea’s last zoom, reading ranges and not the archive', async () => {
    // A planet archive of zooms 0–6, each tile holding its own coordinates.
    const archive = join(root, 'planet.pmtiles');
    const tiles = [];
    for (let z = 0; z <= 6; z++)
      for (let x = 0; x < 2 ** z; x++)
        for (let y = 0; y < 2 ** z; y++)
          tiles.push({ z, x, y, read: () => new TextEncoder().encode(`${z}/${x}/${y}`) });
    writePmtiles(
      archive,
      tiles,
      {
        tileType: TILE_TYPES.mvt,
        tileCompression: COMPRESSION.none,
        minZoom: 0,
        maxZoom: 6,
        bounds: { west: -180, south: -85, east: 180, north: 85 },
        center: { lon: 0, lat: 0, zoom: 0 },
      },
      {},
    );
    const region = { west: 0, south: 0, east: 40, north: 40 };
    const mask = new LandMask(
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      ],
      region,
      6,
    );
    const dataset = {
      id: 'vectors',
      kind: 'vector',
      source: { type: 'pmtiles', url: 'https://archive.test/planet.pmtiles', extension: 'pbf' },
      minZoom: 3,
      maxZoom: 6,
      seaMaxZoom: 4,
      encoding: 'mvt',
    } as DatasetConfig;
    const folders = {
      downloads: join(root, 'downloads'),
      work: join(root, 'work'),
      tiles: join(root, 'output'),
      log: new StepLog(join(root, 'steps.log'), { work: 'w', source: 's' }),
      report: () => undefined,
    };
    const served = rangeFetch(archive);
    const area = { kind: 'bbox' as const, bbox: region };
    const counts = await extractTiles(dataset, area, folders, served.fetch, (z) => mask.tiles(z, 4));
    const expected = [3, 4, 5, 6].reduce((n, z) => n + [...mask.tiles(z, 4)].length, 0);
    expect(counts).toEqual({ built: expected, skipped: 0 });
    // A land tile at zoom 6 and a sea tile at zoom 4 are copied as they are; a sea tile at zoom 6 is not.
    expect(readFileSync(join(root, 'output/6/32/31.pbf'), 'utf8')).toBe('6/32/31');
    expect(existsSync(join(root, 'output/4/9/7.pbf'))).toBe(true);
    expect(existsSync(join(root, 'output/6/38/26.pbf'))).toBe(false);
    expect(served.read()).toBeLessThan(readFileSync(archive).byteLength);
    // Run again: every tile is verified, none read again.
    expect(await extractTiles(dataset, area, folders, served.fetch, (z) => mask.tiles(z, 4))).toEqual({
      built: 0,
      skipped: expected,
    });
  });
});

describe('tiles copied from an XYZ tile service (F686)', () => {
  it('copies each tile of the area as it is, leaves out the tiles the service does not hold, and asks none twice', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      asked.push(String(url));
      const [, z, y, x] = /\/(\d+)\/(\d+)\/(\d+)\.jpeg$/.exec(String(url)) ?? [];
      return z === '1' && x === '1' && y === '1' ? new Response('', { status: 404 }) : new Response(`${z}/${x}/${y}`);
    }) as typeof fetch;
    const dataset = {
      id: 'sea',
      kind: 'imagery',
      source: { type: 'xyz', url: 'https://tiles.test/{z}/{y}/{x}.jpeg' },
      minZoom: 0,
      maxZoom: 1,
      encoding: 'jpeg',
    } as DatasetConfig;
    const dir = join(root, 'xyz');
    const folders = {
      downloads: join(dir, 'downloads'),
      work: join(dir, 'work'),
      tiles: join(dir, 'output'),
      log: new StepLog(join(dir, 'steps.log'), { work: 'w', source: 's' }),
      report: () => undefined,
    };
    const area = { kind: 'bbox' as const, bbox: { west: -180, south: -85, east: 180, north: 85 } };
    expect(await extractTiles(dataset, area, folders, fetchImpl)).toEqual({ built: 4, skipped: 0 });
    expect(readFileSync(join(dir, 'output/1/0/1.jpg'), 'utf8')).toBe('1/0/1');
    expect(existsSync(join(dir, 'output/1/1/1.jpg'))).toBe(false);
    expect(asked).toHaveLength(5);
    // Run again: the copied tiles are verified, only the one the service lacks is asked for again.
    expect(await extractTiles(dataset, area, folders, fetchImpl)).toEqual({ built: 0, skipped: 4 });
    expect(asked).toHaveLength(6);
  });
});
