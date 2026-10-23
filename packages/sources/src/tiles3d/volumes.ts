/**
 * 3D Tiles bounding volumes (F460, F461; ADR 0041): `box` (center and three half-axes), `region` (west, south, east,
 * north in radians, minimum and maximum height in meters on WGS84) and `sphere`, transformed to Earth-centered,
 * Earth-fixed (ECEF) coordinates in meters, with distance and frustum tests for traversal. Regions are bounded by an
 * oriented box in the local east-north-up frame of their center, built from sampled points, so distances are never
 * overestimated (an overestimate would refine too little and leave coarse tiles up close).
 */

/** A 4×4 matrix, column-major (glTF and 3D Tiles order). */
export type Mat4 = readonly number[];

/** The identity matrix. */
export const IDENTITY: Mat4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** `a × b` for column-major 4×4 matrices. */
export function multiply(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** Transforms a point by a column-major matrix. */
export function transformPoint(m: Mat4, p: readonly number[]): [number, number, number] {
  const [x = 0, y = 0, z = 0] = p;
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

/** Transforms a direction (no translation). */
export function transformVector(m: Mat4, v: readonly number[]): [number, number, number] {
  const [x = 0, y = 0, z = 0] = v;
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z,
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z,
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z,
  ];
}

const A = 6378137;
const E2 = 6.69437999014e-3;

/** WGS84 geodetic coordinates (radians, meters) to ECEF meters. */
export function geodeticToEcef(lonRad: number, latRad: number, heightMeters: number): [number, number, number] {
  const sinLat = Math.sin(latRad);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const r = (n + heightMeters) * Math.cos(latRad);
  return [r * Math.cos(lonRad), r * Math.sin(lonRad), (n * (1 - E2) + heightMeters) * sinLat];
}

/** A volume in ECEF: an oriented box (center and half-axes) or a sphere. */
export type WorldVolume =
  | { readonly kind: 'box'; readonly center: readonly number[]; readonly halfAxes: readonly (readonly number[])[] }
  | { readonly kind: 'sphere'; readonly center: readonly number[]; readonly radius: number };

const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const sub = (a: readonly number[], b: readonly number[]): number[] => [
  (a[0] ?? 0) - (b[0] ?? 0),
  (a[1] ?? 0) - (b[1] ?? 0),
  (a[2] ?? 0) - (b[2] ?? 0),
];
const length = (a: readonly number[]): number => Math.sqrt(dot(a, a));

function regionVolume(region: readonly number[]): WorldVolume {
  const [west = 0, south = 0, rawEast = 0, north = 0, minH = 0, maxH = 0] = region;
  const east = rawEast < west ? rawEast + 2 * Math.PI : rawEast;
  const lon = (west + east) / 2;
  const lat = (south + north) / 2;
  const center = geodeticToEcef(lon, lat, (minH + maxH) / 2);
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const eastAxis = [-Math.sin(lon), Math.cos(lon), 0];
  const northAxis = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const extents = [0, 0, 0];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      for (const h of [minH, maxH]) {
        const p = sub(
          geodeticToEcef(west + ((east - west) * i) / steps, south + ((north - south) * j) / steps, h),
          center,
        );
        extents[0] = Math.max(extents[0] ?? 0, Math.abs(dot(p, eastAxis)));
        extents[1] = Math.max(extents[1] ?? 0, Math.abs(dot(p, northAxis)));
        extents[2] = Math.max(extents[2] ?? 0, Math.abs(dot(p, up)));
      }
    }
  }
  const scale = (v: readonly number[], s: number) => v.map((c) => c * s * 1.0001);
  return {
    kind: 'box',
    center,
    halfAxes: [scale(eastAxis, extents[0] ?? 0), scale(northAxis, extents[1] ?? 0), scale(up, extents[2] ?? 0)],
  };
}

/**
 * The ECEF volume of a tile's `boundingVolume` under its world transform (regions ignore the transform, as the
 * specification says). Undefined when the volume is malformed.
 */
export function worldVolume(volume: unknown, transform: Mat4 = IDENTITY): WorldVolume | undefined {
  if (volume === null || typeof volume !== 'object') return undefined;
  const v = volume as { box?: unknown; region?: unknown; sphere?: unknown };
  const numbers = (a: unknown, n: number): a is number[] =>
    Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (numbers(v.region, 6)) return regionVolume(v.region);
  if (numbers(v.box, 12)) {
    const b = v.box;
    return {
      kind: 'box',
      center: transformPoint(transform, b.slice(0, 3)),
      halfAxes: [3, 6, 9].map((i) => transformVector(transform, b.slice(i, i + 3))),
    };
  }
  if (numbers(v.sphere, 4)) {
    const s = v.sphere;
    const scale = Math.max(
      ...[0, 1, 2].map((c) => length(transformVector(transform, [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0]))),
    );
    return { kind: 'sphere', center: transformPoint(transform, s.slice(0, 3)), radius: (s[3] ?? 0) * scale };
  }
  return undefined;
}

/** Distance in meters from a point to the volume (0 inside). */
export function distanceToVolume(volume: WorldVolume, point: readonly number[]): number {
  const d = sub(point, volume.center);
  if (volume.kind === 'sphere') return Math.max(0, length(d) - volume.radius);
  let squared = 0;
  for (const axis of volume.halfAxes) {
    const half = length(axis);
    if (half === 0) continue;
    const along = Math.abs(dot(d, axis) / half);
    if (along > half) squared += (along - half) ** 2;
  }
  return Math.sqrt(squared);
}

/** A frustum plane: unit normal pointing inside and distance, `dot(n, p) + d >= 0` inside. */
export type Plane = readonly [number, number, number, number];

/** Whether the volume is at least partly inside every plane. */
export function intersectsFrustum(volume: WorldVolume, planes: readonly Plane[]): boolean {
  for (const [nx, ny, nz, d] of planes) {
    const n = [nx, ny, nz];
    const radius =
      volume.kind === 'sphere' ? volume.radius : volume.halfAxes.reduce((sum, axis) => sum + Math.abs(dot(n, axis)), 0);
    if (dot(n, volume.center) + d < -radius) return false;
  }
  return true;
}

/** The radius of a sphere that encloses the volume (for priorities and memory estimates). */
export function boundingRadius(volume: WorldVolume): number {
  return volume.kind === 'sphere'
    ? volume.radius
    : length(volume.halfAxes.reduce((s, a) => s.map((c, i) => c + Math.abs(a[i] ?? 0)), [0, 0, 0]));
}
