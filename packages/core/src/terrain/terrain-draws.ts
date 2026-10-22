import type { Camera } from '../camera/camera.js';
import { NO_TERRAIN } from '../globe/types.js';
import { screenDistance } from '../imagery/imagery-draws.js';
import type { DrawList } from '../imagery/draw-list.js';
import { ARRIVING, type ImageryLoader } from '../imagery/imagery-loader.hot.js';
import {
  MAPPING_LEVEL,
  MAPPING_OFFSET_U,
  MAPPING_OFFSET_V,
  MAPPING_SCALE_U,
  MAPPING_SCALE_V,
  MAPPING_X,
  MAPPING_Y,
  mapAncestor,
  mapGeographic,
  mapMercator,
} from '../imagery/imagery-mapping.hot.js';
import { TILE_SEGMENTS } from '../surface/surface-mesh.js';
import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import { MERCATOR_ROOT, NORTH_CAP, quadtreeTileKey, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { TerrainHeights } from './terrain-heights.js';
import type { TerrainSource } from './terrain-source.js';

/** The terrain of one engine instance: its source, the loader of its height grids and the levels its tiles showed. */
export interface TerrainLayer {
  readonly source: TerrainSource;
  readonly loader: ImageryLoader;
  readonly shown: ShownLevels;
  /** The error of each terrain level's grid, meters, by level: what finer levels may add to its heights. */
  readonly gridErrorMeters: Float64Array;
}

/** {@link TerrainLayer.gridErrorMeters} of a source: computed once, so per-tile code reads an array. */
export function gridErrorsByLevel(source: TerrainSource): Float64Array {
  const errors = new Float64Array(source.maxLevel + 1);
  for (let level = 0; level <= source.maxLevel; level++)
    errors[level] = GRID_ERROR_FACTOR * source.geometricErrorMeters(level);
  return errors;
}

/** The terrain level each drawn tile showed in the last frame and in this one, by surface tile key. */
export class ShownLevels {
  previous = new IntegerKeyMap<number>(1024);
  current = new IntegerKeyMap<number>(1024);

  /** Ends a frame: this frame's levels become the previous ones. */
  swap(): void {
    const previous = this.previous;
    this.previous = this.current;
    this.current = previous;
    this.current.clear();
  }
}

/** Height-grid cells per side of the finest grid a terrain tile decodes to (ADR 0006 §5). */
const MAX_GRID_CELLS = 64;
/**
 * Levels between a surface tile and the terrain it shows: a terrain tile of 64 cells covers 4 × 4 surface tiles of
 * {@link TILE_SEGMENTS} segments, so the surface vertices sample every terrain vertex and nested grids stay exact.
 */
export const TERRAIN_LEVEL_OFFSET = Math.round(Math.log2(MAX_GRID_CELLS / TILE_SEGMENTS));

/**
 * The most levels a terrain morph spans (F138, KB-079): a tile morphing from a much coarser fallback (the levels between
 * not loaded yet) would rise or sink kilometers while its neighbors already show the finer terrain, opening cracks
 * wider than any skirt; such a change switches at once.
 */
export const MAX_TERRAIN_MORPH_LEVELS = 2;

/** A grid adds at most half its level's geometric error (ADR 0006 §5, the worker task's bound). */
const GRID_ERROR_FACTOR = 1.5;

/**
 * The error in meters of the terrain each surface level shows, by level up to `maxLevel` (ADR 0006 §2): the source's
 * geometric error at the terrain level, plus the grid's decimation error.
 */
export function terrainErrorsBySurfaceLevel(source: TerrainSource, maxLevel: number): Float64Array {
  const errors = new Float64Array(maxLevel + 1);
  for (let level = 0; level <= maxLevel; level++)
    errors[level] = GRID_ERROR_FACTOR * source.geometricErrorMeters(terrainLevelOf(level, source));
  return errors;
}

/** ADR 0007's priority class of visible tiles; terrain shares it with imagery. */
const VISIBLE_CLASS = 1024;

const mapping = new Float64Array(7);
const seedMapping = new Float64Array(7);
const transform = new Float64Array(4);

/** The terrain level a surface tile of `surfaceLevel` wants, within the source's levels. */
function terrainLevelOf(surfaceLevel: number, source: TerrainSource): number {
  const level = surfaceLevel - TERRAIN_LEVEL_OFFSET;
  return level < source.minLevel ? source.minLevel : level > source.maxLevel ? source.maxLevel : level;
}

/**
 * Writes the terrain each drawn tile shows (ADR 0006 §3): it wants the terrain tile at its terrain level and every
 * ancestor, coarse first, and draws the deepest one resident; a tile with none, or outside the source's tiling,
 * stays on the ellipsoid. Allocates nothing.
 */
export function drawTerrain(
  list: DrawList,
  tiles: readonly QuadtreeTile[],
  count: number,
  layer: TerrainLayer,
  camera: Camera,
): void {
  const geographic = layer.source.tiling.crs === 'EPSG:3857' ? 0 : 1;
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    if (!tile) continue;
    const handle = wantTerrain(layer, tile, screenDistance(tile, camera));
    if (handle < 0) {
      list.terrain.textures[index] = NO_TERRAIN;
      list.terrain.levels[index] = -1;
      list.terrain.seeded[index] = 0;
      continue;
    }
    layer.loader.markDrawn(handle);
    writeTransform(mapping);
    const level = mapping[MAPPING_LEVEL] ?? -1;
    list.terrain.set(index, handle, level, geographic, transform);
    layer.shown.current.set(tile.key, level);
    if (tile.root === MERCATOR_ROOT && !layer.shown.previous.has(tile.key)) seedMorph(list, index, tile, level, layer);
  }
  layer.shown.swap();
}

