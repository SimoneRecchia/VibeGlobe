import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import type { DrawList } from './draw-list.js';

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
   * with every texture a fade still needs, so the memory budget keeps it resident.
   */
  apply(list: DrawList, now: Float64Array, durationMs: number, keep: (handle: number) => void): void {
    const nowMs = now[0] ?? 0;
    this.frame++;
    this.fading = false;
    for (let i = 0; i < list.count; i++) {
      const key = list.meshKeys[i] ?? 0;
      let slot = this.slots.get(key);
      const texture = list.textures[i] ?? 0;
      const level = list.imageryLevels[i] ?? -1;
      if (slot === undefined) {
        slot = this.allocate(key);
        this.store(slot, list, i);
        this.startMs[slot] = -Infinity;
      } else if (this.toTexture[slot] !== texture || this.toLevel[slot] !== level) {
        if (nowMs - (this.startMs[slot] ?? 0) < durationMs) {
          // A fade is under way: it finishes first, so what the tile shows never jumps; the new imagery fades in next.
          keep(texture);
          this.restore(slot, list, i);
        } else {
          // Fade from what the tile showed to its new imagery.
          this.fromTexture[slot] = this.toTexture[slot] ?? 0;
          this.fromGeographic[slot] = this.toGeographic[slot] ?? 1;
          for (let c = 0; c < 4; c++) this.fromTransform[slot * 4 + c] = this.toTransform[slot * 4 + c] ?? 0;
          this.store(slot, list, i);
          this.startMs[slot] = nowMs;
        }
      }
      this.stamps[slot] = this.frame;
      const elapsed = nowMs - (this.startMs[slot] ?? 0);
      const t = durationMs > 0 && elapsed < durationMs ? Math.max(0, elapsed / durationMs) : 1;
      list.fades[i] = t;
      if (t < 1) {
        this.fading = true;
        const from = this.fromTexture[slot] ?? 0;
        keep(from);
        list.fromTextures[i] = from;
        list.fromGeographic[i] = this.fromGeographic[slot] ?? 1;
        for (let c = 0; c < 4; c++) list.fromUvTransforms[i * 4 + c] = this.fromTransform[slot * 4 + c] ?? 0;
      } else {
        list.fromTextures[i] = list.textures[i] ?? 0;
        list.fromGeographic[i] = list.geographic[i] ?? 1;
        for (let c = 0; c < 4; c++) list.fromUvTransforms[i * 4 + c] = list.uvTransforms[i * 4 + c] ?? 0;
      }
    }
    this.dropUndrawn();
  }

  private store(slot: number, list: DrawList, i: number): void {
    this.toTexture[slot] = list.textures[i] ?? 0;
    this.toLevel[slot] = list.imageryLevels[i] ?? -1;
    this.toGeographic[slot] = list.geographic[i] ?? 1;
    for (let c = 0; c < 4; c++) this.toTransform[slot * 4 + c] = list.uvTransforms[i * 4 + c] ?? 0;
  }

  /** Draws the imagery a fade under way goes to, in place of the draw's newer imagery, keeping it resident. */
  private restore(slot: number, list: DrawList, i: number): void {
    list.textures[i] = this.toTexture[slot] ?? 0;
    list.imageryLevels[i] = this.toLevel[slot] ?? -1;
    list.geographic[i] = this.toGeographic[slot] ?? 1;
    for (let c = 0; c < 4; c++) list.uvTransforms[i * 4 + c] = this.toTransform[slot * 4 + c] ?? 0;
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
