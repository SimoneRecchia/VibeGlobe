import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  WEB_MERCATOR_HALF_EXTENT_METERS,
  WEB_MERCATOR_MAX_LATITUDE_DEG,
  WEB_MERCATOR_MAX_LATITUDE_RAD,
  clampWebMercatorLatitudeRad,
  projectWebMercatorDeg,
  projectWebMercatorRad,
  unprojectWebMercatorDeg,
  unprojectWebMercatorRad,
  webMercatorScaleFactor,
  webMercatorXNearestRad,
} from './web-mercator.js';
import { nearestWorldCopyXMeters } from './longitude.js';

const RADIUS_METERS = 6378137;
const HALF_EXTENT = WEB_MERCATOR_HALF_EXTENT_METERS;
const DEG = Math.PI / 180;

/** Smallest absolute difference between two angles, in radians (longitudes either side of the seam are equal). */
function angleDifference(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function project(lonRad: number, latRad: number): [number, number] {
  const out = projectWebMercatorRad(lonRad, latRad, new Float64Array(2));
  return [out[0] ?? Number.NaN, out[1] ?? Number.NaN];
}

function unproject(xMeters: number, yMeters: number): [number, number] {
  const out = unprojectWebMercatorRad(xMeters, yMeters, new Float64Array(2));
  return [out[0] ?? Number.NaN, out[1] ?? Number.NaN];
}

describe('Web Mercator reference values', () => {
  // EPSG Guidance Note 7-2, Popular Visualisation Pseudo Mercator (method 1024) worked example:
  // φ = 24°22'54.433"N, λ = 100°20'00.000"W → E = -11 169 055.58 m, N = 2 800 000.00 m (published to the centimeter).
  const latDeg = 24 + 22 / 60 + 54.433 / 3600;
  const lonDeg = -(100 + 20 / 60);

  it('matches the EPSG guidance note 7-2 forward example', () => {
    const { xMeters, yMeters } = projectWebMercatorDeg(lonDeg, latDeg);
    expect(Math.abs(xMeters - -11169055.58)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(yMeters - 2800000.0)).toBeLessThanOrEqual(0.005);
  });

  it('matches the EPSG guidance note 7-2 example in reverse', () => {
    const { lonDeg: lon, latDeg: lat } = unprojectWebMercatorDeg(-11169055.58, 2800000.0);
    // The published coordinates carry 0.005 m and 0.0005" of rounding: about 1.4e-7°.
    expect(Math.abs(lon - lonDeg)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(lat - latDeg)).toBeLessThanOrEqual(1e-6);
  });

  it('has the well-known latitude limit and square extent', () => {
    expect(Math.abs(WEB_MERCATOR_MAX_LATITUDE_DEG - 85.0511287798066)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(HALF_EXTENT - 20037508.342789244)).toBeLessThanOrEqual(1e-6);
    const [, yAtLimit] = project(0, WEB_MERCATOR_MAX_LATITUDE_RAD);
    expect(Math.abs(yAtLimit - HALF_EXTENT)).toBeLessThanOrEqual(1e-7);
  });

  it('clamps the poles and beyond to the square', () => {
    for (const latRad of [Math.PI / 2, 2, Number.POSITIVE_INFINITY, Number.MAX_VALUE])
      expect(Math.abs(project(0, latRad)[1] - HALF_EXTENT)).toBeLessThanOrEqual(1e-7);
    expect(Math.abs(project(0, -Math.PI / 2)[1] + HALF_EXTENT)).toBeLessThanOrEqual(1e-7);
    expect(clampWebMercatorLatitudeRad(Number.NEGATIVE_INFINITY)).toBe(-WEB_MERCATOR_MAX_LATITUDE_RAD);
  });

  it('wraps longitudes onto [-π·a, π·a)', () => {
    expect(project(Math.PI, 0)[0]).toBe(-HALF_EXTENT);
    expect(project(-Math.PI, 0)[0]).toBe(-HALF_EXTENT);
    expect(projectWebMercatorDeg(540, 0).xMeters).toBe(-HALF_EXTENT);
    expect(projectWebMercatorDeg(190, 0).xMeters).toBeCloseTo(projectWebMercatorDeg(-170, 0).xMeters, 6);
    expect(unprojectWebMercatorDeg(HALF_EXTENT, 0).lonDeg).toBe(-180);
  });

  it('writes at an offset and unprojects infinite y to the poles', () => {
    const out = projectWebMercatorRad(0, 0, new Float64Array(4), 2);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
    expect(unproject(0, Number.POSITIVE_INFINITY)[1]).toBe(Math.PI / 2);
    expect(unproject(0, Number.NEGATIVE_INFINITY)[1]).toBe(-Math.PI / 2);
  });

  it('has the scale factor 1 / cos φ, finite at the poles', () => {
    expect(webMercatorScaleFactor(0)).toBe(1);
    expect(Math.abs(webMercatorScaleFactor(60 * DEG) - 2)).toBeLessThanOrEqual(1e-15);
    expect(Math.abs(webMercatorScaleFactor(-Math.PI / 2) - Math.cosh(Math.PI))).toBeLessThanOrEqual(1e-12);
    expect(Number.isFinite(webMercatorScaleFactor(Number.POSITIVE_INFINITY))).toBe(true);
  });
});

describe('Web Mercator properties', () => {
  const lonInRange = fc.double({ min: -Math.PI, max: Math.PI, maxExcluded: true, noNaN: true });
  const latInRange = fc.double({
    min: -WEB_MERCATOR_MAX_LATITUDE_RAD,
    max: WEB_MERCATOR_MAX_LATITUDE_RAD,
    noNaN: true,
  });
  const inSquare = fc.double({ min: -HALF_EXTENT, max: HALF_EXTENT, maxExcluded: true, noNaN: true });

  // Measured worst case over 2e6 samples: 4.4e-16 rad (a few ulps), i.e. nanometers on the ground.
  test.prop([lonInRange, latInRange])('forward then inverse returns the position', (lonRad, latRad) => {
    const [x, y] = project(lonRad, latRad);
    const [lon, lat] = unproject(x, y);
    expect(angleDifference(lon, lonRad)).toBeLessThanOrEqual(2e-15);
    expect(Math.abs(lat - latRad)).toBeLessThanOrEqual(2e-15);
  });

  // Measured worst case: 1.1e-8 m, three ulps of a 2e7 m coordinate.
  test.prop([inSquare, inSquare])('inverse then forward returns the point', (xMeters, yMeters) => {
    const [lon, lat] = unproject(xMeters, yMeters);
    const [x, y] = project(lon, lat);
    expect(Math.abs(nearestWorldCopyXMeters(x, xMeters) - xMeters)).toBeLessThanOrEqual(1e-7);
    expect(Math.abs(y - yMeters)).toBeLessThanOrEqual(1e-7);
  });

  test.prop([fc.double({ noNaN: true, noDefaultInfinity: true }), fc.double({ noNaN: true })])(
    'any longitude and any latitude, ±90° and ±Infinity included, give a finite point in the square',
    (lonRad, latRad) => {
      const [x, y] = project(lonRad, latRad);
      expect(x).toBeGreaterThanOrEqual(-HALF_EXTENT);
      expect(x).toBeLessThan(HALF_EXTENT);
      expect(Math.abs(y)).toBeLessThanOrEqual(HALF_EXTENT);
      expect(Number.isFinite(webMercatorScaleFactor(latRad))).toBe(true);
    },
  );

  const nearAntimeridian = fc.double({ min: 0, max: 0.01, noNaN: true });
  test.prop([nearAntimeridian, nearAntimeridian, latInRange])(
    'longitudes either side of ±180° are adjacent once moved to the nearest copy',
    (westOfAntimeridianRad, eastOfAntimeridianRad, latRad) => {
      const [xEast] = project(Math.PI - westOfAntimeridianRad, latRad);
      const xWest = webMercatorXNearestRad(-Math.PI + eastOfAntimeridianRad, xEast);
      const expected = RADIUS_METERS * (westOfAntimeridianRad + eastOfAntimeridianRad);
      expect(Math.abs(xWest - xEast - expected)).toBeLessThanOrEqual(1e-7);
    },
  );

  test.prop([fc.double({ min: -1e3, max: 1e3, noNaN: true }), fc.double({ min: -1e9, max: 1e9, noNaN: true })])(
    'the nearest copy lies within half a world of the reference',
    (lonRad, referenceXMeters) => {
      const x = webMercatorXNearestRad(lonRad, referenceXMeters);
      expect(Math.abs(x - referenceXMeters)).toBeLessThanOrEqual(HALF_EXTENT + 1e-6);
    },
  );
});
