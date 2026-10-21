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

const geodeticScratch = new Float64Array(3);
const ecefScratch = new Float64Array(3);

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
  geodeticScratch[0] = longitudeRad;
  geodeticScratch[1] = latitudeRad;
  geodeticScratch[2] = heightMeters;
  return geodeticArrayToEcef(geodeticScratch, out, offset);
}

/**
 * {@link geodeticToEcef} with the input (longitude and latitude in radians, height in meters) read from
 * `geodetic[0..2]`: per-frame code passes doubles in arrays, never as call arguments, which V8 boxes (ADR 0018).
 */
export function geodeticArrayToEcef(geodetic: Float64Array, out: Float64Array, offset = 0): Float64Array {
  const longitudeRad = geodetic[0] ?? 0;
  const latitudeRad = geodetic[1] ?? 0;
  const heightMeters = geodetic[2] ?? 0;
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
  ecefScratch[0] = x;
  ecefScratch[1] = y;
  ecefScratch[2] = z;
  return ecefArrayToGeodetic(ecefScratch, out);
}

/** {@link ecefToGeodetic} with the input read from `ecef[offset..offset+2]` (per-frame form, ADR 0018). */
export function ecefArrayToGeodetic(ecef: Float64Array, out: GeodeticRad, offset = 0): GeodeticRad {
  const x = ecef[offset] ?? 0;
  const y = ecef[offset + 1] ?? 0;
  const z = ecef[offset + 2] ?? 0;
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
  // Not Math.hypot: V8 boxes its arguments. d and z are below 1e8 m, far from overflow.
  const dz = Math.sqrt(d * d + z * z);
  out.longitudeRad = Math.atan2(y, x);
  out.latitudeRad = 2 * Math.atan2(z, d + dz);
  out.heightMeters = ((k + E2 - 1) / k) * dz;
  return out;
}
