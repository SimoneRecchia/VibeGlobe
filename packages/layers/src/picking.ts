// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The picking id scheme (ADR 0029): every pickable feature draws a 32-bit id into the renderer's id buffer as RGBA8.
 * The high 8 bits are the layer's slot (1–255, assigned while the layer is in the stack), the low 24 bits the
 * feature's index in its layer's buffers. Id 0 means nothing was drawn there (bare terrain or sky).
 */

/** Largest number of layers that can be pickable at once. */
export const MAX_PICK_SLOTS = 255;
/** Largest feature index a layer can pick (2^24 − 1). */
export const MAX_PICK_FEATURE_INDEX = 0xff_ffff;

/** Packs a layer slot and feature index into one id. */
export function packPickId(slot: number, featureIndex: number): number {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_PICK_SLOTS)
    throw new RangeError(`pick slot ${slot} not in 1–255`);
  if (!Number.isInteger(featureIndex) || featureIndex < 0 || featureIndex > MAX_PICK_FEATURE_INDEX) {
    throw new RangeError(`feature index ${featureIndex} not in 0–${MAX_PICK_FEATURE_INDEX}`);
  }
  return (slot * 0x100_0000 + featureIndex) >>> 0;
}

/** The layer slot of an id (0 for the empty id). */
export function pickSlot(id: number): number {
  return id >>> 24;
}

/** The feature index of an id. */
export function pickFeatureIndex(id: number): number {
  return id & MAX_PICK_FEATURE_INDEX;
}

/** Writes an id as the four bytes the id buffer stores (R holds the slot, so the most significant byte comes first). */
export function encodePickColor(id: number, out: Uint8Array | Uint8ClampedArray, offset = 0): void {
  out[offset] = id >>> 24;
  out[offset + 1] = (id >>> 16) & 0xff;
  out[offset + 2] = (id >>> 8) & 0xff;
  out[offset + 3] = id & 0xff;
}

/** Reads the id stored at a pixel of an RGBA8 readback. */
export function decodePickColor(rgba: Uint8Array | Uint8ClampedArray, offset = 0): number {
  return (
    ((rgba[offset] ?? 0) * 0x100_0000 +
      ((rgba[offset + 1] ?? 0) << 16) +
      ((rgba[offset + 2] ?? 0) << 8) +
      (rgba[offset + 3] ?? 0)) >>>
    0
  );
}

/**
 * Picks from a small readback region around the pointer (for example 5 × 5 px centered on it): the id at the pixel
 * closest to the center, ties broken in row order so the answer never depends on anything but the pixels. The id buffer
 * is depth-tested, so the id at a pixel is already the topmost feature there.
 * @returns the id, or 0 when no pixel of the region holds a feature.
 */
export function pickNearest(rgba: Uint8Array | Uint8ClampedArray, widthPx: number, heightPx: number): number {
  const centerX = (widthPx - 1) / 2;
  const centerY = (heightPx - 1) / 2;
  let best = 0;
  let bestDistance = Infinity;
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const id = decodePickColor(rgba, (y * widthPx + x) * 4);
      if (id === 0) continue;
      const distance = (x - centerX) ** 2 + (y - centerY) ** 2;
      if (distance < bestDistance) {
        best = id;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** Hands out pick slots to layers and maps slots back to them. */
export class PickSlotTable<T> {
  readonly #owners: (T | undefined)[] = new Array<T | undefined>(MAX_PICK_SLOTS + 1);
  #next = 1;

  /**
   * Assigns the lowest free slot, starting after the last one handed out so a freed slot is not reused at once (an id
   * buffer read back late can then never name a different layer).
   * @throws RangeError when all 255 slots are taken.
   */
  acquire(owner: T): number {
    for (let tried = 0; tried < MAX_PICK_SLOTS; tried++) {
      const slot = ((this.#next - 1 + tried) % MAX_PICK_SLOTS) + 1;
      if (this.#owners[slot] === undefined) {
        this.#owners[slot] = owner;
        this.#next = (slot % MAX_PICK_SLOTS) + 1;
        return slot;
      }
    }
    throw new RangeError(`at most ${MAX_PICK_SLOTS} pickable layers`);
  }

  /** Frees a slot. */
  release(slot: number): void {
    this.#owners[slot] = undefined;
  }

  /** The owner of an id's slot, if any. */
  owner(id: number): T | undefined {
    return this.#owners[pickSlot(id)];
  }
}
