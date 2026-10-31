// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import type { DrawLayer } from './draw-list.js';
import { grownArray } from '../collections/typed-arrays.js';

/** Default duration of an imagery cross-fade (M3 plan §4.2: the popping detector assumes 250 ms). */
export const DEFAULT_FADE_MS = 250;
/** Levels up a tile appearing by refinement looks for an ancestor drawn last frame: motion-aware detail's (F288). */
const MAX_REFINE_LEVELS = 3;

/**
 * Cross-fades between the imagery a surface tile showed and what it shows now (F105, ADR 0006): when a tile's texture
 * changes, it draws both for the fade's duration, the old one fading out. State lives per surface tile key in typed
 * arrays reused across frames; tiles not drawn in a frame drop theirs (ADR 0018: nothing allocated per frame).
 */
export class ImageryFades {
  /** True when the last frame drew a fade in progress: the engine draws the next frame and is not idle. */
  fading = false;
  /** Set for a frame that shows a change at once (the imagery stack's, F243): it starts no fade. */
  snapNext = false;
  private readonly slots = new IntegerKeyMap<number>(1024);
  private capacity = 0;
  private used = 0;
  private freeCount = 0;
  private frame = 0;
  private free = new Int32Array(0);
  private keys = new Float64Array(0);
  private stamps = new Uint32Array(0);
  private toTexture = new Int32Array(0);
  private toLevel = new Int8Array(0);
  private toGeographic = new Uint8Array(0);
  private toTransform = new Float32Array(0);
  private fromTexture = new Int32Array(0);
  private fromGeographic = new Uint8Array(0);
  private fromTransform = new Float32Array(0);
  private startMs = new Float64Array(0);

  /**
   * Writes each draw's fade at engine time `now[0]` into `list`: the texture it fades from and how far it is (`fades`,
   * 1 when done). A draw whose imagery changes during a fade keeps the fade's imagery until it ends. `keep` is called
   * with every texture a fade still needs, so the memory budget keeps it resident. A change across more than
   * `maxLevelGap` levels switches at once: terrain morphs between levels that far apart would open cracks wider than
   * any skirt against neighbors already showing the finer level (KB-079).
   */
  apply(
    list: { readonly count: number; readonly meshKeys: Float64Array },
    layer: DrawLayer,
    now: Float64Array,
    durationMs: number,
    keep: (handle: number) => void,
    maxLevelGap = Infinity,
  ): void {
    const nowMs = now[0] ?? 0;
    const fadeMs = this.snapNext ? 0 : durationMs;
    this.snapNext = false;
    this.frame++;
    this.fading = false;
    for (let i = 0; i < list.count; i++) {
      const key = list.meshKeys[i] ?? 0;
      let slot = this.slots.get(key);
      const texture = layer.textures[i] ?? 0;
      const level = layer.levels[i] ?? -1;
      if (slot === undefined) {
        slot = this.begin(key, layer, i, nowMs, maxLevelGap === Infinity ? fadeMs : 0);
      } else if (this.toTexture[slot] !== texture || this.toLevel[slot] !== level) {
        const gap = (this.toLevel[slot] ?? -1) - level;
        if (gap > maxLevelGap || -gap > maxLevelGap) {
          // Too far apart to morph: the draw shows its new data at once.
          this.store(slot, layer, i);
          this.startMs[slot] = -Infinity;
        } else if (nowMs - (this.startMs[slot] ?? 0) < fadeMs) {
          // A fade is under way: it finishes first, so what the tile shows never jumps; the new imagery fades in next.
          keep(texture);
          keep(this.toTexture[slot] ?? 0);
          this.restore(slot, layer, i);
        } else {
          // Fade from what the tile showed to its new imagery.
          this.fromTexture[slot] = this.toTexture[slot] ?? 0;
          this.fromGeographic[slot] = this.toGeographic[slot] ?? 1;
          for (let c = 0; c < 4; c++) this.fromTransform[slot * 4 + c] = this.toTransform[slot * 4 + c] ?? 0;
          this.store(slot, layer, i);
          // Without a duration (a frame that shows a change at once, F243) no fade starts.
          this.startMs[slot] = fadeMs > 0 ? nowMs : -Infinity;
        }
      }
      this.stamps[slot] = this.frame;
      const elapsed = nowMs - (this.startMs[slot] ?? 0);
      const t = fadeMs > 0 && elapsed < fadeMs ? Math.max(0, elapsed / fadeMs) : 1;
      layer.fades[i] = t;
      if (t < 1) {
        this.fading = true;
        const from = this.fromTexture[slot] ?? 0;
        keep(from);
        layer.fromTextures[i] = from;
        layer.fromGeographic[i] = this.fromGeographic[slot] ?? 1;
        for (let c = 0; c < 4; c++) layer.fromUvTransforms[i * 4 + c] = this.fromTransform[slot * 4 + c] ?? 0;
      } else {
        layer.fromTextures[i] = layer.textures[i] ?? 0;
        layer.fromGeographic[i] = layer.geographic[i] ?? 1;
        for (let c = 0; c < 4; c++) layer.fromUvTransforms[i * 4 + c] = layer.uvTransforms[i * 4 + c] ?? 0;
      }
    }
    this.dropUndrawn();
  }

