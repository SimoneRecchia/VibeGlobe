/**
 * Cases and reference arithmetic of the GPU probes (ADR 0004 and 0005 verification): the views, the tracked vertices
 * and what float64 says the GPU must produce. Kept free of three.js so it runs in unit tests.
 */

/** The probes' virtual screen: 4K, 37° vertical field of view (the eye-offset property test's pixel). */
export const PROBE_SCREEN = { widthPx: 3840, heightPx: 2160, fovYRad: 0.6435 } as const;
/** The near plane of the probes' projection, in meters (the engine's default). */
export const PROBE_NEAR_METERS = 0.1;

/** A camera frame: unit right, up and forward axes in ECEF. */
export interface CameraFrame {
  readonly right: Float64Array;
  readonly up: Float64Array;
  readonly forward: Float64Array;
}

/** One tracked vertex: a mesh origin, the vertex's float32 offset from it and the eye, all ECEF meters. */
export interface PrecisionCase {
  readonly origin: Float64Array;
  readonly offset: Float32Array;
  readonly eye: Float64Array;
}

/** A small deterministic generator (mulberry32), so every run and device probes the same cases. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitVector(next: () => number): Float64Array {
  for (;;) {
    const v = Float64Array.of(next() * 2 - 1, next() * 2 - 1, next() * 2 - 1);
    const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
    if (length > 0.1 && length <= 1) return v.map((c) => c / length);
  }
}

function cross(a: Float64Array, b: Float64Array): Float64Array {
  const v = Float64Array.of(
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  );
  const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  return v.map((c) => c / length);
}

/** A camera frame looking along `forward` (unit), with a random roll. */
export function cameraFrame(forward: Float64Array, next: () => number): CameraFrame {
  const right = cross(forward, unitVector(next));
  return { right, up: cross(right, forward), forward };
}

/**
 * The fixed case where losing T_lo moves the vertex across the view by 0.13 px at 4K (KB-025): a vertex 786,432·√3 m
 * from its origin seen from 1363 m, every component of T 0.03 m from the nearest float32. The camera looks at it.
 */
export function lowPartCase(): PrecisionCase {
  const side = 786_432;
  const origin = Float64Array.of(4e6, 3e6, 3.9e6);
  const toVertex = Float64Array.of(729.03, -340.28, 1100.22);
  return {
    origin,
    offset: Float32Array.of(side, side, side),
    eye: origin.map((c, i) => c + side - (toVertex[i] ?? 0)),
  };
}

/**
 * Tracked vertices for a camera frame, as in the eye-offset property test: a tile origin on the Earth, a vertex within
 * the tile radius R (1 m to 1000 km), seen from a distance between the closest allowed one (R/1000, at least 0.5 m) and
 * 1000 times that, inside the field of view.
 */
export function precisionCases(frame: CameraFrame, count: number, next: () => number): PrecisionCase[] {
  const halfY = Math.tan(PROBE_SCREEN.fovYRad / 2) * 0.9;
  const halfX = halfY * (PROBE_SCREEN.widthPx / PROBE_SCREEN.heightPx);
  return Array.from({ length: count }, () => {
    const origin = unitVector(next).map((c) => c * 6.371e6);
    const radius = 10 ** (6 * next());
    const offset = Float32Array.from(unitVector(next), (c) => c * radius * (next() < 0.3 ? 1 : next()));
    const distance = Math.max(radius / 1000, 0.5) * 1000 ** (next() < 0.3 ? 0 : next());
    const a = (next() * 2 - 1) * halfX;
    const b = (next() * 2 - 1) * halfY;
    const direction = frame.forward.map((f, i) => f + a * (frame.right[i] ?? 0) + b * (frame.up[i] ?? 0));
    const length = Math.hypot(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0);
    const eye = origin.map((c, i) => c + (offset[i] ?? 0) - ((direction[i] ?? 0) / length) * distance);
    return { origin, offset, eye };
  });
}

/** The rotation-only view matrix of a frame, column-major (rows right, up and backward). */
export function viewMatrix(frame: CameraFrame): Float64Array {
  const view = new Float64Array(16);
  for (let axis = 0; axis < 3; axis++) {
    view[axis * 4] = frame.right[axis] ?? 0;
    view[axis * 4 + 1] = frame.up[axis] ?? 0;
    view[axis * 4 + 2] = -(frame.forward[axis] ?? 0);
  }
  view[15] = 1;
  return view;
}

/** The reversed-Z infinite projection of the probe screen (the engine's, ADR 0005), column-major. */
export function projectionMatrix(aspect = PROBE_SCREEN.widthPx / PROBE_SCREEN.heightPx): Float64Array {
  const f = 1 / Math.tan(PROBE_SCREEN.fovYRad / 2);
  const projection = new Float64Array(16);
  projection[0] = f / aspect;
  projection[5] = f;
  projection[11] = -1;
  projection[14] = PROBE_NEAR_METERS;
  return projection;
}

/** Clip coordinates (x, y, w) of a case in float64: the exact position relative to the eye, projected. */
export function exactClip(view: Float64Array, projection: Float64Array, c: PrecisionCase): Float64Array {
  const relative = c.origin.map((o, i) => o + (c.offset[i] ?? 0) - (c.eye[i] ?? 0));
  const eyeSpace = new Float64Array(3);
  for (let row = 0; row < 3; row++)
    eyeSpace[row] = relative.reduce((sum, value, column) => sum + (view[column * 4 + row] ?? 0) * value, 0);
  const at = (row: number): number =>
    eyeSpace.reduce((sum, value, column) => sum + (projection[column * 4 + row] ?? 0) * value, 0) +
    (projection[12 + row] ?? 0);
  return Float64Array.of(at(0), at(1), at(3));
}

/** The distance between two clip positions (x, y, w) on the probe screen, in pixels. */
export function screenDistancePx(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const dx = ((a[0] ?? 0) / (a[2] ?? 1) - (b[0] ?? 0) / (b[2] ?? 1)) * (PROBE_SCREEN.widthPx / 2);
  const dy = ((a[1] ?? 0) / (a[2] ?? 1) - (b[1] ?? 0) / (b[2] ?? 1)) * (PROBE_SCREEN.heightPx / 2);
  return Math.hypot(dx, dy);
}

/** Log-spaced view distances for the depth probe, from just beyond the near plane to 4e7 m. */
export function depthDistances(count: number): number[] {
  const from = Math.log(0.12);
  const to = Math.log(4e7);
  return Array.from({ length: count }, (_, i) => Math.exp(from + ((to - from) * i) / (count - 1)));
}
