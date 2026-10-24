// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { MERCATOR_HALF_WORLD_M, METERS_PER_DEGREE, STANDARD_PIXEL_M, tilingOfCrs } from './crs.js';
import type { WmtsTileMatrix, WmtsTileMatrixSet } from './wmts-capabilities.js';

/** A tile matrix set that lines up with one of the engine's tiling schemes, level by level. */
export interface MatchedMatrixSet {
  readonly tiling: 'mercator' | 'geographic';
  /** Engine level → the tile matrix with exactly that level's tiles. */
  readonly levels: ReadonlyMap<number, WmtsTileMatrix>;
  readonly tileSizePx: number;
}

const TOLERANCE = 1e-3;

function near(a: number, b: number, scale: number): boolean {
  return Math.abs(a - b) <= TOLERANCE * scale;
}

/** The engine level of a matrix, or undefined when the matrix is not one of the scheme's levels. */
function levelOf(
  matrix: WmtsTileMatrix,
  tiling: 'mercator' | 'geographic',
  latitudeFirst: boolean,
): number | undefined {
  if (matrix.tileWidth !== matrix.tileHeight || matrix.tileWidth <= 0) return undefined;
  const rootColumns = tiling === 'mercator' ? 1 : 2;
  const level = Math.log2(matrix.matrixWidth / rootColumns);
  if (!Number.isInteger(level) || level < 0) return undefined;
  const rows = 2 ** level;
  // Some services declare fewer rows than the full pyramid (the rest has no data); never more.
  if (matrix.matrixHeight > rows) return undefined;
  const pixel = matrix.scaleDenominator * STANDARD_PIXEL_M;
  if (tiling === 'mercator') {
    const width = pixel * matrix.tileWidth * matrix.matrixWidth;
    const [x, y] = matrix.topLeftCorner;
    const fits =
      near(width, 2 * MERCATOR_HALF_WORLD_M, width) &&
      near(x, -MERCATOR_HALF_WORLD_M, width) &&
      near(y, MERCATOR_HALF_WORLD_M, width);
    return fits ? level : undefined;
  }
  const width = (pixel / METERS_PER_DEGREE) * matrix.tileWidth * matrix.matrixWidth;
  const [a, b] = matrix.topLeftCorner;
  const [lon, lat] = latitudeFirst ? [b, a] : [a, b];
  return near(width, 360, 360) && near(lon, -180, 360) && near(lat, 90, 360) ? level : undefined;
}

/**
 * Matches a tile matrix set to the Web Mercator or geographic tiling scheme: every matrix that is exactly one of the
 * scheme's levels is kept (others are ignored), with one tile size throughout. Undefined when nothing lines up, which
 * means the set needs client-side reprojection.
 */
export function matchMatrixSet(set: WmtsTileMatrixSet): MatchedMatrixSet | undefined {
  const tiling = tilingOfCrs(set.crs);
  if (!tiling) return undefined;
  // EPSG:4326 is latitude first in WMTS; CRS:84 is longitude first. Some servers write longitude first anyway.
  const levels = new Map<number, WmtsTileMatrix>();
  let tileSizePx: number | undefined;
  for (const matrix of set.matrices) {
    const latitudeFirst = set.crs === 'EPSG:4326' && Math.abs(matrix.topLeftCorner[0]) <= 90;
    const level = levelOf(matrix, tiling, latitudeFirst);
    if (level === undefined || levels.has(level)) continue;
    if (tileSizePx !== undefined && matrix.tileWidth !== tileSizePx) continue;
    tileSizePx = matrix.tileWidth;
    levels.set(level, matrix);
  }
  return tileSizePx === undefined ? undefined : { tiling, levels, tileSizePx };
}
