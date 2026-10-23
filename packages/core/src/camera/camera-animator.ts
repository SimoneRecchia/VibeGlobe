import { WGS84 } from '../geodesy/wgs84.js';
import type { Camera } from './camera.js';
import { FlightPath } from './flight.js';

const TWO_PI = 2 * Math.PI;
/** Flights travel this many flight-path units per second by default (F195): long flights last a few seconds. */
const FLIGHT_SPEED_PER_S = 1.2;
/** Bounds of an automatic flight duration, milliseconds. */
const MIN_FLIGHT_MS = 400;
const MAX_FLIGHT_MS = 8000;

/** The kinds of animated camera movement (F195, F198). */
export type AnimationKind = 'ease' | 'fly';

/** Slots of an animation's start and end, in one array (ADR 0018). */
const LON0 = 0;
const LAT0 = 1;
const RANGE0 = 2;
const HEADING0 = 3;
const TILT0 = 4;
const LON1 = 5;
const LAT1 = 6;
const RANGE1 = 7;
const HEADING1 = 8;
const TILT1 = 9;
/** The great-circle angle between the two centers, radians. */
const ANGLE = 10;
const START_MS = 11;
const DURATION_MS = 12;
/** 1 when the tilt is animated (the target gives one), else 0. */
const ANIMATE_TILT = 13;

/** Smooth start and stop (cubic ease in-out), on `t` in [0, 1]. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

const linear = (t: number): number => t;

/** How a movement runs (F195): flight speed and rise, and the timing curve; every field optional. */
export interface AnimationShape {
  /** Flight path units per second when no duration is given (default 1.2). */
  readonly speed?: number;
  /** The flight path's ρ (default 1.42): greater rises higher. */
  readonly curve?: number;
  /** The timing curve on [0, 1]: 'ease-in-out' (default), 'linear', or a function with f(0) = 0 and f(1) = 1. */
  readonly easing?: 'ease-in-out' | 'linear' | ((t: number) => number);
}

/**
 * One animated camera movement (F195, F198, F203): from the pose at its start to a target pose, as a function of the
 * engine time, so the camera follows the same trajectory at every frame rate and after stalled frames. `ease`
 * interpolates the center along the great circle, the range geometrically, the heading along the shorter arc and the
 * tilt, all on one ease-in-out curve; `fly` moves the center and the range along van Wijk and Nuij's path, rising
 * between distant places. Allocates nothing per frame.
 */
export class CameraAnimator {
  readonly kind: AnimationKind;
  private readonly v = new Float64Array(14);
  private readonly path = new FlightPath();
  private readonly io = new Float64Array(3);
  private readonly a = new Float64Array(3);
  private readonly b = new Float64Array(3);
  private readonly easing: (t: number) => number;

  /**
   * Starts at the camera's current pose toward `target` (radians and meters: longitude, latitude, range, heading, tilt;
   * a NaN tilt keeps the tilt), at engine time `startMs`. A `durationMs` of undefined picks one: proportional to the
   * flight path for `fly` (at `shape.speed`), 1 s for `ease`. `shape` also sets the flight's rise and the timing curve.
   */
  constructor(
    kind: AnimationKind,
    camera: Camera,
    target: Float64Array,
    startMs: number,
    durationMs: number | undefined,
    shape: AnimationShape = {},
  ) {
    this.kind = kind;
    const easing = shape.easing ?? 'ease-in-out';
    this.easing = easing === 'ease-in-out' ? easeInOut : easing === 'linear' ? linear : easing;
    const v = this.v;
    const pose = camera.pose;
    v[LON0] = pose.targetLongitudeRad;
    v[LAT0] = pose.targetLatitudeRad;
    v[RANGE0] = pose.rangeMeters;
    v[HEADING0] = pose.headingRad;
    v[TILT0] = pose.tiltRad;
    v[LON1] = target[0] ?? 0;
    v[LAT1] = target[1] ?? 0;
    v[RANGE1] = target[2] ?? pose.rangeMeters;
    // The shorter way round to the new heading.
    let turn = ((((target[3] ?? 0) - pose.headingRad) % TWO_PI) + TWO_PI) % TWO_PI;
    if (turn > Math.PI) turn -= TWO_PI;
    v[HEADING1] = pose.headingRad + turn;
    const tilt = target[4] ?? Number.NaN;
    v[ANIMATE_TILT] = tilt === tilt ? 1 : 0;
    v[TILT1] = tilt === tilt ? tilt : pose.tiltRad;
    unitVector(v[LON0] ?? 0, v[LAT0] ?? 0, this.a);
    unitVector(v[LON1] ?? 0, v[LAT1] ?? 0, this.b);
    const dot =
      (this.a[0] ?? 0) * (this.b[0] ?? 0) + (this.a[1] ?? 0) * (this.b[1] ?? 0) + (this.a[2] ?? 0) * (this.b[2] ?? 0);
    v[ANGLE] = Math.acos(dot > 1 ? 1 : dot < -1 ? -1 : dot);
    // View widths in ground meters: the visible height at the target, proportional to the range.
    const scale = 2 * Math.tan(camera.fovYRad / 2);
    this.path.set(
      (v[RANGE0] ?? 1) * scale,
      (v[RANGE1] ?? 1) * scale,
      (v[ANGLE] ?? 0) * WGS84.semiMajorAxisMeters,
      shape.curve,
    );
    v[START_MS] = startMs;
    v[DURATION_MS] =
      durationMs ??
      (kind === 'fly'
        ? Math.min(
            MAX_FLIGHT_MS,
            Math.max(MIN_FLIGHT_MS, (this.path.length / (shape.speed ?? FLIGHT_SPEED_PER_S)) * 1000),
          )
        : 1000);
  }

