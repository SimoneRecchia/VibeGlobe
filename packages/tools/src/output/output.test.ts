import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMbtiles, writeMbtiles } from './mbtiles.js';
import {
  COMPRESSION,
  PmtilesReader,
  TILE_TYPES,
  decodeDirectory,
  encodeDirectory,
  tileId,
  writePmtiles,
} from './pmtiles.js';

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((f) => rmSync(f, { recursive: true, force: true })));
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'vg-output-'));
  folders.push(path);
  return path;
}

/**
 * Every tile of zooms 0–`maxZoom`. Odd columns repeat the content of the even column to their left (deduplicated);
 * lengths vary so the directory does not compress into the root.
 */
function pyramid(maxZoom: number): { z: number; x: number; y: number; read: () => Uint8Array }[] {
  const tiles = [];
  for (let z = 0; z <= maxZoom; z++) {
    for (let x = 0; x < 2 ** z; x++) {
      for (let y = 0; y < 2 ** z; y++) {
        const column = x & ~1;
        const header = [z, column & 255, column >> 8, y & 255, y >> 8];
        const length = 5 + ((column * 7919 + y * 104729 + z * 13) % 61);
        tiles.push({ z, x, y, read: () => Uint8Array.from({ length }, (_, i) => header[i] ?? i) });
      }
    }
  }
  return tiles;
}

const info = {
  tileType: TILE_TYPES.png,
  tileCompression: COMPRESSION.none,
  minZoom: 0,
  maxZoom: 8,
  bounds: { west: -180, south: -85, east: 180, north: 85 },
  center: { lon: 0, lat: 0, zoom: 0 },
};

describe('packages', () => {
  it('numbers tiles along the Hilbert curve like the PMTiles specification', () => {
    expect([
      tileId(0, 0, 0),
      tileId(1, 0, 0),
      tileId(1, 0, 1),
      tileId(1, 1, 1),
      tileId(1, 1, 0),
      tileId(2, 0, 0),
    ]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(tileId(12, 3423, 1763)).toBe(19078479);
  });

  it('round-trips directories', () => {
    const entries = [
      { tileId: 0, offset: 0, length: 10, runLength: 1 },
      { tileId: 1, offset: 10, length: 5, runLength: 3 },
      { tileId: 9, offset: 0, length: 10, runLength: 1 },
    ];
    expect(decodeDirectory(encodeDirectory(entries))).toEqual(entries);
  });

  it('writes a PMTiles archive with leaf directories, deduplicated tiles and metadata, deterministically', () => {
    const dir = folder();
    const tiles = pyramid(8);
    const result = writePmtiles(join(dir, 'a.pmtiles'), tiles, info, { attribution: 'x' });
    expect(result.addressed).toBe(tiles.length);
    expect(result.contents).toBe(tiles.filter((t) => t.x % 2 === 0).length);
    const reader = PmtilesReader.open(join(dir, 'a.pmtiles'));
    expect(reader.u64(48)).toBeGreaterThan(0);
    for (const tile of [tiles[0], tiles[100], tiles[tiles.length - 1]]) {
      if (tile) expect(reader.tile(tile.z, tile.x, tile.y)).toEqual(tile.read());
    }
    expect(reader.tile(9, 0, 0)).toBeUndefined();
    expect(reader.metadata()).toEqual({ attribution: 'x' });
    reader.close();
    writePmtiles(join(dir, 'b.pmtiles'), [...tiles].reverse(), info, { attribution: 'x' });
    expect(PmtilesReader.open(join(dir, 'b.pmtiles')).u64(56)).toBe(reader.u64(56));
  });

  it('writes MBTiles with TMS rows and metadata', () => {
    const dir = folder();
    writeMbtiles(join(dir, 'a.mbtiles'), pyramid(3), { name: 'n', attribution: 'a' });
    const db = readMbtiles(join(dir, 'a.mbtiles'));
    expect(db.metadata).toEqual({ name: 'n', attribution: 'a' });
    expect(db.count()).toBe(85);
    expect(db.tile(3, 5, 1)).toEqual(
      pyramid(3)
        .find((t) => t.z === 3 && t.x === 5 && t.y === 1)
        ?.read(),
    );
    db.close();
  });
});
