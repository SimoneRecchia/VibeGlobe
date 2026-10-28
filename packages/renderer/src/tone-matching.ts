// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Tone matching of an imagery layer's source chain (F249, ADR 0044): each tile's mean color is measured once at
 * upload, from a 4 × 4 downscale; each frame, the drawn tiles of each source of a chain give that source's mean color
 * in view, and a later source's gain moves toward the first source's mean over its own, so a switch or a boundary
 * between sources does not show a change of tone. Gains follow the view's means each frame (an idle engine draws no
 * frame to ease them in), stay within ×0.5–×2, and keep their last value while a source or its reference is not in view.
 * A layer that matches the imagery below it (`harmonize: 'below'`, F633) compares each of its tiles with what lies under
 * it on the same surface tile, cell by cell of a 4 × 4 grid and weighted by its own coverage: for a transparent layer
 * the draw's opaque imagery, for an opaque one the next layer down with a tile there (each with its own gain), or the
 * world base image, measured once on a {@link BASE_COLUMNS} × {@link BASE_ROWS} grid.
 */
import { BASE_TEXTURE_HANDLE, TONE_BELOW, type TileDrawList, type TileDrawOverlay } from '@vibeglobe/core';

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

/** Cells of a tile's color grid per side: its mean colors are kept per cell, so a part of a tile can be compared. */
const CELLS = 4;
/** The world base image's color grid, columns: fine enough for the tiles of the lowest levels a layer starts at. */
export const BASE_COLUMNS = 256;
/** The world base image's color grid, rows. */
export const BASE_ROWS = 128;
/** Tone keys of layers that match the imagery below (64 layers × chain positions, as the chain keys). */
const BELOW_KEYS = 64;

/**
 * The colors of a decoded image on a `columns` × `rows` grid, rgba 0–1 per cell (sRGB, alpha unpremultiplied), or
 * undefined for one that cannot be drawn (compressed tiles).
 */
function colorGrid(image: unknown, columns = CELLS, rows = CELLS): Float32Array | undefined {
  if (isPixels(image)) return pixelGrid(image, columns, rows);
  const context = samplerContext();
  const drawable =
    (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) ||
    (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) ||
    (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement);
  if (!context || !drawable) return undefined;
  try {
    const canvas = context.canvas;
    if (canvas.width !== columns || canvas.height !== rows) {
      canvas.width = columns;
      canvas.height = rows;
    }
    context.clearRect(0, 0, columns, rows);
    context.drawImage(image as CanvasImageSource, 0, 0, columns, rows);
    const data = context.getImageData(0, 0, columns, rows).data;
    const grid = new Float32Array(columns * rows * 4);
    for (let i = 0; i < grid.length; i++) grid[i] = (data[i] ?? 0) / 255;
    return grid;
  } catch {
    return undefined;
  }
}

/** A tile's own pixels (a tile masked per pixel, F636): RGBA8, straight alpha. */
interface Pixels {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

function isPixels(image: unknown): image is Pixels {
  return typeof image === 'object' && image !== null && (image as Partial<Pixels>).data instanceof Uint8Array;
}

/** The colors of RGBA pixels on a grid, as a canvas's downscale gives them: alpha-weighted color, mean alpha. */
function pixelGrid({ data, width, height }: Pixels, columns: number, rows: number): Float32Array {
  const grid = new Float32Array(columns * rows * 4);
  const counts = new Float32Array(columns * rows);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const cell = Math.floor((y * rows) / height) * columns + Math.floor((x * columns) / width);
      const at = (y * width + x) * 4;
      const alpha = (data[at + 3] ?? 0) / 255;
      for (let c = 0; c < 3; c++) grid[cell * 4 + c] = (grid[cell * 4 + c] ?? 0) + (alpha * (data[at + c] ?? 0)) / 255;
      grid[cell * 4 + 3] = (grid[cell * 4 + 3] ?? 0) + alpha;
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  for (let cell = 0; cell < counts.length; cell++) {
    const alpha = grid[cell * 4 + 3] ?? 0;
    for (let c = 0; c < 3; c++) grid[cell * 4 + c] = alpha > 0 ? (grid[cell * 4 + c] ?? 0) / alpha : 0;
    grid[cell * 4 + 3] = alpha / Math.max(1, counts[cell] ?? 1);
  }
  return grid;
}

/** A grid of one color, for a mean given directly (tests, and images measured elsewhere). */
function uniformGrid(mean: Float32Array): Float32Array {
  const grid = new Float32Array(CELLS * CELLS * 4);
  for (let cell = 0; cell < CELLS * CELLS; cell++) {
    for (let c = 0; c < 3; c++) grid[cell * 4 + c] = mean[c] ?? 0;
    grid[cell * 4 + 3] = mean[3] ?? 1;
  }
  return grid;
}

/** The cell of a grid at texture coordinates (u, v), clamped to the grid; its index times 4. */
function cellAt(u: number, v: number, columns: number, rows: number): number {
  const x = Math.min(columns - 1, Math.max(0, Math.floor(u * columns)));
  const y = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
  return (y * columns + x) * 4;
}

/** The tone gains of a renderer's imagery: tile color grids by texture handle, and a gain per chain source. */
export class ToneMatcher {
  /** Tile color grids by texture handle; null for a tile that cannot be measured (compressed). */
  readonly #grids = new Map<number, Float32Array | null>();
  /** The source a texture was last drawn as, for the gain of a fade that starts from it. */
  readonly #sources = new Map<number, number>();
  /** Per key: summed means and count of this frame's draws. */
  readonly #sums = new Float64Array(KEYS * 4);
  readonly #gains = new Float32Array(KEYS * 3).fill(1);
  /** Per key of a layer matched to the imagery below: its own and the reference's coverage-weighted sums. */
  readonly #below = new Float64Array(BELOW_KEYS * 7);
  readonly #belowGains = new Float32Array(BELOW_KEYS * 3).fill(1);
  /** The world base image's color grid, once measured. */
  #base: Float32Array | undefined;

