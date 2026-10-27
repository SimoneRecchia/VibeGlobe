import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { geodeticToEcef } from '../geodesy/ecef.js';
import { fogVisibilityInto, surfaceVisibility } from './fog.js';
import {
  FULL_FOG_VISIBILITY,
  quadtreeTileBounds,
  selectQuadtreeTiles,
  type QuadtreeTile,
} from './surface-quadtree.hot.js';

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

  it('never refines a tile that lies entirely inside full fog, and still refines one partly in view (F574)', () => {
    const camera = tiltedCamera();
    const options = { maxScreenErrorPx: 1, maxLevel: 22, imageryTexelsPerTile: 256, imageryMaxLevel: 18, fogHaze: 4 };
    const out: QuadtreeTile[] = [];
    const count = selectQuadtreeTiles(camera, options, out);
    const tiles = out.slice(0, count).map((t) => ({ ...t }));
    // The most light that reaches the eye from a tile, sampled over a 5 × 5 grid of its surface (the eye is within
    // 3 km of the target, so the target stands for it).
    const eye = camera.eyeEcef;
    const point = new Float64Array(3);
    const offset = new Float64Array(3);
    const io = new Float64Array(3);
    const eyeLon = camera.pose.targetLongitudeRad;
    const eyeLat = camera.pose.targetLatitudeRad;
    const clamp = (v: number, low: number, high: number): number => Math.min(high, Math.max(low, v));
    const clearest = (tile: QuadtreeTile): number => {
      let most = 0;
      // The grid, and the tile's point nearest the eye (last).
      for (let i = 0; i <= 5; i++)
        for (let j = 0; j <= (i === 5 ? 0 : 4); j++) {
          const lon =
            i === 5
              ? clamp(eyeLon, tile.westRad, tile.eastRad)
              : tile.westRad + ((tile.eastRad - tile.westRad) * i) / 4;
          const lat =
            i === 5
              ? clamp(eyeLat, tile.southRad, tile.northRad)
              : tile.southRad + ((tile.northRad - tile.southRad) * j) / 4;
          geodeticToEcef(lon, lat, 0, point);
          for (let k = 0; k < 3; k++) offset[k] = (point[k] ?? 0) - (eye[k] ?? 0);
          io[0] = Math.hypot(offset[0] ?? 0, offset[1] ?? 0, offset[2] ?? 0);
          io[1] = 4;
          fogVisibilityInto(eye, offset, io);
          most = Math.max(most, io[2] ?? 0);
        }
      return most;
    };
    const corner = new Float64Array(3);
    const diagonal = (tile: QuadtreeTile): number => {
      geodeticToEcef(tile.westRad, tile.southRad, 0, point);
      geodeticToEcef(tile.eastRad, tile.northRad, 0, corner);
      return Math.hypot(
        (point[0] ?? 0) - (corner[0] ?? 0),
        (point[1] ?? 0) - (corner[1] ?? 0),
        (point[2] ?? 0) - (corner[2] ?? 0),
      );
    };
    const nearest = (tile: QuadtreeTile): number => {
      geodeticToEcef(clamp(eyeLon, tile.westRad, tile.eastRad), clamp(eyeLat, tile.southRad, tile.northRad), 0, point);
      return Math.hypot(
        (point[0] ?? 0) - (eye[0] ?? 0),
        (point[1] ?? 0) - (eye[1] ?? 0),
        (point[2] ?? 0) - (eye[2] ?? 0),
      );
    };
    const parent = { ...(tiles[0] as QuadtreeTile) };
    const refinedInFog: string[] = [];
    let fogged = 0;
    for (const tile of tiles) {
      if (tile.root !== 0) continue;
      if (clearest(tile) < FULL_FOG_VISIBILITY) fogged++;
      if (tile.level <= 2) continue;
      quadtreeTileBounds(0, tile.level - 1, tile.x >> 1, tile.y >> 1, 1, parent);
      // A margin of four in visibility: the selection measures from the tile's closest point, the grid samples it.
      // Only parents smaller than their distance from the eye, which the selection's bounding volume measures fairly
      // (a continent-sized tile holds near and far ground alike), and a margin of four in visibility.
      if (nearest(parent) > diagonal(parent) && clearest(parent) < FULL_FOG_VISIBILITY / 4)
        refinedInFog.push(`${tile.level}/${tile.x}/${tile.y}`);
    }
    // The view reaches into full fog, and nothing there was refined.
    expect(fogged).toBeGreaterThan(0);
    expect(refinedInFog).toEqual([]);
    // Near the eye the detail is the same as without fog.
    const clear = selectQuadtreeTiles(camera, { ...options, fogHaze: undefined }, out);
    const finestClear = Math.max(...out.slice(0, clear).map((t) => t.level));
    expect(Math.max(...tiles.map((t) => t.level))).toBe(finestClear);
  });
});