/** Copies a mapping's scale and offset into {@link transform}. */
function writeTransform(from: Float64Array): void {
  transform[0] = from[MAPPING_SCALE_U] ?? 1;
  transform[1] = from[MAPPING_SCALE_V] ?? 1;
  transform[2] = from[MAPPING_OFFSET_U] ?? 0;
  transform[3] = from[MAPPING_OFFSET_V] ?? 0;
}

/**
 * The terrain level shown last frame where a Mercator tile drawn for the first time lies (F138): its parent's when it
 * appears by refinement, else the finest of its children's when it appears by coarsening; -1 when neither was drawn.
 */
function previousLevel(tile: QuadtreeTile, previous: IntegerKeyMap<number>): number {
  if (tile.level > 0) {
    const parent = previous.get(quadtreeTileKey(MERCATOR_ROOT, tile.level - 1, tile.x >> 1, tile.y >> 1));
    if (parent !== undefined) return parent;
  }
  let finest = -1;
  for (let child = 0; child < 4; child++) {
    const key = quadtreeTileKey(MERCATOR_ROOT, tile.level + 1, 2 * tile.x + (child & 1), 2 * tile.y + (child >> 1));
    const level = previous.get(key);
    if (level !== undefined && level > finest) finest = level;
  }
  return finest;
}

/**
 * Starts a tile drawn for the first time from the terrain shown there last frame (F138, ADR 0006 §4): the parent's on
 * refinement, the children's on coarsening (the two-level offset makes four children share one terrain tile, which
 * covers their parent). The draw's `from` grid is that terrain when resident and different, flagged `seeded`, so the
 * fades morph from it instead of jumping.
 */
function seedMorph(list: DrawList, index: number, tile: QuadtreeTile, level: number, layer: TerrainLayer): void {
  const before = previousLevel(tile, layer.shown.previous);
  if (before < 0 || before === level || Math.abs(before - level) > MAX_TERRAIN_MORPH_LEVELS) return;
  const source = layer.source;
  const mapped =
    source.tiling.crs === 'EPSG:3857'
      ? mapMercator(tile, before, seedMapping, 0)
      : mapGeographic(tile, before, seedMapping, 0);
  if (!mapped) return;
  const seedLevel = seedMapping[MAPPING_LEVEL] ?? -1;
  if (seedLevel === level) return;
  const handle = layer.loader.readyHandle(seedLevel, seedMapping[MAPPING_X] ?? 0, seedMapping[MAPPING_Y] ?? 0);
  if (handle < 0) return;
  writeTransform(seedMapping);
  const terrain = list.terrain;
  terrain.fromTextures[index] = handle;
  terrain.fromGeographic[index] = source.tiling.crs === 'EPSG:3857' ? 0 : 1;
  for (let c = 0; c < 4; c++) terrain.fromUvTransforms[index * 4 + c] = transform[c] ?? 0;
  terrain.seeded[index] = 1;
}

