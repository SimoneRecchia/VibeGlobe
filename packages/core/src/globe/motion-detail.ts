// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Camera } from '../camera/camera.js';

/** Up to this speed, in view ranges per second, the camera counts as still: full detail. */
const STILL_SPEED = 0.25;
/** The coarsest motion asks for: four times the texel size, two imagery levels. */
export const MAX_FACTOR = 4;
/** How fast the remembered speed fades once the camera slows, per second: detail returns within about half a second. */
const SPEED_DECAY_PER_S = 0.002;
/** Longer gaps than this (a day, or a NaN or infinite one) measure no speed. */
const MAX_DT_S = 86_400;
/**
 * `SLOW_LINK_BPS` of the bandwidth estimator, as a constant of this module: per-frame code that compares with an
 * imported binding boxes the double it compares (ADR 0018); motion-detail.test.ts checks that the two agree.
 */
export const SLOW_LINK_BPS_HERE = 1.5e6;
/** Indices of {@link MotionDetail.state}. */
const LAST_MS = 0;
const SPEED = 1;
const MOTION_FACTOR = 2;
/** Index of the last frame's factor in {@link MotionDetail.state}, which per-frame code reads directly. */
export const FACTOR = 3;
/** Index of the largest texel at rest in {@link MotionDetail.state}. */
export const BASE_TEXEL = 4;

/**
 * Motion-aware detail (F287, F288, F301): while the camera moves fast the imagery may be coarser (texels up to four
 * times the still size, two levels), so a fast pan or a flight loads fewer, coarser tiles it can actually show; on a
 * slow link one level coarser again. Once the camera slows the factor returns to 1 and the tiles refine with their
 * cross-fades. The speed is the eye's motion in view ranges (its distance to the target) per second, remembered with a
 * fast decay so a frame without motion does not refine at once. A zoom out is not motion here (KB-309).
 */
export class MotionDetail {
  private readonly lastEye = new Float64Array(3).fill(Number.NaN);
  /**
   * The numbers written every frame, in an array: a double field can turn into a tagged one, which allocates on every
   * write (F064). Indices: last clock time, remembered speed, the motion's own factor (held while the camera slows),
   * the factor of the last frame, and the largest texel at rest.
   */
  readonly state = Float64Array.of(Number.NaN, 0, 1, 1, 1.5);
  /** A flight runs: on a slow link it asks for one level coarser from its first frame (F301). */
  flying = false;

  /** The texel error multiplier of the last frame (1 at rest). */
  get factor(): number {
    return this.state[FACTOR] ?? 1;
  }

  /** The largest texel at rest, render-target pixels in CSS pixels (1.5 over the pixel ratio, F109). */
  get baseTexelErrorPx(): number {
    return this.state[BASE_TEXEL] ?? 1.5;
  }

  /** Sets the largest texel at rest (when the pixel ratio or the screen error changes, not per frame). */
  set baseTexelErrorPx(value: number) {
    this.state[BASE_TEXEL] = value;
  }

  /** The camera jumped (`jumpTo`): not motion the eye follows, so the next frame measures no speed from it (F085). */
  jumped(): void {
    this.state[LAST_MS] = Number.NaN;
  }

  /**
   * Measures the camera's speed at the clock time `clock[0]` and sets {@link MotionDetail.factor}, the texel error
   * multiplier for this frame; `link` is the page's measured link. Numbers come in arrays and objects and none is
   * returned: doubles crossing a call the compiler does not inline are boxed every frame (F064).
   */
  update(camera: Camera, clock: Float64Array, link: { readonly bitsPerSecond: number } | undefined): void {
    const nowMs = clock[0] ?? 0;
    const eye = camera.eyeEcef;
    const state = this.state;
    const dtS = (nowMs - (state[LAST_MS] ?? Number.NaN)) / 1000;
    // Comparisons, not Number.isFinite: a builtin call the compiler does not inline boxes its argument (F064).
    if (dtS > 0 && dtS < MAX_DT_S) {
      // Not Math.hypot, which allocates for three arguments (F064).
      const dx = (eye[0] ?? 0) - (this.lastEye[0] ?? 0);
      const dy = (eye[1] ?? 0) - (this.lastEye[1] ?? 0);
      const dz = (eye[2] ?? 0) - (this.lastEye[2] ?? 0);
      // Motion straight back from the target (a zoom out) does not count: the view coarsens by itself then, and two
      // levels more would drop at once a layer that starts at a finer level, such as the orthophotos (KB-309). A
      // rounding below zero gives NaN, which the speed below ignores.
      const f = camera.forward;
      const along = dx * (f[0] ?? 0) + dy * (f[1] ?? 0) + dz * (f[2] ?? 0);
      const moved = Math.sqrt(dx * dx + dy * dy + dz * dz - (along < 0 ? along * along : 0));
      const speed = moved / Math.max(1, camera.pose.rangeMeters) / dtS;
      const remembered = (state[SPEED] ?? 0) * SPEED_DECAY_PER_S ** dtS;
      state[SPEED] = speed > remembered ? speed : remembered;
    }
    if (dtS !== 0) {
      this.lastEye.set(eye);
      state[LAST_MS] = nowMs;
    }
    // Whole levels: 1, 2 or 4 (and 8 on a slow link, F301), so the selection's threshold changes only between them.
    let factor =
      2 ** Math.round(Math.log2(Math.min(MAX_FACTOR, 1 + Math.max(0, (state[SPEED] ?? 0) - STILL_SPEED) * 2)));
    // Slowing down keeps the coarse detail until the camera is still, then refines at once: stepping through the
    // levels between would request tiles that the next level replaces before they show (F090).
    const held = state[MOTION_FACTOR] ?? 1;
    if (factor > 1 && factor < held) factor = held;
    state[MOTION_FACTOR] = factor;
    if ((factor > 1 || this.flying) && link !== undefined && link.bitsPerSecond < SLOW_LINK_BPS_HERE) factor *= 2;
    state[FACTOR] = factor;
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
