// Column-major 4×4 matrices in Float64Array(16), the layout WebGPU and WebGL expect after rounding to float32.

/** The parameters of a perspective projection. */
export interface PerspectiveLens {
  /** Vertical field of view, in radians. */
  fovYRad: number;
  /** Width over height. */
  aspect: number;
  /** Near plane distance, in meters. */
  nearMeters: number;
}

/**
 * Writes a reversed-Z perspective projection with an infinite far plane (ADR 0005): view-space depth d maps to
 * clip-space z/w = near / d, so 1 at the near plane and 0 at infinity, for a [0, 1] depth range. The parameters come in
 * an object because the camera rebuilds this every frame and V8 boxes doubles passed as arguments (ADR 0018).
 */
export function perspectiveReversedInfinite(out: Float64Array, lens: PerspectiveLens): Float64Array {
  const f = 1 / Math.tan(lens.fovYRad / 2);
  out.fill(0);
  out[0] = f / lens.aspect;
  out[5] = f;
  out[11] = -1;
  out[14] = lens.nearMeters;
  return out;
}

/**
 * Writes a rotation-only view matrix whose rows are the camera's right, up and backward axes (world → view, the eye at
 * the origin).
 */
export function viewRotation(
  out: Float64Array,
  right: Float64Array,
  up: Float64Array,
  forward: Float64Array,
): Float64Array {
  out.fill(0);
  for (let axis = 0; axis < 3; axis++) {
    out[axis * 4] = right[axis] ?? 0;
    out[axis * 4 + 1] = up[axis] ?? 0;
    out[axis * 4 + 2] = -(forward[axis] ?? 0);
  }
  out[15] = 1;
  return out;
}

/** Transforms the point (x, y, z, 1) by `m`, writing the homogeneous result to `out[0..3]`. */
export function transformPoint4(out: Float64Array, m: Float64Array, x: number, y: number, z: number): Float64Array {
  for (let row = 0; row < 4; row++) {
    out[row] = (m[row] ?? 0) * x + (m[row + 4] ?? 0) * y + (m[row + 8] ?? 0) * z + (m[row + 12] ?? 0);
  }
  return out;
}
