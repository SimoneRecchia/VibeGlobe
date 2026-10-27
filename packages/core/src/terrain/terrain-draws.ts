// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
import { gridRangeInto, samplingErrorMeters } from './sample-height.js';
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
 * geometric error at the terrain level, plus the grid's decimation error. Beyond the surface level that shows the
 * finest terrain, tiles of neighboring levels show the same grid with meshes finer than it, so what they differ by
 * (what the skirts hide) halves with each level instead of staying the finest grid's error (KB-080).
 */
export function terrainErrorsBySurfaceLevel(source: TerrainSource, maxLevel: number): Float64Array {
  const errors = new Float64Array(maxLevel + 1);
  const finest = source.maxLevel + TERRAIN_LEVEL_OFFSET;
  for (let level = 0; level <= maxLevel; level++) {
    const beyond = level > finest ? 2 ** (level - finest) : 1;
    errors[level] = (GRID_ERROR_FACTOR * source.geometricErrorMeters(terrainLevelOf(level, source))) / beyond;
  }
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
    const handle = wantTerrain(layer, tile, screenDistance(tile, camera), layer.shown.previous.get(tile.key) ?? -1);
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
    if (!layer.shown.previous.has(tile.key)) seedMorph(list, index, tile, level, layer);
  }
}

/**
 * Records the terrain level each drawn tile shows this frame, after the morphs (a morph under way keeps showing its
 * target): {@link drawTerrain} morphs the next frame from these, and refines no tile more than
 * {@link MAX_TERRAIN_MORPH_LEVELS} beyond them (KB-092). Allocates nothing.
 */
