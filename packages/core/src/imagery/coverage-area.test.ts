import { describe, expect, it } from 'vitest';
import type { TileRectangleRad } from '../tiling/tiling-scheme.js';
import { coverageArea, coverageTest, type PolygonDeg } from './coverage-area.js';

const DEG = Math.PI / 180;
const rect = (west: number, south: number, east: number, north: number): TileRectangleRad => ({
  westRad: west * DEG,
  southRad: south * DEG,
  eastRad: east * DEG,
  northRad: north * DEG,
});

// A country 10°–16° E, 46°–49° N with a lake (a hole) at 12°–13° E, 47°–48° N.
const COUNTRY: PolygonDeg = [
  [
    [10, 46],
    [16, 46],
    [16, 49],
    [10, 49],
    [10, 46],
  ],
  [
    [12, 47],
    [13, 47],
    [13, 48],
    [12, 48],
    [12, 47],
  ],
];

describe('coverage areas (polygon coverage of a source)', () => {
  it('asks only for tiles wholly inside the polygons by default, every touching tile with overlap, none in a hole', () => {
    const inside = coverageTest({ polygons: [COUNTRY] });
    const overlap = coverageTest({ polygons: [COUNTRY], tiles: 'overlap' });
    expect(inside.rectangles).toEqual([rect(10, 46, 16, 49)]);
    // Wholly inside the country, away from the lake.
    expect(inside.covers(rect(14, 47, 15, 48))).toBe(true);
    // Across the border: only a source transparent beyond its area asks for it.
    expect(inside.covers(rect(15.5, 47, 16.5, 48))).toBe(false);
    expect(overlap.covers(rect(15.5, 47, 16.5, 48))).toBe(true);
    // Wholly in the lake, and wholly abroad.
    expect(overlap.covers(rect(12.2, 47.2, 12.8, 47.8))).toBe(false);
    expect(overlap.covers(rect(20, 40, 21, 41))).toBe(false);
    // Around the lake's shore: touching both.
    expect(inside.covers(rect(11.5, 47.2, 12.5, 47.8))).toBe(false);
    expect(overlap.covers(rect(11.5, 47.2, 12.5, 47.8))).toBe(true);
  });

  it('clips: a border tile gets the outline in tile units, a tile wholly inside none; GeoJSON clips by default (F618)', () => {
    const area = coverageArea({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: COUNTRY.map((r) => [...r]) },
    });
    expect(area.tiles).toBe('clip');
    const clip = coverageTest(area);
    // Across the east border (16° E) on geographic rows: the outer ring's x runs to 0.5 of the tile, its rows linear.
    const mask = clip.mask(rect(15, 46, 17, 49), false);
    expect(mask?.ringEnds.length).toBe(2);
    expect([2, 3, 4, 5].map((k) => (mask?.points[k] ?? NaN) + 0)).toEqual([0.5, 1, 0.5, 0]);
    expect(clip.covers(rect(15, 46, 17, 49))).toBe(true);
    expect(clip.mask(rect(14, 47, 15, 48), true)).toBeUndefined();
    // The other modes never mask.
    expect(coverageTest({ polygons: [COUNTRY], tiles: 'overlap' }).mask(rect(15, 46, 17, 49), false)).toBeUndefined();
  });
});
