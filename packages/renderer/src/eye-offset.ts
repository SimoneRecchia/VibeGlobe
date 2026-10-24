// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Writes T = origin − eye, computed in float64, as two float32 parts (ADR 0004 §3): high = fround(T) and
 * low = fround(T − high). The shader evaluates (offset + high) + low, whose first sum is exact near the eye, so a vertex
 * keeps float32 precision relative to its own distance from the eye. The float32 stores do the rounding (no Math.fround
 * call on the per-frame path, ADR 0018).
 */
export function splitEyeOffset(origin: Float64Array, eye: Float64Array, high: Float32Array, low: Float32Array): void {
  for (let i = 0; i < 3; i++) {
    const offset = (origin[i] ?? 0) - (eye[i] ?? 0);
    high[i] = offset;
    low[i] = offset - (high[i] ?? 0);
  }
}
