import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { GEOD_F } from './geodesic-series.js';
import { astroidRoot, initialAzimuth } from './geodesic-start.js';

describe('starting azimuth of the inverse problem', () => {
  test.prop([fc.double({ min: -20, max: 0, noNaN: true }), fc.double({ min: -20, max: -1e-9, noNaN: true })])(
    'solves the astroid equation x²/(1+μ)² + y²/μ² = 1 for its positive root',
    (x, y) => {
      const mu = astroidRoot(x, y);
      expect(mu).toBeGreaterThan(0);
      expect(Math.abs((x * x) / (1 + mu) ** 2 + (y * y) / (mu * mu) - 1)).toBeLessThan(1e-12);
    },
  );

  it('returns a unit azimuth vector with sin α1 > 0', () => {
    const out = new Float64Array(2);
    const cases: [number, number, number][] = [
      [-30, 20, 40],
      [-10, 10, 179.9],
      [-0.0001, 0, 179.95],
      [-45, 44.999, 179.5],
      [0, 0, 179.8],
    ];
    for (const [lat1Deg, lat2Deg, lon12Deg] of cases) {
      const beta1 = Math.atan((1 - GEOD_F) * Math.tan((lat1Deg * Math.PI) / 180));
      const beta2 = Math.atan((1 - GEOD_F) * Math.tan((lat2Deg * Math.PI) / 180));
      initialAzimuth(Math.sin(beta1), Math.cos(beta1), Math.sin(beta2), Math.cos(beta2), lon12Deg, out);
      expect(Math.hypot(out[0] ?? NaN, out[1] ?? NaN)).toBeCloseTo(1, 14);
      expect(out[0]).toBeGreaterThan(0);
    }
  });

  it('starts nearly antipodal points on opposite latitudes beyond the cusp at α1 = 90°', () => {
    const out = new Float64Array(2);
    const beta = (-20 * Math.PI) / 180;
    // λ12 well short of 180° by more than f π cos β1: x < -1, the geodesic runs between vertices.
    initialAzimuth(Math.sin(beta), Math.cos(beta), -Math.sin(beta), Math.cos(beta), 179.3, out);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(0);
  });
});
