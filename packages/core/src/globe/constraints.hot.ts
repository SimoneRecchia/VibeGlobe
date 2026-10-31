// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @hotpath Applied to the camera once per frame after input and movements (F209–F211): doubles stay in arrays.
 * @benchmark packages/core/src/globe/frame-allocation.test.ts
 */
import type { Camera } from '../camera/camera.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { GlobeError } from './errors.js';
import { validateBounds } from './fit-bounds.js';
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
/** The farthest range, meters (F646). */
const FAR = 9;

/** Throws a GlobeError unless `constraints` are valid; returns them. */
export function validateConstraints(constraints: unknown): CameraConstraints {
  if (constraints === null || typeof constraints !== 'object')
    throw new GlobeError('invalid-option', 'constraints must be an object');
  const c = constraints as CameraConstraints;
  for (const [name, value, min, max] of [
    ['minZoom', c.minZoom, 0, 25],
    ['maxZoom', c.maxZoom, 0, 25],
    ['maxTiltDeg', c.maxTiltDeg, 0, 89],
    ['maxRangeMeters', c.maxRangeMeters, 1, 6e7],
    ['minSurfaceDistanceMeters', c.minSurfaceDistanceMeters, 0, 10_000],
  ] as const) {
    if (value !== undefined && !(typeof value === 'number' && value >= min && value <= max))
      throw new GlobeError('invalid-option', `constraints.${name} must be a number from ${min} to ${max}`);
  }
  if (c.minZoom !== undefined && c.maxZoom !== undefined && c.minZoom > c.maxZoom)
    throw new GlobeError('invalid-option', 'constraints.minZoom must not exceed maxZoom');
  if (c.bounds !== undefined) validateBounds(c.bounds);
  return c;
}

/**
 * The camera constraints of a globe (F209–F211): zoom limits, a maximum tilt and geographic bounds for the target,
 * held for every input and movement by clamping the pose each frame, so a limit stops the camera without overshoot.
 */
export class Constraints {
  /** The constraints as last set, validated (`Globe.constraints`). */
  settings: CameraConstraints = {};
  readonly values = new Float64Array(10).fill(Number.NaN);
  /** How near a zoom in may bring the eye to the surface it zooms toward, meters (KB-299). */
  minSurfaceDistanceMeters = 40;
  /**
   * Whether zoom limits or bounds are set: without, {@link apply} reads nothing (KB-132: a frame's reads of the values
   * allocate whenever the function runs unoptimized).
   */
  private clamps = false;

  /** Replaces the constraints (validated), passing the maximum tilt on to `view` when given. */
  set(constraints: CameraConstraints, view?: { setMaxTilt(maxTiltRad: number): void }): void {
    this.settings = constraints;
    const v = this.values;
    v.fill(Number.NaN);
    v[MIN_ZOOM] = constraints.minZoom ?? Number.NaN;
    v[MAX_ZOOM] = constraints.maxZoom ?? Number.NaN;
    v[MAX_TILT] = constraints.maxTiltDeg === undefined ? Number.NaN : constraints.maxTiltDeg * RAD;
    v[FAR] = constraints.maxRangeMeters ?? Number.NaN;
    if (constraints.bounds) {
      v[WEST] = constraints.bounds.westDeg * RAD;
      v[SOUTH] = constraints.bounds.southDeg * RAD;
      v[EAST] = constraints.bounds.eastDeg * RAD;
      v[NORTH] = constraints.bounds.northDeg * RAD;
    }
    // Anything but the tilt limit clamps the pose.
    this.clamps = v.some((value, slot) => slot !== MAX_TILT && value === value);
    this.minSurfaceDistanceMeters = constraints.minSurfaceDistanceMeters ?? 40;
    view?.setMaxTilt(this.maxTiltRad);
  }

  /** Whether a zoom limit, a farthest range or bounds are set: zooms are then limited by {@link limitZoomDelta}. */
  get zoomLimited(): boolean {
    return this.clamps;
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
    let minZoom = v[MIN_ZOOM] ?? Number.NaN;
    const maxZoom = v[MAX_ZOOM] ?? Number.NaN;
    const far = v[FAR] ?? Number.NaN;
    if (minZoom !== minZoom && maxZoom !== maxZoom && far !== far) return deltaZoom;
    const pose = camera.pose;
    const toRange = rangeAtZoomZero(camera);
    const zoom = Math.log2(toRange / pose.rangeMeters);
    // The farthest range is a zoom at this latitude (F646); the higher of it and minZoom holds.
    const farZoom = Math.log2(toRange / far);
    if (minZoom !== minZoom || farZoom > minZoom) minZoom = farZoom;
    let target = zoom + deltaZoom;
    // A NaN bound (none) compares false.
    if (target > maxZoom) target = Math.max(maxZoom, Math.min(zoom, target));
    if (target < minZoom) target = Math.min(minZoom, Math.max(zoom, target));
    return target - zoom;
  }

  /** Clamps the camera's range to the zoom limits and its target into the bounds. Does not update the camera. */
  apply(camera: Camera): void {
    if (!this.clamps) return;
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
    const far = v[FAR] ?? Number.NaN;
    if (minZoom !== minZoom && maxZoom !== maxZoom && far !== far) return;
    const toRange = rangeAtZoomZero(camera);
    v[MAX_RANGE] = minZoom === minZoom ? toRange / 2 ** minZoom : Number.POSITIVE_INFINITY;
    // The farthest range holds at every latitude: a drag toward a pole never moves the camera in (F646).
    if (far < (v[MAX_RANGE] ?? 0)) v[MAX_RANGE] = far;
    v[MIN_RANGE] = maxZoom === maxZoom ? toRange / 2 ** maxZoom : 0;
    if (pose.rangeMeters > (v[MAX_RANGE] ?? 0)) pose.rangeMeters = v[MAX_RANGE] ?? pose.rangeMeters;
    if (pose.rangeMeters < (v[MIN_RANGE] ?? 0)) pose.rangeMeters = v[MIN_RANGE] ?? pose.rangeMeters;
  }
}

/**
 * The range of Web Mercator zoom 0 at the target's latitude, meters: zoom z at latitude φ is ground zoom z − log2(cos φ),
 * and range = (h / 2) · m/px / tan(fov / 2).
 */
function rangeAtZoomZero(camera: Camera): number {
  return (
    ((camera.heightPx / 2) * METERS_PER_PIXEL_AT_ZERO * Math.cos(camera.pose.targetLatitudeRad)) /
    Math.tan(camera.fovYRad / 2)
  );
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