  /**
   * A slot for a tile drawn for the first time: it starts without a fade, or, when its draw names what was shown there
   * before (`seeded`, terrain, F138), fading from that. With `refine` (imagery), a Web Mercator tile whose parent was
   * drawn last frame with other imagery fades from the part of the parent's that covers it, or continues the parent's
   * fade when one is under way: a refinement that brings finer imagery already loaded then shows no jump (F269).
   * `refineMs` is the fade duration for such tiles, 0 for none.
   */
  private begin(key: number, layer: DrawLayer, i: number, nowMs: number, refineMs: number): number {
    const slot = this.allocate(key);
    this.store(slot, layer, i);
    this.startMs[slot] = -Infinity;
    let start = layer.seeded[i] === 1 ? nowMs : Number.NaN;
    if (refineMs > 0 && key % 3 === 0) {
      const tile = tileOfKey(key);
      const level = tile[0];
      const column = tile[1];
      const row = tile[2];
      // The nearest ancestor drawn last frame: a camera stopping refines by up to its motion's levels at once (F288).
      let parent = -1;
      let up = 0;
      while (parent < 0 && up < MAX_REFINE_LEVELS && up < level) {
        up++;
        parent = this.drawnLastFrame(meshKey(level - up, column >> up, row >> up));
      }
      const parentStart = this.startMs[parent] ?? -Infinity;
      // A layer's tile where the parent showed what lies below (the base image, or nothing in an overlay slot: a
      // negative texture, which the draw's own `from` fields hold) fades in from it, or goes on with the parent's fade
      // in from it (KB-306).
      if (parent >= 0 && (this.toTexture[slot] ?? -1) >= 0)
        if (nowMs - parentStart < refineMs && (this.fromTexture[parent] ?? 0) < 0) start = parentStart;
        else if ((this.toTexture[parent] ?? 0) < 0) start = nowMs;
      if (
        start !== start &&
        (layer.geographic[i] ?? 1) === 0 &&
        !this.seedFromParent(slot, parent, 2 ** up, column, row, nowMs, refineMs)
      )
        this.seedFromChildren(slot, level, column, row, nowMs, refineMs);
    }
    if (start === start) {
      this.fromTexture[slot] = layer.fromTextures[i] ?? 0;
      this.fromGeographic[slot] = layer.fromGeographic[i] ?? 1;
      for (let c = 0; c < 4; c++) this.fromTransform[slot * 4 + c] = layer.fromUvTransforms[i * 4 + c] ?? 0;
      this.startMs[slot] = start;
    }
    return slot;
  }

