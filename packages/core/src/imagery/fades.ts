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
    this.frame++;
    this.fading = false;
    for (let i = 0; i < list.count; i++) {
      const key = list.meshKeys[i] ?? 0;
      let slot = this.slots.get(key);
      const texture = layer.textures[i] ?? 0;
      const level = layer.levels[i] ?? -1;
      if (slot === undefined) {
        slot = this.begin(key, layer, i, nowMs);
      } else if (this.toTexture[slot] !== texture || this.toLevel[slot] !== level) {
        const gap = (this.toLevel[slot] ?? -1) - level;
        if (gap > maxLevelGap || -gap > maxLevelGap) {
          // Too far apart to morph: the draw shows its new data at once.
          this.store(slot, layer, i);
          this.startMs[slot] = -Infinity;
        } else if (nowMs - (this.startMs[slot] ?? 0) < durationMs) {
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
          this.startMs[slot] = nowMs;
        }
      }
      this.stamps[slot] = this.frame;
      const elapsed = nowMs - (this.startMs[slot] ?? 0);
      const t = durationMs > 0 && elapsed < durationMs ? Math.max(0, elapsed / durationMs) : 1;
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
   * before (`seeded`, terrain, F138), fading from that.
   */
  private begin(key: number, layer: DrawLayer, i: number, nowMs: number): number {
    const slot = this.allocate(key);
    this.store(slot, layer, i);
    this.startMs[slot] = -Infinity;
    if (layer.seeded[i] === 1) {
      this.fromTexture[slot] = layer.fromTextures[i] ?? 0;
      this.fromGeographic[slot] = layer.fromGeographic[i] ?? 1;
      for (let c = 0; c < 4; c++) this.fromTransform[slot * 4 + c] = layer.fromUvTransforms[i * 4 + c] ?? 0;
      this.startMs[slot] = nowMs;
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
