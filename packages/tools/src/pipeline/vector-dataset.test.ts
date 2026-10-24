import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatasetConfig } from '../config/schema.js';
import { syntheticOsmExtract } from '../fixtures/osm-sample.js';
import type { Area } from '../tiles/area.js';
import { StepLog, sha256 } from './step-log.js';
import { tileVectorDataset } from './vector-dataset.js';

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((f) => rmSync(f, { recursive: true, force: true })));

const AREA: Area = {
  kind: 'bbox',
  bbox: { west: 6.6796875, south: 45.82879925192134, east: 7.03125, north: 46.07323062540836 },
};
const vectors = (minZoom: number, maxZoom: number): DatasetConfig => ({
  id: 'vectors',
  kind: 'vector',
  profile: 'openstreetmap-extract',
  dataYear: 2026,
  sourceVersion: 'fixture',
  source: { type: 'osm-extract', url: 'https://download.fixture.test/italy.osm.pbf' },
  minZoom,
  maxZoom,
  encoding: 'mvt',
  bytesPerTile: 30_000,
  downloadBytesPerFile: 1,
  outputs: { static: true, pmtiles: false, mbtiles: false },
});

/** Tiles the synthetic extract; returns the report lines and the checksum of every tile. */
function tile(dataset: DatasetConfig, chunkZoom?: number): { lines: string[]; tiles: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'vg-vector-'));
  folders.push(dir);
  const extract = join(dir, 'extract.osm.pbf');
  writeFileSync(extract, syntheticOsmExtract());
  const lines: string[] = [];
  const out = join(dir, 'tiles');
  const f = { downloads: dir, work: join(dir, 'work'), tiles: out, log: new StepLog(join(dir, 'log')) };
  tileVectorDataset(dataset, AREA, [extract], { ...f, report: (l) => lines.push(l) }, chunkZoom);
  const tiles: Record<string, string> = {};
  for (const path of readdirSync(out, { recursive: true, encoding: 'utf8' }))
    if (path.endsWith('.pbf')) tiles[path] = sha256(readFileSync(join(out, path)));
  return { lines, tiles };
}

const readCount = (lines: string[]): number => Number(/read (\d+) features/.exec(lines.join('\n'))?.[1]);

describe('vector dataset tiling', () => {
  it('reads only the features its zoom range shows (DP-003)', () => {
    const low = tile(vectors(0, 9));
    const full = tile(vectors(0, 14));
    // The synthetic extract: its city, town, motorway and primary road show by zoom 9; the village from zoom 10.
    expect(readCount(low.lines)).toBe(4);
    expect(readCount(full.lines)).toBeGreaterThan(50);
  });

  it('cuts the extract in chunks on disk with the same tiles as in one pass (DP-004)', () => {
    const chunked = tile(vectors(9, 14), 11);
    const whole = tile(vectors(9, 14), 15);
    expect(chunked.lines.join('\n')).toMatch(/[1-9]\d* chunks of zoom 11 on disk/);
    expect(whole.lines.join('\n')).toMatch(/ 0 chunks of zoom 15/);
    expect(Object.keys(chunked.tiles).length).toBeGreaterThan(10);
    expect(chunked.tiles).toEqual(whole.tiles);
  });
});