  /** The movement's duration, milliseconds. */
  get durationMs(): number {
    return this.v[DURATION_MS] ?? 0;
  }

  /** True when the target gives a tilt, which the animation then moves the camera to. */
  get animatesTilt(): boolean {
    return (this.v[ANIMATE_TILT] ?? 0) === 1;
  }

  /**
   * Writes the pose at engine time `io[0]` (milliseconds) into the camera, and the tilt it wants into `io[1]`
   * (radians); returns true once the movement has reached its target, which it then holds exactly. Does not update the
   * camera.
   */
  step(camera: Camera, io: Float64Array): boolean {
    const v = this.v;
    const duration = v[DURATION_MS] ?? 0;
    const elapsed = (io[0] ?? 0) - (v[START_MS] ?? 0);
    const t = duration > 0 ? (elapsed >= duration ? 1 : elapsed <= 0 ? 0 : elapsed / duration) : 1;
    const eased = this.easing(t);
    const pose = camera.pose;
    let along: number;
    if (this.kind === 'fly') {
      this.io[2] = eased;
      this.path.evaluate(this.io);
      const total = (v[ANGLE] ?? 0) * WGS84.semiMajorAxisMeters;
      along = total > 0 ? (this.io[1] ?? 0) / total : eased;
      pose.rangeMeters = (this.io[0] ?? 0) / (2 * Math.tan(camera.fovYRad / 2));
    } else {
      along = eased;
      pose.rangeMeters = (v[RANGE0] ?? 1) * ((v[RANGE1] ?? 1) / (v[RANGE0] ?? 1)) ** eased;
    }
    this.slerp(along, pose);
    pose.headingRad = (v[HEADING0] ?? 0) + ((v[HEADING1] ?? 0) - (v[HEADING0] ?? 0)) * eased;
    io[1] = (v[TILT0] ?? 0) + ((v[TILT1] ?? 0) - (v[TILT0] ?? 0)) * eased;
    if (t >= 1) {
      // The end, exactly (F195).
      pose.targetLongitudeRad = v[LON1] ?? 0;
      pose.targetLatitudeRad = v[LAT1] ?? 0;
      pose.rangeMeters = v[RANGE1] ?? pose.rangeMeters;
      pose.headingRad = wrapHeading(v[HEADING1] ?? 0);
      io[1] = v[TILT1] ?? 0;
      return true;
    }
    return false;
  }

  /** The target position at fraction `f` of the great circle from the start to the end. */
  private slerp(f: number, pose: Camera['pose']): void {
    const angle = this.v[ANGLE] ?? 0;
    const a = this.a;
    const b = this.b;
    let wa = 1 - f;
    let wb = f;
    if (angle > Math.PI - 1e-9) {
      // Antipodal ends: every great circle joins them; take the one through the north of the start (KB-128).
      const ax = a[0] ?? 0;
      const ay = a[1] ?? 0;
      const az = a[2] ?? 0;
      const horizontal = Math.sqrt(ax * ax + ay * ay);
      // The northward tangent at the start; at a pole, the direction of longitude 0.
      const px = horizontal > 1e-12 ? (-az * ax) / horizontal : 1;
      const py = horizontal > 1e-12 ? (-az * ay) / horizontal : 0;
      const pz = horizontal > 1e-12 ? horizontal : 0;
      const cos = Math.cos(f * angle);
      const sin = Math.sin(f * angle);
      const x = cos * ax + sin * px;
      const y = cos * ay + sin * py;
      const z = cos * az + sin * pz;
      pose.targetLongitudeRad = Math.atan2(y, x);
      pose.targetLatitudeRad = Math.atan2(z, Math.sqrt(x * x + y * y));
      return;
    }
    if (angle > 1e-12) {
      const sin = Math.sin(angle);
      wa = Math.sin((1 - f) * angle) / sin;
      wb = Math.sin(f * angle) / sin;
    }
    const x = wa * (a[0] ?? 0) + wb * (b[0] ?? 0);
    const y = wa * (a[1] ?? 0) + wb * (b[1] ?? 0);
    const z = wa * (a[2] ?? 0) + wb * (b[2] ?? 0);
    pose.targetLongitudeRad = Math.atan2(y, x);
    pose.targetLatitudeRad = Math.atan2(z, Math.sqrt(x * x + y * y));
  }
}

/** A heading in [0, 2π). */
function wrapHeading(rad: number): number {
  return ((rad % TWO_PI) + TWO_PI) % TWO_PI;
}

/** The unit vector of a longitude and latitude on the sphere. */
function unitVector(lonRad: number, latRad: number, out: Float64Array): void {
  const cos = Math.cos(latRad);
  out[0] = cos * Math.cos(lonRad);
  out[1] = cos * Math.sin(lonRad);
  out[2] = Math.sin(latRad);
}
