import { describe, expect, it } from 'vitest';
import { DrawList } from '../imagery/draw-list.js';
import { WEB_MERCATOR_MAX_LATITUDE_RAD } from '../projections/web-mercator.js';
import { MERCATOR_ROOT, NORTH_CAP, quadtreeTileKey, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { TerrainLayer } from './terrain-draws.js';
import { stitchTerrainEdges } from './terrain-stitch.hot.js';

function tile(root: 0 | 1 | 2, level: number, x: number, y: number, northRad = 0, southRad = 0): QuadtreeTile {
  return {
    key: quadtreeTileKey(root, level, x, y),
    root,
    level,
    x,
    y,
    span: 1,
    westRad: 0,
    southRad,
    eastRad: 0,
    northRad,
  } as QuadtreeTile;
}

/** Terrain tiles as handles `level × 10000 + y × 100 + x`, all resident except `missing`; records kept handles. */
function layer(crs: string, missing: number[] = []) {
  const drawn: number[] = [];
  const loader = {
    coordOf: (handle: number) => ({
      level: Math.floor(handle / 10000),
      y: Math.floor((handle % 10000) / 100),
      x: handle % 100,
    }),
    readyHandle: (level: number, x: number, y: number) => {
      const handle = level * 10000 + y * 100 + x;
      return missing.includes(handle) ? -1 : handle;
    },
    markDrawn: (handle: number) => drawn.push(handle),
  };
  return { drawn, layer: { loader, source: { tiling: { crs } } } as unknown as TerrainLayer };
}

/** A list whose draw `i` shows the terrain tile `handles[i]` through the transform `transforms[i]`. */
function list(handles: number[], transforms: number[][]): DrawList {
  const draws = new DrawList(8);
  draws.count = handles.length;
  handles.forEach((handle, i) => {
    draws.terrain.set(i, handle, Math.floor(handle / 10000), 0, new Float64Array(transforms[i] ?? [1, 1, 0, 0]));
  });
  return draws;
}

describe('stitchTerrainEdges', () => {
  it("takes an edge's heights from the coarser terrain its neighbor shows, through the ancestor of its own (KB-178)", () => {
    // Level 12 tile (5, 6) shows terrain tile 10/(1, 1), the quarter (1, 2) of it; its east neighbor, the level 11
    // tile (3, 3), shows terrain level 9, and its west neighbor (4, 6) the same terrain as it.
    const tiles = [tile(MERCATOR_ROOT, 12, 5, 6), tile(MERCATOR_ROOT, 11, 3, 3), tile(MERCATOR_ROOT, 12, 4, 6)];
    const own = 10 * 10000 + 1 * 100 + 1;
    const draws = list(
      [own, 9 * 10000, own],
      [
        [0.25, 0.25, 0.25, 0.5],
        [0.25, 0.25, 0.75, 0.75],
        [0.25, 0.25, 0, 0.5],
      ],
    );
    const { layer: terrain, drawn } = layer('EPSG:3857');
    stitchTerrainEdges(draws, tiles, 3, terrain);
    const t = draws.terrain;
    // Bit 0: the stitch texture; the top three bits: the neighbor's mesh one level coarser (KB-302).
    expect([...t.stitchEdges.subarray(0, 4)]).toEqual([0, 1 + (1 << 5), 0, 0]);
    // Terrain tile 9/(0, 0) holds 10/(1, 1) in its south-east quarter.
    expect(t.stitchTextures[0]).toBe(9 * 10000);
    expect([...t.stitchTransforms.subarray(0, 4)]).toEqual([0.125, 0.125, 0.625, 0.75]);
    expect(drawn).toEqual([9 * 10000]);
    // The coarser tile and the west neighbor of the same detail keep their edges.
    expect([...t.stitchEdges.subarray(4, 12)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([t.stitchTextures[1], t.stitchTextures[2]]).toEqual([-1, -1]);
  });

  it('marks an edge next to a coarser mesh showing the same terrain with the levels between them, at most four (KB-302)', () => {
    // Level 12 tile (64, 64); its north neighbor is the level 11 tile (32, 31), its west one the level 6 tile (0, 1),
    // six levels coarser; all three show the same terrain tile, so no edge takes the stitch texture.
    const tiles = [tile(MERCATOR_ROOT, 12, 64, 64), tile(MERCATOR_ROOT, 11, 32, 31), tile(MERCATOR_ROOT, 6, 0, 1)];
    const own = 6 * 10000 + 1 * 100 + 1;
    const draws = list([own, own, own], [[1 / 64, 1 / 64, 0, 0]]);
    stitchTerrainEdges(draws, tiles, 3, layer('EPSG:3857').layer);
    expect([...draws.terrain.stitchEdges.subarray(0, 4)]).toEqual([1 << 5, 0, 0, 4 << 5]);
    expect(draws.terrain.stitchTextures[0]).toBe(-1);
  });

  it('stitches only to the coarsest neighbor, and not at all when its terrain tile is not resident (KB-178)', () => {
    // North neighbor at terrain level 6, east one at 8.
    const tiles = [tile(MERCATOR_ROOT, 12, 1, 2), tile(MERCATOR_ROOT, 12, 1, 1), tile(MERCATOR_ROOT, 12, 2, 2)];
    const draws = list([100000, 60000, 80000], [[0.25, 0.25, 0.25, 0.5]]);
    stitchTerrainEdges(draws, tiles, 3, layer('EPSG:3857').layer);
    expect([...draws.terrain.stitchEdges.subarray(0, 4)]).toEqual([1, 0, 0, 0]);
    expect(draws.terrain.stitchTextures[0]).toBe(60000);
    stitchTerrainEdges(draws, tiles, 3, layer('EPSG:3857', [60000]).layer);
    expect([...draws.terrain.stitchEdges.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("fades a polar cap's heights over Web Mercator terrain from the 85.05° edge to the pole (KB-180)", () => {
    const edge = WEB_MERCATOR_MAX_LATITUDE_RAD;
    const middle = (edge + Math.PI / 2) / 2;
    const tiles = [tile(NORTH_CAP, 1, 0, 1, middle, edge), tile(NORTH_CAP, 1, 0, 0, Math.PI / 2, middle)];
    const draws = list(
      [30000, 30000],
      [
        [1, 0, 0, 0],
        [1, 0, 0, 0],
      ],
    );
    stitchTerrainEdges(draws, tiles, 2, layer('EPSG:3857').layer);
    const scales = [...draws.terrain.heightScales.subarray(0, 4)];
    expect(scales[0]).toBeCloseTo(0.5, 6);
    expect(scales[1]).toBeCloseTo(1, 6);
    expect(scales[2]).toBeCloseTo(0, 6);
    expect(scales[3]).toBeCloseTo(0.5, 6);
    // A geographic terrain covers the caps with its own heights.
    stitchTerrainEdges(draws, tiles, 2, layer('EPSG:4326').layer);
    expect([...draws.terrain.heightScales.subarray(0, 4)]).toEqual([1, 1, 1, 1]);
  });
});
