import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { geodeticToEcef, type GeodeticRad } from '../geodesy/ecef.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { transformPoint4 } from '../math/mat4.js';
import { Camera, rayEllipsoidDistance } from './camera.js';
import { projectToScreen } from './projection.js';

const DEG = Math.PI / 180;

function cameraAt(lonDeg: number, latDeg: number, rangeMeters: number, headingDeg = 0, tiltDeg = 0): Camera {
  const camera = new Camera();
  camera.widthPx = 800;
  camera.heightPx = 600;
  Object.assign(camera.pose, {
    targetLongitudeRad: lonDeg * DEG,
    targetLatitudeRad: latDeg * DEG,
    rangeMeters,
    headingRad: headingDeg * DEG,
    tiltRad: tiltDeg * DEG,
  });
  camera.update();
  return camera;
}

function at(array: Float64Array, index: number): number {
  return array[index] ?? NaN;
}

const point = new Float64Array(4);

describe('Camera', () => {
  it('looks straight down from orbit with north up and east right', () => {
    const camera = cameraAt(0, 0, 2e7);
    // At (0°, 0°) up is +X, east +Y, north +Z (ECEF).
    expect([...camera.forward].map((v) => Math.round(v * 1e12) / 1e12)).toEqual([-1, 0, 0]);
    expect(at(camera.right, 1)).toBeCloseTo(1, 12);
    expect(at(camera.up, 2)).toBeCloseTo(1, 12);
    expect(at(camera.eyeEcef, 0)).toBeCloseTo(WGS84.semiMajorAxisMeters + 2e7, 6);
    expect(camera.eyeGeodetic.heightMeters).toBeCloseTo(2e7, 6);
  });

  it.each([
    ['orbit', 0, 0, 2e7, 0, 0],
    ['1 km, heading 30°, tilt 45°', 9.19, 45.46, 1000, 30, 45],
    ['1 m, heading -120°, tilt 60°', -73.98, 40.75, 1, -120, 60],
  ])('maps the target to the screen center and the view axis at %s', (_, lon, lat, range, heading, tilt) => {
    const camera = cameraAt(lon, lat, range, heading, tilt);
    const tx = at(camera.targetEcef, 0) - at(camera.eyeEcef, 0);
    const ty = at(camera.targetEcef, 1) - at(camera.eyeEcef, 1);
    const tz = at(camera.targetEcef, 2) - at(camera.eyeEcef, 2);
    // The rotation-only view matrix sends the target to (0, 0, -range).
    transformPoint4(point, camera.view, tx, ty, tz);
    expect(at(point, 0)).toBeCloseTo(0, 6);
    expect(at(point, 1)).toBeCloseTo(0, 6);
    expect(at(point, 2)).toBeCloseTo(-range, 6);
    // The projection puts it at depth near / range in [0, 1] (reversed Z, infinite far).
    transformPoint4(point, camera.projection, at(point, 0), at(point, 1), at(point, 2));
    // Relative 1e-8: at a 1 m range float64 cancellation against 6.4e6 m ECEF values leaves about 1e-9.
    expect(Math.abs((at(point, 2) / at(point, 3)) * (range / camera.nearMeters) - 1)).toBeLessThan(1e-8);
    // Heading: the horizontal part of the view direction points at the heading, clockwise from north.
    const screen = new Float64Array(2);
    expect(projectToScreen(camera, camera.targetEcef, screen)).toBe(true);
    expect(at(screen, 0)).toBeCloseTo(400, 6);
    expect(at(screen, 1)).toBeCloseTo(300, 6);
  });

  it('puts the eye range·cos(tilt) above the target, plus the Earth curvature drop over the horizontal offset', () => {
    const camera = cameraAt(10, 50, 1000, 70, 60);
    const horizontalMeters = 1000 * Math.sin(60 * DEG);
    const curvatureMeters = horizontalMeters ** 2 / (2 * 6.37e6);
    expect(camera.eyeGeodetic.heightMeters).toBeCloseTo(500 + curvatureMeters, 3);
  });

  it('chooses the near plane from the clearance (ADR 0005)', () => {
    expect(cameraAt(0, 0, 2e7).nearMeters).toBe(0.1);
    expect(cameraAt(0, 0, 0.1).nearMeters).toBeCloseTo(0.05, 9);
    expect(cameraAt(0, 0, 0.001).nearMeters).toBe(0.001);
  });

  it('writes a reversed-Z infinite projection matrix', () => {
    const camera = cameraAt(0, 0, 100);
    const f = 1 / Math.tan(camera.fovYRad / 2);
    expect(at(camera.projection, 0)).toBeCloseTo(f / (800 / 600), 12);
    expect(at(camera.projection, 5)).toBeCloseTo(f, 12);
    expect(at(camera.projection, 10)).toBe(0);
    expect(at(camera.projection, 11)).toBe(-1);
    expect(at(camera.projection, 14)).toBe(camera.nearMeters);
  });

  it('builds frustum planes that contain the target and exclude points behind the eye', () => {
    const camera = cameraAt(0, 0, 1e6, 0, 30);
    const inside = (x: number, y: number, z: number): boolean => {
      for (let plane = 0; plane < 5; plane++) {
        const d =
          at(camera.frustumPlanes, plane * 4) * x +
          at(camera.frustumPlanes, plane * 4 + 1) * y +
          at(camera.frustumPlanes, plane * 4 + 2) * z +
          at(camera.frustumPlanes, plane * 4 + 3);
        if (d < -1e-6) return false;
      }
      return true;
    };
    const t = [0, 1, 2].map((i) => at(camera.targetEcef, i) - at(camera.eyeEcef, i)) as [number, number, number];
    expect(inside(...t)).toBe(true);
    expect(inside(-t[0], -t[1], -t[2])).toBe(false);
    // Far beyond the horizon in the view direction stays inside: there is no far plane.
    expect(inside(at(camera.forward, 0) * 1e12, at(camera.forward, 1) * 1e12, at(camera.forward, 2) * 1e12)).toBe(true);
  });
});

