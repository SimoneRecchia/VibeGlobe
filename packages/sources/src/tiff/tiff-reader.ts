// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * A GeoTIFF reader for single images (F234), from the data pipeline's reader (`@vibeglobe/tools`, ADR 0024) with
 * DEFLATE through `fflate` so it runs in browsers: classic TIFF, tiled or stripped, chunky samples, no/LZW/DEFLATE
 * compression, horizontal predictor, 8-bit samples; the georeference from ModelPixelScale, ModelTiepoint and the EPSG
 * code of the GeoKeys. Every byte is untrusted: sizes are bounded, and anything malformed throws an `Error`.
 */
import { unzlibSync } from 'fflate';
import { decodeLzw, readTiffValue, TIFF_TYPE_SIZES } from '@vibeglobe/core/decoders';

/** A decoded 8-bit raster with its georeference: box in the units of its system, west, south, east, north. */
export interface TiffRaster {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly samplesPerPixel: number;
  readonly data: Uint8Array;
  readonly crs: string;
  readonly bounds: [number, number, number, number];
}

type Tags = Map<number, number[]>;

/** The largest side accepted, pixels, and the largest raster, bytes. */
const MAX_SIDE_PX = 32_768;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_TAGS = 4096;
const MAX_VALUES = 1 << 20;

function readTags(view: DataView, little: boolean): Tags {
  const first = view.getUint32(4, little);
  const count = view.getUint16(first, little);
  if (count > MAX_TAGS) throw new Error('too many tags');
  const tags: Tags = new Map();
  // All tags together: they may all point at the same bytes, so a small file could claim billions of values.
  let values = 0;
  for (let i = 0; i < count; i++) {
    const entry = first + 2 + i * 12;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const n = view.getUint32(entry + 4, little);
    if (type === 2) continue;
    values += n;
    if (values > MAX_VALUES) throw new Error(`tag ${String(tag)} brings the tags to too many values`);
    const size = (TIFF_TYPE_SIZES[type] ?? 1) * n;
    const at = size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
    const read: number[] = [];
    for (let k = 0; k < n; k++) read.push(readTiffValue(view, type, at + k * (TIFF_TYPE_SIZES[type] ?? 1), little));
    tags.set(tag, read);
  }
  return tags;
}

function one(tags: Tags, tag: number, fallback?: number): number {
  const value = tags.get(tag)?.[0] ?? fallback;
  if (value === undefined) throw new Error(`missing required tag ${String(tag)}`);
  return value;
}

/** Undoes horizontal differencing (predictor 2), in place. */
function undoHorizontal(samples: Uint8Array, width: number, spp: number): void {
  for (let row = 0; row < samples.length / (width * spp); row++) {
    const base = row * width * spp;
    for (let i = spp; i < width * spp; i++)
      samples[base + i] = ((samples[base + i] ?? 0) + (samples[base + i - spp] ?? 0)) & 0xff;
  }
}

function decompress(tags: Tags, chunk: Uint8Array, expectedBytes: number): Uint8Array {
  const compression = one(tags, 259, 1);
  if (compression === 1) return chunk;
  if (compression === 5) return decodeLzw(chunk, expectedBytes);
  // Into a buffer of the chunk's size: a small DEFLATE stream that inflates to gigabytes stops there.
  if (compression === 8 || compression === 32946) return unzlibSync(chunk, { out: new Uint8Array(expectedBytes) });
  throw new Error(`unsupported compression ${String(compression)}`);
}

