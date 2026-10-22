import type { Camera } from './camera.js';

/** Slots of a fade's state, in one array (ADR 0018). */
const LON = 0;
const LAT = 1;
const RANGE = 2;
const HEADING = 3;
const TILT = 4;
const START_MS = 5;
const DURATION_MS = 6;
const JUMPED = 7;
const OPACITY = 8;

/**
 * A flight under the reduced-motion setting (F214): instead of traversing the path, the view fades out, jumps to the
 * target at the midpoint and fades back in, over `durationMs` of engine time. Same targets as `CameraAnimator`
 * (radians and meters; a NaN tilt keeps the tilt). Allocates nothing per frame.
 */
export class FadeJump {
  readonly animatesTilt: boolean;
  private readonly v = new Float64Array(9);

  constructor(camera: Camera, target: Float64Array, startMs: number, durationMs: number) {
    const v = this.v;
    for (let i = 0; i <= TILT; i++) v[i] = target[i] ?? 0;
    const tilt = target[TILT] ?? Number.NaN;
    this.animatesTilt = tilt === tilt;
    if (!this.animatesTilt) v[TILT] = camera.pose.tiltRad;
    v[START_MS] = startMs;
    v[DURATION_MS] = durationMs;
    v[OPACITY] = 1;
  }

  /** How opaque the view is now: 1, falling to 0 at the jump and rising back to 1. */
  get opacity(): number {
    return this.v[OPACITY] ?? 1;
  }

  /**
   * At engine time `io[0]` (milliseconds): jumps the camera to the target once half the duration has passed, writes
   * the tilt it wants into `io[1]`, and returns true at the end. Does not update the camera.
   */
  step(camera: Camera, io: Float64Array): boolean {
    const v = this.v;
    const duration = v[DURATION_MS] ?? 0;
    const elapsed = (io[0] ?? 0) - (v[START_MS] ?? 0);
    const t = duration > 0 ? (elapsed >= duration ? 1 : elapsed <= 0 ? 0 : elapsed / duration) : 1;
    const pose = camera.pose;
    if (t >= 0.5 && v[JUMPED] === 0) {
      v[JUMPED] = 1;
      pose.targetLongitudeRad = v[LON] ?? 0;
      pose.targetLatitudeRad = v[LAT] ?? 0;
      pose.rangeMeters = v[RANGE] ?? pose.rangeMeters;
      pose.headingRad = v[HEADING] ?? 0;
    }
    io[1] = v[JUMPED] === 1 ? (v[TILT] ?? 0) : pose.tiltRad;
    v[OPACITY] = t < 0.5 ? 1 - 2 * t : 2 * t - 1;
    return t >= 1;
  }
}
