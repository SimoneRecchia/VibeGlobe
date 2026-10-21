import {
  WORLD_WIDTH_METERS,
  degToRad,
  longitudeToXMeters,
  radToDeg,
  wrapLongitudeDeg,
  xMetersToLongitudeRad,
} from './longitude.js';
import type { LonLatDeg, ProjectedPointMeters } from './types.js';

/**
 * Geographic plate carrée (equirectangular EPSG:4326 laid out in meters): x = a·λ, y = a·φ with a = WGS84 semi-major
 * axis. One world copy is 2π·a wide and π·a tall, and x matches Web Mercator x exactly. Both axes are computed as
 * ratios to the world edges, so ±180° and ±90° land exactly on them.
 */
const HALF_PI = Math.PI / 2;

/** Half the height of the plate carrée world, (π/2)·a ≈ 10018754.171394622 m. */
export const GEOGRAPHIC_HALF_HEIGHT_METERS = WORLD_WIDTH_METERS / 4;

function clampLatitudeRad(latRad: number): number {
  return Math.min(Math.max(latRad, -HALF_PI), HALF_PI);
}

/**
 * Projects a geodetic position to plate carrée without allocating. The longitude is wrapped into [-π, π) and the
 * latitude clamped to [-π/2, π/2].
 * @param lonRad - Longitude in radians.
 * @param latRad - Geodetic latitude in radians.
 * @param out - Receives x at `out[outOffset]` and y at `out[outOffset + 1]`, in meters.
 * @param outOffset - Index of x in `out`.
 * @returns `out`.
 */
export function projectGeographicRad(lonRad: number, latRad: number, out: Float64Array, outOffset = 0): Float64Array {
  out[outOffset] = longitudeToXMeters(lonRad);
  out[outOffset + 1] = GEOGRAPHIC_HALF_HEIGHT_METERS * (clampLatitudeRad(latRad) / HALF_PI);
  return out;
}

/**
 * Unprojects a plate carrée point without allocating. x is wrapped to a longitude in [-π, π) and the latitude is
 * clamped to [-π/2, π/2].
 * @param xMeters - Easting in meters.
 * @param yMeters - Northing in meters.
 * @param out - Receives the longitude at `out[outOffset]` and the latitude at `out[outOffset + 1]`, in radians.
 * @param outOffset - Index of the longitude in `out`.
 * @returns `out`.
 */
export function unprojectGeographicRad(
  xMeters: number,
  yMeters: number,
  out: Float64Array,
  outOffset = 0,
): Float64Array {
  out[outOffset] = xMetersToLongitudeRad(xMeters);
  out[outOffset + 1] = clampLatitudeRad(HALF_PI * (yMeters / GEOGRAPHIC_HALF_HEIGHT_METERS));
  return out;
}

/**
 * Projects a longitude and latitude in degrees to plate carrée meters (see {@link projectGeographicRad}).
 * @param lonDeg - Longitude in degrees.
 * @param latDeg - Geodetic latitude in degrees, clamped to ±90°.
 * @returns The projected point in meters.
 */
export function projectGeographicDeg(lonDeg: number, latDeg: number): ProjectedPointMeters {
  const out = projectGeographicRad(degToRad(lonDeg), degToRad(latDeg), new Float64Array(2));
  return { xMeters: out[0] ?? Number.NaN, yMeters: out[1] ?? Number.NaN };
}

/**
 * Unprojects plate carrée meters to a longitude and latitude in degrees (see {@link unprojectGeographicRad}).
 * @param xMeters - Easting in meters.
 * @param yMeters - Northing in meters.
 * @returns The longitude in [-180°, 180°) and the latitude in [-90°, 90°], in degrees.
 */
export function unprojectGeographicDeg(xMeters: number, yMeters: number): LonLatDeg {
  const out = unprojectGeographicRad(xMeters, yMeters, new Float64Array(2));
  return { lonDeg: wrapLongitudeDeg(radToDeg(out[0] ?? Number.NaN)), latDeg: radToDeg(out[1] ?? Number.NaN) };
}
