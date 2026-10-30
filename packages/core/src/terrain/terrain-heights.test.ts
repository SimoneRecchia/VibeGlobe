import { describe, expect, it } from 'vitest';
import type { TerrainLayer } from '../globe/imagery-runtime.js';
import { GEOGRAPHIC_TILING } from '../tiling/tiling-scheme.js';
import type { HeightGrid } from './heightmap.js';
import { TerrainHeights, type ElevationSample } from './terrain-heights.js';
import type { TerrainSource } from './terrain-source.js';

describe('TerrainHeights', () => {
  it('samples a longitude past ±180° from the tile on the other side of the antimeridian', () => {
    // One geographic level-0 tile, the western hemisphere, 500 m everywhere.
    const grid: HeightGrid = {
      cells: 1,
      heightsMeters: Float32Array.of(500, 500, 500, 500),
      minMeters: 500,
      maxMeters: 500,
    };
    const source = { tiling: GEOGRAPHIC_TILING, minLevel: 0, maxLevel: 0 } as unknown as TerrainSource;
    const layer = {
      source,
      loader: {
        coordOf: () => ({ root: 0, level: 0, x: 0, y: 0 }),
        peekInside: (level: number, x: number, y: number) => (level === 0 && x === 0 && y === 0 ? 7 : -1),
      },
    } as unknown as TerrainLayer;
    const heights = new TerrainHeights(layer);
    heights.add(7, grid);
    const out: ElevationSample = { heightMeters: 0, level: -1, noData: true };
    // 170° W, given as 190° E (a look-ahead past the antimeridian).
    expect(heights.sample((190 * Math.PI) / 180, 0.2, out)).toMatchObject({ heightMeters: 500, noData: false });
    expect(heights.sample((-170 * Math.PI) / 180, 0.2, out)).toMatchObject({ heightMeters: 500, noData: false });
  });
});
