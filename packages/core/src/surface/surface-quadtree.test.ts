import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { ecefToGeodetic } from '../geodesy/ecef.js';
import { buildQuadtreeTileMesh, tileIndices } from './surface-mesh.js';
import { WEB_MERCATOR_MAX_LATITUDE_RAD } from '../projections/web-mercator.js';
import { packTileKey } from '../tiling/tile-key.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import {
  MERCATOR_ROOT,
  NORTH_CAP,
  QUADTREE_SEGMENTS,
  quadtreeRowLatitudeRad,
  quadtreeTileBounds,
  quadtreeTileKey,
  selectQuadtreeTiles,
  SOUTH_CAP,
  type QuadtreeSelectionOptions,
  type QuadtreeTile,
} from './surface-quadtree.hot.js';

const DEG = Math.PI / 180;
const tile = (): QuadtreeTile => ({
  key: 0,
  root: 0,
  level: 0,
  x: 0,
  y: 0,
  span: 1,
  westRad: 0,
  southRad: 0,
  eastRad: 0,
  northRad: 0,
});

function camera(lonDeg: number, latDeg: number, range: number, tiltDeg = 0, headingDeg = 0): Camera {
  const c = new Camera();
  c.widthPx = 960;
  c.heightPx = 540;
  Object.assign(c.pose, {
    targetLongitudeRad: lonDeg * DEG,
    targetLatitudeRad: latDeg * DEG,
    rangeMeters: range,
    tiltRad: tiltDeg * DEG,
    headingRad: headingDeg * DEG,
  });
  c.update();
  return c;
}

/** True when a tile contains a position, edges included. */
const contains = (t: QuadtreeTile, lonRad: number, latRad: number): boolean =>
  t.westRad <= lonRad + 1e-12 &&
  t.eastRad >= lonRad - 1e-12 &&
  t.southRad <= latRad + 1e-12 &&
  t.northRad >= latRad - 1e-12;

describe('the three-root surface quadtree (ADR 0006 §1)', () => {
  it('cuts the Mercator root exactly like the Web Mercator tiling scheme, with packed keys', () => {
    const extent = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
    for (const [level, x, y] of [
      [0, 0, 0],
      [3, 5, 2],
      [10, 511, 340],
    ] as const) {
      const t = quadtreeTileBounds(MERCATOR_ROOT, level, x, y, 1, tile());
      WEB_MERCATOR_TILING.tileExtent({ root: 0, level, x, y }, extent);
      expect([t.westRad, t.southRad, t.eastRad, t.northRad]).toEqual([
        extent.westRad,
        extent.southRad,
        extent.eastRad,
        extent.northRad,
      ]);
      expect(t.key).toBe(packTileKey({ root: 0, level, x, y }, 1, 1));
    }
    expect(quadtreeTileKey(NORTH_CAP, 4, 3, 2)).toBe(packTileKey({ root: 1, level: 4, x: 3, y: 2 }, 1, 1));
  });

  it('closes the poles with geographic caps that meet the Mercator root without a gap', () => {
    const north = quadtreeTileBounds(NORTH_CAP, 0, 0, 0, 1, tile());
    const south = quadtreeTileBounds(SOUTH_CAP, 0, 0, 0, 1, tile());
    const mercator = quadtreeTileBounds(MERCATOR_ROOT, 0, 0, 0, 1, tile());
    expect([north.northRad, north.southRad]).toEqual([Math.PI / 2, WEB_MERCATOR_MAX_LATITUDE_RAD]);
    expect([south.northRad, south.southRad]).toEqual([-WEB_MERCATOR_MAX_LATITUDE_RAD, -Math.PI / 2]);
    expect([mercator.northRad, mercator.southRad]).toEqual([north.southRad, south.northRad]);
    // The last row of a cap at any level reaches the pole exactly.
    expect(quadtreeTileBounds(NORTH_CAP, 7, 0, 0, 1, tile()).northRad).toBe(Math.PI / 2);
    expect(quadtreeTileBounds(SOUTH_CAP, 7, 0, 127, 1, tile()).southRad).toBe(-Math.PI / 2);
  });

  it('spaces Mercator mesh rows evenly in Mercator y, from the tile edge to edge', () => {
    const t = quadtreeTileBounds(MERCATOR_ROOT, 2, 1, 1, 1, tile());
    expect(quadtreeRowLatitudeRad(t, 0)).toBe(t.northRad);
    expect(quadtreeRowLatitudeRad(t, QUADTREE_SEGMENTS)).toBe(t.southRad);
    const y = (lat: number): number => Math.asinh(Math.tan(lat));
    const steps = Array.from(
      { length: QUADTREE_SEGMENTS },
      (_, row) => y(quadtreeRowLatitudeRad(t, row)) - y(quadtreeRowLatitudeRad(t, row + 1)),
    );
    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 12);
  });

  test.prop([
    fc.constantFrom(MERCATOR_ROOT, NORTH_CAP, SOUTH_CAP),
    fc.integer({ min: 0, max: 20 }),
    fc.double({ min: 0, max: 0.999999, noNaN: true }),
    fc.double({ min: 0, max: 0.999999, noNaN: true }),
  ])('gives every tile of every root its own key', (root, level, u, v) => {
    const n = 2 ** level;
    const x = Math.floor(u * n);
    const y = Math.floor(v * n);
    const key = quadtreeTileKey(root, level, x, y);
    expect(Number.isSafeInteger(key)).toBe(true);
    for (const other of [MERCATOR_ROOT, NORTH_CAP, SOUTH_CAP] as const) {
      if (other !== root) expect(quadtreeTileKey(other, level, x, y)).not.toBe(key);
    }
    if (x + 1 < n) expect(quadtreeTileKey(root, level, x + 1, y)).not.toBe(key);
  });
});

