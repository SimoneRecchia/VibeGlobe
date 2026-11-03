// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Motion blur of the camera's movement (F694), loaded with the first frame that uses it. Each pixel's depth puts it
 * back in space, and one matrix, made in float64 from the engine's matrices of this frame and the one before, carries
 * it from where it is on screen now to where it was then: the frame is sampled along that path, one tap every 2 px
 * and at most 32 px long, so a pixel costs at most 16 taps and one that moved under a pixel costs one. Only a camera
 * that keeps moving blurs: the first frame after a still one (a jump) stays sharp. Every frame of a moving camera asks
 * for one more, so the last one drawn shows the camera at rest, and still frames skip this pass.
 */
import type { FrameView } from '@vibeglobe/core';
import { ceil, float, Fn, If, length, Loop, max, min, screenSize, screenUV, uniform, vec4 } from 'three/tsl';
import { Matrix4, RenderPipeline, Vector3, type Node, type TextureNode, type WebGPURenderer } from 'three/webgpu';

/** The longest smear, and the distance between its taps, in drawing-buffer pixels. */
const MAX_SMEAR_PX = 32;
const TAP_SPACING_PX = 2;
/** From a screen position (u, v from the top left, and the depth near / d) to normalized device coordinates. */
const NDC_FROM_SCREEN = new Matrix4().set(2, 0, 0, -1, 0, -2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1);
const SCREEN_FROM_NDC = new Matrix4().copy(NDC_FROM_SCREEN).invert();

/**
 * The camera's motion between the frames drawn: takes each frame's view and returns 0 when the camera did not move
 * since the previous frame, 1 when it just moved (a jump, drawn sharp) and 2 when it keeps moving; on a move it sets
 * `toPrevious`, this frame's screen position and depth to the previous frame's screen position (homogeneous), made
 * from the absolute matrices in float64 and only then rounded to float32. Allocates nothing.
 */
export function cameraMotion(toPrevious: Matrix4): (view: FrameView) => number {
  const now = new Matrix4();
  const before = new Matrix4();
  const scratch = new Matrix4();
  const eye = new Vector3();
  let moved = 0;
  return (view) => {
    now
      .fromArray(view.projection)
      .multiply(scratch.fromArray(view.view))
      .multiply(scratch.makeTranslation(eye.fromArray(view.eyeEcef).negate()));
    moved = now.equals(before) ? 0 : Math.min(moved + 1, 2);
    if (moved)
      toPrevious.copy(SCREEN_FROM_NDC).multiply(before).multiply(scratch.copy(now).invert()).multiply(NDC_FROM_SCREEN);
    before.copy(now);
    return moved;
  };
}

/** A frame drawn smeared along the camera's motion. */
export interface MotionBlur {
  /**
   * Draws the frame when the camera moved, blurred over `share` of the motion if it keeps moving; false draws nothing,
   * the camera is still.
   */
  readonly render: (view: FrameView, share: number) => boolean;
  dispose(): void;
}

/**
 * The motion blur of the scene's `frame` and `depth` (near / d, ADR 0005); `still` shows a pixel that moved under a
 * pixel, sampled at level 0 since it runs in a branch.
 */
export function createMotionBlur(
  renderer: WebGPURenderer,
  frame: TextureNode,
  depth: TextureNode,
  still: (uv: Node<'vec2'>) => Node<'vec4'>,
): MotionBlur {
  const toPrevious = new Matrix4();
  const motion = cameraMotion(toPrevious);
  const strength = uniform(0);
  const output = Fn(() => {
    const uv = screenUV.toVar();
    const previous = uniform(toPrevious).mul(vec4(uv, depth.sample(uv).x, 1));
    // A point behind the previous camera (w ≤ 0) counts as far off: its smear stays finite, then capped.
    const smearPx = uv
      .sub(previous.xy.div(max(previous.w, 1e-6)))
      .mul(screenSize)
      .mul(strength)
      .toVar();
    const lengthPx = length(smearPx).toVar();
    const color = vec4(0).toVar();
    If(lengthPx.lessThan(1), () => {
      color.assign(still(uv));
    }).Else(() => {
      const cappedPx = min(lengthPx, MAX_SMEAR_PX);
      const taps = ceil(cappedPx.div(TAP_SPACING_PX)).toVar();
      const step = smearPx.mul(cappedPx.div(lengthPx)).div(screenSize.mul(taps)).toVar();
      const at = uv.sub(step.mul(taps.sub(1).mul(0.5))).toVar();
      Loop(taps, () => {
        color.addAssign(frame.sample(at).level(float(0)));
        at.addAssign(step);
      });
      color.divAssign(taps);
    });
    return color;
  })();
  const pipeline = new RenderPipeline(renderer, output);
  return {
    render: (view, share) => {
      const moved = motion(view);
      if (!moved) return false;
      strength.value = moved > 1 ? share : 0;
      pipeline.render();
      return true;
    },
    dispose: () => pipeline.dispose(),
  };
}
