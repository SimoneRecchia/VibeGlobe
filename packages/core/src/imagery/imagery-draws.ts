import type { Camera } from '../camera/camera.js';
import { projectToScreen } from '../camera/projection.js';
import { geodeticToEcef } from '../geodesy/ecef.js';
import { MERCATOR_ROOT, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { MAX_OVERLAYS, type DrawList } from './draw-list.js';
import { ARRIVING, PREFETCH_CLASS, VISIBLE_CLASS, type ImageryLoader } from './imagery-loader.hot.js';
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
import { inCoverage, type ImagerySource } from './imagery-source.js';
import { BLEND_CODES, isOpaque, type StackEntry } from './imagery-stack.js';
import type { VisibleSources } from './credits.js';

/** Where `mapping` keeps the handle of the tile it maps to, after the mapping's own seven numbers. */
const MAPPING_HANDLE = 7;

/** A source of one engine instance: the source, the loader of its tiles and its index among the instance's sources. */
export interface ImageryLayer {
  readonly source: ImagerySource;
  readonly loader: ImageryLoader;
  readonly index: number;
}

/** A layer of the imagery stack (ADR 0038): its look and the loaded sources of its chain, in priority order. */
export interface StackLayer {
  readonly entry: StackEntry;
  readonly chain: readonly ImageryLayer[];
}

/** The imagery stack over the loaders of every source, which are in the order of the entries' chains. */
export function stackOf(entries: readonly StackEntry[], layers: readonly ImageryLayer[]): StackLayer[] {
  let next = 0;
  return entries.map((entry) => ({ entry, chain: entry.sources.map(() => layers[next++] as ImageryLayer) }));
}

const mapping = new Float64Array(8);
const centerEcef = new Float64Array(3);
const screen = new Float64Array(2);
/** Overlays found for a draw, top first: handle, geographic, opacity, blend and the four UV numbers each. */
const found = new Float64Array(MAX_OVERLAYS * 8);

/**
 * Textures the surface tiles of a frame with the imagery stack (M3 plan §2.5, ADR 0038). For each drawn tile and
 * visible layer it wants the source tile at the tile's level (clamped to the source's levels) and every second
 * ancestor, coarse first (F085), from the first source of the layer's chain that has it (F247, F248), then draws the
 * deepest ancestor already on the GPU with its sub-rectangle (F082, F083). The topmost opaque layer with a resident
 * tile is the draw's own imagery (else the world base image the list already holds); the translucent or blended
 * layers above it, up to {@link MAX_OVERLAYS}, are its overlays. Allocates nothing.
 */
export function drawImagery(
  list: DrawList,
  tiles: readonly QuadtreeTile[],
  count: number,
  layers: readonly StackLayer[],
  camera: Camera,
  visible?: VisibleSources,
): void {
  let center: QuadtreeTile | undefined;
  let centerDistance = Infinity;
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    if (!tile) continue;
    const distance = screenDistance(tile, camera);
    if (distance < centerDistance) {
      centerDistance = distance;
      center = tile;
    }
    let based = false;
    let overlays = 0;
    for (let layer = layers.length - 1; layer >= 0; layer--) {
      const entry = layers[layer];
      if (!entry || !entry.entry.visible || entry.entry.opacity <= 0) continue;
      const chosen = wantChain(entry.chain, tile, distance);
      if (based || chosen < 0) continue;
      const loader = entry.chain[chosen]?.loader;
      const handle = mapping[MAPPING_HANDLE] ?? -1;
      loader?.markDrawn(handle);
      const geographic = entry.chain[chosen]?.source.tiling.crs === 'EPSG:3857' ? 0 : 1;
      if (isOpaque(entry.entry)) {
        based = true;
        visible?.mark(entry.chain[chosen]?.index ?? 0);
        list.textures[index] = handle;
        list.geographic[index] = geographic;
        list.imageryLevels[index] = mapping[MAPPING_LEVEL] ?? -1;
        const at = index * 4;
        list.uvTransforms[at] = mapping[MAPPING_SCALE_U] ?? 1;
        list.uvTransforms[at + 1] = mapping[MAPPING_SCALE_V] ?? 1;
        list.uvTransforms[at + 2] = mapping[MAPPING_OFFSET_U] ?? 0;
        list.uvTransforms[at + 3] = mapping[MAPPING_OFFSET_V] ?? 0;
      } else if (overlays < MAX_OVERLAYS) {
        visible?.mark(entry.chain[chosen]?.index ?? 0);
        const at = overlays * 8;
        found[at] = handle;
        found[at + 1] = geographic;
        found[at + 2] = entry.entry.opacity;
        found[at + 3] = BLEND_CODES[entry.entry.blend];
        found[at + 4] = mapping[MAPPING_SCALE_U] ?? 1;
        found[at + 5] = mapping[MAPPING_SCALE_V] ?? 1;
        found[at + 6] = mapping[MAPPING_OFFSET_U] ?? 0;
        found[at + 7] = mapping[MAPPING_OFFSET_V] ?? 0;
        overlays++;
      }
    }
    writeOverlays(list, index, overlays);
  }
  if (center) prefetchStack(layers, center, centerDistance);
}

