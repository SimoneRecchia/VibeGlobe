import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { buildTileMesh, tileIndices, TILE_SEGMENTS } from './surface-mesh.js';
import { selectSurfaceTiles, surfaceTileBounds, surfaceTileKey, type SurfaceTile } from './surface-selection.hot.js';

const DEG = Math.PI / 180;

function camera(lonDeg: number, latDeg: number, range: number, tiltDeg = 0): Camera {
  const c = new Camera();
  c.widthPx = 960;
  c.heightPx = 540;
  Object.assign(c.pose, {
    targetLongitudeRad: lonDeg * DEG,
    targetLatitudeRad: latDeg * DEG,
    rangeMeters: range,
    tiltRad: tiltDeg * DEG,
  });
  c.update();
  return c;
}

describe('surface tile keys', () => {
  it('are unique and exact up to level 25', () => {
    const seen = new Set<number>();
    for (let level = 0; level <= 4; level++)
      for (let y = 0; y < 2 ** level; y++)
        for (let x = 0; x < 2 ** (level + 1); x++) seen.add(surfaceTileKey(level, x, y));
    expect(seen.size).toBe([0, 1, 2, 3, 4].reduce((sum, l) => sum + 2 * 4 ** l, 0));
    const last = surfaceTileKey(25, 2 ** 26 - 1, 2 ** 25 - 1);
    expect(Number.isSafeInteger(last)).toBe(true);
    expect(last).toBe(surfaceTileKey(26, 0, 0) - 1);
  });

  it('cover the globe from the north-west', () => {
    const tile = surfaceTileBounds(1, 3, 1, {} as SurfaceTile);
    expect([tile.westRad, tile.eastRad, tile.northRad, tile.southRad].map((r) => r / DEG)).toEqual([90, 180, 0, -90]);
  });
});

describe('selectSurfaceTiles', () => {
  const out: SurfaceTile[] = [];

  it('draws a handful of tiles from orbit and covers the visible hemisphere', () => {
    const count = selectSurfaceTiles(camera(0, 0, 2e7), { maxScreenErrorPx: 1, maxLevel: 26 }, out);
    expect(count).toBeGreaterThan(4);
    expect(count).toBeLessThan(200);
    // The tile under the screen center is drawn.
    expect(
      out.slice(0, count).some((t) => t.westRad <= 0 && t.eastRad >= 0 && t.southRad <= 0 && t.northRad >= 0),
    ).toBe(true);
  });

  it('refines to tiles small enough for float32 offsets at 1 m altitude (ADR 0004)', () => {
    const c = camera(9.19, 45.46, 1, 0);
    const count = selectSurfaceTiles(c, { maxScreenErrorPx: 1, maxLevel: 26 }, out);
    const under = out
      .slice(0, count)
      .find(
        (t) =>
          t.westRad <= 9.19 * DEG && t.eastRad >= 9.19 * DEG && t.southRad <= 45.46 * DEG && t.northRad >= 45.46 * DEG,
      );
    expect(under).toBeDefined();
    const sizeMeters = ((under?.northRad ?? 0) - (under?.southRad ?? 0)) * 6378137;
    expect(sizeMeters).toBeLessThan(2000);
    expect(count).toBeLessThan(2000);
  });

  it('culls the far side of the globe', () => {
    const count = selectSurfaceTiles(camera(0, 0, 1e6), { maxScreenErrorPx: 1, maxLevel: 26 }, out);
    expect(out.slice(0, count).every((t) => t.eastRad > -Math.PI / 2 && t.westRad < Math.PI / 2)).toBe(true);
  });

  it('refines every visible tile at least to the minimum level', () => {
    const coarse = selectSurfaceTiles(camera(0, 0, 2e7), { maxScreenErrorPx: 1, maxLevel: 26 }, out);
    const count = selectSurfaceTiles(camera(0, 0, 2e7), { maxScreenErrorPx: 1, maxLevel: 26, minLevel: 5 }, out);
    expect(out.slice(0, count).every((t) => t.level >= 5)).toBe(true);
    expect(count).toBeGreaterThan(coarse * 4);
  });
});

describe('buildTileMesh', () => {
  it('stores small float32 offsets from a float64 origin, with skirts and shared indices', () => {
    const mesh = buildTileMesh(7, 0, 40 * DEG, 0.001, 40 * DEG + 0.001, 1);
    const vertices = (TILE_SEGMENTS + 1) ** 2 + 4 * (TILE_SEGMENTS + 1);
    expect(mesh.positions.length).toBe(vertices * 3);
    expect(Math.max(...mesh.positions.map(Math.abs))).toBeLessThan(10000);
    expect(mesh.indices).toBe(tileIndices());
    expect(Math.max(...mesh.indices)).toBe(vertices - 1);
    expect(mesh.uvs.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});

describe('surface coverage (KB-012)', () => {
  const tiles: SurfaceTile[] = [];
  const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };

  test.prop([
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.double({ min: -85, max: 85, noNaN: true }),
    // Ranges from 1 m to orbit, log-distributed.
    fc.double({ min: 0, max: 7.3, noNaN: true }).map((exponent) => 10 ** exponent),
    fc.double({ min: 0, max: 360, noNaN: true }),
    fc.double({ min: 0, max: 70, noNaN: true }),
  ])('every pixel that shows the ellipsoid lies in a selected tile', (lon, lat, range, heading, tilt) => {
    const c = camera(lon, lat, range, tilt);
    c.pose.headingRad = heading * DEG;
    c.update();
    const count = selectSurfaceTiles(c, { maxScreenErrorPx: 1, maxLevel: 25 }, tiles);
    for (let y = 0; y <= c.heightPx; y += c.heightPx / 8) {
      for (let x = 0; x <= c.widthPx; x += c.widthPx / 8) {
        if (!c.pickEllipsoid(x, y, hit)) continue;
        const covered = tiles
          .slice(0, count)
          .some(
            (t) =>
              t.westRad <= hit.longitudeRad + 1e-12 &&
              t.eastRad >= hit.longitudeRad - 1e-12 &&
              t.southRad <= hit.latitudeRad + 1e-12 &&
              t.northRad >= hit.latitudeRad - 1e-12,
          );
        expect(covered, `pixel (${x}, ${y}) at ${hit.longitudeRad / DEG}°, ${hit.latitudeRad / DEG}°`).toBe(true);
      }
    }
  });
});
