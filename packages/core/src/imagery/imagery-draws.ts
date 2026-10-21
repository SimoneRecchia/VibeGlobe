import type { Camera } from '../camera/camera.js';
import { projectToScreen } from '../camera/projection.js';
import { geodeticToEcef } from '../geodesy/ecef.js';
import { MERCATOR_ROOT, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { DrawList } from './draw-list.js';
import type { ImageryLoader } from './imagery-loader.js';
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
} from './imagery-mapping.hot.js';
import type { ImagerySource } from './imagery-source.js';

/** An imagery layer of one engine instance: its source and the loader of its tiles. */
export interface ImageryLayer {
  readonly source: ImagerySource;
  readonly loader: ImageryLoader;
}

/** ADR 0007's priority classes: visible tiles are class 1 (class 0 is the pinned base). */
const VISIBLE_CLASS = 1024;

const mapping = new Float64Array(7);
const centerEcef = new Float64Array(3);
const screen = new Float64Array(2);

/**
 * Textures the surface tiles of a frame with imagery (M3 plan §2.5). For each drawn tile and layer it wants the source
 * tile at the tile's level (clamped to the source's levels) and every second ancestor, coarse first (F085), then draws
 * the deepest ancestor already on the GPU with its sub-rectangle (F082, F083). The topmost layer with a resident tile
 * wins; a tile no layer covers keeps the world base image the list already holds. Allocates nothing.
 */
export function drawImagery(
  list: DrawList,
  tiles: readonly QuadtreeTile[],
  count: number,
  layers: readonly ImageryLayer[],
  camera: Camera,
): void {
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    if (!tile) continue;
    const distance = screenDistance(tile, camera);
    let drawn = false;
    for (let layer = layers.length - 1; layer >= 0; layer--) {
      const entry = layers[layer];
      if (!entry) continue;
      const handle = wantLayer(entry, tile, distance);
      if (drawn || handle < 0) continue;
      drawn = true;
      list.textures[index] = handle;
      list.geographic[index] = entry.source.tiling.crs === 'EPSG:3857' ? 0 : 1;
      list.imageryLevels[index] = mapping[MAPPING_LEVEL] ?? -1;
      const at = index * 4;
      list.uvTransforms[at] = mapping[MAPPING_SCALE_U] ?? 1;
      list.uvTransforms[at + 1] = mapping[MAPPING_SCALE_V] ?? 1;
      list.uvTransforms[at + 2] = mapping[MAPPING_OFFSET_U] ?? 0;
      list.uvTransforms[at + 3] = mapping[MAPPING_OFFSET_V] ?? 0;
    }
  }
}

/**
 * Wants a layer's tiles for a surface tile and returns the handle of the deepest resident one, its mapping left in
 * `mapping`; -1 when none is resident or the layer cannot cover the tile.
 */
function wantLayer(layer: ImageryLayer, tile: QuadtreeTile, distance: number): number {
  const source = layer.source;
  const level = tile.level < source.maxLevel ? tile.level : source.maxLevel;
  if (source.tiling.crs === 'EPSG:3857') {
    if (tile.root !== MERCATOR_ROOT || !mapMercator(tile, level, mapping, 0)) return -1;
  } else if (!mapGeographic(tile, level, mapping, 0)) {
    return -1;
  }
  const wanted = mapping[MAPPING_LEVEL] ?? 0;
  for (let current = wanted; current >= source.minLevel; current--) {
    const x = mapping[MAPPING_X] ?? 0;
    const y = mapping[MAPPING_Y] ?? 0;
    // The wanted tile and every second ancestor are requested; the others are only looked up.
    const handle =
      (wanted - current) % 2 === 0
        ? layer.loader.want(current, x, y, VISIBLE_CLASS + current + 2 * distance)
        : layer.loader.readyHandle(current, x, y);
    if (handle >= 0) return handle;
    if (current > source.minLevel) mapAncestor(mapping, 0, 1);
  }
  return -1;
}

/** Distance of a tile's center from the screen center, 0 at the center and 1 at a corner or beyond. */
function screenDistance(tile: QuadtreeTile, camera: Camera): number {
  geodeticToEcef((tile.westRad + tile.eastRad) / 2, (tile.southRad + tile.northRad) / 2, 0, centerEcef);
  if (!projectToScreen(camera, centerEcef, screen)) return 1;
  const halfWidth = camera.widthPx / 2;
  const halfHeight = camera.heightPx / 2;
  const dx = ((screen[0] ?? 0) - halfWidth) / halfWidth;
  const dy = ((screen[1] ?? 0) - halfHeight) / halfHeight;
  const d = Math.sqrt((dx * dx + dy * dy) / 2);
  return d < 1 ? d : 1;
}
