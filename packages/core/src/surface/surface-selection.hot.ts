/**
 * @hotpath Runs every frame over every visited tile; doubles never cross a call boundary here, because V8 boxes doubles
 * passed to or returned from a call it does not inline (ADR 0018).
 * @benchmark benchmarks/run.ts
 */
import type { Camera } from '../camera/camera.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { TILE_SEGMENTS } from './surface-mesh.js';

/** A geographic tile: two root tiles (west and east hemispheres) split as a quadtree. */
export interface SurfaceTile {
  key: number;
  level: number;
  x: number;
  y: number;
  westRad: number;
  southRad: number;
  eastRad: number;
  northRad: number;
}

/** Selection settings. */
export interface SurfaceSelectionOptions {
  /** Largest allowed geometric error on screen, in CSS pixels. */
  maxScreenErrorPx: number;
  /** Deepest level. */
  maxLevel: number;
}

const MIN_LEVEL = 2;
/** ADR 0004: a chunk's radius stays below this multiple of its distance from the eye, so float32 offsets stay exact. */
const RADIUS_TO_DISTANCE = 1000;
const A = WGS84.semiMajorAxisMeters;
const B = WGS84.semiMinorAxisMeters;
const E2 = WGS84.firstEccentricitySquared;

/** Packs a tile into an integer key, exact up to level 25: levels are stacked, then rows, then columns. */
export function surfaceTileKey(level: number, x: number, y: number): number {
  return ((4 ** level - 1) * 2) / 3 + y * 2 ** (level + 1) + x;
}

/** Fills a tile's bounds from its level and indices. */
export function surfaceTileBounds(level: number, x: number, y: number, out: SurfaceTile): SurfaceTile {
  const size = Math.PI / 2 ** level;
  // surfaceTileKey, written out: a key beyond 31 bits returned from a call would be boxed.
  out.key = ((4 ** level - 1) * 2) / 3 + y * 2 ** (level + 1) + x;
  out.level = level;
  out.x = x;
  out.y = y;
  out.westRad = -Math.PI + x * size;
  out.eastRad = out.westRad + size;
  out.northRad = Math.PI / 2 - y * size;
  out.southRad = out.northRad - size;
  return out;
}

/** The 3 × 3 grid of tile corners, edge midpoints and center on the ellipsoid, ECEF: the center is point 4. */
const grid = new Float64Array(27);
const lonSin = new Float64Array(3);
const lonCos = new Float64Array(3);
/** The tile center relative to the eye. */
const offset = new Float64Array(3);
/** Per-tile measures written by measureTile. */
const measure = new Float64Array(3);
const RADIUS = 0;
const CLOSEST = 1;
const SAG = 2;
/** The eye's horizon vector w = (x/a², y/a², z/b²) and its length, set once per selection. */
const horizon = new Float64Array(4);

/**
 * Chooses the surface tiles to draw for a camera: frustum and horizon culling, then refinement while the projected
 * geometric error exceeds the limit or the tile is too large for its distance (ADR 0004). Fills `out` and returns the
 * count; reuses the tile records in `out`, so steady-state selection allocates nothing.
 */
export function selectSurfaceTiles(camera: Camera, options: SurfaceSelectionOptions, out: SurfaceTile[]): number {
  state.camera = camera;
  state.options = options;
  state.out = out;
  state.count = 0;
  state.pixelsPerRadian = camera.heightPx / (2 * Math.tan(camera.fovYRad / 2));
  const eye = camera.eyeEcef;
  horizon[0] = (eye[0] ?? 0) / (A * A);
  horizon[1] = (eye[1] ?? 0) / (A * A);
  horizon[2] = (eye[2] ?? 0) / (B * B);
  horizon[3] = Math.sqrt((horizon[0] ?? 0) ** 2 + (horizon[1] ?? 0) ** 2 + (horizon[2] ?? 0) ** 2);
  visit(0, 0, 0);
  visit(0, 1, 0);
  state.out = undefined;
  return state.count;
}

/** Traversal state, module-level so the recursion allocates nothing. */
const state: {
  camera: Camera | undefined;
  options: SurfaceSelectionOptions;
  out: SurfaceTile[] | undefined;
  count: number;
  pixelsPerRadian: number;
} = { camera: undefined, options: { maxScreenErrorPx: 1, maxLevel: 1 }, out: undefined, count: 0, pixelsPerRadian: 1 };

