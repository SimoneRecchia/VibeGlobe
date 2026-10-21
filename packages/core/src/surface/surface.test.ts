import { describe, expect, it } from 'vitest';
import { buildQuadtreeTileMesh, buildTileMesh, tileIndices, TILE_SEGMENTS, type TileMeshData } from './surface-mesh.js';
import {
  MERCATOR_ROOT,
  NORTH_CAP,
  quadtreeRowLatitudeRad,
  quadtreeTileBounds,
  type QuadtreeTile,
} from './surface-quadtree.hot.js';

const DEG = Math.PI / 180;

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

describe('tile-local texture coordinates (M3 plan §2.4)', () => {
  const GRID = TILE_SEGMENTS + 1;
  const uvw = (mesh: TileMeshData, vertex: number): number[] =>
    Array.from(mesh.uvs.subarray(vertex * 3, vertex * 3 + 3));
  const blank = (): QuadtreeTile => ({
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

  it('gives each vertex u east and v south across the tile, in Mercator y and in latitude', () => {
    const tile = quadtreeTileBounds(MERCATOR_ROOT, 4, 9, 5, 1, blank());
    const mesh = buildQuadtreeTileMesh(tile, 1);
    expect(mesh.uvs.length).toBe(((TILE_SEGMENTS + 1) ** 2 + 4 * (TILE_SEGMENTS + 1)) * 3);
    expect(uvw(mesh, 0)).toEqual([0, 0, 0]);
    expect(uvw(mesh, GRID * GRID - 1)).toEqual([1, 1, 1]);
    // The middle row is half way down in Mercator y, but not in latitude.
    const middle = (TILE_SEGMENTS / 2) * GRID;
    const latRad = quadtreeRowLatitudeRad(tile, TILE_SEGMENTS / 2);
    expect(uvw(mesh, middle)[1]).toBe(0.5);
    expect(uvw(mesh, middle)[2]).toBeCloseTo((tile.northRad - latRad) / (tile.northRad - tile.southRad), 6);
    expect(uvw(mesh, middle)[2]).not.toBeCloseTo(0.5, 3);
  });

  it('gives cap tiles and geographic tiles the same v in both schemes, and skirts the coordinates of their edge', () => {
    const cap = buildQuadtreeTileMesh(quadtreeTileBounds(NORTH_CAP, 3, 2, 1, 1, blank()), 1);
    const flat = buildTileMesh(7, 0, 40 * DEG, 0.001, 40 * DEG + 0.001, 1);
    for (const mesh of [cap, flat]) {
      for (let vertex = 0; vertex < GRID * GRID; vertex++)
        expect(uvw(mesh, vertex)[1]).toBeCloseTo(uvw(mesh, vertex)[2] ?? NaN, 6);
      // The first skirt runs along the north edge.
      expect(uvw(mesh, GRID * GRID)[1]).toBe(0);
      expect(uvw(mesh, GRID * GRID + 4 * GRID - 1)).toEqual(uvw(mesh, 0));
    }
  });
});
