import type { Camera } from '../camera/camera.js';
import { geodeticToEcef } from '../geodesy/ecef.js';
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

/** Packs a tile into an integer key, exact up to level 25: levels are stacked, then rows, then columns. */
export function surfaceTileKey(level: number, x: number, y: number): number {
  return ((4 ** level - 1) * 2) / 3 + y * 2 ** (level + 1) + x;
}

/** Fills a tile's bounds from its level and indices. */
export function surfaceTileBounds(level: number, x: number, y: number, out: SurfaceTile): SurfaceTile {
  const size = Math.PI / 2 ** level;
  out.key = surfaceTileKey(level, x, y);
  out.level = level;
  out.x = x;
  out.y = y;
  out.westRad = -Math.PI + x * size;
  out.eastRad = out.westRad + size;
  out.northRad = Math.PI / 2 - y * size;
  out.southRad = out.northRad - size;
  return out;
}

const center = new Float64Array(3);
const corner = new Float64Array(3);

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
  const radius = boundingRadius(tile);
  offsetFromEye(camera.eyeEcef);
  const closest = Math.hypot(offset[0], offset[1], offset[2]) - radius;
  const distance = Math.max(closest, camera.nearMeters);
  if (level >= MIN_LEVEL && (outsideFrustum(camera, radius) || beyondHorizon(camera.eyeEcef, closest))) return;
  const screenError = (sagMeters(tile) / distance) * state.pixelsPerRadian;
  const refine =
    level < MIN_LEVEL ||
    (level < options.maxLevel && (screenError > options.maxScreenErrorPx || radius > RADIUS_TO_DISTANCE * distance));
  if (!refine) {
    state.count++;
    return;
  }
  for (let child = 0; child < 4; child++) visit(level + 1, 2 * x + (child & 1), 2 * y + (child >> 1));
}

/** Writes the tile center (on the ellipsoid) into `center` and returns the radius of a sphere around the tile. */
function boundingRadius(tile: SurfaceTile): number {
  const midLon = (tile.westRad + tile.eastRad) / 2;
  const midLat = (tile.southRad + tile.northRad) / 2;
  geodeticToEcef(midLon, midLat, 0, center);
  let radius = 0;
  for (let i = 0; i < 9; i++) {
    const lon = i % 3 === 0 ? tile.westRad : i % 3 === 1 ? midLon : tile.eastRad;
    const lat = i < 3 ? tile.northRad : i < 6 ? midLat : tile.southRad;
    geodeticToEcef(lon, lat, 0, corner);
    radius = Math.max(
      radius,
      Math.hypot(
        (corner[0] ?? 0) - (center[0] ?? 0),
        (corner[1] ?? 0) - (center[1] ?? 0),
        (corner[2] ?? 0) - (center[2] ?? 0),
      ),
    );
  }
  return radius + sagMeters(tile);
}

const offset: [number, number, number] = [0, 0, 0];

/** The tile center relative to the eye. */
function offsetFromEye(eye: Float64Array): [number, number, number] {
  offset[0] = (center[0] ?? 0) - (eye[0] ?? 0);
  offset[1] = (center[1] ?? 0) - (eye[1] ?? 0);
  offset[2] = (center[2] ?? 0) - (eye[2] ?? 0);
  return offset;
}

/** True when the tile's bounding sphere is entirely outside one of the frustum planes. */
function outsideFrustum(camera: Camera, radius: number): boolean {
  const planes = camera.frustumPlanes;
  for (let plane = 0; plane < 5; plane++) {
    const signedDistance =
      (planes[plane * 4] ?? 0) * offset[0] +
      (planes[plane * 4 + 1] ?? 0) * offset[1] +
      (planes[plane * 4 + 2] ?? 0) * offset[2] +
      (planes[plane * 4 + 3] ?? 0);
    if (signedDistance < -radius) return true;
  }
  return false;
}

/** Maximum chord sag of the tile's grid below the ellipsoid, in meters: the geometric error of its mesh. */
function sagMeters(tile: SurfaceTile): number {
  const step = (tile.northRad - tile.southRad) / TILE_SEGMENTS;
  return (A * step * step) / 8;
}

/**
 * True when the whole tile lies beyond the horizon: every visible point of the ellipsoid is within the tangent length
 * √(|eye|² − b²) of the eye (exact for a sphere of radius b, conservative for the ellipsoid), so a bounding sphere
 * entirely farther than that cannot show anything.
 */
function beyondHorizon(eye: Float64Array, closestDistanceMeters: number): boolean {
  const eyeDistanceSquared = (eye[0] ?? 0) ** 2 + (eye[1] ?? 0) ** 2 + (eye[2] ?? 0) ** 2;
  const tangentSquared = eyeDistanceSquared - B * B;
  return tangentSquared > 0 && closestDistanceMeters * closestDistanceMeters > tangentSquared;
}