  /**
   * A Web Mercator tile appearing by refinement, at `column` and `row`: fades from its part of what its ancestor
   * `parent` (−1: none), `cells` of it to a side, showed last frame, or goes on with the ancestor's fade under way.
   * Returns whether it did.
   */
  private seedFromParent(
    slot: number,
    parent: number,
    cells: number,
    column: number,
    row: number,
    nowMs: number,
    fadeMs: number,
  ): boolean {
    if (parent < 0 || this.toGeographic[parent] !== 0) return false;
    // A fade of the parent under way goes on from where it started, with its timing, also when the child shows the
    // imagery the parent fades to: cutting it off would jump.
    const fading = nowMs - (this.startMs[parent] ?? -Infinity) < fadeMs && this.fromGeographic[parent] === 0;
    if (!fading && this.toTexture[parent] === this.toTexture[slot]) return false;
    const source = fading ? this.fromTransform : this.toTransform;
    this.fromTexture[slot] = (fading ? this.fromTexture[parent] : this.toTexture[parent]) ?? 0;
    this.fromGeographic[slot] = 0;
    // The tile's part of what the ancestor showed: its scale over the cells, offset by its column and row within it.
    const su = (source[parent * 4] ?? 1) / cells;
    const sv = (source[parent * 4 + 1] ?? 1) / cells;
    this.fromTransform[slot * 4] = su;
    this.fromTransform[slot * 4 + 1] = sv;
    this.fromTransform[slot * 4 + 2] = (source[parent * 4 + 2] ?? 0) + (column % cells) * su;
    this.fromTransform[slot * 4 + 3] = (source[parent * 4 + 3] ?? 0) + (row % cells) * sv;
    this.startMs[slot] = fading ? (this.startMs[parent] ?? nowMs) : nowMs;
    return true;
  }

  /**
   * A Web Mercator tile appearing by coarsening, at `level`, `column` and `row`, where every child drawn last frame with
   * Web Mercator imagery showed the same imagery (a stand-in magnified over all of them), or was fading from the same
   * imagery: fades from that imagery over the whole tile, or goes on with the children's fade.
   */
  private seedFromChildren(
    slot: number,
    level: number,
    column: number,
    row: number,
    nowMs: number,
    fadeMs: number,
  ): void {
    let first = -1;
    let firstChild = 0;
    let fading = false;
    for (let k = 0; k < 4; k++) {
      const child = this.drawnLastFrame(meshKey(level + 1, 2 * column + (k & 1), 2 * row + (k >> 1)));
      if (child < 0 || this.toGeographic[child] !== 0) continue;
      // A fade of the children under way goes on, from what they all fade from.
      const childFading = nowMs - (this.startMs[child] ?? -Infinity) < fadeMs && this.fromGeographic[child] === 0;
      const shown = (childFading ? this.fromTexture[child] : this.toTexture[child]) ?? 0;
      if (first < 0) {
        first = child;
        firstChild = k;
        fading = childFading;
      } else if (childFading !== fading || shown !== (fading ? this.fromTexture[first] : this.toTexture[first])) return;
    }
    if (first < 0 || (!fading && this.toTexture[first] === this.toTexture[slot])) return;
    const source = fading ? this.fromTransform : this.toTransform;
    this.fromTexture[slot] = (fading ? this.fromTexture[first] : this.toTexture[first]) ?? 0;
    this.fromGeographic[slot] = 0;
    // The child showed its quarter of this tile's part: twice its scale, back by its column and row within this tile.
    const su = source[first * 4] ?? 1;
    const sv = source[first * 4 + 1] ?? 1;
    this.fromTransform[slot * 4] = 2 * su;
    this.fromTransform[slot * 4 + 1] = 2 * sv;
    this.fromTransform[slot * 4 + 2] = (source[first * 4 + 2] ?? 0) - (firstChild & 1) * su;
    this.fromTransform[slot * 4 + 3] = (source[first * 4 + 3] ?? 0) - (firstChild >> 1) * sv;
    this.startMs[slot] = fading ? (this.startMs[first] ?? nowMs) : nowMs;
  }

