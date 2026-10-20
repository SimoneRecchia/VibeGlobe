import { WGS84 } from './wgs84.js';

/** A geodetic position in radians and meters, the internal form of WGS84 coordinates. */
export interface GeodeticRad {
  longitudeRad: number;
  latitudeRad: number;
  heightMeters: number;
}

const A = WGS84.semiMajorAxisMeters;
const E2 = WGS84.firstEccentricitySquared;
const E4 = E2 * E2;

/**
 * Converts WGS84 geodetic coordinates to Earth-centered, Earth-fixed (ECEF) meters, written to `out[offset..offset+2]`.
 * Exact closed form; allocates nothing.
 */
export function geodeticToEcef(
  longitudeRad: number,
  latitudeRad: number,
  heightMeters: number,
  out: Float64Array,
  offset = 0,
): Float64Array {
  const sinLat = Math.sin(latitudeRad);
  const cosLat = Math.cos(latitudeRad);
  const primeVerticalRadius = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const r = (primeVerticalRadius + heightMeters) * cosLat;
  out[offset] = r * Math.cos(longitudeRad);
  out[offset + 1] = r * Math.sin(longitudeRad);
  out[offset + 2] = (primeVerticalRadius * (1 - E2) + heightMeters) * sinLat;
  return out;
}

/**
 * Converts ECEF meters to WGS84 geodetic coordinates, written to `out`. Uses Vermeille's closed-form solution
 * (J. Geodesy 76, 2002), accurate to far below a millimeter for any point farther than about 50 km from the Earth's
 * center, including the poles and points high above the ellipsoid; allocates nothing.
 */
export function ecefToGeodetic(x: number, y: number, z: number, out: GeodeticRad): GeodeticRad {
  const horizontalSquared = x * x + y * y;
  const p = horizontalSquared / (A * A);
  const q = ((1 - E2) * z * z) / (A * A);
  const r = (p + q - E4) / 6;
  const s = (E4 * p * q) / (4 * r * r * r);
  const t = Math.cbrt(1 + s + Math.sqrt(s * (2 + s)));
  const u = r * (1 + t + 1 / t);
  const v = Math.sqrt(u * u + E4 * q);
  const w = (E2 * (u + v - q)) / (2 * v);
  const k = Math.sqrt(u + v + w * w) - w;
  const horizontal = Math.sqrt(horizontalSquared);
  const d = (k * horizontal) / (k + E2);
  const dz = Math.hypot(d, z);
  out.longitudeRad = Math.atan2(y, x);
  out.latitudeRad = 2 * Math.atan2(z, d + dz);
  out.heightMeters = ((k + E2 - 1) / k) * dz;
  return out;
}
