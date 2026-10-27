// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Angle helpers of the geodesic solvers: exact degree reductions so that 90°, 180° and the poles stay exact. */

/** Radians per degree. */
export const DEG_TO_RAD = Math.PI / 180;
/** Degrees per radian. */
export const RAD_TO_DEG = 180 / Math.PI;

/** Reduces an angle to (-180, 180] degrees; exact for finite input. */
export function normalizeDeg(angleDeg: number): number {
  const reduced = angleDeg % 360;
  if (reduced > 180) return reduced - 360;
  return reduced <= -180 ? reduced + 360 : reduced;
}

/**
 * The longitude difference `lon2Deg - lon1Deg` reduced to [-180, 180] degrees (-180 only when the difference itself is
 * -180 modulo 360, which keeps the direction of a half turn), with the rounding error of the subtraction carried
 * through an error-free sum so that it stays exact to the last bit.
 */
export function longitudeDifferenceDeg(lon1Deg: number, lon2Deg: number): number {
  const x = normalizeDeg(lon2Deg);
  const y = -normalizeDeg(lon1Deg);
  const sum = x + y;
  const yPart = sum - x;
  const error = x - (sum - yPart) + (y - yPart);
  let difference = sum % 360;
  if (difference > 180) difference -= 360;
  else if (difference < -180) difference += 360;
  difference += error;
  if (difference > 180) return difference - 360;
  return difference < -180 ? difference + 360 : difference;
}

/**
 * Writes sin and cos of an angle in degrees to `out[offset]` and `out[offset + 1]`, reducing the angle to a quadrant
 * exactly first, so that multiples of 90° give exact zeros and ones.
 */
export function sinCosDeg(angleDeg: number, out: Float64Array, offset: number): void {
  let reduced = angleDeg % 360;
  const quadrant = Math.round(reduced / 90);
  reduced -= 90 * quadrant;
  const radians = reduced * DEG_TO_RAD;
  const s = Math.sin(radians);
  const c = Math.cos(radians);
  let sine: number;
  let cosine: number;
  switch (quadrant & 3) {
    case 0:
      sine = s;
      cosine = c;
      break;
    case 1:
      sine = c;
      cosine = -s;
      break;
    case 2:
      sine = -s;
      cosine = -c;
      break;
    default:
      sine = -c;
      cosine = s;
  }
  out[offset] = sine + 0;
  out[offset + 1] = cosine + 0;
}

/** The direction of the vector (x, y) — atan2(y, x) — in degrees, in (-180, 180]. */
export function atan2Deg(y: number, x: number): number {
  const angleDeg = Math.atan2(y, x) * RAD_TO_DEG;
  if (angleDeg > 180 || angleDeg <= -180) return 180;
  return angleDeg + 0;
}

/**
 * Rounds angles smaller than 1/16° in magnitude to multiples of 2⁻⁵⁷° (7e-18°, under 1e-11 m on the ground) so that
 * products of tiny angles cannot underflow; larger angles are returned unchanged.
 */
export function snapTinyDeg(angleDeg: number): number {
  const magnitude = Math.abs(angleDeg);
  const snapped = magnitude < 1 / 16 ? 1 / 16 - (1 / 16 - magnitude) : magnitude;
  return angleDeg < 0 ? -snapped : snapped;
}
