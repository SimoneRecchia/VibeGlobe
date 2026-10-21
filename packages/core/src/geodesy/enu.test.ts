import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  enuFrame,
  enuFrameDeg,
  headingPitchRollToRotationDeg,
  headingPitchRollToRotationRad,
  rotationToHeadingPitchRollDeg,
  rotationToHeadingPitchRollRad,
} from './enu.js';
import { WGS84 } from './wgs84.js';

type Vec3 = [number, number, number];

const HALF_PI = Math.PI / 2;
const DEG = Math.PI / 180;

function column(m: Float64Array, index: number): Vec3 {
  return [m[3 * index] ?? Number.NaN, m[3 * index + 1] ?? Number.NaN, m[3 * index + 2] ?? Number.NaN];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function frameAt(lonRad: number, latRad: number): Float64Array {
  return enuFrame(lonRad, latRad, new Float64Array(9));
}

function expectVector(actual: Vec3, expected: Vec3, tolerance = 1e-15): void {
  expect(distance(actual, expected)).toBeLessThanOrEqual(tolerance);
}

/** Largest deviation of the three columns from an orthonormal, right-handed basis (c0 × c1 = c2). */
function orthonormalityError(m: Float64Array): number {
  const [a, b, c] = [column(m, 0), column(m, 1), column(m, 2)];
  return Math.max(
    Math.abs(dot(a, a) - 1),
    Math.abs(dot(b, b) - 1),
    Math.abs(dot(c, c) - 1),
    Math.abs(dot(a, b)),
    Math.abs(dot(a, c)),
    Math.abs(dot(b, c)),
    distance(cross(a, b), c),
  );
}

/** Smallest absolute difference between two angles, in radians. */
function angleDifference(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

describe('enuFrame reference axes', () => {
  it('points east along +Y, north along +Z and up along +X at the equator on the prime meridian', () => {
    const frame = frameAt(0, 0);
    expectVector(column(frame, 0), [0, 1, 0]);
    expectVector(column(frame, 1), [0, 0, 1]);
    expectVector(column(frame, 2), [1, 0, 0]);
  });

  it('points east along -X and up along +Y at 90°E on the equator', () => {
    const frame = enuFrameDeg(90, 0);
    expectVector(column(frame, 0), [-1, 0, 0]);
    expectVector(column(frame, 1), [0, 0, 1]);
    expectVector(column(frame, 2), [0, 1, 0]);
  });

  it('stays defined at the poles, with east chosen by longitude', () => {
    const north = frameAt(0, HALF_PI);
    expectVector(column(north, 0), [0, 1, 0]);
    expectVector(column(north, 1), [-1, 0, 0]);
    expectVector(column(north, 2), [0, 0, 1]);
    const south = frameAt(0, -HALF_PI);
    expectVector(column(south, 0), [0, 1, 0]);
    expectVector(column(south, 1), [1, 0, 0]);
    expectVector(column(south, 2), [0, 0, -1]);
    const northAt90E = enuFrameDeg(90, 90);
    expectVector(column(northAt90E, 0), [-1, 0, 0]);
    expectVector(column(northAt90E, 1), [0, -1, 0]);
  });

  it('clamps latitudes beyond the poles', () => {
    expect(Array.from(frameAt(0.3, 2))).toEqual(Array.from(frameAt(0.3, HALF_PI)));
    expect(Array.from(frameAt(0.3, Number.NEGATIVE_INFINITY))).toEqual(Array.from(frameAt(0.3, -HALF_PI)));
  });

  it('uses the WGS84 ellipsoid normal as up', () => {
    const a = WGS84.semiMajorAxisMeters;
    const b = WGS84.semiMinorAxisMeters;
    const e2 = WGS84.firstEccentricitySquared;
    for (const [lonDeg, latDeg] of [
      [10, 45],
      [-120, -33],
      [170, 80],
    ] as const) {
      const [lon, lat] = [lonDeg * DEG, latDeg * DEG];
      const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
      const p: Vec3 = [
        n * Math.cos(lat) * Math.cos(lon),
        n * Math.cos(lat) * Math.sin(lon),
        n * (1 - e2) * Math.sin(lat),
      ];
      // The gradient of x²/a² + y²/a² + z²/b² is normal to the ellipsoid surface at p.
      const gradient: Vec3 = [p[0] / a ** 2, p[1] / a ** 2, p[2] / b ** 2];
      const length = Math.hypot(...gradient);
      expectVector(
        column(frameAt(lon, lat), 2),
        [gradient[0] / length, gradient[1] / length, gradient[2] / length],
        1e-14,
      );
    }
  });
});

describe('heading, pitch and roll reference orientations', () => {
  it('is the ENU frame itself at zero angles', () => {
    const rotation = headingPitchRollToRotationDeg(30, 40, { headingDeg: 0, pitchDeg: 0, rollDeg: 0 });
    const frame = enuFrameDeg(30, 40);
    for (let i = 0; i < 9; i++) expect(Math.abs((rotation[i] ?? 0) - (frame[i] ?? 0))).toBeLessThanOrEqual(1e-16);
    const read = rotationToHeadingPitchRollDeg(30, 40, frame);
    expect(Math.abs(read.headingDeg)).toBeLessThanOrEqual(1e-13);
    expect(Math.abs(read.pitchDeg)).toBeLessThanOrEqual(1e-13);
    expect(Math.abs(read.rollDeg)).toBeLessThanOrEqual(1e-13);
  });

  it('turns clockwise from north, pitches up and rolls the right wing down', () => {
    const at = (headingDeg: number, pitchDeg: number, rollDeg: number): Float64Array =>
      headingPitchRollToRotationDeg(0, 0, { headingDeg, pitchDeg, rollDeg });
    // At (0°, 0°): east = +Y, north = +Z, up = +X in ECEF.
    expectVector(column(at(90, 0, 0), 1), [0, 1, 0]);
    expectVector(column(at(90, 0, 0), 0), [0, 0, -1]);
    expectVector(column(at(0, 90, 0), 1), [1, 0, 0]);
    expectVector(column(at(0, 90, 0), 2), [0, 0, -1]);
    expectVector(column(at(0, 0, 90), 0), [-1, 0, 0]);
    expectVector(column(at(0, 0, 90), 2), [0, 1, 0]);
  });

  it('reads back a known orientation in degrees', () => {
    const hpr = { headingDeg: 250, pitchDeg: -35, rollDeg: 12 };
    const read = rotationToHeadingPitchRollDeg(-75, 61, headingPitchRollToRotationDeg(-75, 61, hpr));
    expect(read.headingDeg).toBeCloseTo(250, 10);
    expect(read.pitchDeg).toBeCloseTo(-35, 10);
    expect(read.rollDeg).toBeCloseTo(12, 10);
  });

  it('takes the heading from the right axis in gimbal lock', () => {
    const rotation = headingPitchRollToRotationRad(1, 0.5, 30 * DEG, HALF_PI, 0, new Float64Array(9));
    const read = rotationToHeadingPitchRollRad(1, 0.5, rotation, new Float64Array(3));
    expect(Math.abs((read[0] ?? 0) - 30 * DEG)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs((read[1] ?? 0) - HALF_PI)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(read[2] ?? 1)).toBeLessThanOrEqual(1e-12);
  });
});

const longitude = fc.double({ min: -10, max: 10, noNaN: true });
const latitude = fc.oneof(
  fc.constantFrom(HALF_PI, -HALF_PI),
  fc.double({ min: -HALF_PI, max: HALF_PI, noNaN: true }),
  fc.double({ min: HALF_PI - 1e-3, max: HALF_PI, noNaN: true }),
  fc.double({ min: -HALF_PI, max: -HALF_PI + 1e-3, noNaN: true }),
);
const heading = fc.double({ min: 0, max: 2 * Math.PI, maxExcluded: true, noNaN: true });
const pitch = fc.oneof(fc.constantFrom(HALF_PI, -HALF_PI), fc.double({ min: -HALF_PI, max: HALF_PI, noNaN: true }));
const roll = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });

