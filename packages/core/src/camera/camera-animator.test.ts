import { describe, expect, it } from 'vitest';
import { Camera } from './camera.js';
import { CameraAnimator } from './camera-animator.js';

const DEG = Math.PI / 180;

function cameraAt(lonDeg: number, latDeg: number, rangeMeters: number, headingDeg = 0, tiltDeg = 0): Camera {
  const camera = new Camera();
  camera.widthPx = 800;
  camera.heightPx = 600;
  Object.assign(camera.pose, {
    targetLongitudeRad: lonDeg * DEG,
    targetLatitudeRad: latDeg * DEG,
    rangeMeters,
    headingRad: headingDeg * DEG,
    tiltRad: tiltDeg * DEG,
  });
  camera.update();
  return camera;
}

function target(lonDeg: number, latDeg: number, rangeMeters: number, headingDeg: number, tiltDeg = NaN): Float64Array {
  return Float64Array.of(lonDeg * DEG, latDeg * DEG, rangeMeters, headingDeg * DEG, tiltDeg * DEG);
}

/** The pose at engine time `ms`, and whether the movement has ended. */
function at(animator: CameraAnimator, camera: Camera, ms: number): { done: boolean; tiltDeg: number } {
  const io = Float64Array.of(ms, 0);
  const done = animator.step(camera, io);
  return { done, tiltDeg: (io[1] ?? NaN) / DEG };
}

