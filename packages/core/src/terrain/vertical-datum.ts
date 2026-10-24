// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Vertical datums of terrain sources (F133). Heights above a geoid (for example EGM2008, used by Copernicus DEM) are
 * converted to WGS84 ellipsoidal heights with h = H + N, where N is the geoid undulation, bilinearly interpolated in a
 * regular latitude–longitude grid the consumer hosts (ADR 0015: the project ships and serves no datasets).
 */
import type { HeightGrid } from './heightmap.js';

/** What a terrain source's heights are measured from. */
export type VerticalDatum = { readonly kind: 'ellipsoid' } | { readonly kind: 'geoid'; readonly model: GeoidModel };

/** Geoid undulations on a regular grid, rows from the north pole, columns eastward from 180° W, wrapping. */
export interface GeoidModel {
  readonly rows: number;
  readonly columns: number;
  /** Undulation in meters (geoid above the ellipsoid), `rows × columns`, row by row. */
  readonly undulationsMeters: Float32Array;
}

/** Validates a geoid grid: at least 2 × 2 values, all finite. */
export function geoidModel(rows: number, columns: number, undulationsMeters: Float32Array): GeoidModel {
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 2 || columns < 2)
    throw new RangeError('a geoid grid needs at least 2 × 2 values');
  if (undulationsMeters.length !== rows * columns) throw new RangeError('geoid grid size does not match its values');
  for (const value of undulationsMeters) if (!Number.isFinite(value)) throw new RangeError('geoid value not finite');
  return { rows, columns, undulationsMeters };
}

/**
 * The undulation at a position. Rows span 90° N to 90° S inclusive; columns span 360° from 180° W and wrap, so the
 * antimeridian interpolates between the last and the first column.
 */
export function undulationMeters(model: GeoidModel, lonRad: number, latRad: number): number {
  const { rows, columns, undulationsMeters: n } = model;
  const y = ((Math.PI / 2 - latRad) / Math.PI) * (rows - 1);
  const row = Math.min(Math.max(Math.floor(y), 0), rows - 2);
  const fy = Math.min(Math.max(y - row, 0), 1);
  const turns = (lonRad + Math.PI) / (2 * Math.PI);
  const x = (turns - Math.floor(turns)) * columns;
  const col = Math.floor(x) % columns;
  const next = (col + 1) % columns;
  const fx = x - Math.floor(x);
  const at = (r: number, c: number): number => n[r * columns + c] ?? 0;
  const top = at(row, col) + (at(row, next) - at(row, col)) * fx;
  const bottom = at(row + 1, col) + (at(row + 1, next) - at(row + 1, col)) * fx;
  return top + (bottom - top) * fy;
}

/** Mercator y of a latitude (unbounded). */
function mercatorY(latRad: number): number {
  return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
}

/**
 * Converts a height grid covering [west, east] × [south, north] (radians, rows from the north, spaced evenly in
 * latitude, or in Mercator y when `mercator`) to WGS84 ellipsoidal heights in place, and updates its range.
 * Ellipsoidal sources are returned unchanged.
 */
export function toEllipsoidal(
  grid: HeightGrid,
  datum: VerticalDatum,
  westRad: number,
  southRad: number,
  eastRad: number,
  northRad: number,
  mercator = false,
): HeightGrid {
  if (datum.kind === 'ellipsoid') return grid;
  const side = grid.cells + 1;
  const heights = grid.heightsMeters;
  const top = mercatorY(northRad);
  const bottom = mercatorY(southRad);
  let min = Infinity;
  let max = -Infinity;
  for (let row = 0; row < side; row++) {
    const fraction = row / grid.cells;
    const lat = mercator
      ? 2 * Math.atan(Math.exp(top + (bottom - top) * fraction)) - Math.PI / 2
      : northRad + (southRad - northRad) * fraction;
    for (let col = 0; col < side; col++) {
      const lon = westRad + ((eastRad - westRad) * col) / grid.cells;
      const i = row * side + col;
      const h = (heights[i] ?? 0) + undulationMeters(datum.model, lon, lat);
      heights[i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { cells: grid.cells, heightsMeters: heights, minMeters: min, maxMeters: max };
}
