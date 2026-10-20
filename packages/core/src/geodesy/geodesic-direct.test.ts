import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { geodesicDirect } from './geodesic-direct.js';
import { geodesicInverse } from './geodesic-inverse.js';
import { WGS84 } from './wgs84.js';

const QUARTER_MERIDIAN_METERS = 10001965.7293127;

function azimuthDifferenceDeg(a: number, b: number): number {
  const reduced = (a - b) % 360;
  return Math.abs(reduced > 180 ? reduced - 360 : reduced < -180 ? reduced + 360 : reduced);
}

describe('geodesicDirect special cases', () => {
  it('stays put for a zero distance', () => {
    const end = geodesicDirect(13.4, 52.5, 77, 0);
    expect(end.longitudeDeg).toBe(13.4);
    // Latitude and azimuth make a round trip through the auxiliary sphere: equal to the last bit or two.
    expect(end.latitudeDeg).toBeCloseTo(52.5, 13);
    expect(end.finalAzimuthDeg).toBeCloseTo(77, 13);
  });

  it('runs along the equator and around it', () => {
    const quarter = geodesicDirect(-10, 0, 90, (Math.PI / 2) * WGS84.semiMajorAxisMeters);
    expect(quarter.longitudeDeg).toBeCloseTo(80, 12);
    expect(quarter.latitudeDeg).toBe(0);
    expect(quarter.finalAzimuthDeg).toBe(90);
    const around = geodesicDirect(-10, 0, 90, 2 * Math.PI * WGS84.semiMajorAxisMeters);
    expect(around.longitudeDeg).toBeCloseTo(-10, 12);
  });

  it('reaches the pole along a meridian and continues over it', () => {
    const pole = geodesicDirect(30, 0, 0, QUARTER_MERIDIAN_METERS);
    expect(pole.latitudeDeg).toBeCloseTo(90, 12);
    const beyond = geodesicDirect(30, 0, 0, QUARTER_MERIDIAN_METERS + 1e5);
    expect(beyond.longitudeDeg).toBeCloseTo(-150, 9);
    expect(beyond.latitudeDeg).toBeLessThan(90);
    expect(beyond.finalAzimuthDeg).toBe(180);
  });

  it('leaves a pole along the meridian given by the azimuth', () => {
    // At the north pole, approached along meridian 0°, azimuth 120° heads down meridian 180° - 120° = 60°.
    const end = geodesicDirect(0, 90, 120, QUARTER_MERIDIAN_METERS);
    expect(end.longitudeDeg).toBeCloseTo(60, 9);
    expect(end.latitudeDeg).toBeCloseTo(0, 9);
    expect(end.finalAzimuthDeg).toBeCloseTo(180, 9);
  });

  it('runs backwards for a negative distance', () => {
    const forward = geodesicDirect(5, 45, 30, 1e6);
    const back = geodesicDirect(forward.longitudeDeg, forward.latitudeDeg, forward.finalAzimuthDeg, -1e6);
    expect(back.longitudeDeg).toBeCloseTo(5, 11);
    expect(back.latitudeDeg).toBeCloseTo(45, 11);
    expect(back.finalAzimuthDeg).toBeCloseTo(30, 11);
  });

  it('returns NaN for latitudes beyond the poles and non-finite input', () => {
    for (const end of [
      geodesicDirect(0, 90.5, 0, 1),
      geodesicDirect(0, NaN, 0, 1),
      geodesicDirect(NaN, 0, 0, 1),
      geodesicDirect(0, 0, Infinity, 1),
      geodesicDirect(0, 0, 0, NaN),
    ]) {
      expect(end.longitudeDeg).toBeNaN();
      expect(end.latitudeDeg).toBeNaN();
      expect(end.finalAzimuthDeg).toBeNaN();
    }
  });
});

describe('geodesicDirect properties', () => {
  test.prop([
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.double({ min: -90, max: 90, noNaN: true }),
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.double({ min: 0, max: 1e7, noNaN: true }),
  ])('is consistent with the inverse problem: length within 1e-6 m, azimuth within 1e-9°', (lon, lat, azimuth, s) => {
    // Geodesics up to 10,000 km are shortest paths for every start and azimuth (the conjugate point lies beyond).
    const end = geodesicDirect(lon, lat, azimuth, s);
    const inverse = geodesicInverse(lon, lat, end.longitudeDeg, end.latitudeDeg);
    expect(Math.abs(inverse.distanceMeters - s)).toBeLessThanOrEqual(1e-6);
    // Below 1 km the azimuth is set by end-point bits: a 1e-9 m rounding is 1e-12 rad at 1 km.
    if (s >= 1000) {
      expect(azimuthDifferenceDeg(inverse.initialAzimuthDeg, azimuth)).toBeLessThanOrEqual(1e-9);
      expect(azimuthDifferenceDeg(inverse.finalAzimuthDeg, end.finalAzimuthDeg)).toBeLessThanOrEqual(1e-9);
    }
  });
});