describe('selectQuadtreeTiles', () => {
  const out: QuadtreeTile[] = [];

  it('draws a handful of tiles from orbit, all at least at the minimum level', () => {
    const count = selectQuadtreeTiles(camera(0, 0, 2e7), { maxScreenErrorPx: 1, maxLevel: 25 }, out);
    expect(count).toBeGreaterThan(4);
    expect(count).toBeLessThan(200);
    expect(out.slice(0, count).every((t) => t.level >= 2)).toBe(true);
    expect(out.slice(0, count).some((t) => contains(t, 0, 0))).toBe(true);
  });

  it('skips tiles outside the view frustum (F086)', () => {
    // Low over the equator, looking straight down: the antipode's longitudes are in view nowhere.
    const count = selectQuadtreeTiles(camera(0, 0, 5e5), { maxScreenErrorPx: 1, maxLevel: 25 }, out);
    const drawn = out.slice(0, count);
    expect(drawn.every((t) => t.eastRad > -60 * DEG && t.westRad < 60 * DEG)).toBe(true);
    expect(drawn.every((t) => t.southRad < 60 * DEG && t.northRad > -60 * DEG)).toBe(true);
  });

  it('skips tiles hidden behind the curve of the Earth (F087)', () => {
    // Tilted toward the horizon from 1 km: the frustum reaches far, the horizon at about 113 km cuts it.
    const c = camera(9.19, 45.46, 1000, 85);
    const count = selectQuadtreeTiles(c, { maxScreenErrorPx: 1, maxLevel: 25 }, out);
    const eye = c.eyeEcef;
    const w = [(eye[0] ?? 0) / 6378137 ** 2, (eye[1] ?? 0) / 6378137 ** 2, (eye[2] ?? 0) / 6356752.314245 ** 2];
    // Every drawn tile has some point that can be above the horizon: no tile lies wholly behind it.
    for (const t of out.slice(0, count)) {
      const lon = (t.westRad + t.eastRad) / 2;
      const lat = (t.southRad + t.northRad) / 2;
      const r = 6378137 * Math.cos(lat);
      const center = [r * Math.cos(lon), r * Math.sin(lon), 6356752.314245 * Math.sin(lat)];
      const halfDiagonal = 6378137 * Math.hypot(t.eastRad - t.westRad, t.northRad - t.southRad);
      const reach =
        (center[0] ?? 0) * (w[0] ?? 0) +
        (center[1] ?? 0) * (w[1] ?? 0) +
        (center[2] ?? 0) * (w[2] ?? 0) +
        halfDiagonal * Math.hypot(...w);
      expect(reach).toBeGreaterThanOrEqual(1);
    }
    expect(count).toBeLessThan(3000);
  });

  it('keeps tiles whose relief can rise above the horizon, and refines while the terrain error shows (F142, F126)', () => {
    // From 1 km, tilted toward the horizon: tiles wholly behind the ellipsoid's horizon (about 113 km away) are culled,
    // but a 4,000 m peak stays visible to about 340 km, so with the terrain's heights more tiles stay drawn.
    const c = camera(9.19, 45.46, 1000, 85, 0);
    const flat = { maxScreenErrorPx: 1, maxLevel: 25 };
    const flatCount = selectQuadtreeTiles(c, flat, out);
    const relief: QuadtreeSelectionOptions = { ...flat, terrainMaxMeters: 4000, terrainMinMeters: -100 };
    expect(selectQuadtreeTiles(c, relief, out)).toBeGreaterThan(flatCount);
    // Terrain whose error is large next to the ellipsoid's chord sag refines the view further.
    const nadir = camera(7, 46, 50_000);
    const deepest = (options: QuadtreeSelectionOptions): number =>
      Math.max(...out.slice(0, selectQuadtreeTiles(nadir, options, out)).map((t) => t.level));
    const errors = new Float64Array(26).map((_, level) => 4e6 / 2 ** level);
    expect(deepest({ ...flat, terrainErrorMeters: errors, terrainMaxLevel: 25 })).toBeGreaterThan(deepest(flat));
  });

  it('refines to tiles small enough for float32 offsets at 1 m altitude (ADR 0004)', () => {
    const count = selectQuadtreeTiles(camera(9.19, 45.46, 1), { maxScreenErrorPx: 1, maxLevel: 25 }, out);
    const under = out.slice(0, count).find((t) => contains(t, 9.19 * DEG, 45.46 * DEG));
    expect(under).toBeDefined();
    expect(((under?.northRad ?? 0) - (under?.southRad ?? 0)) * 6378137).toBeLessThan(2000);
    expect(count).toBeLessThan(2000);
  });

  describe('refinement by imagery texel size (F081, ADR 0006 §2)', () => {
    const imagery = { maxScreenErrorPx: 1, maxLevel: 25, imageryTexelsPerTile: 256, imageryMaxLevel: 18 };
    const pixelsPerRadian = 540 / (2 * Math.tan(Math.PI / 8));
    const texelPx = (t: QuadtreeTile, distance: number): number =>
      ((6378137 * Math.cos((t.northRad + t.southRad) / 2) * (t.eastRad - t.westRad)) / 256 / distance) *
      pixelsPerRadian;

    it('refines the tile under a nadir view until a texel covers at most 1.5 pixels, and no further', () => {
      const range = 2e5;
      const count = selectQuadtreeTiles(camera(12.5, 41.9, range), imagery, out);
      const under = out.slice(0, count).find((t) => contains(t, 12.5 * DEG, 41.9 * DEG));
      expect(under).toBeDefined();
      if (!under) return;
      expect(texelPx(under, range)).toBeLessThanOrEqual(1.5);
      // Its parent's texels were too coarse: the tile is not finer than the threshold needs.
      expect(texelPx(under, range) * 2).toBeGreaterThan(1.5 * 0.6);
      // Geometry alone stops much coarser (the next selection reuses the records, so the level is read first).
      const level = under.level;
      const geometric = selectQuadtreeTiles(camera(12.5, 41.9, range), { maxScreenErrorPx: 1, maxLevel: 25 }, out);
      const coarse = out.slice(0, geometric).find((t) => contains(t, 12.5 * DEG, 41.9 * DEG));
      expect(coarse?.level ?? 99).toBeLessThan(level);
    });

    it('draws finer tiles near the camera than toward the horizon in a tilted view', () => {
      const count = selectQuadtreeTiles(camera(12.5, 41.9, 2e4, 70), imagery, out);
      const drawn = out.slice(0, count);
      const near = drawn.find((t) => contains(t, 12.5 * DEG, 41.9 * DEG));
      const coarsest = Math.min(...drawn.map((t) => t.level));
      expect(near?.level ?? 0).toBeGreaterThan(coarsest + 2);
    });

    it('stops refining for texels at the finest level of the source', () => {
      const count = selectQuadtreeTiles(camera(12.5, 41.9, 2e3), { ...imagery, imageryMaxLevel: 9 }, out);
      const level = out.slice(0, count).find((t) => contains(t, 12.5 * DEG, 41.9 * DEG))?.level;
      const geometric = selectQuadtreeTiles(camera(12.5, 41.9, 2e3), { maxScreenErrorPx: 1, maxLevel: 25 }, out);
      const coarse = out.slice(0, geometric).find((t) => contains(t, 12.5 * DEG, 41.9 * DEG));
      expect(level).toBe(Math.max(9, coarse?.level ?? 0));
    });
  });

  it('culls the far side of the globe', () => {
    const count = selectQuadtreeTiles(camera(0, 0, 1e6), { maxScreenErrorPx: 1, maxLevel: 25 }, out);
    expect(out.slice(0, count).every((t) => t.eastRad > -Math.PI / 2 && t.westRad < Math.PI / 2)).toBe(true);
  });

  it('refines every visible tile at least to the minimum level', () => {
    const coarse = selectQuadtreeTiles(camera(0, 0, 2e7), { maxScreenErrorPx: 1, maxLevel: 25 }, out);
    const count = selectQuadtreeTiles(camera(0, 0, 2e7), { maxScreenErrorPx: 1, maxLevel: 25, minLevel: 5 }, out);
    expect(out.slice(0, count).every((t) => t.level >= 5)).toBe(true);
    expect(count).toBeGreaterThan(coarse * 4);
  });

  it.each([
    ['above the north pole at 1 m', 0, 90, 1, 0],
    ['beside the north pole, tilted', 30, 89.99, 50, 60],
    ['above the south pole at 10 m', -120, -90, 10, 0],
  ])('keeps the tile count bounded %s, with caps all around the pole', (_, lon, lat, range, tilt) => {
    const count = selectQuadtreeTiles(camera(lon, lat, range, tilt), { maxScreenErrorPx: 1, maxLevel: 25 }, out);
    expect(count).toBeLessThan(1000);
    const pole = lat > 0 ? Math.PI / 2 : -Math.PI / 2;
    const ring = out.slice(0, count).filter((t) => Math.abs((lat > 0 ? t.northRad : t.southRad) - pole) < 1e-12);
    expect(ring.every((t) => t.root === (lat > 0 ? NORTH_CAP : SOUTH_CAP))).toBe(true);
    expect(ring.reduce((sum, t) => sum + (t.eastRad - t.westRad), 0)).toBeCloseTo(2 * Math.PI, 9);
  });

  const hit = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
  test.prop([
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.double({ min: -90, max: 90, noNaN: true }),
    fc.double({ min: 0, max: 7.3, noNaN: true }).map((exponent) => 10 ** exponent),
    fc.double({ min: 0, max: 360, noNaN: true }),
    fc.double({ min: 0, max: 70, noNaN: true }),
  ])(
    'covers every pixel that shows the ellipsoid, poles and antimeridian included',
    (lon, lat, range, heading, tilt) => {
      const c = camera(lon, lat, range, tilt, heading);
      const count = selectQuadtreeTiles(c, { maxScreenErrorPx: 1, maxLevel: 25 }, out);
      for (let y = 0; y <= c.heightPx; y += c.heightPx / 8) {
        for (let x = 0; x <= c.widthPx; x += c.widthPx / 8) {
          if (!c.pickEllipsoid(x, y, hit)) continue;
          const covered = out.slice(0, count).some((t) => contains(t, hit.longitudeRad, hit.latitudeRad));
          expect(covered, `pixel (${x}, ${y}) at ${hit.longitudeRad / DEG}°, ${hit.latitudeRad / DEG}°`).toBe(true);
        }
      }
    },
  );
});