/** Prefetches the children of the center tile from each visible layer, from the first source of its chain that has it. */
function prefetchStack(layers: readonly StackLayer[], tile: QuadtreeTile, distance: number): void {
  for (let layer = 0; layer < layers.length; layer++) {
    const entry = layers[layer];
    if (!entry || !entry.entry.visible || entry.entry.opacity <= 0) continue;
    // The source the tile comes from: the first of the chain that has it.
    const chain = entry.chain;
    let source = 0;
    while (source < chain.length - 1 && !hasTile(chain[source] as ImageryLayer, tile)) source++;
    const chosen = chain[source];
    if (chosen && chosen.loader.prefetching !== false) prefetchChildren(chosen, tile, distance);
  }
}

/** Writes the overlays found for draw `index` into the list's slots, bottom first; the slots left empty show nothing. */
function writeOverlays(list: DrawList, index: number, overlays: number): void {
  for (let slot = 0; slot < list.overlays.length; slot++) {
    const overlay = list.overlays[slot];
    if (!overlay) continue;
    if (slot >= overlays) {
      overlay.opacities[index] = 0;
      continue;
    }
    const at = (overlays - 1 - slot) * 8;
    overlay.textures[index] = found[at] ?? -1;
    overlay.geographic[index] = found[at + 1] ?? 0;
    overlay.opacities[index] = found[at + 2] ?? 0;
    overlay.blends[index] = found[at + 3] ?? 0;
    for (let c = 0; c < 4; c++) overlay.uvTransforms[index * 4 + c] = found[at + 4 + c] ?? 0;
  }
}

/**
 * Wants a tile of a layer from its source chain (F247, F248): the first source that has the tile at the surface's
 * level (within its levels and coverage, not missing or failing), the deepest resident tile of which is drawn; while
 * that source's tiles load, a resident tile of another source stands in. When no source has it, the first source that
 * covers the area shows its deepest tile magnified. Returns the chosen source's index with the handle and mapping in
 * `mapping`, or -1 when nothing is resident.
 */
function wantChain(chain: readonly ImageryLayer[], tile: QuadtreeTile, distance: number): number {
  let fallback = -1;
  // Levels an earlier source serves are its own: a later source is asked only for finer ones (F247).
  let floor = 0;
  for (let k = 0; k < chain.length; k++) {
    const layer = chain[k];
    if (!layer) continue;
    if (!hasTile(layer, tile)) {
      if (fallback < 0 && mapInto(layer.source, tile)) fallback = k;
      if (tile.level > layer.source.maxLevel && layer.source.maxLevel + 1 > floor) floor = layer.source.maxLevel + 1;
      continue;
    }
    if (wantLayer(layer, tile, distance, floor) >= 0) return k;
    for (let j = 0; j < chain.length; j++) {
      const standIn = chain[j];
      if (j !== k && standIn && residentLayer(standIn, tile) >= 0) return j;
    }
    return -1;
  }
  const covering = chain[fallback];
  return covering && wantLayer(covering, tile, distance, 0) >= 0 ? fallback : -1;
}

/** Maps a tile into a source's tiles at the tile's level clamped to the source's (into `mapping`); false if it cannot. */
function mapInto(source: ImagerySource, tile: QuadtreeTile): boolean {
  // Outside its coverage a source has nothing, not even its coarse ancestors magnified: the layers below show (F094).
  if (source.coverage && !inCoverage(source.coverage, tile)) return false;
  const level = tile.level < source.maxLevel ? tile.level : source.maxLevel;
  if (source.tiling.crs === 'EPSG:3857') return tile.root === MERCATOR_ROOT && mapMercator(tile, level, mapping, 0);
  return mapGeographic(tile, level, mapping, 0);
}

