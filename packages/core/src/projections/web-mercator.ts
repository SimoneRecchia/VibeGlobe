// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { WGS84 } from '../geodesy/wgs84.js';
import {
  longitudeToXMeters,
  nearestWorldCopyXMeters,
  projectDeg,
  radToDeg,
  unprojectDeg,
  xMetersToLongitudeRad,
} from './longitude.js';
import type { LonLatDeg, ProjectedPointMeters } from './types.js';

/**
 * Spherical Web Mercator (EPSG:3857, "Popular Visualisation Pseudo Mercator", EPSG method 1024): WGS84 longitude and
 * latitude projected as if on a sphere of radius a = WGS84 semi-major axis, with no false origin.
 *
 * x = a·λ, y = a·ln(tan(π/4 + φ/2)) = a·asinh(tan φ); inverse φ = atan(sinh(y / a)).
 */
const RADIUS_METERS = WGS84.semiMajorAxisMeters;

/**
 * Latitude limit of Web Mercator, atan(sinh(π)) ≈ 85.0511287798066°, in radians: the latitude at which the map
 * becomes square (y = ±π·a).
 */
export const WEB_MERCATOR_MAX_LATITUDE_RAD = Math.atan(Math.sinh(Math.PI));

/** Latitude limit of Web Mercator, atan(sinh(π)) ≈ 85.0511287798066°, in degrees. */
export const WEB_MERCATOR_MAX_LATITUDE_DEG = radToDeg(WEB_MERCATOR_MAX_LATITUDE_RAD);

/** Half the side of the square Web Mercator world, π·a ≈ 20037508.342789244 m. */
export const WEB_MERCATOR_HALF_EXTENT_METERS = Math.PI * RADIUS_METERS;

/**
 * Clamps a latitude to the Web Mercator limit ±atan(sinh(π)). NaN stays NaN; ±Infinity clamps to the limit.
 * @param latRad - Latitude in radians.
 * @returns The latitude in [-WEB_MERCATOR_MAX_LATITUDE_RAD, WEB_MERCATOR_MAX_LATITUDE_RAD].
 */
export function clampWebMercatorLatitudeRad(latRad: number): number {
  return Math.min(Math.max(latRad, -WEB_MERCATOR_MAX_LATITUDE_RAD), WEB_MERCATOR_MAX_LATITUDE_RAD);
}

/**
 * The latitude of a Web Mercator row edge, `row` of `rows` rows from the north (rows may be fractional): the inverse
 * Gudermannian of the row's projected y, the limit at and beyond the map's edges.
 */
export function mercatorRowLatitudeRad(row: number, rows: number): number {
  if (row <= 0) return WEB_MERCATOR_MAX_LATITUDE_RAD;
  if (row >= rows) return -WEB_MERCATOR_MAX_LATITUDE_RAD;
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / rows)));
}

/**
 * Projects a geodetic position to Web Mercator without allocating. The longitude is wrapped into [-π, π) and the
 * latitude clamped to ±atan(sinh(π)), so any finite longitude and any non-NaN latitude (±90° and beyond, ±Infinity
 * included) yield finite x in [-π·a, π·a) and y in [-π·a, π·a].
 * @param lonRad - Longitude in radians.
 * @param latRad - Geodetic latitude in radians.
 * @param out - Receives x at `out[outOffset]` and y at `out[outOffset + 1]`, in meters.
 * @param outOffset - Index of x in `out`.
 * @returns `out`.
 */
export function projectWebMercatorRad(lonRad: number, latRad: number, out: Float64Array, outOffset = 0): Float64Array {
  const yMeters = RADIUS_METERS * Math.asinh(Math.tan(clampWebMercatorLatitudeRad(latRad)));
  out[outOffset] = longitudeToXMeters(lonRad);
  out[outOffset + 1] = Math.min(Math.max(yMeters, -WEB_MERCATOR_HALF_EXTENT_METERS), WEB_MERCATOR_HALF_EXTENT_METERS);
  return out;
}

/**
 * Unprojects a Web Mercator point to a geodetic position without allocating. x is wrapped to a longitude in [-π, π);
 * y is not clamped: a y beyond the square gives the matching latitude beyond ±85.05° (±π/2 at ±Infinity).
 * @param xMeters - Easting in meters.
 * @param yMeters - Northing in meters.
 * @param out - Receives the longitude at `out[outOffset]` and the latitude at `out[outOffset + 1]`, in radians.
 * @param outOffset - Index of the longitude in `out`.
 * @returns `out`.
 */
export function unprojectWebMercatorRad(
  xMeters: number,
  yMeters: number,
  out: Float64Array,
  outOffset = 0,
): Float64Array {
  out[outOffset] = xMetersToLongitudeRad(xMeters);
  out[outOffset + 1] = Math.atan(Math.sinh(yMeters / RADIUS_METERS));
  return out;
}

/**
 * Projects a longitude to the Web Mercator x of its world copy nearest `referenceXMeters`, so positions on both sides
 * of the antimeridian stay adjacent to the reference (for example the camera anchor).
 * @param lonRad - Longitude in radians.
 * @param referenceXMeters - The x the result should be nearest to, in meters.
 * @returns The x in meters, within half a world width of the reference.
 */
export function webMercatorXNearestRad(lonRad: number, referenceXMeters: number): number {
  return nearestWorldCopyXMeters(longitudeToXMeters(lonRad), referenceXMeters);
}

/**
 * Web Mercator scale factor k(φ) = 1 / cos φ: how many map meters one ground meter becomes at latitude φ (the same in
 * every direction). The latitude is clamped like the projection, so the result is finite (at most cosh(π) ≈ 11.59).
 * @param latRad - Geodetic latitude in radians.
 * @returns The scale factor, at least 1.
 */
export function webMercatorScaleFactor(latRad: number): number {
  return 1 / Math.cos(clampWebMercatorLatitudeRad(latRad));
}

/**
 * Projects a longitude and latitude in degrees to Web Mercator meters (see {@link projectWebMercatorRad}).
 * @param lonDeg - Longitude in degrees.
 * @param latDeg - Geodetic latitude in degrees, clamped to ±85.0511287798066°.
 * @returns The projected point in meters.
 */
export function projectWebMercatorDeg(lonDeg: number, latDeg: number): ProjectedPointMeters {
  return projectDeg(projectWebMercatorRad, lonDeg, latDeg);
}

/**
 * Unprojects Web Mercator meters to a longitude and latitude in degrees (see {@link unprojectWebMercatorRad}).
 * @param xMeters - Easting in meters.
 * @param yMeters - Northing in meters.
 * @returns The longitude in [-180°, 180°) and the latitude, in degrees.
 */
export function unprojectWebMercatorDeg(xMeters: number, yMeters: number): LonLatDeg {
  return unprojectDeg(unprojectWebMercatorRad, xMeters, yMeters);
}
