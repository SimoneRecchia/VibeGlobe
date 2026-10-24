// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Tone matching of an imagery layer's source chain (F249, ADR 0044): each tile's mean color is measured once at
 * upload, from a 4 × 4 downscale; each frame, the drawn tiles of each source of a chain give that source's mean color
 * in view, and a later source's gain moves toward the first source's mean over its own, so a switch or a boundary
 * between sources does not show a change of tone. Gains follow the view's means each frame (an idle engine draws no
 * frame to ease them in), stay within ×0.5–×2, and keep their last value while a source or its reference is not in view.
 */
import type { TileDrawList } from '@vibeglobe/core';

/** Layers × chain positions a frame can tell apart (`TileDrawList.toneSources`). */
const KEYS = 64;
const MIN_GAIN = 0.5;
const MAX_GAIN = 2;
/** The gains scale sRGB means, the shader multiplies linear texels: a gain g there is about g^2.2. */
const SRGB_GAMMA = 2.2;

/** A 2D context of a 4 × 4 canvas for the means, created on first use; undefined where none exists (workers, tests). */
let sampler: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null | undefined;

function samplerContext(): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  if (sampler !== undefined) return sampler;
  if (typeof OffscreenCanvas === 'function')
    sampler = new OffscreenCanvas(4, 4).getContext('2d', { willReadFrequently: true });
  else if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    sampler = canvas.getContext('2d', { willReadFrequently: true });
  } else sampler = null;
  return sampler;
}

/** The mean color of a decoded image, 0–1 per channel, or undefined for one that cannot be drawn (compressed tiles). */
function meanColor(image: unknown): Float32Array | undefined {
  const context = samplerContext();
  const drawable =
    (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) ||
    (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) ||
    (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement);
  if (!context || !drawable) return undefined;
  try {
    context.clearRect(0, 0, 4, 4);
    context.drawImage(image as CanvasImageSource, 0, 0, 4, 4);
    const data = context.getImageData(0, 0, 4, 4).data;
    const mean = new Float32Array(3);
    for (let i = 0; i < 64; i += 4)
      for (let c = 0; c < 3; c++) mean[c] = (mean[c] ?? 0) + (data[i + c] ?? 0) / (16 * 255);
    return mean;
  } catch {
    return undefined;
  }
}

/** The tone gains of a renderer's imagery: tile means by texture handle, and a gain per chain source. */
export class ToneMatcher {
  /** Tile means by texture handle; null for a tile that cannot be measured (compressed). */
  readonly #means = new Map<number, Float32Array | null>();
  /** The source a texture was last drawn as, for the gain of a fade that starts from it. */
  readonly #sources = new Map<number, number>();
  /** Per key: summed means and count of this frame's draws. */
  readonly #sums = new Float64Array(KEYS * 4);
  readonly #gains = new Float32Array(KEYS * 3).fill(1);

  /** Records a tile's mean color (0–1 per channel, sRGB), measured from its image unless given. */
  measure(handle: number, image: unknown, mean = meanColor(image)): void {
    this.#means.set(handle, mean ?? null);
  }

  /** Forgets a released texture. */
  release(handle: number): void {
    this.#means.delete(handle);
    this.#sources.delete(handle);
  }

  /**
   * Sets each later source's gain to the first source's mean over its own, from this frame's draws. A tile is measured
   * the first time a matched layer draws it (`imageOf` gives its image): layers without a chain measure nothing.
   */
  frame(draws: TileDrawList, imageOf?: (handle: number) => unknown): void {
    const sums = this.#sums;
    sums.fill(0);
    for (let i = 0; i < draws.count; i++) {
      const key = draws.toneSources[i] ?? -1;
      if (key < 0 || key >= KEYS) continue;
      const handle = draws.textures[i] ?? -1;
      if (this.#sources.get(handle) !== key) this.#sources.set(handle, key);
      if (imageOf && !this.#means.has(handle)) this.measure(handle, imageOf(handle));
      const mean = this.#means.get(handle);
      if (!mean) continue;
      for (let c = 0; c < 3; c++) sums[key * 4 + c] = (sums[key * 4 + c] ?? 0) + (mean[c] ?? 0);
      sums[key * 4 + 3] = (sums[key * 4 + 3] ?? 0) + 1;
    }
    for (let key = 0; key < KEYS; key++) {
      const reference = key - (key % 8);
      if (key === reference) continue;
      const count = sums[key * 4 + 3] ?? 0;
      const referenceCount = sums[reference * 4 + 3] ?? 0;
      if (count === 0 || referenceCount === 0) continue;
      for (let c = 0; c < 3; c++) {
        const own = (sums[key * 4 + c] ?? 0) / count;
        const wanted = (sums[reference * 4 + c] ?? 0) / referenceCount;
        this.#gains[key * 3 + c] = own > 1e-3 ? Math.min(MAX_GAIN, Math.max(MIN_GAIN, wanted / own)) : 1;
      }
    }
  }

  /**
   * Writes the gains of draw `i`'s imagery and of the imagery it fades from (1 where no gain applies) into a matrix's
   * first two columns (`SurfaceDraw.tones`).
   */
  apply(draws: TileDrawList, i: number, out: Float32Array | number[]): void {
    const key = draws.toneSources[i] ?? -1;
    const from = draws.fromTextures[i] ?? -1;
    this.gainInto(key, out, 0);
    this.gainInto(from === (draws.textures[i] ?? -1) ? key : (this.#sources.get(from) ?? -1), out, 4);
  }

  private gainInto(key: number, out: Float32Array | number[], at: number): void {
    for (let c = 0; c < 3; c++) {
      out[at + c] = key < 0 || key >= KEYS ? 1 : (this.#gains[key * 3 + c] ?? 1) ** SRGB_GAMMA;
    }
  }
}
