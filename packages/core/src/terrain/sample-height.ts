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
