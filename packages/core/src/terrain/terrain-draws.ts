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
import type { QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { TerrainSource } from './terrain-source.js';

/** The terrain of one engine instance: its source and the loader of its height grids. */
export interface TerrainLayer {
  readonly source: TerrainSource;
  readonly loader: ImageryLoader;
}

/** Height-grid cells per side of the finest grid a terrain tile decodes to (ADR 0006 §5). */
const MAX_GRID_CELLS = 64;
/**
 * Levels between a surface tile and the terrain it shows: a terrain tile of 64 cells covers 4 × 4 surface tiles of
 * {@link TILE_SEGMENTS} segments, so the surface vertices sample every terrain vertex and nested grids stay exact.
 */
export const TERRAIN_LEVEL_OFFSET = Math.round(Math.log2(MAX_GRID_CELLS / TILE_SEGMENTS));

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
const transform = new Float64Array(4);

/** The terrain level a surface tile of `surfaceLevel` wants, within the source's levels. */
export function terrainLevelOf(surfaceLevel: number, source: TerrainSource): number {
  const level = surfaceLevel - TERRAIN_LEVEL_OFFSET;
  return level < source.minLevel ? source.minLevel : level > source.maxLevel ? source.maxLevel : level;
}

/**
 * Writes the terrain each drawn tile shows (ADR 0006 §3): it wants the terrain tile at its terrain level and every
 * second ancestor, coarse first, and draws the deepest one resident; a tile with none, or outside the source's tiling,
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
      continue;
    }
    layer.loader.markDrawn(handle);
    transform[0] = mapping[MAPPING_SCALE_U] ?? 1;
    transform[1] = mapping[MAPPING_SCALE_V] ?? 1;
    transform[2] = mapping[MAPPING_OFFSET_U] ?? 0;
    transform[3] = mapping[MAPPING_OFFSET_V] ?? 0;
    list.terrain.set(index, handle, mapping[MAPPING_LEVEL] ?? -1, geographic, transform);
  }
}

/** Wants a surface tile's terrain and returns the deepest resident handle, its mapping left in `mapping`; else -1. */
function wantTerrain(layer: TerrainLayer, tile: QuadtreeTile, distance: number): number {
  const source = layer.source;
  const level = terrainLevelOf(tile.level, source);
  if (source.tiling.crs === 'EPSG:3857') {
    if (!mapMercator(tile, level, mapping, 0)) return -1;
  } else if (!mapGeographic(tile, level, mapping, 0)) {
    return -1;
  }
  const wanted = mapping[MAPPING_LEVEL] ?? 0;
  let arriving = false;
  for (let current = wanted; current >= source.minLevel; current--) {
    const x = mapping[MAPPING_X] ?? 0;
    const y = mapping[MAPPING_Y] ?? 0;
    const handle =
      !arriving && (wanted - current) % 2 === 0
        ? layer.loader.want(current, x, y, VISIBLE_CLASS + current + 2 * distance)
        : layer.loader.readyHandle(current, x, y);
    if (handle >= 0) return handle;
    if (handle === ARRIVING) arriving = true;
    if (current > source.minLevel) mapAncestor(mapping, 0, 1);
  }
  return -1;
}