describe('buildQuadtreeTileMesh', () => {
  it('puts each row at its quadtree latitude, as small float32 offsets from a float64 origin', () => {
    const t = quadtreeTileBounds(MERCATOR_ROOT, 12, 2150, 1460, 1, tile());
    const mesh = buildQuadtreeTileMesh(t, 10);
    expect(mesh.key).toBe(t.key);
    expect(mesh.indices).toBe(tileIndices());
    expect(Math.max(...mesh.positions.map(Math.abs))).toBeLessThan(20000);
    const point = new Float64Array(3);
    const geodetic = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    for (const row of [0, 5, QUADTREE_SEGMENTS]) {
      const index = row * (QUADTREE_SEGMENTS + 1) + 3;
      for (let i = 0; i < 3; i++) point[i] = (mesh.positions[index * 3 + i] ?? 0) + (mesh.originEcef[i] ?? 0);
      ecefToGeodetic(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0, geodetic);
      expect(geodetic.latitudeRad).toBeCloseTo(quadtreeRowLatitudeRad(t, row), 8);
    }
  });

  it('closes a cap tile at the pole', () => {
    const t = quadtreeTileBounds(NORTH_CAP, 3, 0, 0, 4, tile());
    const mesh = buildQuadtreeTileMesh(t, 10);
    const point = new Float64Array(3);
    for (let i = 0; i < 3; i++) point[i] = (mesh.positions[i] ?? 0) + (mesh.originEcef[i] ?? 0);
    expect(Math.hypot(point[0] ?? 0, point[1] ?? 0)).toBeLessThan(1e-6 * 6378137);
  });
});
