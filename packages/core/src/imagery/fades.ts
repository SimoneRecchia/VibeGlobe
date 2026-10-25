// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import type { DrawLayer } from './draw-list.js';

/** Default duration of an imagery cross-fade (M3 plan §4.2: the popping detector assumes 250 ms). */
export const DEFAULT_FADE_MS = 250;

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
    if (layer.seeded[i] === 1) {
      this.fromTexture[slot] = layer.fromTextures[i] ?? 0;
      this.fromGeographic[slot] = layer.fromGeographic[i] ?? 1;
      for (let c = 0; c < 4; c++) this.fromTransform[slot * 4 + c] = layer.fromUvTransforms[i * 4 + c] ?? 0;
      this.startMs[slot] = nowMs;
    } else if (refineMs > 0 && (layer.geographic[i] ?? 1) === 0) {
      const parentKey = mercatorParentKey(key);
      const parent = parentKey < 0 ? undefined : this.slots.get(parentKey);
      if (
        parent !== undefined &&
        this.stamps[parent] === this.frame - 1 &&
        this.toGeographic[parent] === 0 &&
        this.toTexture[parent] !== this.toTexture[slot]
      ) {
        // A fade of the parent under way goes on from where it started, with its timing.
        const fading = nowMs - (this.startMs[parent] ?? -Infinity) < refineMs && this.fromGeographic[parent] === 0;
        const source = fading ? this.fromTransform : this.toTransform;
        this.fromTexture[slot] = (fading ? this.fromTexture[parent] : this.toTexture[parent]) ?? 0;
        this.fromGeographic[slot] = 0;
        // The child's quarter of what the parent showed: half its scale, offset by the child's column and row.
        const tile = (key - (key % 3)) / 3;
        const level = levelOfIndex(tile);
        const within = tile - (4 ** level - 1) / 3;
        const column = within % 2 ** level;
        const row = (within - column) / 2 ** level;
        const su = (source[parent * 4] ?? 1) / 2;
        const sv = (source[parent * 4 + 1] ?? 1) / 2;
        this.fromTransform[slot * 4] = su;
        this.fromTransform[slot * 4 + 1] = sv;
        this.fromTransform[slot * 4 + 2] = (source[parent * 4 + 2] ?? 0) + (column % 2) * su;
        this.fromTransform[slot * 4 + 3] = (source[parent * 4 + 3] ?? 0) + (row % 2) * sv;
        this.startMs[slot] = fading ? (this.startMs[parent] ?? nowMs) : nowMs;
      }
    }
    return slot;
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
    const copy = <T extends Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array | Int8Array>(
      array: T,
      size: number,
      create: (length: number) => T,
    ): T => {
      const next = create(size);
      next.set(array);
      return next;
    };
    this.free = copy(this.free, capacity, (n) => new Int32Array(n));
    this.keys = copy(this.keys, capacity, (n) => new Float64Array(n));
    this.stamps = copy(this.stamps, capacity, (n) => new Uint32Array(n));
    this.toTexture = copy(this.toTexture, capacity, (n) => new Int32Array(n));
    this.toLevel = copy(this.toLevel, capacity, (n) => new Int8Array(n));
    this.toGeographic = copy(this.toGeographic, capacity, (n) => new Uint8Array(n));
    this.toTransform = copy(this.toTransform, capacity * 4, (n) => new Float32Array(n));
    this.fromTexture = copy(this.fromTexture, capacity, (n) => new Int32Array(n));
    this.fromGeographic = copy(this.fromGeographic, capacity, (n) => new Uint8Array(n));
    this.fromTransform = copy(this.fromTransform, capacity * 4, (n) => new Float32Array(n));
    this.startMs = copy(this.startMs, capacity, (n) => new Float64Array(n));
    this.capacity = capacity;
  }
}

/** The quadtree level of a tile index (`quadtreeTileKey` without its root): levels start at (4^level − 1) / 3. */
function levelOfIndex(index: number): number {
  let level = 0;
  while ((4 ** (level + 1) - 1) / 3 <= index) level++;
  return level;
}

/** The key of a Web Mercator surface tile's parent (`quadtreeTileKey`), or −1 for a root or another root's tile. */
function mercatorParentKey(key: number): number {
  const root = key % 3;
  if (root !== 0) return -1;
  const index = key / 3;
  const level = levelOfIndex(index);
  if (level === 0) return -1;
  const within = index - (4 ** level - 1) / 3;
  const column = within % 2 ** level;
  const row = (within - column) / 2 ** level;
  return ((4 ** (level - 1) - 1) / 3 + Math.floor(row / 2) * 2 ** (level - 1) + Math.floor(column / 2)) * 3;
}
