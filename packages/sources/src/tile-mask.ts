// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `@vibeglobe/sources/tile-mask`: the per-pixel side of a source's area (F618), for the worker's image decoder. A tile
 * across the area's border keeps only the pixels inside it, and a tile of the source's blank color is no data.
 *
 * @packageDocumentation
 */
import type { TileMask } from '@vibeglobe/core';
import { bleedTransparentEdges } from './reproject/edge-bleed.js';

/** A color that, filling a whole tile, means no data: sRGB channels and the tolerance per channel. */
export interface BlankColor {
  readonly rgb: readonly number[];
  readonly tolerance: number;
}

/** True when every pixel is within `tolerance` of the opaque color in each channel. */
export function isBlank(rgba: Uint8ClampedArray, { rgb, tolerance }: BlankColor): boolean {
  for (let i = 0; i < rgba.length; i++)
    if (Math.abs((rgba[i] ?? 0) - (i % 4 === 3 ? 255 : (rgb[i % 4] ?? 0))) > tolerance) return false;
  return true;
}

/**
 * The decoded tile masked to the area's outline (even-odd: holes and several polygons) on an `OffscreenCanvas`, the
 * input closed; null for a tile of the blank color (also closed); the tile itself where no canvas is available. A
 * feathered mask fades from transparent at the border to opaque `featherPx` inside it; a keyed mask applies only to
 * pixels of its color (KB-231); the sea's key, to water's colors outside the land (KB-303).
 */
export function maskTile(image: ImageBitmap, blank?: BlankColor, mask?: TileMask): ImageBitmap | RgbaTile | null {
  if (typeof OffscreenCanvas !== 'function') return image;
  const { width, height } = image;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', {
    willReadFrequently: blank !== undefined || mask?.key !== undefined || mask?.sea !== undefined,
  });
  if (!context) return image;
  context.drawImage(image, 0, 0);
  if (blank && isBlank(context.getImageData(0, 0, width, height).data, blank)) {
    image.close();
    return null;
  }
  if (!mask) return image;
  if ((mask.featherPx ?? 0) <= 0 && !mask.key && !mask.sea) {
    context.globalCompositeOperation = 'destination-in';
    tracePath(context, mask, width, height, 0);
    context.fill('evenodd');
  } else {
    const inside = insideAlpha(mask, width, height, (mask.featherPx ?? 0) / 2, 2);
    const land =
      mask.sea &&
      (mask.sea.ringEnds.length > 0
        ? insideAlpha(mask.sea, width, height, mask.sea.featherPx * SEA_BLUR, SEA_GAIN)
        : NO_LAND);
    if (!inside || (mask.sea && !land)) return image;
    const data = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
    applyAlpha(data, inside, mask.key, land);
    // The pixels made transparent take their visible neighbors' color, so filtering shows no dark fringe along the
    // border; a canvas would drop the color of transparent pixels, so the pixels themselves are the tile (F636). The
    // pixels still visible keep their own color: here it is exact.
    bleedTransparentEdges(data, width, height, 4, 1);
    image.close();
    return { data, width, height };
  }
  image.close();
  return canvas.transferToImageBitmap();
}

