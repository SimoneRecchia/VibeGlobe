// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { WEB_MERCATOR_MAX_LATITUDE_RAD } from '../projections/web-mercator.js';
import type { TileCoord } from './tile-key.js';

/**
 * A tile's extent in WGS84 radians. Extents are half-open toward the east and the south: a position on a shared edge
 * belongs to the tile east of it and north of it; the last column's east edge is +π, the antimeridian.
 */
export interface TileRectangleRad {
  westRad: number;
  southRad: number;
  eastRad: number;
  northRad: number;
}

/**
 * A quadtree pyramid over the globe (architecture §tiling schemes): tile extents and the tile under a position. Rows
 * count from the north, columns from the antimeridian eastward.
 */
export interface TilingScheme {
  /** The coordinate reference system the tiles are cut in, such as 'EPSG:3857'. */
  readonly crs: string;
  readonly rootTilesX: number;
  readonly rootTilesY: number;
  /** The northern edge of the pyramid; the southern one is its negative. */
  readonly maxLatitudeRad: number;
  /** Writes the tile's extent into `out` and returns it. */
  tileExtent(coord: TileCoord, out: TileRectangleRad): TileRectangleRad;
  /** The tile of `level` containing a position, written into `out`; latitudes beyond the pyramid clamp to its edge. */
  tileAt(longitudeRad: number, latitudeRad: number, level: number, out: TileCoord): TileCoord;
}

const TWO_PI = 2 * Math.PI;

/** The column of a longitude at `columns` columns, wrapped so that +π is the first column again. */
function columnAt(longitudeRad: number, columns: number): number {
  const turns = (longitudeRad + Math.PI) / TWO_PI;
  const column = Math.floor((turns - Math.floor(turns)) * columns);
  // Rounding can land a longitude just below the antimeridian on `columns`.
  return column >= columns ? 0 : column;
}

function clampRow(row: number, rows: number): number {
  return Math.min(rows - 1, Math.max(0, row));
}

/** The longitude of a column's western edge; the last column's eastern edge is exactly +π. */
function columnWestRad(x: number, columns: number): number {
  return x === columns ? Math.PI : -Math.PI + (TWO_PI * x) / columns;
}

/** The Web Mercator quad (EPSG:3857, XYZ rows): one root tile covering ±85.0511°. */
export const WEB_MERCATOR_TILING: TilingScheme = {
  crs: 'EPSG:3857',
  rootTilesX: 1,
  rootTilesY: 1,
  maxLatitudeRad: WEB_MERCATOR_MAX_LATITUDE_RAD,
  tileExtent(coord, out) {
    const n = 2 ** coord.level;
    out.westRad = columnWestRad(coord.x, n);
    out.eastRad = columnWestRad(coord.x + 1, n);
    out.northRad = mercatorRowLatitudeRad(coord.y, n);
    out.southRad = mercatorRowLatitudeRad(coord.y + 1, n);
    return out;
  },
  tileAt(longitudeRad, latitudeRad, level, out) {
    const n = 2 ** level;
    const clamped = Math.max(-WEB_MERCATOR_MAX_LATITUDE_RAD, Math.min(WEB_MERCATOR_MAX_LATITUDE_RAD, latitudeRad));
    // Mercator y from the north edge, in tiles: (1 − asinh(tan φ) / π) / 2 · n.
    const row = Math.floor(((1 - Math.asinh(Math.tan(clamped)) / Math.PI) / 2) * n);
    out.root = 0;
    out.level = level;
    out.x = columnAt(longitudeRad, n);
    out.y = clampRow(row, n);
    return out;
  },
};

/** The latitude of a Web Mercator row edge at `n` rows: the inverse Gudermannian of the row's projected y. */
function mercatorRowLatitudeRad(row: number, n: number): number {
  if (row === 0) return WEB_MERCATOR_MAX_LATITUDE_RAD;
  if (row === n) return -WEB_MERCATOR_MAX_LATITUDE_RAD;
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n)));
}

/** The geographic pyramid (EPSG:4326): two root tiles, west and east of the prime meridian, covering ±90°. */
export const GEOGRAPHIC_TILING: TilingScheme = {
  crs: 'EPSG:4326',
  rootTilesX: 2,
  rootTilesY: 1,
  maxLatitudeRad: Math.PI / 2,
  tileExtent(coord, out) {
    const columns = 2 * 2 ** coord.level;
    const rows = 2 ** coord.level;
    out.westRad = columnWestRad(coord.x, columns);
    out.eastRad = columnWestRad(coord.x + 1, columns);
    out.northRad = coord.y === 0 ? Math.PI / 2 : Math.PI / 2 - (Math.PI * coord.y) / rows;
    out.southRad = coord.y + 1 === rows ? -Math.PI / 2 : Math.PI / 2 - (Math.PI * (coord.y + 1)) / rows;
    return out;
  },
  tileAt(longitudeRad, latitudeRad, level, out) {
    const rows = 2 ** level;
    out.root = 0;
    out.level = level;
    out.x = columnAt(longitudeRad, 2 * rows);
    out.y = clampRow(Math.floor(((Math.PI / 2 - latitudeRad) / Math.PI) * rows), rows);
    return out;
  },
};
