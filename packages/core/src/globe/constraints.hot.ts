/**
 * @hotpath Applied to the camera once per frame after input and movements (F209–F211): doubles stay in arrays.
 * @benchmark packages/core/src/globe/frame-allocation.test.ts
 */
import type { Camera } from '../camera/camera.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { GlobeError } from './errors.js';
import type { CameraConstraints } from './types.js';

/** Ground meters per CSS pixel at ground zoom 0 (512 px across the equator, as `camera/zoom.ts`). */
const METERS_PER_PIXEL_AT_ZERO = (2 * Math.PI * WGS84.semiMajorAxisMeters) / 512;
const RAD = Math.PI / 180;

/** Slots of the constraints, NaN where none is set. */
const MIN_ZOOM = 0;
const MAX_ZOOM = 1;
const MAX_TILT = 2;
const WEST = 3;
const SOUTH = 4;
const EAST = 5;
const NORTH = 6;
/** Scratch: the range limits of this frame. */
const MIN_RANGE = 7;
const MAX_RANGE = 8;

/** Throws a GlobeError unless `constraints` are valid; returns them. */
export function validateConstraints(constraints: unknown): CameraConstraints {
  if (constraints === null || typeof constraints !== 'object')
    throw new GlobeError('invalid-option', 'constraints must be an object');
  const c = constraints as CameraConstraints;
  for (const [name, value, min, max] of [
    ['minZoom', c.minZoom, 0, 25],
    ['maxZoom', c.maxZoom, 0, 25],
    ['maxTiltDeg', c.maxTiltDeg, 0, 89],
  ] as const) {
    if (value !== undefined && !(typeof value === 'number' && value >= min && value <= max))
      throw new GlobeError('invalid-option', `constraints.${name} must be a number from ${min} to ${max}`);
  }
  if (c.minZoom !== undefined && c.maxZoom !== undefined && c.minZoom > c.maxZoom)
    throw new GlobeError('invalid-option', 'constraints.minZoom must not exceed maxZoom');
  const b = c.bounds;
  if (
    b !== undefined &&
    !(
      [b.westDeg, b.southDeg, b.eastDeg, b.northDeg].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
      Math.abs(b.westDeg) <= 180 &&
      Math.abs(b.eastDeg) <= 180 &&
      b.southDeg >= -90 &&
      b.northDeg <= 90 &&
      b.southDeg <= b.northDeg
    )
  )
    throw new GlobeError('invalid-coordinate', 'constraints.bounds must be valid degrees with southDeg ≤ northDeg');
  return c;
}

/**
 * The camera constraints of a globe (F209–F211): zoom limits, a maximum tilt and geographic bounds for the target,
 * held for every input and movement by clamping the pose each frame, so a limit stops the camera without overshoot.
 */
export class Constraints {
  /** The constraints as last set, validated (`Globe.constraints`). */
  settings: CameraConstraints = {};
  readonly values = new Float64Array(9).fill(Number.NaN);

  /** Replaces the constraints (validated), passing the maximum tilt on to `view` when given. */
  set(constraints: CameraConstraints, view?: { setMaxTilt(maxTiltRad: number): void }): void {
    this.settings = constraints;
    const v = this.values;
    v.fill(Number.NaN);
    v[MIN_ZOOM] = constraints.minZoom ?? Number.NaN;
    v[MAX_ZOOM] = constraints.maxZoom ?? Number.NaN;
    v[MAX_TILT] = constraints.maxTiltDeg === undefined ? Number.NaN : constraints.maxTiltDeg * RAD;
    if (constraints.bounds) {
      v[WEST] = constraints.bounds.westDeg * RAD;
      v[SOUTH] = constraints.bounds.southDeg * RAD;
      v[EAST] = constraints.bounds.eastDeg * RAD;
      v[NORTH] = constraints.bounds.northDeg * RAD;
    }
    view?.setMaxTilt(this.maxTiltRad);
  }

  /** The maximum tilt in radians, NaN when unconstrained: the view state caps applied and chosen tilts with it. */
  get maxTiltRad(): number {
    return this.values[MAX_TILT] ?? Number.NaN;
  }

