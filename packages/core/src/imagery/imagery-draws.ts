// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Camera } from '../camera/camera.js';
import { projectToScreen } from '../camera/projection.js';
import { geodeticToEcef } from '../geodesy/ecef.js';
import { MERCATOR_ROOT, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { MAX_OVERLAYS, TONE_BELOW, type DrawList } from './draw-list.js';
import {
  ARRIVING,
  COVER_CLASS,
  PREFETCH_CLASS,
  PRELOAD_CLASS,
  VISIBLE_CLASS,
  type ImageryLoader,
} from './imagery-loader.hot.js';
import {
  MAPPING_LEVEL,
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
import { BLEND_CODES, isOpaque, shownAt, shownOpacity, type StackEntry } from './imagery-stack.js';
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

/** A slot of {@link mapping} (all eight always exist). */
function mapped(slot: number): number {
  return mapping[slot] ?? 0;
}
const centerEcef = new Float64Array(3);
const screen = new Float64Array(2);
/** Numbers kept per overlay found: handle, geographic, opacity, blend, the four UV numbers, level and tone source. */
const FOUND = 10;
/** Overlays found for a draw, top first. */
const found = new Float64Array(MAX_OVERLAYS * FOUND);

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
  const strengths = list.below.strengths;
  for (let layer = 0; layer < strengths.length; layer++) strengths[layer] = layers[layer]?.entry.toneStrength ?? 1;
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    if (!tile) continue;
    const distance = screenDistance(tile, camera);
    if (distance < centerDistance) {
      centerDistance = distance;
      center = tile;
    }
    let based = false;
    let below = false;
    let overlays = 0;
    for (let layer = layers.length - 1; layer >= 0; layer--) {
      const entry = layers[layer];
      if (!entry || !entry.entry.visible || shownOpacity(entry.entry) <= 0) continue;
      const chosen = wantChain(entry.chain, tile, distance);
      if (based) {
        // The first layer down with a tile under the draw's own: the reference of tone matching to the imagery below.
        if (!below && chosen >= 0) below = writeBelow(list, index, tile, entry, layer, chosen);
        continue;
      }
      if (chosen < 0) {
        // A layer whose sources cover none of this tile takes no slot, so several clipped layers (one per country)
        // leave the slots to the ones that have data here (F618).
        if (coversTile(entry.chain, tile)) overlays = keepSlot(entry, overlays);
        continue;
      }
      const drawn = entry.chain[chosen];
      const handle = mapped(MAPPING_HANDLE);
      drawn?.loader.markDrawn(handle);
      const geographic = drawn?.source.tiling.crs === 'EPSG:3857' && !latitudeRows(drawn.source, tile) ? 0 : 1;
      const opaque = isOpaque(entry.entry);
      if (!opaque && overlays >= MAX_OVERLAYS) continue;
      visible?.mark(drawn?.index ?? 0);
      const credit = drawn?.loader.attributionOf(handle);
      if (credit) visible?.markCredit(credit, drawn?.index ?? 0);
      // Tone matching between the chain's sources (F249): which one this draw shows.
      const tone = toneSource(entry, layer, chosen);
      if (opaque) {
        based = true;
        writeBase(list, index, handle, geographic, tone);
      } else overlays = addOverlay(entry, overlays, handle, geographic, tone);
    }
    writeOverlays(list, index, overlays);
  }
  // Nothing finer shows under a center the fog nearly hides (F574, KB-174).
  if (center && !hazed(center)) prefetchStack(layers, center, centerDistance);
}

/**
 * For a source whose Web Mercator tiles have rows linear in latitude (`ImagerySource.latitudeRows`, KB-232): the
 * mapping's v scale and offset in latitude, and true; false for any other source.
 */
function latitudeRows(source: ImagerySource | undefined, tile: QuadtreeTile): boolean {
  if (!source?.latitudeRows) return false;
  const rows = 2 ** mapped(MAPPING_LEVEL);
  const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * mapped(MAPPING_Y)) / rows)));
  const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (mapped(MAPPING_Y) + 1)) / rows)));
  mapping[MAPPING_SCALE_V] = (tile.northRad - tile.southRad) / (north - south);
  mapping[MAPPING_OFFSET_V] = (north - tile.northRad) / (north - south);
  return true;
}

/** Writes the tile in `mapping` as draw `index`'s own imagery. */
function writeBase(list: DrawList, index: number, handle: number, geographic: number, tone: number): void {
  list.toneSources[index] = tone;
  list.textures[index] = handle;
  list.geographic[index] = geographic;
  list.imageryLevels[index] = mapped(MAPPING_LEVEL);
  writeTransform(list.uvTransforms, index * 4);
}

