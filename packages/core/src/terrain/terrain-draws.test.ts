import { describe, expect, it } from 'vitest';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import {
  MERCATOR_ROOT,
  NORTH_CAP,
  quadtreeTileBounds,
  quadtreeTileKey,
  type QuadtreeTile,
} from '../surface/surface-quadtree.hot.js';
import type { HeightGrid } from './heightmap.js';
import { Camera } from '../camera/camera.js';
import { DrawList } from '../imagery/draw-list.js';
import type { ImageryLoader } from '../imagery/imagery-loader.hot.js';
import {
  drawTerrain,
  previousLevel,
  ShownLevels,
  TERRAIN_LEVEL_OFFSET,
  terrainErrorsBySurfaceLevel,
  terrainHeightRange,
  type TerrainLayer,
} from './terrain-draws.js';
import type { TerrainHeights } from './terrain-heights.js';
import type { TerrainSource } from './terrain-source.js';

const source = {
  id: 'errors',
  tiling: WEB_MERCATOR_TILING,
  minLevel: 0,
  maxLevel: 10,
  geometricErrorMeters: (level: number) => 10_000 / 2 ** level,
} as unknown as TerrainSource;

describe('terrainErrorsBySurfaceLevel', () => {
  it('follows the terrain level a surface level shows, and halves per level beyond the finest one (KB-080)', () => {
    const errors = terrainErrorsBySurfaceLevel(source, 24);
    const finest = 10 + TERRAIN_LEVEL_OFFSET;
    // Each surface level up to the finest shows a finer terrain level: its error halves.
    for (let level = TERRAIN_LEVEL_OFFSET + 1; level <= finest; level++)
      expect(errors[level]).toBeCloseTo((errors[level - 1] ?? 0) / 2, 9);
    // Beyond, neighbors show the same grid with finer meshes: the error keeps halving instead of staying the finest's.
    for (let level = finest + 1; level <= 24; level++)
      expect(errors[level]).toBeCloseTo((errors[level - 1] ?? 0) / 2, 9);
  });
});

describe('previousLevel', () => {
  const tile = (root: 0 | 1 | 2, level: number, x: number, y: number): QuadtreeTile => ({
    key: quadtreeTileKey(root, level, x, y),
    root,
    level,
    x,
    y,
    span: 1,
    westRad: 0,
    southRad: 0,
    eastRad: 0,
    northRad: 0,
  });

  it('finds the terrain shown last frame up to two levels above or below, on every root (F138)', () => {
    const shown = new IntegerKeyMap<number>();
    // Refined by two levels in one frame: the grandparent was drawn.
    shown.set(quadtreeTileKey(MERCATOR_ROOT, 8, 33, 22), 6);
    expect(previousLevel(tile(MERCATOR_ROOT, 10, 133, 89), shown)).toBe(6);
    // Coarsened by two levels: the finest of the grandchildren drawn.
    shown.set(quadtreeTileKey(MERCATOR_ROOT, 7, 20, 13), 5);
    shown.set(quadtreeTileKey(MERCATOR_ROOT, 7, 21, 14), 7);
    expect(previousLevel(tile(MERCATOR_ROOT, 5, 5, 3), shown)).toBe(7);
    // Three levels away is a switch, not a morph (KB-079).
    expect(previousLevel(tile(MERCATOR_ROOT, 11, 266, 178), shown)).toBe(-1);
    // A polar cap tile morphs too.
    shown.set(quadtreeTileKey(NORTH_CAP, 3, 2, 1), 4);
    expect(previousLevel(tile(NORTH_CAP, 4, 4, 3), shown)).toBe(4);
    // Cap tiles of span 2 (after a two-way split) split into four at columns 2x and 2x + 2: the right-hand children
    // find their parent, and a coarsened parent finds them.
    shown.set(quadtreeTileKey(NORTH_CAP, 6, 8, 2), 5);
    expect(previousLevel({ ...tile(NORTH_CAP, 7, 18, 5), span: 2 }, shown)).toBe(5);
    shown.set(quadtreeTileKey(NORTH_CAP, 9, 22, 4), 7);
    expect(previousLevel({ ...tile(NORTH_CAP, 8, 10, 2), span: 2 }, shown)).toBe(7);
  });
});

describe('terrainHeightRange', () => {
  it('counts the error of a mesh that samples only every fourth vertex of a fine grid (KB-097)', () => {
    // One terrain tile of 256 cells, flat but for a 1,000 m spike on a vertex between the mesh's samples: a surface
    // tile two levels deeper shows a quarter of it (64 cells) through 16 segments, so its mesh never reaches the spike.
    const cells = 256;
    const heightsMeters = new Float32Array((cells + 1) ** 2);
    heightsMeters[2 * (cells + 1) + 2] = 1000;
    const grid: HeightGrid = { cells, heightsMeters, minMeters: 0, maxMeters: 1000, errorMeters: 0 };
    const source = { tiling: WEB_MERCATOR_TILING, minLevel: 0, maxLevel: 0 } as TerrainSource;
    const layer = {
      source,
      loader: { peekHandle: (level: number) => (level === 0 ? 7 : -1) },
      gridErrorMeters: Float64Array.of(10),
    } as unknown as TerrainLayer;
    const heights = { grid: (handle: number) => (handle === 7 ? grid : undefined) } as unknown as TerrainHeights;
    const mercatorLat = (y: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
    const surface: QuadtreeTile = {
      key: quadtreeTileKey(MERCATOR_ROOT, TERRAIN_LEVEL_OFFSET, 0, 0),
      root: MERCATOR_ROOT,
      level: TERRAIN_LEVEL_OFFSET,
      x: 0,
      y: 0,
      span: 1,
      westRad: -Math.PI,
      eastRad: -Math.PI / 2,
      northRad: mercatorLat(0),
      southRad: mercatorLat(0.25),
    };
    const out = new Float64Array(4);
    expect(terrainHeightRange(layer, heights, surface, out)).toBe(true);
    // What finer surface levels may add covers the spike the mesh skips, so the selection refines the tile.
    expect(out[2]).toBeGreaterThanOrEqual(1000);
  });
});

const surfaceTile = (level: number, x: number, y: number): QuadtreeTile =>
  quadtreeTileBounds(MERCATOR_ROOT, level, x, y, 1, {
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

describe('drawTerrain', () => {
  it('asks for no terrain tile below one known missing: an empty level of the service costs no request (F640)', () => {
    const wanted: number[] = [];
    // The service has levels 0 to 13 here: level 14 answered 404, so 15 to 17 cannot exist.
    const loader = {
      want: (level: number) => {
        wanted.push(level);
        return -1;
      },
      readyHandle: () => -1,
      unavailable: (level: number) => level === 14,
      markDrawn: () => undefined,
    } as unknown as ImageryLoader;
    const terrain = { ...source, maxLevel: 17 } as TerrainSource;
    const layer: TerrainLayer = {
      source: terrain,
      loader,
      shown: new ShownLevels(),
      gridErrorMeters: new Float64Array(18),
    };
    const level = 17 + TERRAIN_LEVEL_OFFSET;
    const tile = surfaceTile(level, 2 ** (level - 1), 2 ** (level - 1));
    const camera = new Camera();
    camera.widthPx = 800;
    camera.heightPx = 600;
    camera.update();
    drawTerrain(new DrawList(1), [tile], 1, layer, camera);
    expect(Math.max(...wanted)).toBe(13);
    expect(wanted).toContain(0);
  });
});