export function recordShownTerrain(
  list: DrawList,
  tiles: readonly QuadtreeTile[],
  count: number,
  layer: TerrainLayer,
): void {
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    const level = list.terrain.levels[index] ?? -1;
    if (tile && level >= 0) layer.shown.current.set(tile.key, level);
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
 * The terrain level shown last frame where a tile drawn for the first time lies (F138): its nearest ancestor's within
 * {@link MAX_TERRAIN_MORPH_LEVELS} levels when it appears by refinement, else the finest of its descendants' within as
 * many levels when it appears by coarsening; -1 when none was drawn. Columns follow the quadtree's split rules: a tile
 * of span s splits into four at columns 2x and 2x + s (span s), or into two at column 2x (span 2s), so its parent is at
 * ⌊x / 2s⌋ · s or x / 2 and its descendants within two levels at columns 4x … 4x + 3s; Mercator tiles have span 1.
 * Allocates nothing.
 */
export function previousLevel(tile: QuadtreeTile, previous: IntegerKeyMap<number>): number {
  const { root, level, x, y, span } = tile;
  // Parents: k = 0 as a four-way split (same span), k = 1 as a two-way split (half the span, even columns only).
  for (let k = 0; k < 2 && level >= 1; k++) {
    const px = k === 0 ? Math.floor(x / (2 * span)) * span : x % 2 === 0 ? x / 2 : -1;
    if (px < 0) continue;
    const found = previous.get(quadtreeTileKey(root, level - 1, px, y >> 1));
    if (found !== undefined) return found;
  }
  for (let k = 0; k < 4 && level >= 2 && MAX_TERRAIN_MORPH_LEVELS >= 2; k++) {
    // Grandparents: either split at either level (k & 1 for the parent's, k >> 1 for the grandparent's).
    const px = (k & 1) === 0 ? Math.floor(x / (2 * span)) * span : x % 2 === 0 ? x / 2 : -1;
    const parentSpan = (k & 1) === 0 ? span : span / 2;
    if (px < 0 || parentSpan < 1 || !Number.isInteger(parentSpan)) continue;
    const gx = k >> 1 === 0 ? Math.floor(px / (2 * parentSpan)) * parentSpan : px % 2 === 0 ? px / 2 : -1;
    if (gx < 0) continue;
    const found = previous.get(quadtreeTileKey(root, level - 2, gx, y >> 2));
    if (found !== undefined) return found;
  }
  let finest = -1;
  for (let i = 0; i < 4; i++) {
    const found = previous.get(quadtreeTileKey(root, level + 1, 2 * x + (i & 1) * span, 2 * y + (i >> 1)));
    if (found !== undefined && found > finest) finest = found;
  }
  if (finest >= 0 || MAX_TERRAIN_MORPH_LEVELS < 2) return finest;
  for (let i = 0; i < 16; i++) {
    const found = previous.get(quadtreeTileKey(root, level + 2, 4 * x + (i & 3) * span, 4 * y + (i >> 2)));
    if (found !== undefined && found > finest) finest = found;
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
  let mapped: boolean;
  if (source.tiling.crs !== 'EPSG:3857') mapped = mapGeographic(tile, before, seedMapping, 0);
  else if (tile.root === MERCATOR_ROOT) mapped = mapMercator(tile, before, seedMapping, 0);
  else {
    // A cap tile samples the Mercator edge row; the current mapping is no longer needed once the draw is set.
    mapped = mapCapToMercatorEdge(tile, before);
    seedMapping.set(mapping);
  }
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

/**
 * Wants a surface tile's terrain and returns the deepest resident handle, its mapping left in `mapping`; else -1. A
 * tile that showed level `shown` last frame advances at most {@link MAX_TERRAIN_MORPH_LEVELS} levels, to a resident
 * ancestor of the deepest, so the change morphs instead of jumping when several finer levels arrive at once (KB-092).
 */
function wantTerrain(layer: TerrainLayer, tile: QuadtreeTile, distance: number, shown: number): number {
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
    if (handle >= 0)
      return shown >= 0 && current > shown + MAX_TERRAIN_MORPH_LEVELS
        ? limitAdvance(layer, shown, current, handle)
        : handle;
    if (handle === ARRIVING) arriving = true;
    if (current > source.minLevel) mapAncestor(mapping, 0, 1);
  }
  return -1;
}

/**
 * The resident ancestor {@link MAX_TERRAIN_MORPH_LEVELS} levels below `shown` of the terrain tile at `level` in
 * `mapping` (handle `handle`), its mapping left in `mapping`; `handle` and the deepest mapping when it is not resident.
 */
function limitAdvance(layer: TerrainLayer, shown: number, level: number, handle: number): number {
  seedMapping.set(mapping);
  for (let current = level; current > shown + MAX_TERRAIN_MORPH_LEVELS; current--) mapAncestor(mapping, 0, 1);
  const ancestor = layer.loader.readyHandle(
    mapping[MAPPING_LEVEL] ?? -1,
    mapping[MAPPING_X] ?? 0,
    mapping[MAPPING_Y] ?? 0,
  );
  if (ancestor >= 0) return ancestor;
  mapping.set(seedMapping);
  return handle;
}

/** {@link gridRangeInto}'s part of a grid and its range, reused per tile. */
const part = new Float64Array(6);

/**
 * The height range of a surface tile's relief (ADR 0006 §2): writes into `out` the lowest and highest heights of the
 * part of the deepest resident terrain tile covering it that the tile shows, then that level's error, which bounds what finer levels add, and returns
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
      // The part of the grid the tile shows (KB-080): a tile far deeper than its terrain shows a few cells of it.
      const offsetU = mapping[MAPPING_OFFSET_U] ?? 0;
      const offsetV = mapping[MAPPING_OFFSET_V] ?? 0;
      const endU = offsetU + (mapping[MAPPING_SCALE_U] ?? 1);
      const endV = offsetV + (mapping[MAPPING_SCALE_V] ?? 1);
      part[0] = offsetU < endU ? offsetU : endU;
      part[1] = offsetU < endU ? endU : offsetU;
      part[2] = offsetV < endV ? offsetV : endV;
      part[3] = offsetV < endV ? endV : offsetV;
      gridRangeInto(grid, part);
      out[0] = part[4] ?? grid.minMeters;
      out[1] = part[5] ?? grid.maxMeters;
      // What finer levels may add: the level's bound, or more where the grid's measured error exceeds its share of it.
      const bound = layer.gridErrorMeters[current] ?? 0;
      const measured = bound / GRID_ERROR_FACTOR + (grid.errorMeters ?? 0);
      // A tile whose part holds more cells than its mesh has segments shows only every few vertices (KB-097): what it
      // skips is error finer levels remove too.
      const stride = ((part[1] ?? 1) - (part[0] ?? 0)) * (grid.cells / TILE_SEGMENTS);
      out[2] = (measured > bound ? measured : bound) + samplingErrorMeters(grid, stride);
      // At the source's finest level, the surface refines until it samples each vertex of this grid (ADR 0028); below
      // it, finer terrain is still to come and the selection's own limit applies.
      const sampled = Math.log2(grid.cells / TILE_SEGMENTS);
      out[3] =
        current === source.maxLevel
          ? current + (sampled > TERRAIN_LEVEL_OFFSET ? sampled : TERRAIN_LEVEL_OFFSET)
          : Number.POSITIVE_INFINITY;
      return true;
    }
    if (current > source.minLevel) mapAncestor(mapping, 0, 1);
  }
  return false;
}

/**
 * Deepens the skirts of draws showing terrain coarser than their surface level's (a fallback ancestor, or a morph from
 * one; M4 review), and of the draws they touch: across a shared edge, the two surfaces may differ by up to twice the
 * coarser grid's error (its level's bound, or its measured error when larger), more than skirts sized for each tile's
 * own level hide, and whichever edge lies higher needs its skirt to reach the other. Call after the terrain fades.
 * Allocates nothing; the neighbor search runs only for the few draws showing fallback terrain.
 */
export function deepenFallbackSkirts(
  list: DrawList,
  tiles: readonly QuadtreeTile[],
  count: number,
  layer: TerrainLayer,
  heights: TerrainHeights,
): void {
  const terrain = list.terrain;
  terrain.skirtMeters.fill(0, 0, count);
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    const level = terrain.levels[index] ?? -1;
    // Cap tiles over Mercator terrain show its edge row by design (ADR 0006 §7): not a fallback.
    if (!tile || level < 0 || (tile.root !== MERCATOR_ROOT && layer.source.tiling.crs === 'EPSG:3857')) continue;
    let coarsest = level;
    let handle = terrain.textures[index] ?? -1;
    if ((terrain.fades[index] ?? 1) < 1) {
      const fromHandle = terrain.fromTextures[index] ?? -1;
      const from = layer.loader.coordOf(fromHandle)?.level ?? level;
      if (from < coarsest) {
        coarsest = from;
        handle = fromHandle;
      }
    }
    if (coarsest >= terrainLevelOf(tile.level, layer.source)) continue;
    const bound = layer.gridErrorMeters[coarsest] ?? 0;
    const measured = bound / GRID_ERROR_FACTOR + (heights.grid(handle)?.errorMeters ?? 0);
    const depth = 2 * (measured > bound ? measured : bound);
    if (depth > (terrain.skirtMeters[index] ?? 0)) terrain.skirtMeters[index] = depth;
    // The draws sharing an edge or a corner with it.
    for (let other = 0; other < count; other++) {
      const near = tiles[other];
      if (
        !near ||
        other === index ||
        near.westRad > tile.eastRad ||
        near.eastRad < tile.westRad ||
        near.southRad > tile.northRad ||
        near.northRad < tile.southRad
      )
        continue;
      if (depth > (terrain.skirtMeters[other] ?? 0)) terrain.skirtMeters[other] = depth;
    }
  }
}
