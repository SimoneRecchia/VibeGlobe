import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { geodeticToEcef } from '../geodesy/ecef.js';
import { solveAnchor } from './anchor.js';
import { Camera } from './camera.js';
import { projectToScreen } from './projection.js';

const DEG = Math.PI / 180;

function camera(lonDeg: number, latDeg: number, range: number, headingDeg = 0): Camera {
  const c = new Camera();
  c.widthPx = 1000;
  c.heightPx = 800;
  Object.assign(c.pose, {
    targetLongitudeRad: lonDeg * DEG,
    targetLatitudeRad: latDeg * DEG,
    rangeMeters: range,
    headingRad: headingDeg * DEG,
  });
  c.update();
  return c;
}

function screenOf(c: Camera, lonDeg: number, latDeg: number): [number, number] {
  const ecef = new Float64Array(3);
  geodeticToEcef(lonDeg * DEG, latDeg * DEG, 0, ecef);
  const out = new Float64Array(2);
  projectToScreen(c, ecef, out);
  return [out[0] ?? NaN, out[1] ?? NaN];
}

describe('solveAnchor', () => {
  it.each([
    ['orbit', 10, 45, 1e7],
    ['street level', 9.19, 45.46, 50],
    ['1 m', -73.98, 40.75, 1],
  ])('moves a grabbed point under a new pixel and holds the heading (%s)', (_, lon, lat, range) => {
    const c = camera(lon, lat, range, 25);
    const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    expect(c.pickEllipsoid(400, 300, hit)).toBe(true);
    expect(solveAnchor(c, Float64Array.of(hit.longitudeRad, hit.latitudeRad, 0), Float64Array.of(600, 420))).toBe(true);
    const [x, y] = screenOf(c, hit.longitudeRad / DEG, hit.latitudeRad / DEG);
    expect(Math.hypot(x - 600, y - 420)).toBeLessThan(0.05);
    expect(c.pose.headingRad).toBeCloseTo(25 * DEG, 12);
  });

  it('crosses a pole by rotating the camera when the heading-held solve is singular', () => {
    const c = camera(0, 88, 3e6);
    const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    expect(c.pickEllipsoid(500, 700, hit)).toBe(true);
    expect(solveAnchor(c, Float64Array.of(hit.longitudeRad, hit.latitudeRad, 0), Float64Array.of(500, 50))).toBe(true);
    const [x, y] = screenOf(c, hit.longitudeRad / DEG, hit.latitudeRad / DEG);
    expect(Math.hypot(x - 500, y - 50)).toBeLessThan(1);
  });
});

describe('solveAnchor properties (F046)', () => {
  test.prop([
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.oneof(fc.double({ min: -89.9, max: 89.9, noNaN: true }), fc.double({ min: 80, max: 89.9, noNaN: true })),
    fc.double({ min: 2, max: 7, noNaN: true }).map((exponent) => 10 ** exponent),
    fc.double({ min: 0, max: 360, noNaN: true }),
    fc.tuple(fc.integer({ min: 50, max: 950 }), fc.integer({ min: 50, max: 750 })),
    fc.tuple(fc.integer({ min: 50, max: 950 }), fc.integer({ min: 50, max: 750 })),
  ])('never reports success without bringing the anchor to the pixel', (lon, lat, range, heading, from, to) => {
    const c = camera(lon, lat, range, heading);
    const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    if (!c.pickEllipsoid(from[0], from[1], hit)) return;
    const solved = solveAnchor(c, Float64Array.of(hit.longitudeRad, hit.latitudeRad, 0), Float64Array.of(...to));
    if (!solved) return;
    const [x, y] = screenOf(c, hit.longitudeRad / DEG, hit.latitudeRad / DEG);
    expect(Math.hypot(x - to[0], y - to[1])).toBeLessThan(0.5);
  });
});
