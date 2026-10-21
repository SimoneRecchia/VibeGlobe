import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { MERCATOR_ROOT, NORTH_CAP, quadtreeTileBounds, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { GEOGRAPHIC_TILING, WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import {
  MAPPING_LEVEL,
  MAPPING_OFFSET_U,
  MAPPING_OFFSET_V,
  MAPPING_SCALE_U,
  MAPPING_SCALE_V,
  MAPPING_X,
  MAPPING_Y,
  mapAncestor,
  mapGeographic,
  mapMercator,
} from './imagery-mapping.hot.js';

const tile = (root: 0 | 1 | 2, level: number, x: number, y: number, span = 1): QuadtreeTile =>
  quadtreeTileBounds(root, level, x, y, span, {
    key: 0,
    root: 0,
    level: 0,
    x: 0,
    y: 0,
    span: 1,
    westRad: 0,
    southRad: 0,
    eastRad: 0,
    northRad: 0,
  });
const read = (out: Float64Array) => ({
  level: out[MAPPING_LEVEL],
  x: out[MAPPING_X],
  y: out[MAPPING_Y],
  scale: [out[MAPPING_SCALE_U], out[MAPPING_SCALE_V]],
  offset: [out[MAPPING_OFFSET_U], out[MAPPING_OFFSET_V]],
});
const rect = () => ({ westRad: 0, southRad: 0, eastRad: 0, northRad: 0 });

describe('imagery mapping (F081, F083)', () => {
  it('maps a Mercator surface tile onto the same Mercator tile, or a sub-rectangle of a coarser one', () => {
    const out = new Float64Array(7);
    expect(mapMercator(tile(MERCATOR_ROOT, 5, 13, 9), 5, out, 0)).toBe(true);
    expect(read(out)).toEqual({ level: 5, x: 13, y: 9, scale: [1, 1], offset: [0, 0] });
    expect(mapMercator(tile(MERCATOR_ROOT, 5, 13, 9), 3, out, 0)).toBe(true);
    expect(read(out)).toEqual({ level: 3, x: 3, y: 2, scale: [0.25, 0.25], offset: [0.25, 0.25] });
    expect(mapMercator(tile(NORTH_CAP, 3, 0, 0), 3, out, 0)).toBe(false);
    expect(mapMercator(tile(MERCATOR_ROOT, 3, 0, 0), 4, out, 0)).toBe(false);
  });

  it('walks to an ancestor with the same result as mapping at its level directly', () => {
    const direct = new Float64Array(7);
    const walked = new Float64Array(7);
    mapMercator(tile(MERCATOR_ROOT, 9, 301, 177), 2, direct, 0);
    mapMercator(tile(MERCATOR_ROOT, 9, 301, 177), 6, walked, 0);
    mapAncestor(walked, 0, 4);
    expect(read(walked)).toEqual(read(direct));
  });

  test.prop([
    fc.integer({ min: 2, max: 18 }),
    fc.double({ min: 0, max: 0.999, noNaN: true }),
    fc.double({ min: 0, max: 0.999, noNaN: true }),
  ])('puts a Mercator surface tile exactly on its texels in every ancestor', (level, u, v) => {
    const n = 2 ** level;
    const surface = tile(MERCATOR_ROOT, level, Math.floor(u * n), Math.floor(v * n));
    const out = new Float64Array(7);
    for (let ancestor = level; ancestor >= 0; ancestor -= 3) {
      mapMercator(surface, ancestor, out, 0);
      const source = WEB_MERCATOR_TILING.tileExtent(
        { root: 0, level: ancestor, x: out[1] ?? 0, y: out[2] ?? 0 },
        rect(),
      );
      // The surface tile's west and east edges land where the transform puts u = 0 and u = 1.
      const toLon = (s: number): number => source.westRad + s * (source.eastRad - source.westRad);
      expect(toLon(out[MAPPING_OFFSET_U] ?? 0)).toBeCloseTo(surface.westRad, 12);
      expect(toLon((out[MAPPING_OFFSET_U] ?? 0) + (out[MAPPING_SCALE_U] ?? 0))).toBeCloseTo(surface.eastRad, 12);
    }
  });

  it('maps a surface tile onto the deepest geographic tile that contains it, linearly in longitude and latitude', () => {
    const out = new Float64Array(7);
    const surface = tile(MERCATOR_ROOT, 6, 34, 23);
    expect(mapGeographic(surface, 12, out, 0)).toBe(true);
    const source = GEOGRAPHIC_TILING.tileExtent(
      { root: 0, level: out[0] ?? 0, x: out[1] ?? 0, y: out[2] ?? 0 },
      rect(),
    );
    expect(source.westRad).toBeLessThanOrEqual(surface.westRad);
    expect(source.eastRad).toBeGreaterThanOrEqual(surface.eastRad);
    expect(source.northRad).toBeGreaterThanOrEqual(surface.northRad);
    expect(source.southRad).toBeLessThanOrEqual(surface.southRad);
    const width = source.eastRad - source.westRad;
    expect(source.westRad + (out[MAPPING_OFFSET_U] ?? 0) * width).toBeCloseTo(surface.westRad, 12);
    expect(source.northRad - (out[MAPPING_OFFSET_V] ?? 0) * width).toBeCloseTo(surface.northRad, 12);
    // One level deeper no single tile contains it.
    const deeper = new Float64Array(7);
    mapGeographic(surface, (out[0] ?? 0) + 1, deeper, 0);
    expect(deeper[0]).toBe(out[0]);
  });

  it('maps a polar cap tile onto geographic imagery, and refuses a tile crossing the two root tiles', () => {
    const out = new Float64Array(7);
    expect(mapGeographic(tile(NORTH_CAP, 4, 6, 3), 8, out, 0)).toBe(true);
    expect(out[MAPPING_Y]).toBe(0);
    expect(mapGeographic(tile(MERCATOR_ROOT, 0, 0, 0), 5, out, 0)).toBe(false);
  });
});