/** A masked tile's pixels, RGBA8 with straight alpha, rows from the north (the renderer's RGBA image). */
export interface RgbaTile {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** An outline over a tile: rings in tile units ({@link TileMask}). */
type Outline = Pick<TileMask, 'points' | 'ringEnds'>;

/**
 * The sea's fade (KB-303): the land blurred by 1.5 feathers and stretched fourfold about its outline, so its share of a
 * pixel rises from none at the outline to all a feather inside, and gaps narrower than a feather between its polygons
 * stay land.
 */
const SEA_BLUR = 1.5;
const SEA_GAIN = 4;
/** The land's share of a tile wholly at sea: none, for every pixel. */
const NO_LAND = new Uint8ClampedArray(0);

/** Adds the outline's rings to the context's path, in pixels, shifted by `offsetPx` on both axes. */
function tracePath(
  context: OffscreenCanvasRenderingContext2D,
  mask: Outline,
  width: number,
  height: number,
  offsetPx: number,
): void {
  context.beginPath();
  let start = 0;
  for (const end of mask.ringEnds) {
    for (let i = start; i < end; i++) {
      const x = (mask.points[i * 2] ?? 0) * width + offsetPx;
      const y = (mask.points[i * 2 + 1] ?? 0) * height + offsetPx;
      if (i === start) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    start = end;
  }
}

/**
 * How much of each pixel lies inside the outline, 0–255: the outline filled on a canvas larger than the tile by the
 * blur's reach (so the fade does not stop at the tile's edges), blurred by `blurPx` (σ) and stretched by `gain` about
 * the outline, where the blurred alpha is a half. A wide blur is drawn smaller and stretched back to the tile: it
 * varies slowly, and a blur costs as many pixels as its canvas. Undefined where no canvas context is available.
 */
function insideAlpha(
  outline: Outline,
  width: number,
  height: number,
  blurPx: number,
  gain: number,
): Uint8ClampedArray | undefined {
  const pad = Math.ceil(blurPx * 4) + 1;
  const scale = Math.max(1, Math.floor(blurPx / 8));
  const filled = new OffscreenCanvas(Math.ceil((width + 2 * pad) / scale), Math.ceil((height + 2 * pad) / scale));
  const fill = filled.getContext('2d');
  if (!fill) return undefined;
  fill.scale(1 / scale, 1 / scale);
  tracePath(fill, outline, width, height, pad);
  fill.fill('evenodd');
  let source: OffscreenCanvas = filled;
  if (blurPx > 0) {
    const blurred = new OffscreenCanvas(filled.width, filled.height);
    const blur = blurred.getContext('2d');
    if (!blur) return undefined;
    blur.filter = `blur(${String(blurPx / scale)}px)`;
    blur.drawImage(filled, 0, 0);
    source = blurred;
  }
  let read = source.getContext('2d') as OffscreenCanvasRenderingContext2D;
  if (scale > 1) {
    const stretched = new OffscreenCanvas(width, height);
    read = stretched.getContext('2d') as OffscreenCanvasRenderingContext2D;
    read.drawImage(source, pad / scale, pad / scale, width / scale, height / scale, 0, 0, width, height);
  }
  const at = scale > 1 ? 0 : pad;
  const rgba = read.getImageData(at, at, width, height).data;
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < alpha.length; i++) {
    const a = rgba[i * 4 + 3] ?? 0;
    alpha[i] = blurPx > 0 ? gain * (a - 127.5) : a;
  }
  return alpha;
}

/**
 * How much a color is water, 0–1: blue and green above red by 6 to 14 levels (sea, lakes, a package's no-data water;
 * not vegetation, soil, grey, or the land's neutral shadows) and red below 160 to 200 (not snow, ice or cloud).
 */
export function waterShare(r: number, g: number, b: number): number {
  return Math.max(0, Math.min(1, (Math.min(g - r, b - r) - 6) / 8, (200 - r) / 40));
}

/**
 * Scales each pixel's alpha by its inside value (0–255); with a key, only the pixels of the key's color; with a key
 * everywhere, every pixel, those of the key's color made transparent, fading back in up to twice its tolerance (F636);
 * with the land's share of each pixel (0–255, none past its end), water's colors by how much of the pixel is sea
 * (KB-303).
 */
export function applyAlpha(
  rgba: Uint8Array,
  inside: Uint8ClampedArray,
  key: TileMask['key'],
  land?: Uint8ClampedArray,
): void {
  for (let i = 0; i < inside.length; i++) {
    const at = i * 4;
    const r = rgba[at] ?? 0;
    const g = rgba[at + 1] ?? 0;
    const b = rgba[at + 2] ?? 0;
    let kept = (inside[i] ?? 0) / 255;
    if (key) {
      const distance = Math.max(Math.abs(r - key.rgb[0]), Math.abs(g - key.rgb[1]), Math.abs(b - key.rgb[2]));
      if (key.everywhere) kept *= Math.min(1, Math.max(0, (distance - key.tolerance) / Math.max(1, key.tolerance)));
      else if (distance > key.tolerance) kept = 1;
    }
    if (land) kept *= 1 - waterShare(r, g, b) * (1 - (land[i] ?? 0) / 255);
    rgba[at + 3] = Math.round((rgba[at + 3] ?? 0) * kept);
  }
}
