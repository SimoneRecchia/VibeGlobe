import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { geodeticToEcef } from './ecef.js';
import { geodesicDirect } from './geodesic-direct.js';
import { geodesicInverse } from './geodesic-inverse.js';
import { WGS84 } from './wgs84.js';

const DEG = Math.PI / 180;
/** Length of a meridian from pole to pole on WGS84, in meters. */
const HALF_MERIDIAN_METERS = 20003931.4586254;
const longitude = fc.double({ min: -180, max: 180, noNaN: true });
const latitude = fc.double({ min: -90, max: 90, noNaN: true });

const ecefA = new Float64Array(3);
const ecefB = new Float64Array(3);

/** Straight-line distance between two points on the ellipsoid, in meters: exact enough for errors above 1e-9 m. */
function chordMeters(lon1Deg: number, lat1Deg: number, lon2Deg: number, lat2Deg: number): number {
  geodeticToEcef(lon1Deg * DEG, lat1Deg * DEG, 0, ecefA);
  geodeticToEcef(lon2Deg * DEG, lat2Deg * DEG, 0, ecefB);
  return Math.hypot(
    (ecefA[0] ?? 0) - (ecefB[0] ?? 0),
    (ecefA[1] ?? 0) - (ecefB[1] ?? 0),
    (ecefA[2] ?? 0) - (ecefB[2] ?? 0),
  );
}

function azimuthDifferenceDeg(a: number, b: number): number {
  const reduced = (a - b) % 360;
  return Math.abs(reduced > 180 ? reduced - 360 : reduced < -180 ? reduced + 360 : reduced);
}

describe('geodesicInverse special cases', () => {
  it('returns zero for coincident points, with the azimuth of a meridian', () => {
    const result = geodesicInverse(13.4, 52.5, 13.4, 52.5);
    expect(result.distanceMeters).toBe(0);
    expect(result.initialAzimuthDeg).toBe(result.finalAzimuthDeg);
    expect([0, 180]).toContain(result.initialAzimuthDeg);
  });

  it('treats angles below 1e-17 degrees as exact zeros', () => {
    expect(geodesicInverse(1.8e-160, 0, 0, -1.4e-322).distanceMeters).toBe(0);
    expect(geodesicInverse(0, 1e-300, 1e-200, 0).distanceMeters).toBe(0);
  });

  it('follows the equator while it is the shortest path', () => {
    const result = geodesicInverse(-10, 0, 20, 0);
    expect(result.distanceMeters).toBeCloseTo(WGS84.semiMajorAxisMeters * 30 * DEG, 8);
    expect(result.initialAzimuthDeg).toBe(90);
    expect(result.finalAzimuthDeg).toBe(90);
    expect(geodesicInverse(20, 0, -10, 0).initialAzimuthDeg).toBe(-90);
  });

  it('goes over the north pole between antipodal points of the equator', () => {
    const result = geodesicInverse(0, 0, 180, 0);
    expect(result.distanceMeters).toBeCloseTo(HALF_MERIDIAN_METERS, 6);
    expect(result.initialAzimuthDeg).toBe(0);
    expect(result.finalAzimuthDeg).toBe(180);
  });

  it('runs along meridians between the poles and from a pole', () => {
    expect(geodesicInverse(0, 90, 0, -90).distanceMeters).toBeCloseTo(HALF_MERIDIAN_METERS, 6);
    expect(geodesicInverse(25, -90, 100, 90).distanceMeters).toBeCloseTo(HALF_MERIDIAN_METERS, 6);
    const fromPole = geodesicInverse(0, 90, 30, 0);
    expect(fromPole.distanceMeters).toBeCloseTo(HALF_MERIDIAN_METERS / 2, 6);
    // At a pole the azimuth is measured as the pole is approached along the given meridian (here 0°).
    expect(fromPole.initialAzimuthDeg).toBeCloseTo(150, 12);
    expect(fromPole.finalAzimuthDeg).toBeCloseTo(180, 12);
  });

  it('crosses the antimeridian the short way', () => {
    const result = geodesicInverse(179.5, 10, -179.5, 10);
    expect(result.distanceMeters).toBeLessThan(110000);
    expect(result.initialAzimuthDeg).toBeGreaterThan(0);
    expect(geodesicInverse(179.5 + 360, 10, -179.5 - 720, 10)).toEqual(result);
  });

  it('returns NaN for latitudes beyond the poles and non-finite input', () => {
    for (const result of [
      geodesicInverse(0, 91, 0, 0),
      geodesicInverse(0, 0, 0, -90.5),
      geodesicInverse(NaN, 0, 0, 0),
      geodesicInverse(0, 0, Infinity, 0),
      geodesicInverse(0, NaN, 0, 0),
    ]) {
      expect(result.distanceMeters).toBeNaN();
      expect(result.initialAzimuthDeg).toBeNaN();
      expect(result.finalAzimuthDeg).toBeNaN();
    }
  });
});

describe('geodesicInverse properties', () => {
  test.prop([longitude, latitude, longitude, latitude])(
    'is symmetric: A to B has the length of B to A and the reversed azimuths',
    (lon1, lat1, lon2, lat2) => {
      const forward = geodesicInverse(lon1, lat1, lon2, lat2);
      const backward = geodesicInverse(lon2, lat2, lon1, lat1);
      expect(Math.abs(forward.distanceMeters - backward.distanceMeters)).toBeLessThanOrEqual(
        1e-9 * forward.distanceMeters,
      );
      // Coincident points have no direction between them (their azimuths are a convention).
      const reversal = forward.distanceMeters > 0 ? 180 : 0;
      const reversedFinal = backward.finalAzimuthDeg + reversal;
      const reversedInitial = backward.initialAzimuthDeg + reversal;
      expect(azimuthDifferenceDeg(forward.initialAzimuthDeg, reversedFinal)).toBeLessThanOrEqual(1e-9);
      expect(azimuthDifferenceDeg(forward.finalAzimuthDeg, reversedInitial)).toBeLessThanOrEqual(1e-9);
    },
  );

  test.prop([longitude, latitude, longitude, latitude])(
    'is consistent with the direct problem: the solved geodesic ends within 1e-6 m of the target',
    (lon1, lat1, lon2, lat2) => {
      const inverse = geodesicInverse(lon1, lat1, lon2, lat2);
      expect(inverse.distanceMeters).toBeGreaterThanOrEqual(0);
      expect(inverse.distanceMeters).toBeLessThanOrEqual(HALF_MERIDIAN_METERS + 1e-6);
      const end = geodesicDirect(lon1, lat1, inverse.initialAzimuthDeg, inverse.distanceMeters);
      expect(chordMeters(end.longitudeDeg, end.latitudeDeg, lon2, lat2)).toBeLessThanOrEqual(1e-6);
    },
  );

  test.prop([longitude, latitude, longitude, fc.double({ min: 0, max: 1, noNaN: true })])(
    'is consistent with the direct problem near the antipode',
    (lon1, lat1, offsetDeg, latitudeOffsetDeg) => {
      // End points within a degree of the antipode, where the azimuth is ill-conditioned but the end point is not.
      const lon2 = lon1 + 180 - offsetDeg / 180;
      const lat2 = Math.max(-90, Math.min(90, -lat1 + latitudeOffsetDeg - 0.5));
      const inverse = geodesicInverse(lon1, lat1, lon2, lat2);
      const end = geodesicDirect(lon1, lat1, inverse.initialAzimuthDeg, inverse.distanceMeters);
      expect(chordMeters(end.longitudeDeg, end.latitudeDeg, lon2, lat2)).toBeLessThanOrEqual(1e-6);
    },
  );
});