/** Writes the UV transform in `mapping` (scale u, scale v, offset u, offset v: its slots in that order) at `at`. */
function writeTransform(out: Float32Array | Float64Array, at: number): void {
  for (let c = 0; c < 4; c++) out[at + c] = mapped(MAPPING_SCALE_U + c);
}

/** Records the tile in `mapping`, of `layer`'s source `chosen`, as the imagery under draw `index`'s own (F633). */
function writeBelow(
  list: DrawList,
  index: number,
  tile: QuadtreeTile,
  entry: StackLayer,
  layer: number,
  chosen: number,
): boolean {
  latitudeRows(entry.chain[chosen]?.source, tile);
  list.below.textures[index] = mapped(MAPPING_HANDLE);
  list.below.toneSources[index] = toneSource(entry, layer, chosen);
  writeTransform(list.below.uvTransforms, index * 4);
  return true;
}

/** Prefetches the children of the center tile from each visible layer, from the first source of its chain that has it. */
function prefetchStack(layers: readonly StackLayer[], tile: QuadtreeTile, distance: number): void {
  for (let layer = 0; layer < layers.length; layer++) {
    const entry = layers[layer];
    if (!entry || !entry.entry.visible || shownOpacity(entry.entry) <= 0) continue;
    // The source the tile comes from: the first of the chain that has it.
    const chain = entry.chain;
    let source = 0;
    while (source < chain.length - 1 && !hasTile(chain[source] as ImageryLayer, tile)) source++;
    const chosen = chain[source];
    if (chosen && chosen.loader.prefetching !== false) prefetchChildren(chosen, tile, distance);
  }
}

/**
 * The tone source of a draw of `layer`'s source `chosen` (F249, F633): its place in the chain where the layer matches its
 * chain, offset by {@link TONE_BELOW} where it matches the imagery below, -1 where it matches nothing.
 */
function toneSource(entry: StackLayer, layer: number, chosen: number): number {
  const { harmonize } = entry.entry;
  if (harmonize === 'below') return TONE_BELOW + layer * 8 + chosen;
  return harmonize && entry.chain.length > 1 ? layer * 8 + chosen : -1;
}

/** Adds a layer's tile in `mapping` to the overlays found for a draw; returns their count. */
function addOverlay(layer: StackLayer, overlays: number, handle: number, geographic: number, tone: number): number {
  const at = overlays * FOUND;
  found[at] = handle;
  found[at + 1] = geographic;
  found[at + 2] = shownOpacity(layer.entry);
  found[at + 3] = BLEND_CODES[layer.entry.blend];
  writeTransform(found, at + 4);
  found[at + 8] = mapped(MAPPING_LEVEL);
  found[at + 9] = tone;
  return overlays + 1;
}

/**
 * A translucent layer still loading keeps its overlay slot, empty: the layers' slots do not shift when its tile arrives,
 * so each slot's cross-fade stays within one layer (KB-155). Returns the overlays found so far.
 */
function keepSlot(layer: StackLayer, overlays: number): number {
  if (isOpaque(layer.entry) || overlays >= MAX_OVERLAYS) return overlays;
  found[overlays * FOUND] = -1;
  found[overlays * FOUND + 2] = 0;
  found[overlays * FOUND + 8] = -1;
  found[overlays * FOUND + 9] = -1;
  return overlays + 1;
}

