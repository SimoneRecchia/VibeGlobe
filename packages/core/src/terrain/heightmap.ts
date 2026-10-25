// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Heightmap terrain encodings (F129, F130) and the height grid every terrain source is decoded to (ADR 0006 §5). Pure
 * functions over RGBA bytes: the worker decodes the PNG, these turn its pixels into heights, in Node for the tests.
 */

/** A heightmap encoding: how a pixel's red, green and blue bytes give a height in meters. */
export type HeightmapEncoding = 'terrarium' | 'terrain-rgb';

/** A terrain data tile decoded to heights on a regular grid of (cells + 1)² vertices, row by row from the north. */
export interface HeightGrid {
  /** Cells per side; vertices per side are one more. */
  readonly cells: number;
  /** Heights in meters above the source's vertical datum, (cells + 1)² of them, north row first, west to east. */
  readonly heightsMeters: Float32Array;
  readonly minMeters: number;
  readonly maxMeters: number;
  /** The largest vertical distance measured between the grid's surface and the source's own heights, meters. */
  readonly errorMeters?: number;
}

/** Terrarium: height = (R × 256 + G + B / 256) − 32768 meters. */
function terrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Mapbox Terrain-RGB: height = −10000 + (R × 65536 + G × 256 + B) × 0.1 meters. */
function terrainRgb(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

/**
 * Decodes a square heightmap tile of `sizePx`² RGBA pixels to one height per pixel, in meters. Throws when the byte
 * count does not match the size, so a truncated image never yields a partial tile.
 */
export function decodeHeightmap(rgba: Uint8Array, sizePx: number, encoding: HeightmapEncoding): Float32Array {
  if (!Number.isInteger(sizePx) || sizePx < 2 || rgba.length !== sizePx * sizePx * 4)
    throw new RangeError(`a ${sizePx}-pixel heightmap needs ${sizePx * sizePx * 4} bytes, got ${rgba.length}`);
  const height = encoding === 'terrarium' ? terrarium : terrainRgb;
  const out = new Float32Array(sizePx * sizePx);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = height(rgba[p] ?? 0, rgba[p + 1] ?? 0, rgba[p + 2] ?? 0);
  return out;
}

/**
 * The border of a heightmap tile `sizePx` pixels wide: 1 for a power of two of 16 or more plus 2 (a tile carrying a ring of
 * its neighbors' pixels, as the dataset pipeline writes terrain, KB-178), else 0.
 */
export function heightmapBorderPx(sizePx: number): number {
  const inner = sizePx - 2;
  return inner >= 16 && (inner & (inner - 1)) === 0 ? 1 : 0;
}

/**
 * Resamples per-pixel heights to a grid of `cells`² cells whose vertices span the tile from edge to edge. Pixel
 * values sit at pixel centers; a vertex between centers is interpolated bilinearly. A tile with a border
 * ({@link heightmapBorderPx}) interpolates its edges between its own and its neighbors' pixels, so two neighbors give
 * their shared edge the same heights; without one, a vertex in the half pixel outside the outermost centers is
 * extrapolated from the two nearest, so a tile needs no neighbor data (ADR 0006 §5) and a plane stays exact up to the
 * edges.
 */
export function heightGrid(pixelHeights: Float32Array, sizePx: number, cells: number): HeightGrid {
  const border = heightmapBorderPx(sizePx);
  const inner = sizePx - 2 * border;
  const side = cells + 1;
  const heights = new Float32Array(side * side);
  let min = Infinity;
  let max = -Infinity;
  for (let row = 0; row < side; row++) {
    const y = (row / cells) * inner - 0.5 + border;
    const y0 = clamp(Math.floor(y), sizePx - 2);
    const y1 = y0 + 1;
    const fy = y - y0;
    for (let col = 0; col < side; col++) {
      const x = (col / cells) * inner - 0.5 + border;
      const x0 = clamp(Math.floor(x), sizePx - 2);
      const x1 = x0 + 1;
      const fx = x - x0;
      const at = (px: number, py: number): number => pixelHeights[py * sizePx + px] ?? 0;
      const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
      const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
      const h = top + (bottom - top) * fy;
      heights[row * side + col] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { cells, heightsMeters: heights, minMeters: min, maxMeters: max };
}

function clamp(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value;
}
