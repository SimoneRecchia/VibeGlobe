// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The height function of a height grid (ADR 0006 §4, §5): piecewise linear over the grid's triangles, every cell split
 * along the same diagonal (north-west to south-east), so nested grids are exact and a child sampling its parent's
 * grid reproduces the parent's surface. The vertex shader evaluates the same function; elevation queries call this
 * reference (F144).
 */
import type { HeightGrid } from './heightmap.js';

/**
 * The height at (u, v) of a grid, u from the west edge (0) to the east (1), v from the north edge (0) to the south
 * (1); positions outside the tile are clamped to its edges.
 */
export function sampleHeight(grid: HeightGrid, u: number, v: number): number {
  uvh[0] = u;
  uvh[1] = v;
  sampleHeightInto(grid, uvh, 0);
  return uvh[2] ?? 0;
}

const uvh = new Float64Array(3);

/**
 * {@link sampleHeight} through an array, for per-query and per-frame code: reads u and v from `at[offset]` and
 * `at[offset + 1]` and writes the height to `at[offset + 2]`, so no double crosses a call boundary, which V8 boxes
 * (ADR 0018).
 */
export function sampleHeightInto(grid: HeightGrid, at: Float64Array, offset: number): void {
  const u = at[offset] ?? 0;
  const v = at[offset + 1] ?? 0;
  const cells = grid.cells;
  const side = cells + 1;
  const x = (u < 0 ? 0 : u > 1 ? 1 : u) * cells;
  const y = (v < 0 ? 0 : v > 1 ? 1 : v) * cells;
  const col = x >= cells ? cells - 1 : Math.floor(x);
  const row = y >= cells ? cells - 1 : Math.floor(y);
  const fx = x - col;
  const fy = y - row;
  const h = grid.heightsMeters;
  const nw = h[row * side + col] ?? 0;
  const ne = h[row * side + col + 1] ?? 0;
  const sw = h[(row + 1) * side + col] ?? 0;
  const se = h[(row + 1) * side + col + 1] ?? 0;
  // The diagonal from north-west to south-east: above it (fx > fy) the north-east triangle, below it the south-west.
  at[offset + 2] = fx >= fy ? nw + (ne - nw) * fx + (se - ne) * fy : nw + (se - sw) * fx + (sw - nw) * fy;
}

/** The widest part of a grid, in cells per side, that {@link gridRangeInto} measures; wider parts take the grid's range. */
export const MAX_RANGE_SCAN_CELLS = 8;

/** {@link gridRangeInto}'s sample point, u, v and height, as {@link sampleHeightInto} reads it. */
const point = new Float64Array(3);

/**
 * The lowest and highest heights a grid shows over part of it (KB-080): reads u from `at[0]` to `at[1]` and v from
 * `at[2]` to `at[3]` (0–1, north first, as {@link sampleHeightInto}) and writes the range to `at[4]` and `at[5]`. The
 * surface is linear on each cell's two triangles, so its extremes over the part lie at the part's corners, the grid
 * vertices inside it, or where grid lines and cell diagonals cross its edges; those are sampled. A part wider than
 * {@link MAX_RANGE_SCAN_CELLS} takes the whole grid's range. Allocates nothing (ADR 0018).
 */
export function gridRangeInto(grid: HeightGrid, at: Float64Array): void {
  const cells = grid.cells;
  const x0 = clampCoordinate((at[0] ?? 0) * cells, cells);
  const x1 = clampCoordinate((at[1] ?? 1) * cells, cells);
  const y0 = clampCoordinate((at[2] ?? 0) * cells, cells);
  const y1 = clampCoordinate((at[3] ?? 1) * cells, cells);
  if (x1 - x0 > MAX_RANGE_SCAN_CELLS || y1 - y0 > MAX_RANGE_SCAN_CELLS) {
    at[4] = grid.minMeters;
    at[5] = grid.maxMeters;
    return;
  }
  at[4] = Infinity;
  at[5] = -Infinity;
  // Interior vertices.
  for (let row = Math.ceil(y0); row <= y1; row++)
    for (let col = Math.ceil(x0); col <= x1; col++) include(grid, col, row, at);
  // The horizontal edges: corners, vertical grid lines and diagonals crossing them.
  for (let edge = 0; edge < 2; edge++) {
    const y = edge === 0 ? y0 : y1;
    include(grid, x0, y, at);
    include(grid, x1, y, at);
    const along = y - (y >= cells ? cells - 1 : Math.floor(y));
    for (let col = Math.floor(x0); col <= x1; col++) {
      if (col > x0) include(grid, col, y, at);
      const diagonal = col + along;
      if (diagonal > x0 && diagonal < x1) include(grid, diagonal, y, at);
    }
  }
  // The vertical edges: horizontal grid lines and diagonals crossing them.
  for (let edge = 0; edge < 2; edge++) {
    const x = edge === 0 ? x0 : x1;
    const along = x - (x >= cells ? cells - 1 : Math.floor(x));
    for (let row = Math.floor(y0); row <= y1; row++) {
      if (row > y0) include(grid, x, row, at);
      const diagonal = row + along;
      if (diagonal > y0 && diagonal < y1) include(grid, x, diagonal, at);
    }
  }
}

/** A coordinate in cells within 0 and `cells`. */
function clampCoordinate(value: number, cells: number): number {
  return value < 0 ? 0 : value > cells ? cells : value;
}

/** Widens `at[4]`–`at[5]` to the height at (x, y) in cells. */
function include(grid: HeightGrid, x: number, y: number, at: Float64Array): void {
  point[0] = x / grid.cells;
  point[1] = y / grid.cells;
  sampleHeightInto(grid, point, 0);
  const height = point[2] ?? 0;
  if (height < (at[4] ?? 0)) at[4] = height;
  if (height > (at[5] ?? 0)) at[5] = height;
}
