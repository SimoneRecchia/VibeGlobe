/**
 * The grid of a terrain tile (ADR 0006 §5, F134): the smallest of 8 to 256 cells per side, no more cells than the
 * tile has pixels, whose surface stays within a vertical error bound of every source sample, with the error measured,
 * not estimated. Grids finer than 64 cells serve rough tiles 64 cells cannot follow (ADR 0027). The finest grid is used
 * when none meets the bound; its measured error travels with it and widens the tile's relief range.
 */
import { heightGrid, type HeightGrid } from './heightmap.js';
import { sampleHeight } from './sample-height.js';

/** The grid sizes a surface tile may use, coarsest first. */
export const GRID_CELLS = [8, 16, 32, 64, 128, 256] as const;

/** A grid and the largest vertical distance between its surface and the source samples, in meters. */
export interface MeasuredGrid {
  readonly grid: HeightGrid;
  readonly maxErrorMeters: number;
}

/** The largest |grid surface − sample| over every pixel center of a `sizePx`² heightmap. */
export function gridErrorMeters(grid: HeightGrid, pixelHeights: Float32Array, sizePx: number): number {
  let worst = 0;
  for (let y = 0; y < sizePx; y++)
    for (let x = 0; x < sizePx; x++) {
      const error = Math.abs(
        sampleHeight(grid, (x + 0.5) / sizePx, (y + 0.5) / sizePx) - (pixelHeights[y * sizePx + x] ?? 0),
      );
      if (error > worst) worst = error;
    }
  return worst;
}

/** The coarsest grid within `maxErrorMeters` of every sample, or the finest grid with its measured error. */
export function chooseGrid(pixelHeights: Float32Array, sizePx: number, maxErrorMeters: number): MeasuredGrid {
  let measured: MeasuredGrid | undefined;
  for (const cells of GRID_CELLS) {
    if (cells > sizePx && measured) break;
    const grid = heightGrid(pixelHeights, sizePx, cells);
    measured = { grid, maxErrorMeters: gridErrorMeters(grid, pixelHeights, sizePx) };
    if (measured.maxErrorMeters <= maxErrorMeters) return measured;
  }
  if (!measured) throw new Error('no grid size');
  return measured;
}
