import { describe, expect, it } from 'vitest';
import {
  CURVE_MORPH,
  CURVE_RELIEF,
  CURVE_TILT_RAD,
  DEFAULT_VIEW_CURVES,
  evaluateViewCurves,
  validateViewCurves,
} from './curves.js';

const DEG = Math.PI / 180;

/** The Auto curves at a ground zoom: [morph, relief, tilt in degrees]. */
function at(groundZoom: number, curves = DEFAULT_VIEW_CURVES): [number, number, number] {
  const out = new Float64Array(3);
  evaluateViewCurves(curves, Float64Array.of(groundZoom), out);
  return [out[CURVE_MORPH] ?? NaN, out[CURVE_RELIEF] ?? NaN, (out[CURVE_TILT_RAD] ?? NaN) / DEG];
}

describe('view curves (F548, F150)', () => {
  it('keeps the globe flat and untilted at world scale, a flat 0° map at region and city scale, and tilts only at street scale (F151, F153, F154)', () => {
    for (const z of [0, 2, 4]) expect(at(z)).toEqual([0, 0, 0]);
    for (const z of [6.5, 8, 10]) expect(at(z)).toEqual([1, 0, 0]);
    expect(at(13)[2]).toBe(0);
    const [morph, relief, tilt] = at(17);
    expect([morph, relief]).toEqual([1, 1]);
    expect(tilt).toBeCloseTo(DEFAULT_VIEW_CURVES.autoTiltDeg, 12);
  });

  it('changes every value continuously with zoom, with zero slope at both ends of each band', () => {
    const h = 1e-3;
    let previous = at(0);
    for (let z = h; z <= 20; z += h) {
      const next = at(z);
      // The steepest smootherstep slope is 1.875 / band width; the narrowest band is 2.5 zoom levels.
      for (let i = 0; i < 2; i++)
        expect(Math.abs((next[i] ?? 0) - (previous[i] ?? 0))).toBeLessThan((1.875 / 2.5) * h * 1.01);
      expect(Math.abs((next[2] ?? 0) - (previous[2] ?? 0))).toBeLessThan((1.875 / 2.5) * 50 * h * 1.01);
      previous = next;
    }
    const bands = [DEFAULT_VIEW_CURVES.morph, DEFAULT_VIEW_CURVES.relief, DEFAULT_VIEW_CURVES.tilt];
    bands.forEach((band, i) => {
      for (const edge of [band.startGroundZoom, band.endGroundZoom]) {
        const slope = ((at(edge + 1e-3)[i] ?? 0) - (at(edge - 1e-3)[i] ?? 0)) / 2e-3;
        expect(Math.abs(slope)).toBeLessThan(1e-4);
      }
    });
  });

  it('validates curve options, filling what is missing from the defaults', () => {
    const curves = validateViewCurves({ morph: { endGroundZoom: 7 }, autoTiltDeg: 55 });
    expect(curves.morph).toEqual({ startGroundZoom: 4, endGroundZoom: 7 });
    expect(curves.autoTiltDeg).toBe(55);
    expect(validateViewCurves(undefined)).toBe(DEFAULT_VIEW_CURVES);
    for (const bad of [
      { relief: { startGroundZoom: 12, endGroundZoom: 11 } },
      { morph: { startGroundZoom: Number.NaN } },
      { autoTiltDeg: 70 },
      { autoTiltDeg: 30 },
      // The tilt would start before the map is flat: no 0° band.
      { tilt: { startGroundZoom: 6 } },
    ])
      expect(() => validateViewCurves(bad)).toThrow(expect.objectContaining({ code: 'invalid-option' }));
  });
});