  /**
   * Moves a movement's end point (longitude and latitude, radians, in the first two entries) into the bounds, so the
   * movement ends where the bounds let it instead of being held at their edge on the way (F211).
   */
  clampEnd(end: Float64Array): void {
    const v = this.values;
    const south = v[SOUTH] ?? Number.NaN;
    if (south !== south) return;
    clampLongitude(end, v);
    end[1] = Math.min(Math.max(end[1] ?? 0, south), v[NORTH] ?? 0);
  }

  /**
   * The part of a zoom step by `deltaZoom` levels that stays within the zoom limits, so a zoom anchored at a point
   * stops at the limit instead of panning the view toward the point (KB-126). Never moves further out of range.
   */
  limitZoomDelta(camera: Camera, deltaZoom: number): number {
    const v = this.values;
    const minZoom = v[MIN_ZOOM] ?? Number.NaN;
    const maxZoom = v[MAX_ZOOM] ?? Number.NaN;
    if (minZoom !== minZoom && maxZoom !== maxZoom) return deltaZoom;
    const pose = camera.pose;
    const toRange =
      ((camera.heightPx / 2) * METERS_PER_PIXEL_AT_ZERO * Math.cos(pose.targetLatitudeRad)) /
      Math.tan(camera.fovYRad / 2);
    const zoom = Math.log2(toRange / pose.rangeMeters);
    let target = zoom + deltaZoom;
    if (maxZoom === maxZoom && target > maxZoom) target = Math.max(maxZoom, Math.min(zoom, target));
    if (minZoom === minZoom && target < minZoom) target = Math.min(minZoom, Math.max(zoom, target));
    return target - zoom;
  }

  /** Clamps the camera's range to the zoom limits and its target into the bounds. Does not update the camera. */
  apply(camera: Camera): void {
    const v = this.values;
    const pose = camera.pose;
    // Bounds first: the zoom limits depend on the latitude.
    const south = v[SOUTH] ?? Number.NaN;
    if (south === south) {
      if (pose.targetLatitudeRad < south) pose.targetLatitudeRad = south;
      if (pose.targetLatitudeRad > (v[NORTH] ?? 0)) pose.targetLatitudeRad = v[NORTH] ?? 0;
      lonIo[0] = pose.targetLongitudeRad;
      if (clampLongitude(lonIo, v)) pose.targetLongitudeRad = lonIo[0] ?? pose.targetLongitudeRad;
    }
    const minZoom = v[MIN_ZOOM] ?? Number.NaN;
    const maxZoom = v[MAX_ZOOM] ?? Number.NaN;
    if (minZoom !== minZoom && maxZoom !== maxZoom) return;
    // Web Mercator zoom z at latitude φ is ground zoom z − log2(cos φ); range = (h / 2) · m/px / tan(fov / 2).
    const toRange =
      ((camera.heightPx / 2) * METERS_PER_PIXEL_AT_ZERO * Math.cos(pose.targetLatitudeRad)) /
      Math.tan(camera.fovYRad / 2);
    v[MAX_RANGE] = minZoom === minZoom ? toRange / 2 ** minZoom : Number.POSITIVE_INFINITY;
    v[MIN_RANGE] = maxZoom === maxZoom ? toRange / 2 ** maxZoom : 0;
    if (pose.rangeMeters > (v[MAX_RANGE] ?? 0)) pose.rangeMeters = v[MAX_RANGE] ?? pose.rangeMeters;
    if (pose.rangeMeters < (v[MIN_RANGE] ?? 0)) pose.rangeMeters = v[MIN_RANGE] ?? pose.rangeMeters;
  }
}

/** Where a longitude is clamped (KB-132): a double passed to or returned from a call that is not inlined is boxed. */
const lonIo = new Float64Array(1);

/**
 * Clamps the longitude in `io[0]` into [west, east], across the antimeridian when east < west, to the nearer edge;
 * returns true when it moved.
 */
function clampLongitude(io: Float64Array, v: Float64Array): boolean {
  const lon = io[0] ?? 0;
  const west = v[WEST] ?? 0;
  const east = v[EAST] ?? 0;
  const inside = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  if (inside) return false;
  // Distances to each edge, going round the shorter way.
  let toWest = Math.abs(lon - west);
  if (toWest > Math.PI) toWest = 2 * Math.PI - toWest;
  let toEast = Math.abs(lon - east);
  if (toEast > Math.PI) toEast = 2 * Math.PI - toEast;
  io[0] = toWest < toEast ? west : east;
  return true;
}
