// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import { DrawList } from '../imagery/draw-list.js';
import {
  MERCATOR_ROOT,
  quadtreeRowLatitudeRad,
  quadtreeTileBounds,
  type QuadtreeTile,
} from '../surface/surface-quadtree.hot.js';
import { displayedHeightMeters } from './displayed-height.js';
import type { HeightGrid } from './heightmap.js';
import type { TerrainHeights } from './terrain-heights.js';

describe('displayedHeightMeters', () => {
  it('reads the surface as the 16-segment mesh draws it, not the finer grid between its vertices (KB-219)', () => {
    // A 256-cell grid at 100 m with a 1,000 m pit at vertex (2, 2): the mesh's vertices sit every 16 cells, so the
    // drawn surface spans the pit at 100 m, and an eye kept above the grid there would be inside the drawn terrain.
    const cells = 256;
    const heightsMeters = new Float32Array((cells + 1) ** 2).fill(100);
    heightsMeters[2 * (cells + 1) + 2] = -900;
    const grid: HeightGrid = { cells, heightsMeters, minMeters: -900, maxMeters: 100 };
    const heights = { grid: () => grid } as unknown as TerrainHeights;
    // A Mercator tile over the Alps, its texture read in its own rows.
    const tile = quadtreeTileBounds(MERCATOR_ROOT, 10, 531, 362, 1, {} as QuadtreeTile);
    const list = new DrawList(1);
    list.count = 1;
    list.terrain.set(0, 0, 10, 0, Float64Array.of(1, 1, 0, 0));
    // A point a fraction u east and v south across the tile's own (Mercator) rows.
    const at = (u: number, v: number): number =>
      displayedHeightMeters(
        list,
        [tile],
        heights,
        tile.westRad + u * (tile.eastRad - tile.westRad),
        quadtreeRowLatitudeRad(tile, v * 16),
      );
    expect(at(2 / cells, 2 / cells)).toBeCloseTo(100, 3);
    // Between vertices of different heights the drawn surface is the mesh triangle's plane.
    heightsMeters[16 * (cells + 1) + 16] = 1700;
    expect(at(12 / cells, 12 / cells)).toBeCloseTo(100 + 0.5 * 1600, 1);
  });
});
