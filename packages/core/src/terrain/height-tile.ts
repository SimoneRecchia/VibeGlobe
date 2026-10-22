import type { DecodedTile } from '../scheduler/types.js';
import type { HeightGrid } from './heightmap.js';

/**
 * A custom decoder's grid as a decoded tile, checked so a wrong grid fails like undecodable bytes: every height must be
 * finite, and the range is measured from the heights rather than taken from the decoder, since culling and selection
 * trust it (F132, F142).
 */
export function heightTile(grid: HeightGrid): DecodedTile {
  const side = grid.cells + 1;
  if (!Number.isInteger(grid.cells) || grid.cells < 1 || grid.heightsMeters.length !== side * side)
    throw new TypeError(`a height grid of ${grid.cells} cells needs ${side * side} heights`);
  let minMeters = Infinity;
  let maxMeters = -Infinity;
  for (const height of grid.heightsMeters) {
    if (!Number.isFinite(height)) throw new TypeError(`a height grid has a height of ${height}`);
    if (height < minMeters) minMeters = height;
    if (height > maxMeters) maxMeters = height;
  }
  const checked: HeightGrid = { cells: grid.cells, heightsMeters: grid.heightsMeters, minMeters, maxMeters };
  return { widthPx: side, heightPx: side, gpuBytes: side * side * 4, image: checked };
}