describe('camera animations (F195, F198, F203)', () => {
  it('ends exactly at the target, for both kinds', () => {
    for (const kind of ['ease', 'fly'] as const) {
      const camera = cameraAt(9.19, 45.46, 2000, 10, 20);
      const animator = new CameraAnimator(kind, camera, target(139.69, 35.68, 3000, 300, 50), 1000, undefined);
      expect(at(animator, camera, 1000 + animator.durationMs / 2).done).toBe(false);
      const end = at(animator, camera, 1000 + animator.durationMs + 5);
      expect(end.done).toBe(true);
      expect(camera.pose.targetLongitudeRad / DEG).toBeCloseTo(139.69, 12);
      expect(camera.pose.targetLatitudeRad / DEG).toBeCloseTo(35.68, 12);
      expect(camera.pose.rangeMeters).toBeCloseTo(3000, 9);
      expect(camera.pose.headingRad / DEG).toBeCloseTo(300, 9);
      expect(end.tiltDeg).toBeCloseTo(50, 9);
    }
  });

  it('follows the same trajectory whatever the frame rate, a function of time alone (F203)', () => {
    const poseAt2s = (stepMs: number): number[] => {
      const camera = cameraAt(9.19, 45.46, 2000);
      const animator = new CameraAnimator('fly', camera, target(139.69, 35.68, 2000, 0), 0, 4000);
      for (let ms = 0; ms < 2000; ms += stepMs) at(animator, camera, ms);
      at(animator, camera, 2000);
      return [camera.pose.targetLongitudeRad, camera.pose.targetLatitudeRad, camera.pose.rangeMeters];
    };
    // 144 Hz, 30 Hz and one stalled frame reach the same pose at the same time.
    expect(poseAt2s(1000 / 144)).toEqual(poseAt2s(1000 / 30));
    expect(poseAt2s(2000)).toEqual(poseAt2s(1000 / 30));
  });

  it('flies between antipodal points along a great circle, without a jump at mid-path (KB-128)', () => {
    const camera = cameraAt(0, 0, 2000);
    const animator = new CameraAnimator('fly', camera, target(180, 0, 2000, 0), 0, 4000);
    let last = { lon: 0, lat: 0 };
    for (let ms = 5; ms <= 4000; ms += 5) {
      at(animator, camera, ms);
      const now = { lon: camera.pose.targetLongitudeRad / DEG, lat: camera.pose.targetLatitudeRad / DEG };
      // The great-circle angle between consecutive targets: the fast middle of a flight moves far, a jump 180°.
      const cosAngle =
        Math.sin(now.lat * DEG) * Math.sin(last.lat * DEG) +
        Math.cos(now.lat * DEG) * Math.cos(last.lat * DEG) * Math.cos((now.lon - last.lon) * DEG);
      expect(Math.acos(Math.min(1, cosAngle)) / DEG).toBeLessThan(20);
      last = now;
    }
    expect(Math.abs(camera.pose.targetLongitudeRad / DEG)).toBeCloseTo(180, 9);
  });

  it('flies high between distant places and lands at street scale (F195, F196)', () => {
    const camera = cameraAt(9.19, 45.46, 2000);
    const animator = new CameraAnimator('fly', camera, target(139.69, 35.68, 2000, 0), 0, undefined);
    at(animator, camera, animator.durationMs / 2);
    // Halfway, the whole of Eurasia is in view: thousands of kilometers up.
    expect(camera.pose.rangeMeters).toBeGreaterThan(3e6);
    // A long flight lasts a few seconds, never forever.
    expect(animator.durationMs).toBeGreaterThan(2000);
    expect(animator.durationMs).toBeLessThanOrEqual(8000);
  });

  it('eases the range geometrically, turns the shorter way and crosses the antimeridian the short way (F198)', () => {
    const camera = cameraAt(179, 0, 1000, 350);
    const animator = new CameraAnimator('ease', camera, target(-179, 0, 4000, 10), 0, 1000);
    at(animator, camera, 500);
    expect(camera.pose.rangeMeters).toBeCloseTo(2000, 6);
    // Halfway from 350° to 10° through north, and across 180° rather than round the world.
    expect((((camera.pose.headingRad / DEG) % 360) + 360) % 360).toBeCloseTo(0, 6);
    expect(Math.abs(camera.pose.targetLongitudeRad / DEG)).toBeCloseTo(180, 6);
  });

  it('keeps the tilt when the target gives none', () => {
    const camera = cameraAt(9, 45, 2000, 0, 35);
    const animator = new CameraAnimator('ease', camera, target(10, 45, 2000, 0), 0, 1000);
    expect(animator.animatesTilt).toBe(false);
    expect(at(animator, camera, 500).tiltDeg).toBeCloseTo(35, 9);
  });

  it('honors the duration, speed, curve and easing options (F195)', () => {
    const start = (): Camera => cameraAt(9.19, 45.46, 2000);
    const end = target(139.69, 35.68, 2000, 0);
    // A given duration, and the automatic one at twice the speed: half as long.
    expect(new CameraAnimator('fly', start(), end, 0, 2500).durationMs).toBe(2500);
    const normal = new CameraAnimator('fly', start(), target(10.5, 45.9, 2000, 0), 0, undefined).durationMs;
    const fast = new CameraAnimator('fly', start(), target(10.5, 45.9, 2000, 0), 0, undefined, { speed: 2.4 })
      .durationMs;
    expect(fast).toBeCloseTo(normal / 2, 6);
    // A larger curve rises higher halfway.
    const rangeHalfway = (curve: number): number => {
      const camera = start();
      const animator = new CameraAnimator('fly', camera, end, 0, 1000, { curve });
      at(animator, camera, 500);
      return camera.pose.rangeMeters;
    };
    expect(rangeHalfway(2.5)).toBeGreaterThan(rangeHalfway(1));
    // Linear easing: an ease is halfway (geometrically in range) at half the time; a custom curve is followed.
    for (const [easing, share] of [
      ['linear', 0.5],
      [(t: number) => t * t, 0.25],
    ] as const) {
      const camera = cameraAt(0, 0, 1000);
      const animator = new CameraAnimator('ease', camera, target(0, 0, 16_000, 0), 0, 1000, { easing });
      at(animator, camera, 500);
      expect(Math.log(camera.pose.rangeMeters / 1000) / Math.log(16)).toBeCloseTo(share, 9);
    }
  });
});
