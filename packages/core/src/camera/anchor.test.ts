import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { geodeticToEcef } from '../geodesy/ecef.js';
import { ANCHOR_NORTH_UP, ANCHOR_TRACKBALL, NORTH_UP_LIMIT_RAD, solveAnchor } from './anchor.js';
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

describe('navigation modes: free and north-up drags', () => {
  /** Drags the point under `from` to `to` in `steps` frames with a solve mode; returns the camera. */
  function drag(c: Camera, from: [number, number], to: [number, number], steps: number, mode: number): boolean[] {
    const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    expect(c.pickEllipsoid(from[0], from[1], hit)).toBe(true);
    const anchor = Float64Array.of(hit.longitudeRad, hit.latitudeRad, 0);
    const solved: boolean[] = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const pixel = Float64Array.of(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
      solved.push(solveAnchor(c, anchor, pixel, undefined, undefined, mode));
    }
    return solved;
  }

  it('free: the grabbed point stays under the cursor over the pole, and the heading turns with the globe', () => {
    const c = camera(0, 80, 8e6);
    const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    // A point beyond the pole, dragged down: the camera moves north, over the pole.
    expect(c.pickEllipsoid(500, 150, hit)).toBe(true);
    const solved = drag(c, [500, 150], [500, 700], 30, ANCHOR_TRACKBALL);
    expect(solved.every(Boolean)).toBe(true);
    const [x, y] = screenOf(c, hit.longitudeRad / DEG, hit.latitudeRad / DEG);
    expect(Math.hypot(x - 500, y - 700)).toBeLessThan(0.05);
    // The view went over the pole: the target is on the far side and the heading turned to about south.
    expect(Math.abs(c.pose.targetLongitudeRad / DEG)).toBeGreaterThan(170);
    expect(Math.abs(c.pose.headingRad / DEG)).toBeGreaterThan(170);
  });

  it('free: a diagonal drag on the globe turns the heading', () => {
    const c = camera(10, 45, 1e7);
    drag(c, [300, 300], [700, 500], 10, ANCHOR_TRACKBALL);
    expect(Math.abs(c.pose.headingRad / DEG)).toBeGreaterThan(1);
  });

  it('north-up: horizontal drags turn about the polar axis and vertical ones change latitude, heading held', () => {
    const c = camera(10, 45, 1e7);
    drag(c, [300, 400], [700, 400], 10, ANCHOR_NORTH_UP);
    expect(c.pose.headingRad).toBe(0);
    expect(c.pose.targetLongitudeRad / DEG).toBeLessThan(10);
    expect(c.pose.targetLatitudeRad / DEG).toBeCloseTo(45, 0);
    const longitude = c.pose.targetLongitudeRad;
    drag(c, [500, 300], [500, 500], 10, ANCHOR_NORTH_UP);
    expect(c.pose.headingRad).toBe(0);
    expect(c.pose.targetLongitudeRad).toBeCloseTo(longitude, 9);
    expect(c.pose.targetLatitudeRad / DEG).toBeGreaterThan(45);
  });

  it('north-up: dragging over the pole stops the camera there, without a jump or a flip', () => {
    for (const latitude of [80, -80]) {
      const c = camera(30, latitude, 8e6);
      // Toward the pole: a point poleward of the target dragged away from it.
      const from: [number, number] = latitude > 0 ? [500, 150] : [500, 650];
      const to: [number, number] = latitude > 0 ? [500, 750] : [500, 50];
      const latitudes: number[] = [];
      const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
      expect(c.pickEllipsoid(from[0], from[1], hit)).toBe(true);
      const anchor = Float64Array.of(hit.longitudeRad, hit.latitudeRad, 0);
      for (let i = 1; i <= 40; i++) {
        const t = i / 40;
        const pixel = Float64Array.of(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
        solveAnchor(c, anchor, pixel, undefined, undefined, ANCHOR_NORTH_UP);
        latitudes.push(c.pose.targetLatitudeRad);
        expect(c.pose.headingRad).toBe(0);
        expect(c.pose.targetLongitudeRad / DEG).toBeCloseTo(30, 6);
      }
      // Monotonic toward the pole, ending at the limit: no flip back, no step larger than the drag's.
      const sign = Math.sign(latitude);
      expect(latitudes.every((value, i) => i === 0 || sign * (value - (latitudes[i - 1] ?? 0)) >= -1e-12)).toBe(true);
      expect(Math.abs(latitudes.at(-1) ?? 0)).toBeCloseTo(NORTH_UP_LIMIT_RAD, 12);
    }
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

/** A camera at a random pose, tilt included (ADR 0009: the anchor solver's verification covers tilt). */
function tiltedCamera(lon: number, lat: number, range: number, heading: number, tiltDeg: number): Camera {
  const c = camera(lon, lat, range, heading);
  c.pose.tiltRad = tiltDeg * DEG;
  c.update();
  return c;
}

const pose = fc.tuple(
  fc.double({ min: -180, max: 180, noNaN: true }),
  fc.oneof(
    fc.double({ min: -89.9, max: 89.9, noNaN: true }),
    fc.double({ min: 80, max: 89.9, noNaN: true }),
    fc.double({ min: -89.9, max: -80, noNaN: true }),
  ),
  fc.double({ min: 0, max: 7, noNaN: true }).map((exponent) => 10 ** exponent),
  fc.double({ min: 0, max: 360, noNaN: true }),
  fc.oneof(fc.constant(0), fc.double({ min: 0, max: 60, noNaN: true })),
);

describe('solveAnchor drift (ADR 0009: at most 0.01 px)', () => {
  test.prop([
    pose,
    fc.tuple(fc.integer({ min: 200, max: 800 }), fc.integer({ min: 200, max: 600 })),
    fc.tuple(fc.double({ min: -40, max: 40, noNaN: true }), fc.double({ min: -40, max: 40, noNaN: true })),
  ])('pan: a drag step keeps the grabbed point under the pointer', ([lon, lat, range, heading, tilt], from, step) => {
    const c = tiltedCamera(lon, lat, range, heading, tilt);
    const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    if (!c.pickEllipsoid(from[0], from[1], hit)) return;
    const to = [from[0] + step[0], from[1] + step[1]] as const;
    if (!solveAnchor(c, Float64Array.of(hit.longitudeRad, hit.latitudeRad, 0), Float64Array.of(...to))) return;
    const [x, y] = screenOf(c, hit.longitudeRad / DEG, hit.latitudeRad / DEG);
    expect(Math.hypot(x - to[0], y - to[1])).toBeLessThanOrEqual(0.01);
  });

  test.prop([
    pose,
    fc.tuple(fc.integer({ min: 200, max: 800 }), fc.integer({ min: 200, max: 600 })),
    fc.double({ min: -0.5, max: 0.5, noNaN: true }),
  ])('zoom-at: a wheel step keeps the point under the cursor', ([lon, lat, range, heading, tilt], at, levels) => {
    const c = tiltedCamera(lon, lat, range, heading, tilt);
    const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    if (!c.pickEllipsoid(at[0], at[1], hit)) return;
    c.pose.rangeMeters = Math.max(1, c.pose.rangeMeters * 2 ** -levels);
    if (!solveAnchor(c, Float64Array.of(hit.longitudeRad, hit.latitudeRad, 0), Float64Array.of(...at))) return;
    const [x, y] = screenOf(c, hit.longitudeRad / DEG, hit.latitudeRad / DEG);
    expect(Math.hypot(x - at[0], y - at[1])).toBeLessThanOrEqual(0.01);
  });

  it('solves nearly every realistic drag step, poles and antimeridian included', () => {
    let tried = 0;
    let solved = 0;
    const samples = fc.sample(
      fc.tuple(
        pose,
        fc.tuple(fc.integer({ min: 200, max: 800 }), fc.integer({ min: 200, max: 600 })),
        fc.tuple(fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true })),
      ),
      { numRuns: 2000, seed: 42 },
    );
    for (const [[lon, lat, range, heading, tilt], from, step] of samples) {
      const c = tiltedCamera(lon, lat, range, heading, tilt);
      const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
      if (!c.pickEllipsoid(from[0], from[1], hit)) continue;
      // Only steps whose target pixel still shows the globe can be solved.
      const probe = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
      if (!c.pickEllipsoid(from[0] + step[0], from[1] + step[1], probe)) continue;
      tried++;
      const target = Float64Array.of(from[0] + step[0], from[1] + step[1]);
      if (solveAnchor(c, Float64Array.of(hit.longitudeRad, hit.latitudeRad, 0), target)) solved++;
    }
    expect(tried).toBeGreaterThan(1000);
    expect(solved / tried).toBeGreaterThanOrEqual(0.99);
  });
});
