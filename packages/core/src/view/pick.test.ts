import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { MorphFrame, morphPointInto } from './morph.js';
import { pickMorphedAt } from './pick.js';

const DEG = Math.PI / 180;

function camera(tiltDeg: number, rangeMeters: number): Camera {
  const cam = new Camera();
  cam.pose.targetLongitudeRad = 10 * DEG;
  cam.pose.targetLatitudeRad = 45 * DEG;
  cam.pose.rangeMeters = rangeMeters;
  cam.pose.tiltRad = tiltDeg * DEG;
  cam.pose.headingRad = 30 * DEG;
  cam.widthPx = 800;
  cam.heightPx = 600;
  cam.update();
  return cam;
}

describe('picking the morphed surface (ADR 0008, F158)', () => {
  it('finds the point whose morphed position lies on the pixel ray, at every morph factor', () => {
    for (const m of [0, 0.25, 0.5, 0.75, 1])
      for (const [tilt, range] of [
        [0, 2e6],
        [50, 3e5],
      ] as const) {
        const cam = camera(tilt, range);
        const frame = new MorphFrame();
        frame.update(Float64Array.of(10 * DEG, 45 * DEG), Float64Array.of(m, 1));
        for (const [x, y] of [
          [400, 300],
          [100, 500],
          [700, 420],
        ] as const) {
          const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
          expect(pickMorphedAt(cam, frame, Float64Array.of(x, y), hit)).toBe(true);
          const p = new Float64Array(3);
          morphPointInto(frame, Float64Array.of(hit.longitudeRad, hit.latitudeRad, 0), p);
          const ray = cam.rayDirection(x, y, new Float64Array(3));
          const v = [0, 1, 2].map((i) => (p[i] ?? 0) - (cam.eyeEcef[i] ?? 0));
          const along = v.reduce((sum, value, i) => sum + value * (ray[i] ?? 0), 0);
          const off = Math.hypot(...v.map((value, i) => value - along * (ray[i] ?? 0)));
          expect(along).toBeGreaterThan(0);
          expect(off).toBeLessThan(1e-3);
        }
        // The screen center shows the anchor at every m.
        const center = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
        pickMorphedAt(cam, frame, Float64Array.of(400, 300), center);
        expect(center.longitudeRad / DEG).toBeCloseTo(10, 7);
        expect(center.latitudeRad / DEG).toBeCloseTo(45, 7);
      }
  });
});
