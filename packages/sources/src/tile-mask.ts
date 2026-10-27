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
 * input closed; null for a tile of the blank color (also closed); the tile itself where no canvas is available.
 */
export function maskTile(image: ImageBitmap, blank?: BlankColor, mask?: TileMask): ImageBitmap | null {
  if (typeof OffscreenCanvas !== 'function') return image;
  const { width, height } = image;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: blank !== undefined });
  if (!context) return image;
  context.drawImage(image, 0, 0);
  if (blank && isBlank(context.getImageData(0, 0, width, height).data, blank)) {
    image.close();
    return null;
  }
  if (!mask) return image;
  context.globalCompositeOperation = 'destination-in';
  let start = 0;
  for (const end of mask.ringEnds) {
    for (let i = start; i < end; i++) {
      const x = (mask.points[i * 2] ?? 0) * width;
      const y = (mask.points[i * 2 + 1] ?? 0) * height;
      if (i === start) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    start = end;
  }
  context.fill('evenodd');
  image.close();
  return canvas.transferToImageBitmap();
}
