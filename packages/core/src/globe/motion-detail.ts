import type { Camera } from '../camera/camera.js';
import { SLOW_LINK_BPS } from '../scheduler/bandwidth.js';

/** Up to this speed, in view ranges per second, the camera counts as still: full detail. */
const STILL_SPEED = 0.25;
/** The coarsest motion asks for: four times the texel size, two imagery levels. */
const MAX_FACTOR = 4;
/** How fast the remembered speed fades once the camera slows, per second: detail returns within about half a second. */
const SPEED_DECAY_PER_S = 0.002;

/**
 * Motion-aware detail (F287, F288, F301): while the camera moves fast the imagery may be coarser (texels up to four
 * times the still size, two levels), so a fast pan or a flight loads fewer, coarser tiles it can actually show; on a
 * slow link one level coarser again. Once the camera slows the factor returns to 1 and the tiles refine with their
 * cross-fades. The speed is the eye's motion in view ranges (its distance to the target) per second, remembered with a
 * fast decay so a frame without motion does not refine at once.
 */
export class MotionDetail {
  private readonly lastEye = new Float64Array(3).fill(Number.NaN);
  private lastMs = Number.NaN;
  private speed = 0;
  /** The factor of the motion alone, before the link's: held while the camera slows. */
  private motionFactor = 1;
  /** The texel error multiplier of the last frame (1 at rest). */
  factor = 1;
  /** A flight runs: on a slow link it asks for one level coarser from its first frame (F301). */
  flying = false;
  /** The largest texel at rest, render-target pixels in CSS pixels (1.5 over the pixel ratio, F109). */
  baseTexelErrorPx = 1.5;

  /** The camera jumped (`jumpTo`): not motion the eye follows, so the next frame measures no speed from it (F085). */
  jumped(): void {
    this.lastMs = Number.NaN;
  }

  /**
   * Measures the camera's speed at the clock time `clock[0]` and returns the texel error multiplier for this frame;
   * `link` is the page's measured link. Numbers come in arrays and objects: doubles passed as arguments would allocate
   * every frame (F064).
   */
  update(camera: Camera, clock: Float64Array, link: { readonly bitsPerSecond: number } | undefined): number {
    const nowMs = clock[0] ?? 0;
    const eye = camera.eyeEcef;
    const dtS = (nowMs - this.lastMs) / 1000;
    if (dtS > 0 && Number.isFinite(dtS)) {
      // Not Math.hypot, which allocates for three arguments (F064).
      const dx = (eye[0] ?? 0) - (this.lastEye[0] ?? 0);
      const dy = (eye[1] ?? 0) - (this.lastEye[1] ?? 0);
      const dz = (eye[2] ?? 0) - (this.lastEye[2] ?? 0);
      const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const speed = moved / Math.max(1, camera.pose.rangeMeters) / dtS;
      this.speed = Math.max(speed, this.speed * SPEED_DECAY_PER_S ** dtS);
    }
    if (dtS !== 0) {
      this.lastEye.set(eye);
      this.lastMs = nowMs;
    }
    // Whole levels: 1, 2 or 4 (and 8 on a slow link, F301), so the selection's threshold changes only between them.
    let factor = 2 ** Math.round(Math.log2(Math.min(MAX_FACTOR, 1 + Math.max(0, this.speed - STILL_SPEED) * 2)));
    // Slowing down keeps the coarse detail until the camera is still, then refines at once: stepping through the
    // levels between would request tiles that the next level replaces before they show (F090).
    if (factor > 1 && factor < this.motionFactor) factor = this.motionFactor;
    this.motionFactor = factor;
    if ((factor > 1 || this.flying) && link !== undefined && link.bitsPerSecond < SLOW_LINK_BPS) factor *= 2;
    this.factor = factor;
    return factor;
  }
}

/** The motion state of each engine's surface, outside the per-frame classes (F064). */
const motions = new WeakMap<object, MotionDetail>();

/** The motion state of `owner`, created on first use. */
export function motionOf(owner: object): MotionDetail {
  let motion = motions.get(owner);
  if (!motion) motions.set(owner, (motion = new MotionDetail()));
  return motion;
}