  /**
   * Records a tile's colors, measured from its image unless given: a mean (rgb 0–1, sRGB) or a 4 × 4 grid of rgba
   * cells.
   */
  measure(handle: number, image: unknown, colors = colorGrid(image)): void {
    this.#grids.set(handle, colors ? (colors.length === CELLS * CELLS * 4 ? colors : uniformGrid(colors)) : null);
  }

  /** Records the world base image's colors, measured from its image unless given as a grid of rgba cells. */
  measureBase(image: unknown, grid = colorGrid(image, BASE_COLUMNS, BASE_ROWS)): void {
    this.#base = grid;
  }

  /** Forgets a released texture. */
  release(handle: number): void {
    this.#grids.delete(handle);
    this.#sources.delete(handle);
  }

  /**
   * Sets each later source's gain to the first source's mean over its own, and each source of a layer matched to the
   * imagery below to that imagery's colors over its own where both show, from this frame's draws. A tile is measured
   * the first time a matched layer draws it (`imageOf` gives its image): layers without matching measure nothing.
   */
  frame(draws: TileDrawList, imageOf?: (handle: number) => unknown): void {
    const sums = this.#sums;
    sums.fill(0);
    this.#below.fill(0);
    for (let i = 0; i < draws.count; i++) {
      const key = draws.toneSources[i] ?? -1;
      const handle = draws.textures[i] ?? -1;
      if (key >= TONE_BELOW) {
        this.track(handle, key, imageOf);
        const below = draws.below?.textures[i] ?? -1;
        if (below >= 0 && imageOf && !this.#grids.has(below)) this.measure(below, imageOf(below));
        this.compareWithBase(draws, i, key - TONE_BELOW, handle);
        continue;
      }
      if (key < 0 || key >= KEYS) continue;
      this.track(handle, key, imageOf);
      const grid = this.#grids.get(handle);
      if (!grid) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;
      for (let cell = 0; cell < CELLS * CELLS * 4; cell += 4) {
        const a = grid[cell + 3] ?? 0;
        r += a * (grid[cell] ?? 0);
        g += a * (grid[cell + 1] ?? 0);
        b += a * (grid[cell + 2] ?? 0);
        weight += a;
      }
      if (weight <= 0) continue;
      sums[key * 4] = (sums[key * 4] ?? 0) + r / weight;
      sums[key * 4 + 1] = (sums[key * 4 + 1] ?? 0) + g / weight;
      sums[key * 4 + 2] = (sums[key * 4 + 2] ?? 0) + b / weight;
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
    // The lowest layers' gains first: an overlay is compared with the layer below as that layer shows, its gain applied.
    this.belowGains();
    for (const overlay of draws.overlays)
      for (let i = 0; i < draws.count; i++) {
        const key = overlay.toneSources?.[i] ?? -1;
        if (key < TONE_BELOW || (overlay.opacities[i] ?? 0) <= 0) continue;
        const handle = overlay.textures[i] ?? -1;
        this.track(handle, key, imageOf);
        const below = draws.textures[i] ?? -1;
        if (below >= 0 && imageOf && !this.#grids.has(below)) this.measure(below, imageOf(below));
        this.compareWithBelow(draws, overlay, i, key - TONE_BELOW, handle);
      }
    this.belowGains();
  }

  /** Remembers the key a texture is drawn as and measures it on first use. */
  private track(handle: number, key: number, imageOf?: (handle: number) => unknown): void {
    if (handle < 0) return;
    if (this.#sources.get(handle) !== key) this.#sources.set(handle, key);
    if (imageOf && !this.#grids.has(handle)) this.measure(handle, imageOf(handle));
  }

  /**
   * Compares draw `i`'s imagery (an opaque layer matched to the imagery below) with what lies under it: the next layer
   * down's tile (with that tile's gain), or the base image.
   */
  private compareWithBase(draws: TileDrawList, i: number, key: number, handle: number): void {
    const own = this.#grids.get(handle);
    const below = draws.below?.textures[i] ?? -1;
    const belowUv = draws.below?.uvTransforms;
    if (!own || !belowUv || key >= BELOW_KEYS) return;
    if (below >= 0) {
      const grid = this.#grids.get(below);
      if (grid) {
        const gain = this.gainOf(draws.below?.toneSources[i] ?? -1);
        this.accumulate(key, own, draws.uvTransforms, i, grid, CELLS, CELLS, belowUv, i, gain);
      }
    } else if (below === BASE_TEXTURE_HANDLE && this.#base)
      this.accumulate(key, own, draws.uvTransforms, i, this.#base, BASE_COLUMNS, BASE_ROWS, belowUv, i);
  }

  /** Compares overlay `i` with the opaque imagery of its draw: a tile (with its gain) or the base image. */
  private compareWithBelow(
    draws: TileDrawList,
    overlay: TileDrawOverlay,
    i: number,
    key: number,
    handle: number,
  ): void {
    const own = this.#grids.get(handle);
    if (!own || key >= BELOW_KEYS) return;
    const below = draws.textures[i] ?? -1;
    if (below >= 0) {
      const grid = this.#grids.get(below);
      if (!grid) return;
      const belowKey = draws.toneSources[i] ?? -1;
      const gain = this.gainOf(belowKey);
      this.accumulate(key, own, overlay.uvTransforms, i, grid, CELLS, CELLS, draws.uvTransforms, i, gain);
    } else if (below === BASE_TEXTURE_HANDLE && this.#base) {
      // The world base image (the polar caps' fills, -2 and -3, are no reference).
      this.accumulate(key, own, overlay.uvTransforms, i, this.#base, BASE_COLUMNS, BASE_ROWS, draws.uvTransforms, i);
    }
  }

  /**
   * Adds, for every cell of a 4 × 4 grid over surface tile `i`, the own imagery's color and the reference's color
   * there, both weighted by the own imagery's coverage (its alpha), to key `key`'s sums.
   */
  private accumulate(
    key: number,
    own: Float32Array,
    ownUv: Float32Array,
    ownAt: number,
    reference: Float32Array,
    columns: number,
    rows: number,
    referenceUv: Float32Array,
    referenceAt: number,
    gain?: Float32Array,
  ): void {
    const sums = this.#below;
    const o = ownAt * 4;
    const r = referenceAt * 4;
    for (let y = 0; y < CELLS; y++)
      for (let x = 0; x < CELLS; x++) {
        const u = (x + 0.5) / CELLS;
        const v = (y + 0.5) / CELLS;
        const at = cellAt(
          u * (ownUv[o] ?? 1) + (ownUv[o + 2] ?? 0),
          v * (ownUv[o + 1] ?? 1) + (ownUv[o + 3] ?? 0),
          CELLS,
          CELLS,
        );
        const alpha = own[at + 3] ?? 0;
        if (alpha <= 0) continue;
        const ref = cellAt(
          u * (referenceUv[r] ?? 1) + (referenceUv[r + 2] ?? 0),
          v * (referenceUv[r + 1] ?? 1) + (referenceUv[r + 3] ?? 0),
          columns,
          rows,
        );
        for (let c = 0; c < 3; c++) {
          sums[key * 7 + c] = (sums[key * 7 + c] ?? 0) + alpha * (own[at + c] ?? 0);
          sums[key * 7 + 3 + c] = (sums[key * 7 + 3 + c] ?? 0) + alpha * (reference[ref + c] ?? 0) * (gain?.[c] ?? 1);
        }
        sums[key * 7 + 6] = (sums[key * 7 + 6] ?? 0) + alpha;
      }
  }

  /** Sets the gains of the keys matched to the imagery below from this frame's sums; others keep theirs. */
  private belowGains(): void {
    const sums = this.#below;
    for (let key = 0; key < BELOW_KEYS; key++) {
      if ((sums[key * 7 + 6] ?? 0) <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const own = sums[key * 7 + c] ?? 0;
        const wanted = sums[key * 7 + 3 + c] ?? 0;
        this.#belowGains[key * 3 + c] = own > 1e-3 ? Math.min(MAX_GAIN, Math.max(MIN_GAIN, wanted / own)) : 1;
      }
    }
  }

  /** The sRGB gains of a key, or undefined where none applies. */
  private gainOf(key: number): Float32Array | undefined {
    if (key >= TONE_BELOW && key - TONE_BELOW < BELOW_KEYS)
      return this.#belowGains.subarray((key - TONE_BELOW) * 3, (key - TONE_BELOW) * 3 + 3);
    if (key >= 0 && key < KEYS) return this.#gains.subarray(key * 3, key * 3 + 3);
    return undefined;
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

  /** Writes the gain of overlay `i`'s imagery (1 where none applies) into `out[at..at + 2]`, linear (F633). */
  applyOverlay(overlay: TileDrawOverlay, i: number, out: Float32Array | number[], at: number): void {
    this.gainInto(overlay.toneSources?.[i] ?? -1, out, at);
  }

  private gainInto(key: number, out: Float32Array | number[], at: number): void {
    const gain = this.gainOf(key);
    for (let c = 0; c < 3; c++) out[at + c] = gain ? (gain[c] ?? 1) ** SRGB_GAMMA : 1;
  }
}
