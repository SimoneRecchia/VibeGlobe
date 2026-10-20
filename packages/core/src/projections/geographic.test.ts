import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  GEOGRAPHIC_HALF_HEIGHT_METERS,
  projectGeographicDeg,
  projectGeographicRad,
  unprojectGeographicDeg,
  unprojectGeographicRad,
} from './geographic.js';
import { nearestWorldCopyXMeters } from './longitude.js';
import { projectWebMercatorRad } from './web-mercator.js';

const HALF_WIDTH = Math.PI * 6378137;

/** Smallest absolute difference between two angles, in radians (longitudes either side of the seam are equal). */
function angleDifference(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function project(lonRad: number, latRad: number): [number, number] {
  const out = projectGeographicRad(lonRad, latRad, new Float64Array(2));
  return [out[0] ?? Number.NaN, out[1] ?? Number.NaN];
}

function unproject(xMeters: number, yMeters: number): [number, number] {
  const out = unprojectGeographicRad(xMeters, yMeters, new Float64Array(2));
  return [out[0] ?? Number.NaN, out[1] ?? Number.NaN];
}

describe('plate carrée reference values', () => {
  it('spaces one degree as a·π/180 = 111319.49079327357 m on both axes', () => {
    expect(Math.abs(projectGeographicDeg(1, 0).xMeters - 111319.49079327357)).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(projectGeographicDeg(0, 1).yMeters - 111319.49079327357)).toBeLessThanOrEqual(1e-8);
  });

  it('maps 45° and 90° to a·π/4 and a·π/2', () => {
    expect(Math.abs(projectGeographicDeg(0, 45).yMeters - 5009377.085697311)).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(GEOGRAPHIC_HALF_HEIGHT_METERS - 10018754.171394622)).toBeLessThanOrEqual(1e-8);
    expect(projectGeographicDeg(90, 90)).toEqual({ xMeters: HALF_WIDTH / 2, yMeters: GEOGRAPHIC_HALF_HEIGHT_METERS });
  });

  it('wraps longitudes and clamps latitudes', () => {
    expect(projectGeographicDeg(180, 0).xMeters).toBe(-HALF_WIDTH);
    expect(projectGeographicDeg(0, 100).yMeters).toBe(GEOGRAPHIC_HALF_HEIGHT_METERS);
    expect(project(0, Number.NEGATIVE_INFINITY)[1]).toBe(-GEOGRAPHIC_HALF_HEIGHT_METERS);
    expect(unprojectGeographicDeg(HALF_WIDTH, 2 * GEOGRAPHIC_HALF_HEIGHT_METERS)).toEqual({ lonDeg: -180, latDeg: 90 });
    expect(unprojectGeographicDeg(-HALF_WIDTH / 2, -GEOGRAPHIC_HALF_HEIGHT_METERS / 2)).toEqual({
      lonDeg: -90,
      latDeg: -45,
    });
  });

  it('writes at an offset', () => {
    expect(Array.from(projectGeographicRad(0, Math.PI / 2, new Float64Array(3), 1))).toEqual([
      0,
      0,
      GEOGRAPHIC_HALF_HEIGHT_METERS,
    ]);
  });
});

describe('plate carrée properties', () => {
  const lonInRange = fc.double({ min: -Math.PI, max: Math.PI, maxExcluded: true, noNaN: true });
  const latInRange = fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true });

  // x = a·λ then λ = x / a: one rounding each way.
  test.prop([lonInRange, latInRange])('forward then inverse returns the position', (lonRad, latRad) => {
    const [lon, lat] = unproject(...project(lonRad, latRad));
    expect(angleDifference(lon, lonRad)).toBeLessThanOrEqual(1e-15);
    expect(Math.abs(lat - latRad)).toBeLessThanOrEqual(1e-15);
  });

  test.prop([
    fc.double({ min: -HALF_WIDTH, max: HALF_WIDTH, maxExcluded: true, noNaN: true }),
    fc.double({ min: -GEOGRAPHIC_HALF_HEIGHT_METERS, max: GEOGRAPHIC_HALF_HEIGHT_METERS, noNaN: true }),
  ])('inverse then forward returns the point', (xMeters, yMeters) => {
    const [x, y] = project(...unproject(xMeters, yMeters));
    expect(Math.abs(nearestWorldCopyXMeters(x, xMeters) - xMeters)).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(y - yMeters)).toBeLessThanOrEqual(1e-8);
  });

  test.prop([fc.double({ noNaN: true, noDefaultInfinity: true }), fc.double({ noNaN: true })])(
    'any input gives a finite point in the world rectangle, with Web Mercator x',
    (lonRad, latRad) => {
      const [x, y] = project(lonRad, latRad);
      expect(x).toBeGreaterThanOrEqual(-HALF_WIDTH);
      expect(x).toBeLessThan(HALF_WIDTH);
      expect(Math.abs(y)).toBeLessThanOrEqual(GEOGRAPHIC_HALF_HEIGHT_METERS);
      expect(x).toBe(projectWebMercatorRad(lonRad, latRad, new Float64Array(2))[0]);
    },
  );

  const nearAntimeridian = fc.double({ min: 0, max: 0.01, noNaN: true });
  test.prop([nearAntimeridian, nearAntimeridian])(
    'longitudes either side of ±180° are adjacent once moved to the nearest copy',
    (westOfAntimeridianRad, eastOfAntimeridianRad) => {
      const [xEast] = project(Math.PI - westOfAntimeridianRad, 0);
      const xWest = nearestWorldCopyXMeters(project(-Math.PI + eastOfAntimeridianRad, 0)[0], xEast);
      const expected = 6378137 * (westOfAntimeridianRad + eastOfAntimeridianRad);
      expect(Math.abs(xWest - xEast - expected)).toBeLessThanOrEqual(1e-7);
    },
  );
});
