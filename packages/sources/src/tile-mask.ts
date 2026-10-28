// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `@vibeglobe/sources/tile-mask`: the per-pixel side of a source's area (F618), for the worker's image decoder. A tile
 * across the area's border keeps only the pixels inside it, and a tile of the source's blank color is no data.
 *
 * @packageDocumentation
 */
import type { TileMask } from '@vibeglobe/core';

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
 * pixels of its color (KB-231).
 */
export function maskTile(image: ImageBitmap, blank?: BlankColor, mask?: TileMask): ImageBitmap | null {
  if (typeof OffscreenCanvas !== 'function') return image;
  const { width, height } = image;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: blank !== undefined || mask?.key !== undefined });
  if (!context) return image;
  context.drawImage(image, 0, 0);
  if (blank && isBlank(context.getImageData(0, 0, width, height).data, blank)) {
    image.close();
    return null;
  }
  if (!mask) return image;
  if ((mask.featherPx ?? 0) <= 0 && !mask.key) {
    context.globalCompositeOperation = 'destination-in';
    tracePath(context, mask, width, height, 0);
    context.fill('evenodd');
  } else {
    const inside = insideAlpha(mask, width, height);
    if (!inside) return image;
    const pixels = context.getImageData(0, 0, width, height);
    applyAlpha(pixels.data, inside, mask.key);
    context.putImageData(pixels, 0, 0);
  }
  image.close();
  return canvas.transferToImageBitmap();
}

/** Adds the mask's rings to the context's path, in pixels, shifted by `offsetPx` on both axes. */
function tracePath(
  context: OffscreenCanvasRenderingContext2D,
  mask: TileMask,
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
 * How much of each pixel lies inside the area, 0–255: the area filled on a canvas larger than the tile by the
 * feather's reach (so the fade does not stop at the tile's edges), blurred, and stretched so that the border is 0 and
 * `featherPx` inside it 255. Undefined where no canvas context is available.
 */
function insideAlpha(mask: TileMask, width: number, height: number): Uint8ClampedArray | undefined {
  const feather = mask.featherPx ?? 0;
  const pad = Math.ceil(feather * 2) + 1;
  const filled = new OffscreenCanvas(width + 2 * pad, height + 2 * pad);
  const fill = filled.getContext('2d');
  if (!fill) return undefined;
  tracePath(fill, mask, width, height, pad);
  fill.fill('evenodd');
  let source: OffscreenCanvas = filled;
  if (feather > 0) {
    const blurred = new OffscreenCanvas(filled.width, filled.height);
    const blur = blurred.getContext('2d');
    if (!blur) return undefined;
    // A Gaussian of σ = feather / 2: the filled area's alpha is 0.5 at the border and nearly 1 a feather inside.
    blur.filter = `blur(${String(feather / 2)}px)`;
    blur.drawImage(filled, 0, 0);
    source = blurred;
  }
  const read = source.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const rgba = read.getImageData(pad, pad, width, height).data;
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < alpha.length; i++) {
    const a = rgba[i * 4 + 3] ?? 0;
    alpha[i] = feather > 0 ? 2 * a - 255 : a;
  }
  return alpha;
}

/** Scales each pixel's alpha by its inside value; with a key, only the pixels of the key's color. */
function applyAlpha(rgba: Uint8ClampedArray, inside: Uint8ClampedArray, key: TileMask['key']): void {
  for (let i = 0; i < inside.length; i++) {
    const at = i * 4;
    if (key) {
      const { rgb, tolerance } = key;
      if (
        Math.abs((rgba[at] ?? 0) - rgb[0]) > tolerance ||
        Math.abs((rgba[at + 1] ?? 0) - rgb[1]) > tolerance ||
        Math.abs((rgba[at + 2] ?? 0) - rgb[2]) > tolerance
      )
        continue;
    }
    rgba[at + 3] = Math.round(((rgba[at + 3] ?? 0) * (inside[i] ?? 0)) / 255);
  }
}