/**
 * Maps a polar cap tile onto the edge row of the Mercator terrain (ADR 0006 §7: Mercator-only terrain continues its
 * 85.0511° heights into the caps): the deepest Mercator tile at or above `level` whose column contains the cap tile's
 * longitudes, sampled along its north (or south) edge only, so heights meet the Mercator root without a step (F143).
 */
function mapCapToMercatorEdge(tile: QuadtreeTile, level: number): boolean {
  const width = tile.eastRad - tile.westRad;
  for (let current = level; current >= 0; current--) {
    const n = 2 ** current;
    const step = (2 * Math.PI) / n;
    const x = Math.floor((tile.westRad + width * 1e-9 + Math.PI) / step);
    if (Math.floor((tile.eastRad - width * 1e-9 + Math.PI) / step) !== x) continue;
    const north = tile.root === NORTH_CAP;
    mapping[MAPPING_LEVEL] = current;
    mapping[MAPPING_X] = x;
    mapping[MAPPING_Y] = north ? 0 : n - 1;
    mapping[MAPPING_SCALE_U] = width / step;
    mapping[MAPPING_SCALE_V] = 0;
    mapping[MAPPING_OFFSET_U] = (tile.westRad + Math.PI - x * step) / step;
    mapping[MAPPING_OFFSET_V] = north ? 0 : 1;
    return true;
  }
  return false;
}

/** Wants a surface tile's terrain and returns the deepest resident handle, its mapping left in `mapping`; else -1. */
function wantTerrain(layer: TerrainLayer, tile: QuadtreeTile, distance: number): number {
  const source = layer.source;
  const level = terrainLevelOf(tile.level, source);
  if (source.tiling.crs === 'EPSG:3857') {
    const mapped =
      tile.root === MERCATOR_ROOT ? mapMercator(tile, level, mapping, 0) : mapCapToMercatorEdge(tile, level);
    if (!mapped) return -1;
  } else if (!mapGeographic(tile, level, mapping, 0)) {
    return -1;
  }
  const wanted = mapping[MAPPING_LEVEL] ?? 0;
  let arriving = false;
  for (let current = wanted; current >= source.minLevel; current--) {
    const x = mapping[MAPPING_X] ?? 0;
    const y = mapping[MAPPING_Y] ?? 0;
    // Every ancestor is wanted, not every second as imagery's (ADR 0006 §3): terrain tiles are small, and the tile
    // whose metadata declares the availability of the deeper levels must load (F128).
    const handle = !arriving
      ? layer.loader.want(current, x, y, VISIBLE_CLASS + current + 2 * distance)
      : layer.loader.readyHandle(current, x, y);
    if (handle >= 0) return handle;
    if (handle === ARRIVING) arriving = true;
    if (current > source.minLevel) mapAncestor(mapping, 0, 1);
  }
  return -1;
}

/**
 * The height range of a surface tile's relief (ADR 0006 §2): writes into `out` the lowest and highest heights of the
 * deepest resident terrain tile covering it, then that level's error, which bounds what finer levels add, and returns
 * true; false when no terrain covering the tile is resident. Wants nothing; allocates nothing.
 */
export function terrainHeightRange(
  layer: TerrainLayer,
  heights: TerrainHeights,
  tile: QuadtreeTile,
  out: Float64Array,
): boolean {
  const source = layer.source;
  const level = terrainLevelOf(tile.level, source);
  if (source.tiling.crs === 'EPSG:3857') {
    const mapped =
      tile.root === MERCATOR_ROOT ? mapMercator(tile, level, mapping, 0) : mapCapToMercatorEdge(tile, level);
    if (!mapped) return false;
  } else if (!mapGeographic(tile, level, mapping, 0)) {
    return false;
  }
  for (let current = mapping[MAPPING_LEVEL] ?? 0; current >= source.minLevel; current--) {
    const handle = layer.loader.peekHandle(current, mapping[MAPPING_X] ?? 0, mapping[MAPPING_Y] ?? 0);
    const grid = handle >= 0 ? heights.grid(handle) : undefined;
    if (grid) {
      out[0] = grid.minMeters;
      out[1] = grid.maxMeters;
      out[2] = layer.gridErrorMeters[current] ?? 0;
      return true;
    }
    if (current > source.minLevel) mapAncestor(mapping, 0, 1);
  }
  return false;
}
