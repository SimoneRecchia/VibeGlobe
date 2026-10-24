// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { WGS84 } from '../geodesy/wgs84.js';

/**
 * Width of one world copy along x, in meters, for every projection whose x is a·λ (Web Mercator and plate carrée):
 * 2π times the WGS84 semi-major axis.
 */
export const WORLD_WIDTH_METERS = 2 * Math.PI * WGS84.semiMajorAxisMeters;

const HALF_WORLD_WIDTH_METERS = WORLD_WIDTH_METERS / 2;

/**
 * Reduces `value` into [-halfPeriod, halfPeriod). `%` is exact on doubles and the single correction step is exact
 * too (Sterbenz), so the result differs from `value` by an exact multiple of the double `2 · halfPeriod`.
 */
function wrapSymmetric(value: number, halfPeriod: number): number {
  if (value >= -halfPeriod && value < halfPeriod) return value;
  const period = 2 * halfPeriod;
  const remainder = value % period;
  if (remainder >= halfPeriod) return remainder - period;
  if (remainder < -halfPeriod) return remainder + period;
  return remainder;
}

/**
 * Wraps a longitude into [-π, π). Values already in range are returned unchanged; infinite or NaN input gives NaN.
 * @param lonRad - Longitude in radians, any finite value.
 * @returns The equivalent longitude in [-π, π), in radians.
 */
export function wrapLongitudeRad(lonRad: number): number {
  return wrapSymmetric(lonRad, Math.PI);
}

/**
 * Wraps a longitude into [-180°, 180°). Values already in range are returned unchanged; infinite or NaN input gives
 * NaN.
 * @param lonDeg - Longitude in degrees, any finite value.
 * @returns The equivalent longitude in [-180°, 180°), in degrees.
 */
export function wrapLongitudeDeg(lonDeg: number): number {
  return wrapSymmetric(lonDeg, 180);
}

/**
 * Moves a projected x by whole world widths to the copy nearest `referenceXMeters`, so geometry on either side of the
 * antimeridian lands next to the reference (for example the camera anchor) instead of a world away.
 * @param xMeters - Projected x in meters (Web Mercator or plate carrée).
 * @param referenceXMeters - The x the result should be nearest to, in meters.
 * @returns `xMeters + k · WORLD_WIDTH_METERS` for the integer k that minimises the distance to the reference.
 */
export function nearestWorldCopyXMeters(xMeters: number, referenceXMeters: number): number {
  return xMeters - WORLD_WIDTH_METERS * Math.round((xMeters - referenceXMeters) / WORLD_WIDTH_METERS);
}

/**
 * Projected x of a longitude for projections with x = a·λ, computed as π·a · (λ / π) so that ±π map exactly onto the
 * world edges ±π·a. The longitude is wrapped first, so x lies in [-π·a, π·a).
 * @param lonRad - Longitude in radians.
 * @returns x in meters.
 */
export function longitudeToXMeters(lonRad: number): number {
  return HALF_WORLD_WIDTH_METERS * (wrapLongitudeRad(lonRad) / Math.PI);
}

/**
 * Longitude of a projected x for projections with x = a·λ, computed as π · (x / (π·a)) so that the world edges ±π·a
 * map exactly onto ±π, then wrapped into [-π, π).
 * @param xMeters - Easting in meters.
 * @returns The longitude in radians.
 */
export function xMetersToLongitudeRad(xMeters: number): number {
  return wrapLongitudeRad(Math.PI * (xMeters / HALF_WORLD_WIDTH_METERS));
}

/** Converts degrees to radians as (deg / 180) · π, which maps ±180° and ±90° exactly onto ±π and ±π/2. */
export function degToRad(deg: number): number {
  return (deg / 180) * Math.PI;
}

/** Converts radians to degrees as (rad / π) · 180, which maps ±π and ±π/2 exactly onto ±180° and ±90°. */
export function radToDeg(rad: number): number {
  return (rad / Math.PI) * 180;
}
