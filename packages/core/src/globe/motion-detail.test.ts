import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { SLOW_LINK_BPS } from '../scheduler/bandwidth.js';
import { MotionDetail, SLOW_LINK_BPS_HERE } from './motion-detail.js';

/** Steps `motion` over `frames` frames of 16 ms, moving the camera target east by `rangesPerS` view ranges per second. */
function run(
  motion: MotionDetail,
  camera: Camera,
  clock: Float64Array,
  frames: number,
  rangesPerS: number,
  link?: { bitsPerSecond: number },
): number {
  let factor = 1;
  for (let i = 0; i < frames; i++) {
    clock[0] = (clock[0] ?? 0) + 16;
    camera.pose.targetLongitudeRad += (rangesPerS * 0.016 * camera.pose.rangeMeters) / 6_378_137;
    camera.update();
    motion.update(camera, clock, link);
    factor = motion.factor;
  }
  return factor;
}

describe('motion-aware detail (F288, F301)', () => {
  it('keeps full detail at rest, coarsens by whole levels while fast, and refines within half a second of stopping', () => {
    const camera = new Camera();
    camera.pose.rangeMeters = 50_000;
    camera.update();
    const motion = new MotionDetail();
    const clock = new Float64Array(1);
    expect(run(motion, camera, clock, 10, 0)).toBe(1);
    expect(run(motion, camera, clock, 10, 0.1)).toBe(1);
    expect(run(motion, camera, clock, 10, 1)).toBe(2);
    expect(run(motion, camera, clock, 10, 3)).toBe(4);
    expect(run(motion, camera, clock, 31, 0)).toBe(1);
  });

  it('takes a jump as no motion: full detail at once (F085)', () => {
    const camera = new Camera();
    camera.pose.rangeMeters = 50_000;
    camera.update();
    const motion = new MotionDetail();
    const clock = new Float64Array(1);
    run(motion, camera, clock, 5, 0);
    // 20 view ranges east in one frame, announced as a jump.
    motion.jumped();
    expect(run(motion, camera, clock, 1, 20 / 0.016)).toBe(1);
    // The same without the announcement is motion.
    expect(run(motion, camera, clock, 1, 20 / 0.016)).toBe(4);
  });

  it('holds the coarse detail while the camera slows and refines straight to full once still, never in steps (F090)', () => {
    const camera = new Camera();
    camera.pose.rangeMeters = 50_000;
    camera.update();
    const motion = new MotionDetail();
    const clock = new Float64Array(1);
    run(motion, camera, clock, 10, 3);
    const factors: number[] = [];
    for (let i = 0; i < 40; i++) factors.push(run(motion, camera, clock, 1, 0));
    expect(new Set(factors)).toEqual(new Set([4, 1]));
    expect(factors.at(-1)).toBe(1);
  });

  it('takes one level coarser again while moving on a slow link, and none at rest (F301)', () => {
    const camera = new Camera();
    camera.pose.rangeMeters = 50_000;
    camera.update();
    const clock = new Float64Array(1);
    const slow = { bitsPerSecond: 400e3 };
    expect(run(new MotionDetail(), camera, clock, 10, 3, slow)).toBe(8);
    expect(run(new MotionDetail(), camera, clock, 10, 3, { bitsPerSecond: 50e6 })).toBe(4);
    expect(run(new MotionDetail(), camera, clock, 10, 0, slow)).toBe(1);
    // A flight on a slow link is one level coarser from its first, still slow frames.
    const flight = new MotionDetail();
    flight.flying = true;
    expect(run(flight, camera, clock, 10, 0, slow)).toBe(2);
    expect(run(flight, camera, clock, 10, 0, { bitsPerSecond: 50e6 })).toBe(1);
  });

  it("uses the bandwidth estimator's slow-link threshold", () => {
    expect(SLOW_LINK_BPS_HERE).toBe(SLOW_LINK_BPS);
  });
});
