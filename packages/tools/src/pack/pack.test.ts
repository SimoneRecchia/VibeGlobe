import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliIo, main } from '../cli.js';
import { startFixtureServer } from '../fixtures/server.js';
import { readMbtiles } from '../output/mbtiles.js';
import { PmtilesReader } from '../output/pmtiles.js';
import { type Area, areaTiles, polygonArea } from '../tiles/area.js';
import { parseBBox } from '../tiles/mercator.js';

let server: Server;
let base = '';
let log: string[] = [];
let dir = '';

beforeAll(async () => {
  const started = await startFixtureServer({ port: 0 });
  server = started.server;
  base = started.url;
  log = started.log;
  dir = mkdtempSync(join(tmpdir(), 'vg-pack-'));
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function io(answer = true): CliIo & { lines: string[]; asked: number } {
  const result = {
    lines: [] as string[],
    asked: 0,
    out: (line: string) => result.lines.push(line),
    err: (line: string) => result.lines.push(`ERR ${line}`),
    fetch,
    interactive: true,
    ask: () => {
      result.asked++;
      return Promise.resolve(answer);
    },
    env: {},
  };
  return result;
}

const ROME = '12.40,41.82,12.58,41.97';

function expectedKeys(area: Area, min: number, max: number): string[] {
  const keys: string[] = [];
  for (let z = min; z <= max; z++) for (const t of areaTiles(area, z)) keys.push(`${z}/${t.x}/${t.y}`);
  return keys.sort();
}

// Each test packs hundreds of synthetic tiles that the in-process fixture server renders.
describe('offline package builder', { timeout: 30_000 }, () => {
  it('packs exactly the tiles of a bounding box and zoom range into PMTiles (F304)', async () => {
    const out = join(dir, 'rome.pmtiles');
    const args = [
      'pack',
      '--source',
      `${base}/xyz/{z}/{x}/{y}.png`,
      '--profile',
      'fixture',
      '--bbox',
      ROME,
      '--zooms',
      '0-14',
      '--out',
      out,
      '--yes',
    ];
    expect(await main(args, io())).toBe(0);
    const reader = PmtilesReader.open(out);
    const keys: string[] = [];
    for (const entry of reader.entries()) {
      for (let id = entry.tileId; id < entry.tileId + entry.runLength; id++) keys.push(String(id));
    }
    const expected = expectedKeys({ kind: 'bbox', bbox: parseBBox(ROME) }, 0, 14);
    expect(keys).toHaveLength(expected.length);
    expect(reader.tile(14, 8760, 6088)).toBeDefined();
    expect(reader.tile(14, 8700, 6088)).toBeUndefined();
    expect(reader.metadata()).toMatchObject({ minzoom: 0, maxzoom: 14, attribution: 'VibeGlobe test fixture' });
    reader.close();
  });

  it('packs every tile intersecting a polygon, and none outside it, into MBTiles (F305)', async () => {
    const rings: [number, number][][] = [
      [
        [12.4, 41.85],
        [12.6, 41.82],
        [12.55, 41.98],
        [12.4, 41.85],
      ],
    ];
    writeFileSync(join(dir, 'triangle.geojson'), JSON.stringify({ type: 'Polygon', coordinates: rings }));
    const out = join(dir, 'triangle.mbtiles');
    const args = [
      'pack',
      '--source',
      `${base}/xyz/{z}/{x}/{y}.png`,
      '--profile',
      'fixture',
      '--polygon',
      join(dir, 'triangle.geojson'),
      '--zooms',
      '8-14',
      '--format',
      'mbtiles',
      '--out',
      out,
      '--yes',
    ];
    expect(await main(args, io())).toBe(0);
    const db = readMbtiles(out);
    const expected = expectedKeys(polygonArea(rings), 8, 14);
    expect(db.count()).toBe(expected.length);
    for (const key of expected) {
      const [z, x, y] = key.split('/').map(Number) as [number, number, number];
      expect(db.tile(z, x, y), key).toBeDefined();
    }
    // The bounding box holds tiles the polygon does not touch; none of them is packed.
    const bboxOnly = expectedKeys({ kind: 'bbox', bbox: polygonArea(rings).bbox }, 8, 14).filter(
      (k) => !expected.includes(k),
    );
    expect(bboxOnly.length).toBeGreaterThan(0);
    for (const key of bboxOnly) {
      const [z, x, y] = key.split('/').map(Number) as [number, number, number];
      expect(db.tile(z, x, y), key).toBeUndefined();
    }
    db.close();
  });

  it('estimates before downloading any tile, lets the user cancel, and is within 25% of the built size (F307)', async () => {
    log.length = 0;
    const cancel = io(false);
    const out = join(dir, 'estimate.pmtiles');
    const args = [
      'pack',
      '--source',
      `${base}/xyz/{z}/{x}/{y}.png`,
      '--profile',
      'fixture',
      '--bbox',
      ROME,
      '--zooms',
      '10-13',
      '--out',
      out,
    ];
    expect(await main(args, cancel)).toBe(0);
    expect(cancel.asked).toBe(1);
    expect(cancel.lines.at(-1)).toMatch(/Cancelled/);
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((line) => line.startsWith('HEAD '))).toBe(true);
    const total = /total: ([\d,]+) tiles, ([\d.]+) (kB|MB)/.exec(cancel.lines.join('\n'));
    const counts = [10, 11, 12, 13].map((z) => [...areaTiles({ kind: 'bbox', bbox: parseBBox(ROME) }, z)].length);
    expect(Number(total?.[1]?.replace(/,/g, ''))).toBe(counts.reduce((a, b) => a + b, 0));
    expect(await main([...args, '--yes'], io())).toBe(0);
    const estimated = Number(total?.[2]) * (total?.[3] === 'MB' ? 1e6 : 1e3);
    expect(Math.abs(statSync(out).size - estimated) / statSync(out).size).toBeLessThan(0.25);
  });

  it('refuses a source whose terms forbid packaging before any request', async () => {
    log.length = 0;
    const out = io();
    const args = [
      'pack',
      '--source',
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      '--profile',
      'fixture',
      '--bbox',
      ROME,
      '--zooms',
      '0-2',
      '--out',
      join(dir, 'osm.pmtiles'),
      '--yes',
    ];
    expect(await main(args, out)).toBe(1);
    expect(out.lines.join('\n')).toMatch(/tile usage policies forbid bulk downloading/);
  });
});