/** The reference system and box from the GeoTIFF tags. */
function georeference(tags: Tags, width: number, height: number): Pick<TiffRaster, 'crs' | 'bounds'> {
  const scale = tags.get(33550);
  const tie = tags.get(33922);
  if (!scale || !tie || tie.length < 6) throw new Error('missing ModelPixelScale or ModelTiepoint');
  const [sx = NaN, sy = NaN] = scale;
  const [i = 0, j = 0, , x = NaN, y = NaN] = tie;
  const keys = tags.get(34735) ?? [];
  let pixelIsPoint = false;
  let code: number | undefined;
  for (let k = 4; k + 3 < keys.length; k += 4) {
    const key = keys[k];
    const value = keys[k + 3];
    if (key === 1025 && value === 2) pixelIsPoint = true;
    // ProjectedCSTypeGeoKey wins over GeographicTypeGeoKey.
    if (key === 3072 || (key === 2048 && code === undefined)) code = value;
  }
  if (code === undefined || !Number.isInteger(code) || code <= 0 || code === 32767)
    throw new Error('no EPSG code in its GeoKeys');
  const shift = pixelIsPoint ? 0.5 : 0;
  const west = x - (i + shift) * sx;
  const north = y + (j + shift) * sy;
  const bounds: [number, number, number, number] = [west, north - height * sy, west + width * sx, north];
  if (!bounds.every(Number.isFinite) || !(sx > 0 && sy > 0)) throw new Error('no usable tie point and pixel scale');
  return { crs: `EPSG:${String(code)}`, bounds };
}

/** Decodes the first image of a GeoTIFF; throws an `Error` naming the problem for anything it cannot read. */
export function readTiff(file: Uint8Array): TiffRaster {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const order = view.getUint16(0, false);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('not a TIFF file');
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 42) throw new Error('not a classic TIFF file (BigTIFF is not supported)');
  const tags = readTags(view, little);
  const width = one(tags, 256);
  const height = one(tags, 257);
  const spp = one(tags, 277, 1);
  if (!(width > 0 && height > 0 && width <= MAX_SIDE_PX && height <= MAX_SIDE_PX) || width * height * spp > MAX_BYTES)
    throw new Error(`unsupported size ${String(width)} × ${String(height)}`);
  if (spp !== 3 && spp !== 4) throw new Error(`unsupported ${String(spp)}-sample pixels (RGB or RGBA)`);
  if (one(tags, 258, 8) !== 8 || one(tags, 339, 1) !== 1) throw new Error('only 8-bit unsigned samples are supported');
  if (one(tags, 284, 1) !== 1) throw new Error('only chunky (interleaved) samples are supported');
  const predictor = one(tags, 317, 1);
  const data = new Uint8Array(width * height * spp);
  const tiled = tags.get(324);
  const chunkWidth = tiled ? one(tags, 322) : width;
  const chunkHeight = tiled ? one(tags, 323) : Math.min(height, one(tags, 278, height));
  if (!(chunkWidth > 0 && chunkHeight > 0 && chunkWidth <= MAX_SIDE_PX && chunkHeight <= MAX_SIDE_PX))
    throw new Error('invalid chunk size');
  const offsets = tiled ?? tags.get(273) ?? [];
  const counts = tags.get(tiled ? 325 : 279) ?? [];
  const across = Math.ceil(width / chunkWidth);
  for (let index = 0; index < offsets.length; index++) {
    const count = counts[index] ?? 0;
    if (count === 0) continue;
    const offset = offsets[index] ?? 0;
    if (offset + count > file.length) throw new Error(`chunk ${String(index)} lies outside the file`);
    const expected = chunkWidth * chunkHeight * spp;
    const samples = decompress(tags, file.subarray(offset, offset + count), expected);
    if (predictor === 2) undoHorizontal(samples, chunkWidth, spp);
    const x0 = (index % across) * chunkWidth;
    const y0 = Math.floor(index / across) * chunkHeight;
    const rows = Math.min(chunkHeight, height - y0);
    const cols = Math.min(chunkWidth, width - x0);
    for (let r = 0; r < rows && x0 < width; r++) {
      const from = r * chunkWidth * spp;
      data.set(samples.subarray(from, from + cols * spp), ((y0 + r) * width + x0) * spp);
    }
  }
  return { widthPx: width, heightPx: height, samplesPerPixel: spp, data, ...georeference(tags, width, height) };
}
