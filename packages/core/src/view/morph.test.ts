import { describe, expect, it } from 'vitest';
import { geodeticToEcef } from '../geodesy/ecef.js';
import { WEB_MERCATOR_MAX_LATITUDE_RAD } from '../projections/web-mercator.js';
import { cappedMercatorInto, MorphFrame, morphPointInto } from './morph.js';

const DEG = Math.PI / 180;

function frameAt(lonDeg: number, latDeg: number, morph: number, relief = 1): MorphFrame {
  const frame = new MorphFrame();
  frame.update(Float64Array.of(lonDeg * DEG, latDeg * DEG), Float64Array.of(morph, relief));
  return frame;
}

function morphed(frame: MorphFrame, lonDeg: number, latDeg: number, heightMeters = 0): Float64Array {
  const out = new Float64Array(3);
  morphPointInto(frame, Float64Array.of(lonDeg * DEG, latDeg * DEG, heightMeters), out);
  return out;
}

const distance = (a: Float64Array, b: Float64Array): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

/** The component of `p − anchor` along the anchor's up axis. */
function upOf(frame: MorphFrame, p: Float64Array): number {
  let up = 0;
  for (let i = 0; i < 3; i++) up += ((p[i] ?? 0) - (frame.anchorEcef[i] ?? 0)) * (frame.axes[6 + i] ?? 0);
  return up;
}

describe('globe-to-flat morph (ADR 0008)', () => {
  it('is the globe at m = 0 and keeps the anchor fixed at every m', () => {
    const globe = frameAt(10, 45, 0, 0.5);
    const expected = new Float64Array(3);
    geodeticToEcef(12 * DEG, 47 * DEG, 0.5 * 800, expected);
    expect(distance(morphed(globe, 12, 47, 800), expected)).toBeLessThan(1e-6);
    for (const m of [0, 0.3, 1]) {
      const frame = frameAt(10, 45, m);
      expect(distance(morphed(frame, 10, 45), frame.anchorEcef)).toBeLessThan(1e-6);
    }
  });

  it('lays the map on the anchor tangent plane, true to scale at the anchor', () => {
    const flat = frameAt(10, 45, 1);
    // Points a few hundred kilometers away all lie in the plane.
    for (const [lon, lat] of [
      [14, 45],
      [10, 49],
      [6, 41],
    ])
      expect(Math.abs(upOf(flat, morphed(flat, lon ?? 0, lat ?? 0)))).toBeLessThan(1e-6);
    // 0.01° of longitude at 45° is 788.47 m along the parallel (N·cos φ·Δλ); Web Mercator stretches north by N / M (0.34% here),
    // as EPSG:3857 is conformal on the sphere, not on the ellipsoid.
    expect(distance(morphed(flat, 10.005, 45), morphed(flat, 9.995, 45))).toBeCloseTo(788.47, 2);
    expect(distance(morphed(flat, 10, 45.005), morphed(flat, 10, 44.995)) / 1111.33).toBeCloseTo(1.0034, 3);
  });

  it('scales relief by the projection scale factor, so a feature keeps its proportions at every latitude (F157)', () => {
    const flat = frameAt(10, 45, 1);
    for (const lat of [0, 45, 70]) {
      // A 1,000 m column next to a ground step of 1 km east (both at latitude `lat`).
      const base = morphed(flat, 10, lat);
      const top = morphed(flat, 10, lat, 1000);
      const eastDeg =
        1000 / ((6378137 * Math.cos(lat * DEG)) / Math.sqrt(1 - 0.00669437999014 * Math.sin(lat * DEG) ** 2)) / DEG;
      const east = morphed(flat, 10 + eastDeg, lat);
      expect(distance(top, base) / distance(east, base)).toBeCloseTo(1, 3);
    }
  });

  it('interpolates the vertical scale continuously from the ellipsoid to the plane during the morph (F157)', () => {
    // A 1,000 m column at 70° seen from an anchor at 45°: 1,000 m on the globe, σ·k(70°) × 1,000 m on the plane.
    const k = (latDeg: number): number =>
      Math.sqrt(1 - 0.00669437999014 * Math.sin(latDeg * DEG) ** 2) / Math.cos(latDeg * DEG);
    const planeScale = k(70) / k(45);
    let previous = 1;
    for (let step = 0; step <= 100; step++) {
      const frame = frameAt(10, 45, step / 100);
      const scale = distance(morphed(frame, 10, 70, 1000), morphed(frame, 10, 70)) / 1000;
      expect(Math.abs(scale - previous)).toBeLessThan(0.02 * (planeScale - 1));
      previous = scale;
    }
    expect(previous).toBeCloseTo(planeScale, 6);
  });

  it('places points across the antimeridian at the world copy next to the anchor', () => {
    const flat = frameAt(179, 0, 1);
    const across = morphed(flat, -179, 0);
    // 2° of longitude east of the anchor, not 358° west.
    expect(distance(across, flat.anchorEcef)).toBeCloseTo(2 * DEG * 6378137, -2);
  });

  it('continues Web Mercator beyond its latitude limit with the same value and slope (F160)', () => {
    const out = new Float64Array(2);
    const y = (latRad: number): number => {
      cappedMercatorInto(Float64Array.of(0, latRad), out);
      return out[1] ?? NaN;
    };
    const limit = WEB_MERCATOR_MAX_LATITUDE_RAD;
    const h = 1e-7;
    expect(y(limit + h) - y(limit)).toBeCloseTo(y(limit) - y(limit - h), 3);
    expect(y(Math.PI / 2)).toBeGreaterThan(y(limit));
    expect(y(-Math.PI / 2)).toBeCloseTo(-y(Math.PI / 2), 6);
  });
});
