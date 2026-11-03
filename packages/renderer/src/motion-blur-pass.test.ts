import type { FrameView } from '@vibeglobe/core';
import { Matrix4, Vector4 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { cameraMotion } from './motion-blur-pass.js';

const NEAR = 0.1;
/** The engine's reversed-Z infinite projection (ADR 0005), column-major. */
const PROJECTION = new Float64Array([1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, -1, 0, 0, NEAR, 0]);

/** A view from `eye` turned by `headingRad` about the y axis. */
const viewOf = (eye: readonly number[], headingRad: number): FrameView =>
  ({
    view: new Float64Array(new Matrix4().makeRotationY(headingRad).toArray()),
    projection: PROJECTION,
    eyeEcef: new Float64Array(eye),
  }) as unknown as FrameView;

/** Where `view` shows the point `p` (w 0 for a direction): u, v from the top left, and the depth near / d. */
function screenOf(view: FrameView, p: readonly number[]): Vector4 {
  const [x = 0, y = 0, z = 0, w = 1] = p;
  const [ex = 0, ey = 0, ez = 0] = view.eyeEcef;
  const clip = new Vector4(x - ex * w, y - ey * w, z - ez * w, w)
    .applyMatrix4(new Matrix4().fromArray(view.view))
    .applyMatrix4(new Matrix4().fromArray(view.projection));
  return new Vector4((clip.x / clip.w + 1) / 2, (1 - clip.y / clip.w) / 2, clip.z / clip.w, 1);
}

describe('camera motion (F694)', () => {
  it('blurs only a camera that keeps moving, and carries each pixel to where the previous frame showed it', () => {
    const toPrevious = new Matrix4();
    const motion = cameraMotion(toPrevious);
    const before = viewOf([6.4e6, 1.2e5, -3e5], 0.3);
    const now = viewOf([6.4e6 + 850, 1.2e5 - 40, -3e5 + 120], 0.31);
    const close = viewOf([6.4e6 + 850.5, 1.2e5 - 40, -3e5 + 120.2], 0.31);
    // The first frame, then a still one: no motion to blur. A move after a still frame is a jump: drawn, not smeared.
    expect([motion(before), motion(before), motion(now)]).toEqual([1, 0, 1]);
    const expectReprojected = (from: FrameView, to: FrameView, points: readonly (readonly number[])[]): void => {
      for (const point of points) {
        const previous = screenOf(to, point).applyMatrix4(toPrevious);
        const expected = screenOf(from, point);
        expect(previous.x / previous.w).toBeCloseTo(expected.x, 7);
        expect(previous.y / previous.w).toBeCloseTo(expected.y, 7);
      }
    };
    expectReprojected(before, now, [
      [6.4e6 + 2000, 1.2e5 + 300, -3e5 - 5000, 1],
      [6.4e6 - 400, 1.2e5 - 900, -3e5 - 60_000, 1],
      [0.2, -0.1, -1, 0], // A direction: the sky, at depth 0.
    ]);
    // The camera keeps moving, half a meter over ground 3 m away (the float64 matrices hold the Earth-sized offsets).
    expect(motion(close)).toBe(2);
    expectReprojected(now, close, [[6.4e6 + 851, 1.2e5 - 39.5, -3e5 + 117, 1]]);
    // It stops.
    expect([motion(close), motion(before)]).toEqual([0, 1]);
  });
});
