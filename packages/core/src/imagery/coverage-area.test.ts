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

  it('masks the tiles a feather reaches inside the border, and keys a color outside the area on every tile (KB-231)', () => {
    // A tile of 1° wholly inside, its east edge 1/256 of a tile from the border at 16° E (15°–15.996° E).
    const near = rect(14.996, 47, 15.996, 48);
    const sharp = coverageTest({ polygons: [COUNTRY], tiles: 'clip' });
    expect(sharp.mask(near, false)).toBeUndefined();
    // With a feather of 8 pixels on a 256-pixel tile, the border lies within its reach: the tile is masked.
    const feathered = coverageTest({ polygons: [COUNTRY], tiles: 'clip', featherPx: 8 });
    expect(feathered.mask(near, false, 256)?.featherPx).toBe(8);
    expect(feathered.mask(rect(13.5, 46.5, 14.5, 47.5), false, 256)).toBeUndefined();
    // A keyed area asks for every tile, inside or not; a tile wholly outside gets an empty outline and the key.
    const keyed = coverageTest({ polygons: [COUNTRY], keyOutside: { rgb: [54, 73, 90] } });
    expect(keyed.covers(rect(30, 30, 31, 31))).toBe(true);
    const outside = keyed.mask(rect(30, 30, 31, 31), true);
    expect([outside?.ringEnds.length, outside?.key]).toEqual([0, { rgb: [54, 73, 90], tolerance: 8 }]);
    expect(keyed.mask(rect(15, 46, 17, 49), true)?.ringEnds.length).toBe(2);
    expect(keyed.mask(rect(10.5, 46.5, 11.5, 47.5), true)).toBeUndefined();
  });

  it('keys a color everywhere, the tiles wholly inside too, and clips outside the area with its feather (F636, KB-233)', () => {
    const area = coverageTest({
      polygons: [COUNTRY],
      tiles: 'clip',
      featherPx: 8,
      keyEverywhere: { rgb: [54, 73, 90], tolerance: 16 },
    });
    const key = { rgb: [54, 73, 90], tolerance: 16, everywhere: true };
    // Clipped: only tiles touching the area are asked for.
    expect(area.covers(rect(30, 30, 31, 31))).toBe(false);
    // A tile wholly inside, beyond the feather's reach, is keyed over its whole extent, with no fade at its edges.
    const inside = area.mask(rect(10.5, 46.5, 11.5, 47.5), true);
    expect(inside?.key).toEqual(key);
    expect(Array.from(inside?.points ?? [])).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(inside?.featherPx).toBeUndefined();
    // Across the border: the area's outline with its feather, and the key.
    expect(area.mask(rect(15, 46, 17, 49), true)).toMatchObject({ featherPx: 8, key });
  });

  it('keys the sea outside the land with a fade in meters, every tile but those inside the land beyond it (KB-303)', () => {
    const box: PolygonDeg = [
      [
        [0, 30],
        [40, 30],
        [40, 60],
        [0, 60],
      ],
    ];
    const sea = { land: [COUNTRY], featherMeters: 2000 };
    const area = coverageTest({ polygons: [box], tiles: 'clip', featherPx: 8, keySea: sea });
    // Inside the land, more than the fade from its border and its lake: no mask.
    expect(area.mask(rect(14, 46.5, 15, 47.5), false)).toBeUndefined();
    // Across its east border: the land's rings, the fade in pixels of the tile (1° is 75.2 km at 47.5° N), twice as
    // many on a tile half as wide, and the whole tile inside the box.
    const border = area.mask(rect(15.5, 47, 16.5, 48), false);
    expect(Array.from(border?.points ?? [])).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(border?.sea?.ringEnds.length).toBe(2);
    expect(border?.sea?.featherPx).toBeCloseTo(6.81, 2);
    expect(area.mask(rect(15.5, 47, 16, 48), false)?.sea?.featherPx).toBeCloseTo(13.62, 2);
    // At sea, far from the land: no ring, the whole tile is sea.
    expect(area.mask(rect(30, 40, 31, 41), false)?.sea?.ringEnds.length).toBe(0);
    // Without a clip the area's own outline masks nothing: the whole tile.
    const unclipped = coverageTest({ polygons: [box], keySea: sea }).mask(rect(39.5, 40, 40.5, 41), false);
    expect(Array.from(unclipped?.points ?? [])).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  });
});