/** Writes the overlays found for draw `index` into the list's slots, bottom first; the slots left empty show nothing. */
function writeOverlays(list: DrawList, index: number, overlays: number): void {
  for (let slot = 0; slot < list.overlays.length; slot++) {
    const overlay = list.overlays[slot];
    if (!overlay) continue;
    // What a new slot fades in from, when it fades in (KB-306): nothing.
    overlay.fromTextures[index] = -1;
    if (slot >= overlays) {
      overlay.opacities[index] = 0;
      overlay.textures[index] = -1;
      overlay.levels[index] = -1;
      overlay.toneSources[index] = -1;
      continue;
    }
    const at = (overlays - 1 - slot) * FOUND;
    overlay.textures[index] = found[at] ?? -1;
    overlay.levels[index] = found[at + 8] ?? -1;
    overlay.toneSources[index] = found[at + 9] ?? -1;
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
  // The first source with no tile here although later sources map it: its own ancestors may still be finer (KB-331).
  let missing = -1;
  // Levels an earlier source serves are its own: a later source is asked only for finer ones (F247).
  let floor = 0;
  for (let k = 0; k < chain.length; k++) {
    const layer = chain[k];
    if (!layer) continue;
    if (!hasTile(layer, tile)) {
      // A source that answered "no tile" here does not cover it, coverage declared or not (KB-142), unless no later
      // source can map the tile: then its ancestors are the last resort (KB-149).
      if (fallback < 0 && mapInto(layer, tile)) {
        if (!(unavailableAtMapping(layer) && laterMaps(chain, k, tile))) fallback = k;
        else if (missing < 0) missing = k;
      }
      const top = topLevel(layer);
      if (tile.level > top && top + 1 > floor) floor = top + 1;
      continue;
    }
    if (wantLayer(layer, tile, distance, floor) >= 0) return k;
    for (let j = 0; j < chain.length; j++) {
      const standIn = chain[j];
      if (j !== k && standIn && residentLayer(standIn, tile) >= 0) return j;
    }
    return -1;
  }
  const own = chain[missing];
  // Its own ancestors when finer than anything a later source serves there (Esri's filler, F691).
  if (own && wantLayer(own, tile, distance, laterTop(chain, missing, tile) + 1) >= 0) return missing;
  const covering = chain[fallback];
  return covering && wantLayer(covering, tile, distance, 0) >= 0 ? fallback : -1;
}

/** The finest surface level a source after `k` serves for the tile, -1 when none maps it (overwrites `mapping`). */
function laterTop(chain: readonly ImageryLayer[], k: number, tile: QuadtreeTile): number {
  let top = -1;
  for (let j = k + 1; j < chain.length; j++) {
    const later = chain[j];
    if (later && mapInto(later, tile) && topLevel(later) > top) top = topLevel(later);
  }
  return top;
}

/** The finest surface level a layer's source serves: its finest level, deeper by the layer's level shift (F240). */
function topLevel(layer: ImageryLayer): number {
  return layer.source.maxLevel + layer.loader.levelShift;
}

/**
 * Maps a tile into a source's tiles (into `mapping`) at the tile's level less the layer's level shift (a 512-texel
 * tile serves the next finer surface level, F240, F241), clamped to the source's levels; false if it cannot.
 */
function mapInto(layer: ImageryLayer, tile: QuadtreeTile): boolean {
  const source = layer.source;
  // Outside its coverage a source has nothing, not even its coarse ancestors magnified: the layers below show (F094).
  if (source.coverage && !inCoverage(source.coverage, tile)) return false;
  const shifted = tile.level - layer.loader.levelShift;
  const level = shifted < 0 ? 0 : shifted < source.maxLevel ? shifted : source.maxLevel;
  if (source.tiling.crs === 'EPSG:3857') return tile.root === MERCATOR_ROOT && mapMercator(tile, level, mapping, 0);
  return mapGeographic(tile, level, mapping, 0);
}

/** True when some source of the chain covers the tile (overwrites `mapping`). */
function coversTile(chain: readonly ImageryLayer[], tile: QuadtreeTile): boolean {
  for (const layer of chain) if (mapInto(layer, tile)) return true;
  return false;
}

/** True when a source after `k` in the chain can map the tile (overwrites `mapping`). */
function laterMaps(chain: readonly ImageryLayer[], k: number, tile: QuadtreeTile): boolean {
  for (let j = k + 1; j < chain.length; j++) {
    const later = chain[j];
    if (later && mapInto(later, tile)) return true;
  }
  return false;
}

/** True when the source's tile in `mapping` (from {@link mapInto}) is known missing or failing. */
function unavailableAtMapping(layer: ImageryLayer): boolean {
  return layer.loader.unavailable(mapped(MAPPING_LEVEL), mapped(MAPPING_X), mapped(MAPPING_Y));
}

/** True when a source can give the tile at the surface's level now: within its levels, mapped, and not missing or failing. */
function hasTile(layer: ImageryLayer, tile: QuadtreeTile): boolean {
  const source = layer.source;
  if (tile.level > topLevel(layer) || !mapInto(layer, tile)) return false;
  return mapped(MAPPING_LEVEL) >= source.minLevel && !unavailableAtMapping(layer);
}

/** The deepest resident tile of a source for a tile, without requesting any (handle in `mapping`), or -1. */
function residentLayer(layer: ImageryLayer, tile: QuadtreeTile): number {
  const source = layer.source;
  if (!mapInto(layer, tile)) return -1;
  for (let current = mapped(MAPPING_LEVEL); current >= source.minLevel; current--) {
    const handle = layer.loader.readyHandle(current, mapped(MAPPING_X), mapped(MAPPING_Y));
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
  if (tile.level >= topLevel(layer) || !mapInto(layer, tile)) return;
  const level = mapped(MAPPING_LEVEL);
  const x = 2 * mapped(MAPPING_X);
  const y = 2 * mapped(MAPPING_Y);
  const key = PREFETCH_CLASS + level + 1 + 2 * distance;
  for (let child = 0; child < 4; child++) layer.loader.want(level + 1, x + (child & 1), y + (child >> 1), key);
}

/**
 * Below this fog visibility at a tile's closest point nothing is prefetched around or under it: its neighbors and
 * children, deeper in the haze, would show at most half their detail (F574, KB-174).
 */
const PREFETCH_MIN_VISIBILITY = 0.5;

const hazed = (tile: QuadtreeTile): boolean => (tile.fogVisibility ?? 1) < PREFETCH_MIN_VISIBILITY;

/**
 * Levels from a wanted tile up to its cover, requested first while nothing finer is resident (KB-305): even, so the
 * cover is one of the every-second ancestors requested anyway.
 */
const COVER_LEVELS = 4;

/** Room in the cover class for a tile's levels below its wanted one: more than any pyramid is deep. */
const COVER_SPAN = 32;

/**
 * Wants a layer's tiles for a surface tile and returns the handle of the deepest resident one, its mapping left in
 * `mapping`; -1 when none is resident or the layer cannot cover the tile. Levels below `floor` (served by an earlier
 * source of the chain) are neither requested nor looked up. While nothing finer is resident, the ancestor
 * {@link COVER_LEVELS} up (or the coarsest level), and the coarser ones requested, are requested before every visible
 * tile, coarse first (KB-305). In both classes a request ranks by its levels below the tile's wanted one, not by its
 * own level: where half a view wants deeper levels than the other half, both halves sharpen together (KB-330).
 */
function wantLayer(layer: ImageryLayer, tile: QuadtreeTile, distance: number, floor: number): number {
  const source = layer.source;
  if (!mapInto(layer, tile)) return -1;
  const wanted = mapped(MAPPING_LEVEL);
  const lowest = source.minLevel > floor ? source.minLevel : floor;
  const cover = wanted - COVER_LEVELS > lowest ? wanted - COVER_LEVELS : lowest;
  // Once a finer tile's bytes are in hand (ARRIVING), coarser ones are only looked up, never requested (F097).
  let arriving = false;
  // The level below was found missing: its parent is the finest this source can show there (KB-179).
  let belowMissing = false;
  for (let current = wanted; current >= lowest; current--) {
    const x = mapped(MAPPING_X);
    const y = mapped(MAPPING_Y);
    // The wanted tile, every second ancestor, the source's coarsest level and the parent of a missing tile are
    // requested; the others are only looked up.
    const handle =
      !arriving && ((wanted - current) % 2 === 0 || current === lowest || belowMissing)
        ? layer.loader.want(
            current,
            x,
            y,
            (current > cover ? VISIBLE_CLASS + COVER_LEVELS : COVER_CLASS + COVER_SPAN) -
              (wanted - current) +
              2 * distance,
            !hazed(tile),
          )
        : layer.loader.readyHandle(current, x, y);
    if (handle >= 0) {
      mapping[MAPPING_HANDLE] = handle;
      return handle;
    }
    if (handle === ARRIVING) arriving = true;
    belowMissing = layer.loader.unavailable(current, x, y);
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

/**
 * Wants, from every layer a view of the movement draws (shown at its deepest zoom, `plan.zoom`: a layer fades in as the
 * zoom grows, F635), the tiles its plan will draw (F286, F671, KB-308): each surface tile's imagery at its own level from the
 * first source of the chain that has it, at the preload class (after every visible tile, before prefetch) plus
 * `keys[i]` (-1: not now) and its level; for the destination's tiles (before `arrival`), their ancestor up to
 * {@link COVER_LEVELS} levels up, within the source's levels, first. Sources whose loading flags forbid prefetch load
 * nothing ahead. Allocates nothing.
 */
export function preloadImagery(
  stack: readonly StackLayer[],
  plan: {
    readonly tiles: readonly QuadtreeTile[];
    readonly keys: Float64Array;
    readonly count: number;
    readonly arrival: number;
    readonly zoom: number;
  },
): void {
  for (let s = 0; s < stack.length; s++) {
    const layer = stack[s];
    if (!layer || !shownAt(layer.entry, plan.zoom)) continue;
    for (let index = 0; index < plan.count; index++) {
      const tile = plan.tiles[index];
      const key = plan.keys[index] ?? -1;
      if (!tile || key < 0) continue;
      for (let k = 0; k < layer.chain.length; k++) {
        const source = layer.chain[k];
        if (!source || !hasTile(source, tile)) continue;
        const level = mapped(MAPPING_LEVEL);
        const up = Math.min(COVER_LEVELS, level - source.source.minLevel);
        if (!source.loader.preloading) break;
        source.loader.want(level, mapped(MAPPING_X), mapped(MAPPING_Y), PRELOAD_CLASS + key + level);
        if (index >= plan.arrival || up <= 0) break;
        mapAncestor(mapping, 0, up);
        source.loader.want(level - up, mapped(MAPPING_X), mapped(MAPPING_Y), PRELOAD_CLASS + level - up);
        break;
      }
    }
  }
}
