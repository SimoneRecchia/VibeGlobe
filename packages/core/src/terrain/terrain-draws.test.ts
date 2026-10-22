import { describe, expect, it } from 'vitest';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import { MERCATOR_ROOT, NORTH_CAP, quadtreeTileKey, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { previousLevel, TERRAIN_LEVEL_OFFSET, terrainErrorsBySurfaceLevel } from './terrain-draws.js';
import type { TerrainSource } from './terrain-source.js';

const source = {
  id: 'errors',
  tiling: WEB_MERCATOR_TILING,
  minLevel: 0,
  maxLevel: 10,
  geometricErrorMeters: (level: number) => 10_000 / 2 ** level,
} as unknown as TerrainSource;

describe('terrainErrorsBySurfaceLevel', () => {
  it('follows the terrain level a surface level shows, and halves per level beyond the finest one (KB-080)', () => {
    const errors = terrainErrorsBySurfaceLevel(source, 24);
    const finest = 10 + TERRAIN_LEVEL_OFFSET;
    // Each surface level up to the finest shows a finer terrain level: its error halves.
    for (let level = TERRAIN_LEVEL_OFFSET + 1; level <= finest; level++)
      expect(errors[level]).toBeCloseTo((errors[level - 1] ?? 0) / 2, 9);
    // Beyond, neighbors show the same grid with finer meshes: the error keeps halving instead of staying the finest's.
    for (let level = finest + 1; level <= 24; level++)
      expect(errors[level]).toBeCloseTo((errors[level - 1] ?? 0) / 2, 9);
  });
});

describe('previousLevel', () => {
  const tile = (root: 0 | 1 | 2, level: number, x: number, y: number): QuadtreeTile => ({
    key: quadtreeTileKey(root, level, x, y),
    root,
    level,
    x,
    y,
    span: 1,
    westRad: 0,
    southRad: 0,
    eastRad: 0,
    northRad: 0,
  });

  it('finds the terrain shown last frame up to two levels above or below, on every root (F138)', () => {
    const shown = new IntegerKeyMap<number>();
    // Refined by two levels in one frame: the grandparent was drawn.
    shown.set(quadtreeTileKey(MERCATOR_ROOT, 8, 33, 22), 6);
    expect(previousLevel(tile(MERCATOR_ROOT, 10, 133, 89), shown)).toBe(6);
    // Coarsened by two levels: the finest of the grandchildren drawn.
    shown.set(quadtreeTileKey(MERCATOR_ROOT, 7, 20, 13), 5);
    shown.set(quadtreeTileKey(MERCATOR_ROOT, 7, 21, 14), 7);
    expect(previousLevel(tile(MERCATOR_ROOT, 5, 5, 3), shown)).toBe(7);
    // Three levels away is a switch, not a morph (KB-079).
    expect(previousLevel(tile(MERCATOR_ROOT, 11, 266, 178), shown)).toBe(-1);
    // A polar cap tile morphs too.
    shown.set(quadtreeTileKey(NORTH_CAP, 3, 2, 1), 4);
    expect(previousLevel(tile(NORTH_CAP, 4, 4, 3), shown)).toBe(4);
  });
});
