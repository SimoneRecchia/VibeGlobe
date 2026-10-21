import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { childTiles, MAX_TILE_LEVEL, packTileKey, parentTile, unpackTileKey, type TileCoord } from './tile-key.js';
import { GEOGRAPHIC_TILING, WEB_MERCATOR_TILING, type TileRectangleRad, type TilingScheme } from './tiling-scheme.js';

const DEG = Math.PI / 180;
const SCHEMES = [WEB_MERCATOR_TILING, GEOGRAPHIC_TILING] as const;

const coord = (): TileCoord => ({ root: 0, level: 0, x: 0, y: 0 });
const rect = (): TileRectangleRad => ({ westRad: 0, southRad: 0, eastRad: 0, northRad: 0 });

/** A random tile of a scheme, with its level up to `maxLevel`. */
function anyTile(scheme: TilingScheme, maxLevel: number) {
  return fc.integer({ min: 0, max: maxLevel }).chain((level) =>
    fc.record({
      root: fc.constant(0 as const),
      level: fc.constant(level),
      x: fc.integer({ min: 0, max: scheme.rootTilesX * 2 ** level - 1 }),
      y: fc.integer({ min: 0, max: scheme.rootTilesY * 2 ** level - 1 }),
    }),
  );
}

describe('tiling schemes (F080)', () => {
  it('cut Web Mercator like XYZ tiles', () => {
    const extent = WEB_MERCATOR_TILING.tileExtent({ root: 0, level: 1, x: 0, y: 0 }, rect());
    expect(extent).toEqual({
      westRad: -Math.PI,
      eastRad: 0,
      northRad: WEB_MERCATOR_TILING.maxLatitudeRad,
      southRad: 0,
    });
    expect(WEB_MERCATOR_TILING.maxLatitudeRad / DEG).toBeCloseTo(85.0511287798, 9);
    // Reference tiles of public XYZ maps: London at zoom 10 is 10/511/340, Sydney at zoom 12 is 12/3768/2457.
    expect(WEB_MERCATOR_TILING.tileAt(-0.1278 * DEG, 51.5074 * DEG, 10, coord())).toEqual({
      root: 0,
      level: 10,
      x: 511,
      y: 340,
    });
    expect(WEB_MERCATOR_TILING.tileAt(151.2093 * DEG, -33.8688 * DEG, 12, coord())).toMatchObject({ x: 3768, y: 2457 });
    // Zoom 2, row 1 ends at the latitude whose Mercator y is a quarter of the world: atan(sinh(π / 2)).
    const row = WEB_MERCATOR_TILING.tileExtent({ root: 0, level: 2, x: 3, y: 1 }, rect());
    expect(row.northRad).toBeCloseTo(Math.atan(Math.sinh(Math.PI / 2)), 15);
    expect(row.southRad).toBe(0);
    expect(row.eastRad).toBe(Math.PI);
  });

  it('cut the geographic pyramid into two root tiles split at the prime meridian', () => {
    expect(GEOGRAPHIC_TILING.tileExtent({ root: 0, level: 0, x: 1, y: 0 }, rect())).toEqual({
      westRad: 0,
      eastRad: Math.PI,
      northRad: Math.PI / 2,
      southRad: -Math.PI / 2,
    });
    // Rome at level 3: 16 columns of 22.5°, 8 rows of 22.5° from the north pole.
    expect(GEOGRAPHIC_TILING.tileAt(12.4964 * DEG, 41.9028 * DEG, 3, coord())).toMatchObject({ x: 8, y: 2 });
    expect(GEOGRAPHIC_TILING.tileAt(0, 90 * DEG, 4, coord())).toMatchObject({ y: 0 });
    expect(GEOGRAPHIC_TILING.tileAt(0, -90 * DEG, 4, coord())).toMatchObject({ y: 15 });
  });

  it('put the antimeridian in the first column, from both sides', () => {
    for (const scheme of SCHEMES) {
      expect(scheme.tileAt(Math.PI, 0, 5, coord()).x).toBe(0);
      expect(scheme.tileAt(-Math.PI, 0, 5, coord()).x).toBe(0);
      expect(scheme.tileAt(Math.PI - 1e-12, 0, 5, coord()).x).toBe(scheme.rootTilesX * 32 - 1);
      expect(scheme.tileAt(3 * Math.PI + 0.1, 0, 0, coord()).x).toBe(scheme.tileAt(Math.PI + 0.1, 0, 0, coord()).x);
    }
  });

  it('clamp positions beyond Web Mercator to its first and last rows', () => {
    expect(WEB_MERCATOR_TILING.tileAt(0, 89 * DEG, 6, coord()).y).toBe(0);
    expect(WEB_MERCATOR_TILING.tileAt(0, -90 * DEG, 6, coord()).y).toBe(63);
  });

  for (const scheme of SCHEMES) {
    test.prop([anyTile(scheme, 20)])(
      `${scheme.crs}: children cover their parent exactly, with shared edges and no gap`,
      (tile) => {
        const parent = scheme.tileExtent(tile, rect());
        const children = childTiles(tile, [coord(), coord(), coord(), coord()]).map((child) =>
          scheme.tileExtent(child, rect()),
        );
        const [nw, ne, sw, se] = children as [TileRectangleRad, TileRectangleRad, TileRectangleRad, TileRectangleRad];
        expect([nw.westRad, sw.westRad]).toEqual([parent.westRad, parent.westRad]);
        expect([ne.eastRad, se.eastRad]).toEqual([parent.eastRad, parent.eastRad]);
        expect([nw.northRad, ne.northRad]).toEqual([parent.northRad, parent.northRad]);
        expect([sw.southRad, se.southRad]).toEqual([parent.southRad, parent.southRad]);
        expect([nw.eastRad, sw.eastRad]).toEqual([ne.westRad, se.westRad]);
        expect([nw.southRad, ne.southRad]).toEqual([sw.northRad, se.northRad]);
        for (const child of children) {
          expect(child.westRad).toBeLessThan(child.eastRad);
          expect(child.southRad).toBeLessThan(child.northRad);
        }
      },
    );

    test.prop([
      anyTile(scheme, 20),
      fc.double({ min: 0.001, max: 0.999, noNaN: true }),
      fc.double({ min: 0.001, max: 0.999, noNaN: true }),
    ])(
      `${scheme.crs}: a position inside a tile looks up that tile, and its parent at the level above`,
      (tile, u, v) => {
        const extent = scheme.tileExtent(tile, rect());
        const longitudeRad = extent.westRad + u * (extent.eastRad - extent.westRad);
        const latitudeRad = extent.southRad + v * (extent.northRad - extent.southRad);
        expect(scheme.tileAt(longitudeRad, latitudeRad, tile.level, coord())).toEqual(tile);
        const parent = parentTile(tile, coord());
        if (parent) expect(scheme.tileAt(longitudeRad, latitudeRad, parent.level, coord())).toEqual(parent);
      },
    );

    test.prop([anyTile(scheme, MAX_TILE_LEVEL), fc.constantFrom(0 as const, 1 as const, 2 as const)])(
      `${scheme.crs}: keys round-trip, and a parent's key unpacks to the parent`,
      (tile, root) => {
        const rooted = { ...tile, root };
        const key = packTileKey(rooted, scheme.rootTilesX, scheme.rootTilesY);
        expect(Number.isSafeInteger(key)).toBe(true);
        expect(unpackTileKey(key, scheme.rootTilesX, scheme.rootTilesY, coord())).toEqual(rooted);
        const parent = parentTile(rooted, coord());
        if (parent) {
          const parentKey = packTileKey(parent, scheme.rootTilesX, scheme.rootTilesY);
          expect(unpackTileKey(parentKey, scheme.rootTilesX, scheme.rootTilesY, coord())).toEqual(parent);
        }
      },
    );
  }

  it('give every tile of the first levels its own key, in order', () => {
    for (const scheme of SCHEMES) {
      const keys: number[] = [];
      for (let level = 0; level <= 4; level++) {
        for (let y = 0; y < scheme.rootTilesY * 2 ** level; y++) {
          for (let x = 0; x < scheme.rootTilesX * 2 ** level; x++) {
            keys.push(packTileKey({ root: 0, level, x, y }, scheme.rootTilesX, scheme.rootTilesY));
          }
        }
      }
      expect(keys).toEqual(keys.map((_, i) => i * 3));
    }
  });

  it('keep the deepest keys exact and reject tiles outside the pyramid', () => {
    const last = { root: 2 as const, level: MAX_TILE_LEVEL, x: 2 ** 26 - 1, y: 2 ** 25 - 1 };
    expect(packTileKey(last, 2, 1)).toBeLessThan(2 ** 53);
    expect(unpackTileKey(packTileKey(last, 2, 1), 2, 1, coord())).toEqual(last);
    expect(() => packTileKey({ root: 0, level: MAX_TILE_LEVEL + 1, x: 0, y: 0 }, 1, 1)).toThrow(RangeError);
    expect(() => packTileKey({ root: 0, level: 1, x: 2, y: 0 }, 1, 1)).toThrow(RangeError);
    expect(() => packTileKey({ root: 0, level: 1, x: 0.5, y: 0 }, 1, 1)).toThrow(RangeError);
    expect(parentTile({ root: 1, level: 0, x: 0, y: 0 }, coord())).toBeUndefined();
  });
});