  /** The slot of a tile drawn last frame, −1 for none. */
  private drawnLastFrame(key: number): number {
    const slot = this.slots.get(key);
    return slot !== undefined && this.stamps[slot] === this.frame - 1 ? slot : -1;
  }

  private store(slot: number, layer: DrawLayer, i: number): void {
    this.toTexture[slot] = layer.textures[i] ?? 0;
    this.toLevel[slot] = layer.levels[i] ?? -1;
    this.toGeographic[slot] = layer.geographic[i] ?? 1;
    for (let c = 0; c < 4; c++) this.toTransform[slot * 4 + c] = layer.uvTransforms[i * 4 + c] ?? 0;
  }

  /** Draws the imagery a fade under way goes to, in place of the draw's newer imagery, keeping it resident. */
  private restore(slot: number, layer: DrawLayer, i: number): void {
    layer.textures[i] = this.toTexture[slot] ?? 0;
    layer.levels[i] = this.toLevel[slot] ?? -1;
    layer.geographic[i] = this.toGeographic[slot] ?? 1;
    for (let c = 0; c < 4; c++) layer.uvTransforms[i * 4 + c] = this.toTransform[slot * 4 + c] ?? 0;
  }

  private allocate(key: number): number {
    if (this.freeCount === 0 && this.used === this.capacity) this.grow(Math.max(256, this.capacity * 2));
    const slot = this.freeCount > 0 ? (this.free[--this.freeCount] ?? 0) : this.used++;
    this.keys[slot] = key;
    this.slots.set(key, slot);
    return slot;
  }

  /** Forgets the tiles the frame did not draw: a tile drawn again later starts without a fade. */
  private dropUndrawn(): void {
    for (let slot = 0; slot < this.used; slot++) {
      const stamp = this.stamps[slot] ?? 0;
      if (stamp === 0 || stamp === this.frame) continue;
      this.stamps[slot] = 0;
      this.slots.delete(this.keys[slot] ?? 0);
      this.free[this.freeCount++] = slot;
    }
  }

  private grow(capacity: number): void {
    this.free = grownArray(this.free, capacity);
    this.keys = grownArray(this.keys, capacity);
    this.stamps = grownArray(this.stamps, capacity);
    this.toTexture = grownArray(this.toTexture, capacity);
    this.toLevel = grownArray(this.toLevel, capacity);
    this.toGeographic = grownArray(this.toGeographic, capacity);
    this.toTransform = grownArray(this.toTransform, capacity * 4);
    this.fromTexture = grownArray(this.fromTexture, capacity);
    this.fromGeographic = grownArray(this.fromGeographic, capacity);
    this.fromTransform = grownArray(this.fromTransform, capacity * 4);
    this.startMs = grownArray(this.startMs, capacity);
    this.capacity = capacity;
  }
}

const tileScratch: [number, number, number] = [0, 0, 0];

/** The level, column and row of a Web Mercator tile's `quadtreeTileKey` (reused array: read it at once). */
function tileOfKey(key: number): [number, number, number] {
  const index = key / 3;
  let level = 0;
  while ((4 ** (level + 1) - 1) / 3 <= index) level++;
  const within = index - (4 ** level - 1) / 3;
  const column = within % 2 ** level;
  tileScratch[0] = level;
  tileScratch[1] = column;
  tileScratch[2] = (within - column) / 2 ** level;
  return tileScratch;
}

/** `quadtreeTileKey` of a Web Mercator tile (root 0). */
function meshKey(level: number, column: number, row: number): number {
  return ((4 ** level - 1) / 3 + row * 2 ** level + column) * 3;
}