describe('enuFrame properties', () => {
  // Every component is one product of correctly rounded sines and cosines: measured error 4.4e-16.
  test.prop([fc.double({ noNaN: true, noDefaultInfinity: true }), fc.oneof(latitude, fc.double({ noNaN: true }))])(
    'is orthonormal and right-handed everywhere, the poles and out-of-range latitudes included',
    (lonRad, latRad) => {
      expect(orthonormalityError(frameAt(lonRad, latRad))).toBeLessThanOrEqual(2e-15);
    },
  );

  // |∂axis/∂λ| ≤ 1 and |∂axis/∂φ| ≤ 1 for every axis, so each axis moves at most |Δλ| + |Δφ|.
  const step = fc.double({ min: -1e-3, max: 1e-3, noNaN: true });
  test.prop([longitude, latitude, step, step])('moves continuously, near the poles too', (lon, lat, dLon, dLat) => {
    const a = frameAt(lon, lat);
    const b = frameAt(lon + dLon, Math.min(Math.max(lat + dLat, -HALF_PI), HALF_PI));
    for (let i = 0; i < 3; i++)
      expect(distance(column(a, i), column(b, i))).toBeLessThanOrEqual(Math.abs(dLon) + Math.abs(dLat) + 1e-15);
  });

  const nearAntimeridian = fc.double({ min: 0, max: 0.01, noNaN: true });
  test.prop([nearAntimeridian, nearAntimeridian, latitude])(
    'is continuous across the antimeridian',
    (westOfAntimeridianRad, eastOfAntimeridianRad, lat) => {
      const a = frameAt(Math.PI - westOfAntimeridianRad, lat);
      const b = frameAt(-Math.PI + eastOfAntimeridianRad, lat);
      const bound = westOfAntimeridianRad + eastOfAntimeridianRad + 1e-15;
      for (let i = 0; i < 3; i++) expect(distance(column(a, i), column(b, i))).toBeLessThanOrEqual(bound);
    },
  );
});

