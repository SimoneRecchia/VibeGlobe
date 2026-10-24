import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { geodeticToEcef } from '../geodesy/ecef.js';
import { fogVisibilityInto, surfaceVisibility } from './fog.js';
import { selectQuadtreeTiles, type QuadtreeTile } from './surface-quadtree.hot.js';

const DEG = Math.PI / 180;

function tiltedCamera(): Camera {
  const camera = new Camera();
  camera.widthPx = 960;
  camera.heightPx = 540;
  Object.assign(camera.pose, { targetLongitudeRad: 5 * DEG, targetLatitudeRad: 45 * DEG, rangeMeters: 3000 });
  camera.pose.tiltRad = 85 * DEG;
  camera.update();
  return camera;
}

describe('fog-aware detail (F395)', () => {
  it('sees clear ground near the eye and hazed ground far along a low view', () => {
    // The eye 300 m up: ground 2 km away looking slightly down is clear; 150 km away, nearly horizontal, it is hidden.
    expect(
      surfaceVisibility({ eyeAltitudeKm: 0.3, radiusKm: 6378.137, viewMu: -0.15, maxDistanceKm: 2 }),
    ).toBeGreaterThan(0.9);
    expect(
      surfaceVisibility({ eyeAltitudeKm: 0.3, radiusKm: 6378.137, viewMu: -0.014, maxDistanceKm: 150 }),
    ).toBeLessThan(0.1);
    // More haze hides more.
    const ray = { eyeAltitudeKm: 0.3, radiusKm: 6378.137, viewMu: -0.01, maxDistanceKm: 30 };
    expect(surfaceVisibility(ray, 3)).toBeLessThan(surfaceVisibility(ray, 1));
    // From ECEF: a point 150 km north of an eye 300 m above 45° N.
    const eye = new Float64Array(3);
    const point = new Float64Array(3);
    geodeticToEcef(5 * DEG, 45 * DEG, 300, eye);
    geodeticToEcef(5 * DEG, 46.35 * DEG, 0, point);
    const offset = point.map((v, i) => v - (eye[i] ?? 0));
    const io = Float64Array.of(Math.hypot(...offset), 1, 0);
    fogVisibilityInto(eye, offset, io);
    expect(io[2]).toBeLessThan(0.1);
  });

  it('keeps hazed tiles near the horizon coarse: fewer and coarser tiles in a tilted ground view', () => {
    const camera = tiltedCamera();
    const select = (fogHaze: number | undefined): QuadtreeTile[] => {
      const out: QuadtreeTile[] = [];
      const count = selectQuadtreeTiles(
        camera,
        { maxScreenErrorPx: 1, maxLevel: 22, imageryTexelsPerTile: 256, imageryMaxLevel: 18, fogHaze },
        out,
      );
      return out.slice(0, count).map((t) => ({ ...t }));
    };
    const clear = select(undefined);
    const hazed = select(1);
    expect(hazed.length).toBeLessThan(clear.length * 0.8);
    // Near the eye the detail is the same: the finest level is unchanged.
    const finest = (tiles: QuadtreeTile[]): number => Math.max(...tiles.map((t) => t.level));
    expect(finest(hazed)).toBe(finest(clear));
  });
});
