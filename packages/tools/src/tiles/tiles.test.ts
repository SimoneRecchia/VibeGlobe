import { describe, expect, it } from 'vitest';
import { areaTileCount, areaTiles, polygonArea } from './area.js';
import { latToTileY, lonToTileX, tileBounds, tileRange } from './mercator.js';

describe('tile math', () => {
  it('converts between degrees and tiles and back', () => {
    expect(lonToTileX(0, 1)).toBe(1);
    expect(latToTileY(0, 3)).toBeCloseTo(4, 12);
    const bounds = tileBounds({ z: 10, x: 531, y: 364 });
    expect(bounds.west).toBeCloseTo(6.6796875, 12);
    expect(bounds.north).toBeCloseTo(46.07323062540836, 10);
  });

  it('counts exactly the tiles of a box, about 4× more per added zoom level', () => {
    const rome = { kind: 'bbox' as const, bbox: { west: 12.35, south: 41.8, east: 12.6, north: 41.99 } };
    const counts = [10, 11, 12, 13, 14].map((z) => areaTileCount(rome, z));
    for (let i = 1; i < counts.length; i++) expect((counts[i] ?? 0) / (counts[i - 1] ?? 1)).toBeGreaterThan(2.5);
    expect((counts[4] ?? 0) / (counts[3] ?? 1)).toBeCloseTo(4, 0);
    const range = tileRange(rome.bbox, 14);
    expect(counts[4]).toBe((range.maxX - range.minX + 1) * (range.maxY - range.minY + 1));
  });

  it('does not pull in neighbor tiles when an edge lies exactly on a tile border', () => {
    const tile = tileBounds({ z: 10, x: 531, y: 364 });
    expect(areaTileCount({ kind: 'bbox', bbox: tile }, 10)).toBe(1);
    expect(areaTileCount({ kind: 'bbox', bbox: tile }, 12)).toBe(16);
  });

  it('selects every tile intersecting a polygon and no tile entirely outside it', () => {
    // A triangle over 4×4 tiles of zoom 4 starting at the origin.
    const z = 4;
    const lon = (x: number): number => (x / 16) * 360 - 180;
    const lat = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 16))) * 180) / Math.PI;
    const triangle = polygonArea([
      [
        [lon(4), lat(4)],
        [lon(8), lat(4)],
        [lon(4), lat(8)],
        [lon(4), lat(4)],
      ],
    ]);
    const keys = new Set([...areaTiles(triangle, z)].map((t) => `${t.x},${t.y}`));
    // The hypotenuse is x + y = 12 in tile space: tiles with x + y ≤ 11 overlap the triangle with positive area,
    // tiles with x + y = 12 touch it only at a corner, and tiles beyond lie outside.
    for (let y = 3; y < 9; y++) {
      for (let x = 3; x < 9; x++) expect(keys.has(`${x},${y}`)).toBe(x >= 4 && y >= 4 && x + y <= 11);
    }
  });
});