describe('heading, pitch and roll properties', () => {
  test.prop([longitude, latitude, heading, pitch, roll])(
    'builds a rotation and reads back angles that rebuild it, gimbal lock included',
    (lon, lat, h, p, r) => {
      const rotation = headingPitchRollToRotationRad(lon, lat, h, p, r, new Float64Array(9));
      expect(orthonormalityError(rotation)).toBeLessThanOrEqual(5e-15);
      const angles = rotationToHeadingPitchRollRad(lon, lat, rotation, new Float64Array(3));
      const [h2, p2, r2] = [angles[0] ?? Number.NaN, angles[1] ?? Number.NaN, angles[2] ?? Number.NaN];
      expect(h2).toBeGreaterThanOrEqual(0);
      expect(h2).toBeLessThan(2 * Math.PI);
      expect(Math.abs(p2)).toBeLessThanOrEqual(HALF_PI);
      expect(Math.abs(r2)).toBeLessThanOrEqual(Math.PI);
      const rebuilt = headingPitchRollToRotationRad(lon, lat, h2, p2, r2, new Float64Array(9));
      // Measured worst case 1.2e-15 over 1e6 samples.
      for (let i = 0; i < 9; i++) expect(Math.abs((rebuilt[i] ?? 0) - (rotation[i] ?? 0))).toBeLessThanOrEqual(5e-15);
    },
  );

  // Away from gimbal lock heading and roll are conditioned by 1 / cos(pitch) ≤ 573 here: measured error 8e-14 rad.
  const pitchAwayFromLock = fc.double({ min: -89.9 * DEG, max: 89.9 * DEG, noNaN: true });
  test.prop([longitude, latitude, heading, pitchAwayFromLock, roll])(
    'returns the same angles away from gimbal lock',
    (lon, lat, h, p, r) => {
      const rotation = headingPitchRollToRotationRad(lon, lat, h, p, r, new Float64Array(9));
      const angles = rotationToHeadingPitchRollRad(lon, lat, rotation, new Float64Array(3));
      expect(angleDifference(angles[0] ?? Number.NaN, h)).toBeLessThanOrEqual(1e-11);
      expect(Math.abs((angles[1] ?? Number.NaN) - p)).toBeLessThanOrEqual(1e-11);
      expect(angleDifference(angles[2] ?? Number.NaN, r)).toBeLessThanOrEqual(1e-11);
    },
  );

  const nearAntimeridian = fc.double({ min: 0, max: 0.01, noNaN: true });
  test.prop([nearAntimeridian, nearAntimeridian, latitude, heading, pitch, roll])(
    'is continuous across the antimeridian',
    (westOfAntimeridianRad, eastOfAntimeridianRad, lat, h, p, r) => {
      const a = headingPitchRollToRotationRad(Math.PI - westOfAntimeridianRad, lat, h, p, r, new Float64Array(9));
      const b = headingPitchRollToRotationRad(-Math.PI + eastOfAntimeridianRad, lat, h, p, r, new Float64Array(9));
      // Each column mixes the ENU axes with weights of norm 1, so it moves at most √3 times as far as they do.
      const bound = Math.sqrt(3) * (westOfAntimeridianRad + eastOfAntimeridianRad) + 1e-15;
      for (let i = 0; i < 3; i++) expect(distance(column(a, i), column(b, i))).toBeLessThanOrEqual(bound);
    },
  );
});