function visit(level: number, x: number, y: number): void {
  const { camera, options, out } = state;
  if (!camera || !out) return;
  const tile = (out[state.count] ??= {
    key: 0,
    level: 0,
    x: 0,
    y: 0,
    westRad: 0,
    southRad: 0,
    eastRad: 0,
    northRad: 0,
  });
  surfaceTileBounds(level, x, y, tile);
  measureTile(tile, camera.eyeEcef);
  const radius = measure[RADIUS] ?? 0;
  // Comparisons, not Math.max, here and below: code not yet fully optimized calls it with boxed doubles.
  const closest = measure[CLOSEST] ?? 0;
  const distance = closest > camera.nearMeters ? closest : camera.nearMeters;
  if (level >= MIN_LEVEL && (outsideFrustum(camera) || beyondHorizon())) return;
  const screenError = ((measure[SAG] ?? 0) / distance) * state.pixelsPerRadian;
  const refine =
    level < MIN_LEVEL ||
    (level < options.maxLevel && (screenError > options.maxScreenErrorPx || radius > RADIUS_TO_DISTANCE * distance));
  if (!refine) {
    state.count++;
    return;
  }
  for (let child = 0; child < 4; child++) visit(level + 1, 2 * x + (child & 1), 2 * y + (child >> 1));
}

/**
 * Measures a tile against the eye into `measure`: the radius of a sphere around it, the distance from the eye to that
 * sphere and the chord sag of its mesh; writes the center relative to the eye into `offset`. The 9 grid points use the
 * closed form of `geodeticToEcef`, sharing the sines and cosines of 3 latitudes and 3 longitudes.
 */
function measureTile(tile: SurfaceTile, eye: Float64Array): void {
  const midLon = (tile.westRad + tile.eastRad) / 2;
  for (let column = 0; column < 3; column++) {
    const lon = column === 0 ? tile.westRad : column === 1 ? midLon : tile.eastRad;
    lonSin[column] = Math.sin(lon);
    lonCos[column] = Math.cos(lon);
  }
  for (let row = 0; row < 3; row++) {
    const lat = row === 0 ? tile.northRad : row === 1 ? (tile.southRad + tile.northRad) / 2 : tile.southRad;
    const sinLat = Math.sin(lat);
    const primeVerticalRadius = A / Math.sqrt(1 - E2 * sinLat * sinLat);
    const r = primeVerticalRadius * Math.cos(lat);
    const z = primeVerticalRadius * (1 - E2) * sinLat;
    for (let column = 0; column < 3; column++) {
      const point = (row * 3 + column) * 3;
      grid[point] = r * (lonCos[column] ?? 0);
      grid[point + 1] = r * (lonSin[column] ?? 0);
      grid[point + 2] = z;
    }
  }
  let radiusSquared = 0;
  for (let point = 0; point < 27; point += 3) {
    const dx = (grid[point] ?? 0) - (grid[12] ?? 0);
    const dy = (grid[point + 1] ?? 0) - (grid[13] ?? 0);
    const dz = (grid[point + 2] ?? 0) - (grid[14] ?? 0);
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared > radiusSquared) radiusSquared = distanceSquared;
  }
  // Maximum chord sag of the tile's grid below the ellipsoid, in meters: the geometric error of its mesh.
  const step = (tile.northRad - tile.southRad) / TILE_SEGMENTS;
  const sag = (A * step * step) / 8;
  const radius = Math.sqrt(radiusSquared) + sag;
  offset[0] = (grid[12] ?? 0) - (eye[0] ?? 0);
  offset[1] = (grid[13] ?? 0) - (eye[1] ?? 0);
  offset[2] = (grid[14] ?? 0) - (eye[2] ?? 0);
  measure[RADIUS] = radius;
  measure[CLOSEST] = Math.sqrt((offset[0] ?? 0) ** 2 + (offset[1] ?? 0) ** 2 + (offset[2] ?? 0) ** 2) - radius;
  measure[SAG] = sag;
}

/** True when the tile's bounding sphere is entirely outside one of the frustum planes. */
function outsideFrustum(camera: Camera): boolean {
  const planes = camera.frustumPlanes;
  const radius = measure[RADIUS] ?? 0;
  for (let plane = 0; plane < 5; plane++) {
    const signedDistance =
      (planes[plane * 4] ?? 0) * (offset[0] ?? 0) +
      (planes[plane * 4 + 1] ?? 0) * (offset[1] ?? 0) +
      (planes[plane * 4 + 2] ?? 0) * (offset[2] ?? 0) +
      (planes[plane * 4 + 3] ?? 0);
    if (signedDistance < -radius) return true;
  }
  return false;
}

/**
 * True when the whole tile lies beyond the horizon. A point P of the ellipsoid is visible from the eye E exactly when
 * P · w ≥ 1, with w = (Ex/a², Ey/a², Ez/b²) (the eye is on the outer side of P's tangent plane), so a bounding sphere
 * with center C and radius R whose every point has P · w < 1, that is C · w + R |w| < 1, shows nothing. Exact for the
 * ellipsoid up to the bounding sphere, and valid with the eye inside the sphere (KB-012).
 */
function beyondHorizon(): boolean {
  const reach =
    (grid[12] ?? 0) * (horizon[0] ?? 0) +
    (grid[13] ?? 0) * (horizon[1] ?? 0) +
    (grid[14] ?? 0) * (horizon[2] ?? 0) +
    (measure[RADIUS] ?? 0) * (horizon[3] ?? 0);
  return reach < 1;
}
