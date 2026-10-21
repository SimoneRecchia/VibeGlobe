import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { MERCATOR_ROOT, quadtreeTileBounds, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { BASE_TEXTURE, DrawList, drawOnBaseImage } from './draw-list.js';

const blank = (): QuadtreeTile => ({
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

describe('DrawList', () => {
  it('grows only when a frame needs more draws than it holds', () => {
    const list = new DrawList(2);
    const keys = list.meshKeys;
    list.reserve(2);
    expect(list.meshKeys).toBe(keys);
    list.reserve(5);
    expect([list.meshKeys.length, list.textures.length, list.geographic.length, list.uvTransforms.length]).toEqual([
      8, 8, 8, 32,
    ]);
  });

  test.prop([
    fc.integer({ min: 2, max: 20 }),
    fc.double({ min: 0, max: 0.999, noNaN: true }),
    fc.double({ min: 0.001, max: 0.999, noNaN: true }),
  ])('maps a tile corner to the base image texel of its position (equirectangular, north row first)', (level, u, v) => {
    const n = 2 ** level;
    const tile = quadtreeTileBounds(MERCATOR_ROOT, level, Math.floor(u * n), Math.floor(v * n), 1, blank());
    const list = new DrawList(1);
    drawOnBaseImage(list, [tile], 1);
    expect(list.count).toBe(1);
    expect(list.textures[0]).toBe(BASE_TEXTURE);
    expect(list.geographic[0]).toBe(1);
    const [scaleU = 0, scaleV = 0, offsetU = 0, offsetV = 0] = list.uvTransforms;
    // North-west corner (0, 0) and south-east corner (1, 1) in tile coordinates.
    expect(offsetU).toBeCloseTo((tile.westRad + Math.PI) / (2 * Math.PI), 6);
    expect(offsetV).toBeCloseTo((Math.PI / 2 - tile.northRad) / Math.PI, 6);
    expect(offsetU + scaleU).toBeCloseTo((tile.eastRad + Math.PI) / (2 * Math.PI), 6);
    expect(offsetV + scaleV).toBeCloseTo((Math.PI / 2 - tile.southRad) / Math.PI, 6);
  });
});
