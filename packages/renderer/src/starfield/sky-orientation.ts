// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// The orientation of the sky (ADR 0181): the rotation from the J2000 celestial frame of the star catalog to the
// engine's Earth-fixed axes at a time, precession (IAU 1976, Lieske et al. 1977) then the Earth's rotation by Greenwich
// mean sidereal time (Meeus, Astronomical Algorithms, 2nd ed., ch. 12), and the galactic frame of the Milky Way
// (Hipparcos catalogue, vol. 1, §1.5.3), written from the published formulas. ECEF axes: x toward 0° N 0° E, y toward
// 0° N 90° E, z toward the North Pole. Nutation (under 20″) and polar motion are left out.

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const MS_PER_DAY = 86_400_000;
/** The Julian day of the Unix epoch. */
const JD_UNIX_EPOCH = 2_440_587.5;
/** The Julian day of J2000.0. */
const JD_J2000 = 2_451_545;

/**
 * The rotation from J2000 equatorial axes to galactic axes, row-major: rows are the galactic x (toward the galactic
 * center), y (toward l = 90°) and z (the north galactic pole) in J2000 equatorial axes.
 */
export const EQUATORIAL_TO_GALACTIC: readonly number[] = [
  -0.0548755604, -0.8734370902, -0.4838350155, 0.4941094279, -0.44482963, 0.7469822445, -0.867666149, -0.1980763734,
  0.4559837762,
];

/** Days from J2000.0 (UT) at a time given as Unix milliseconds. */
function daysFromJ2000(utcMs: number): number {
  return utcMs / MS_PER_DAY + JD_UNIX_EPOCH - JD_J2000;
}

/** Greenwich mean sidereal time at a time in Unix milliseconds (UTC taken as UT1), radians in [0, 2π). */
export function greenwichSiderealTimeRad(utcMs: number): number {
  const d = daysFromJ2000(utcMs);
  const t = d / 36_525;
  const deg = (280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38_710_000) % 360;
  return (deg < 0 ? deg + 360 : deg) * DEG;
}

/** `a · b` of row-major 3 × 3 matrices, written to `out` (which may not be `a` or `b`). */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): Float64Array {
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[r * 3 + k] ?? 0) * (b[k * 3 + c] ?? 0);
      out[r * 3 + c] = sum;
    }
  return out;
}

/** The frame rotation about z by `angle` (R3 of the astronomical literature), row-major. */
function rotationZ(angleRad: number, out: Float64Array): Float64Array {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  out.set([c, s, 0, -s, c, 0, 0, 0, 1]);
  return out;
}

/** The frame rotation about y by `angle` (R2), row-major. */
function rotationY(angleRad: number, out: Float64Array): Float64Array {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  out.set([c, 0, -s, 0, 1, 0, s, 0, c]);
  return out;
}

/** Scratch matrices: {@link celestialToEcef} allocates nothing. */
const A = new Float64Array(9);
const B = new Float64Array(9);
const C = new Float64Array(9);

/**
 * Writes the row-major rotation from J2000 equatorial axes (the catalog's right ascension and declination) to ECEF axes
 * at a time in Unix milliseconds: `ecef = M · celestial`. A star whose apparent right ascension equals the sidereal
 * time stands over the Greenwich meridian.
 */
export function celestialToEcef(utcMs: number, out: Float64Array): Float64Array {
  const t = daysFromJ2000(utcMs) / 36_525;
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * ARCSEC;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * ARCSEC;
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * ARCSEC;
  // Precession P = R3(−z) · R2(θ) · R3(−ζ), then the Earth's rotation R3(GMST).
  multiply(rotationY(theta, A), rotationZ(-zeta, B), C);
  multiply(rotationZ(-z, A), C, B);
  return multiply(rotationZ(greenwichSiderealTimeRad(utcMs), A), B, out);
}

/** Writes the row-major rotation from ECEF axes to galactic axes at a time: `galactic = G · ecef`. */
export function ecefToGalactic(utcMs: number, out: Float64Array): Float64Array {
  celestialToEcef(utcMs, C);
  // The inverse of a rotation is its transpose.
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (EQUATORIAL_TO_GALACTIC[r * 3 + k] ?? 0) * (C[c * 3 + k] ?? 0);
      out[r * 3 + c] = sum;
    }
  return out;
}

/** Writes the unit vector of a right ascension and declination in degrees (J2000 equatorial axes). */
export function equatorialDirection(
  rightAscensionDeg: number,
  declinationDeg: number,
  out: Float64Array,
): Float64Array {
  const ra = rightAscensionDeg * DEG;
  const dec = declinationDeg * DEG;
  out[0] = Math.cos(dec) * Math.cos(ra);
  out[1] = Math.cos(dec) * Math.sin(ra);
  out[2] = Math.sin(dec);
  return out;
}

/**
 * Writes the column-major 4 × 4 matrix that takes a celestial direction (w = 0) to clip space for a frame's
 * column-major view and projection (`FrameView`): `projection · rotation(view) · celestialToEcef`. Directions have no
 * position, so the eye's translation drops out and the sky turns with every camera move, globe spin or tilt.
 */
export function celestialToClip(
  view: ArrayLike<number>,
  projection: ArrayLike<number>,
  celestial: ArrayLike<number>,
  out: Float32Array | Float64Array,
): Float32Array | Float64Array {
  // Column j of (rotation(view) · M): the view's rotation applied to column j of M.
  for (let j = 0; j < 3; j++) {
    const x = celestial[j] ?? 0;
    const y = celestial[3 + j] ?? 0;
    const zc = celestial[6 + j] ?? 0;
    for (let i = 0; i < 4; i++) {
      // Eye-space row k, then projection row i.
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        const eye = (view[k] ?? 0) * x + (view[4 + k] ?? 0) * y + (view[8 + k] ?? 0) * zc;
        sum += (projection[k * 4 + i] ?? 0) * eye;
      }
      out[j * 4 + i] = sum;
    }
  }
  for (let i = 0; i < 4; i++) out[12 + i] = 0;
  return out;
}