describe('screen to globe', () => {
  const hit: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };

  it('returns the target at the screen center and nothing off the globe', () => {
    const camera = cameraAt(12.5, 41.9, 2e7);
    expect(camera.pickEllipsoid(400, 300, hit)).toBe(true);
    expect(hit.longitudeRad / DEG).toBeCloseTo(12.5, 9);
    expect(hit.latitudeRad / DEG).toBeCloseTo(41.9, 9);
    expect(camera.pickEllipsoid(1, 1, hit)).toBe(false);
  });

  test.prop([
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.double({ min: -89, max: 89, noNaN: true }),
    fc.double({ min: 1, max: 3e7, noNaN: true }),
    fc.double({ min: 0, max: 360, noNaN: true }),
    fc.double({ min: 0, max: 60, noNaN: true }),
  ])('picks the point a pixel shows, round trip through projection', (lon, lat, range, heading, tilt) => {
    const camera = cameraAt(lon, lat, range, heading, tilt);
    const screen = new Float64Array(2);
    const target = camera.targetEcef;
    projectToScreen(camera, target, screen);
    expect(camera.pickEllipsoid(at(screen, 0), at(screen, 1), hit)).toBe(true);
    const ecef = new Float64Array(3);
    geodeticToEcef(hit.longitudeRad, hit.latitudeRad, 0, ecef);
    const errorMeters = Math.hypot(
      at(ecef, 0) - at(target, 0),
      at(ecef, 1) - at(target, 1),
      at(ecef, 2) - at(target, 2),
    );
    // One pixel's ground size at the target bounds the error with ample margin.
    expect(errorMeters).toBeLessThan(1e-6 * range + 1e-6);
  });

  it('solves the ray–ellipsoid quadratic stably from inside and outside', () => {
    const origin = new Float64Array([WGS84.semiMajorAxisMeters + 1, 0, 0]);
    expect(rayEllipsoidDistance(origin, new Float64Array([-1, 0, 0]))).toBeCloseTo(1, 9);
    expect(rayEllipsoidDistance(origin, new Float64Array([1, 0, 0]))).toBeUndefined();
    expect(rayEllipsoidDistance(new Float64Array([0, 0, 0]), new Float64Array([0, 0, 1]))).toBeCloseTo(
      WGS84.semiMinorAxisMeters,
      6,
    );
  });
});
