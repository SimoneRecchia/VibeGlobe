import { describe, expect, it } from 'vitest';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { TERRAIN_LEVEL_OFFSET, terrainErrorsBySurfaceLevel } from './terrain-draws.js';
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