/** True when a source can give the tile at the surface's level now: within its levels, mapped, and not missing or failing. */
function hasTile(layer: ImageryLayer, tile: QuadtreeTile): boolean {
  const source = layer.source;
  if (tile.level > source.maxLevel || !mapInto(source, tile)) return false;
  const level = mapping[MAPPING_LEVEL] ?? 0;
  if (level < source.minLevel) return false;
  return !layer.loader.unavailable(level, mapping[MAPPING_X] ?? 0, mapping[MAPPING_Y] ?? 0);
}

/** The deepest resident tile of a source for a tile, without requesting any (handle in `mapping`), or -1. */
function residentLayer(layer: ImageryLayer, tile: QuadtreeTile): number {
  const source = layer.source;
  if (!mapInto(source, tile)) return -1;
  for (let current = mapping[MAPPING_LEVEL] ?? 0; current >= source.minLevel; current--) {
    const handle = layer.loader.readyHandle(current, mapping[MAPPING_X] ?? 0, mapping[MAPPING_Y] ?? 0);
    if (handle >= 0) {
      mapping[MAPPING_HANDLE] = handle;
      return handle;
    }
    if (current > source.minLevel) mapAncestor(mapping, 0, 1);
  }
  return -1;
}

/**
 * Prefetches the next level under the screen center, where a zoom in goes first: the four children of the center
 * tile's imagery, at ADR 0007's prefetch class, after every visible tile (F088).
 */
function prefetchChildren(layer: ImageryLayer, tile: QuadtreeTile, distance: number): void {
  const source = layer.source;
  if (tile.level >= source.maxLevel || !mapInto(source, tile)) return;
  const level = mapping[MAPPING_LEVEL] ?? 0;
  const x = 2 * (mapping[MAPPING_X] ?? 0);
  const y = 2 * (mapping[MAPPING_Y] ?? 0);
  const key = PREFETCH_CLASS + level + 1 + 2 * distance;
  for (let child = 0; child < 4; child++) layer.loader.want(level + 1, x + (child & 1), y + (child >> 1), key);
}

/**
 * Wants a layer's tiles for a surface tile and returns the handle of the deepest resident one, its mapping left in
 * `mapping`; -1 when none is resident or the layer cannot cover the tile. Levels below `floor` (served by an earlier
 * source of the chain) are neither requested nor looked up.
 */
function wantLayer(layer: ImageryLayer, tile: QuadtreeTile, distance: number, floor: number): number {
  const source = layer.source;
  if (!mapInto(source, tile)) return -1;
  const wanted = mapping[MAPPING_LEVEL] ?? 0;
  const lowest = source.minLevel > floor ? source.minLevel : floor;
  // Once a finer tile's bytes are in hand (ARRIVING), coarser ones are only looked up, never requested (F097).
  let arriving = false;
  for (let current = wanted; current >= lowest; current--) {
    const x = mapping[MAPPING_X] ?? 0;
    const y = mapping[MAPPING_Y] ?? 0;
    // The wanted tile and every second ancestor are requested; the others are only looked up.
    const handle =
      !arriving && (wanted - current) % 2 === 0
        ? layer.loader.want(current, x, y, VISIBLE_CLASS + current + 2 * distance)
        : layer.loader.readyHandle(current, x, y);
    if (handle >= 0) {
      mapping[MAPPING_HANDLE] = handle;
      return handle;
    }
    if (handle === ARRIVING) arriving = true;
    if (current > lowest) mapAncestor(mapping, 0, 1);
  }
  return -1;
}

/** Distance of a tile's center from the screen center, 0 at the center and 1 at a corner or beyond. */
export function screenDistance(tile: QuadtreeTile, camera: Camera): number {
  geodeticToEcef((tile.westRad + tile.eastRad) / 2, (tile.southRad + tile.northRad) / 2, 0, centerEcef);
  if (!projectToScreen(camera, centerEcef, screen)) return 1;
  const halfWidth = camera.widthPx / 2;
  const halfHeight = camera.heightPx / 2;
  const dx = ((screen[0] ?? 0) - halfWidth) / halfWidth;
  const dy = ((screen[1] ?? 0) - halfHeight) / halfHeight;
  const d = Math.sqrt((dx * dx + dy * dy) / 2);
  return d < 1 ? d : 1;
}
