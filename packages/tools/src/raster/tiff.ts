/**
 * A built-in GeoTIFF reader for the default datasets (ADR 0023): classic TIFF, tiled or stripped, chunky samples,
 * no/LZW/DEFLATE compression, predictors 1–3, unsigned 8/16-bit, signed 16-bit and float32 samples, with the
 * georeferencing of an EPSG:4326 raster (pixel scale and tie point, pixel-is-area or pixel-is-point).
 */
import { inflateSync } from 'node:zlib';
import { decodeLzw } from './lzw.js';

/** A decoded raster: interleaved samples, georeferenced by the outer corner of its first pixel. */
export interface Raster {
  width: number;
  height: number;
  samplesPerPixel: number;
  data: Float32Array | Uint8Array | Uint16Array | Int16Array;
  /** Longitude of the west edge of column 0. */
  westDeg: number;
  /** Latitude of the north edge of row 0. */
  northDeg: number;
  /** Pixel size in degrees (positive). */
  pixelWidthDeg: number;
  pixelHeightDeg: number;
  /** The no-data value, when the file declares one. */
  noData?: number;
}

type Tags = Map<number, number[] | string>;

const TYPE_SIZES: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

function readValue(view: DataView, type: number, offset: number, little: boolean): number {
  switch (type) {
    case 3:
      return view.getUint16(offset, little);
    case 4:
      return view.getUint32(offset, little);
    case 8:
      return view.getInt16(offset, little);
    case 9:
      return view.getInt32(offset, little);
    case 11:
      return view.getFloat32(offset, little);
    case 12:
      return view.getFloat64(offset, little);
    case 5:
      return view.getUint32(offset, little) / view.getUint32(offset + 4, little);
    default:
      return view.getUint8(offset);
  }
}

function readTags(view: DataView, little: boolean): Tags {
  const first = view.getUint32(4, little);
  const count = view.getUint16(first, little);
  const tags: Tags = new Map();
  for (let i = 0; i < count; i++) {
    const entry = first + 2 + i * 12;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const n = view.getUint32(entry + 4, little);
    const size = (TYPE_SIZES[type] ?? 1) * n;
    const at = size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
    if (type === 2) {
      const bytes = new Uint8Array(view.buffer, view.byteOffset + at, n);
      tags.set(tag, new TextDecoder().decode(bytes).replace(/\0+$/, ''));
      continue;
    }
    const values: number[] = [];
    for (let k = 0; k < n; k++) values.push(readValue(view, type, at + k * (TYPE_SIZES[type] ?? 1), little));
    tags.set(tag, values);
  }
  return tags;
}

function numbers(tags: Tags, tag: number): number[] | undefined {
  const value = tags.get(tag);
  return Array.isArray(value) ? value : undefined;
}

function one(tags: Tags, tag: number, fallback?: number): number {
  const value = numbers(tags, tag)?.[0] ?? fallback;
  if (value === undefined) throw new Error(`TIFF: missing required tag ${tag}`);
  return value;
}

/** Undoes horizontal differencing (predictor 2) on integer samples, in place. */
function undoHorizontal(samples: Uint8Array | Uint16Array | Int16Array, width: number, spp: number): void {
  for (let row = 0; row < samples.length / (width * spp); row++) {
    const base = row * width * spp;
    for (let i = spp; i < width * spp; i++)
      samples[base + i] = (samples[base + i] ?? 0) + (samples[base + i - spp] ?? 0);
  }
}

/** Undoes the floating-point predictor (predictor 3): byte-wise differencing of byte-shuffled float32 rows. */
function undoFloatingPoint(bytes: Uint8Array, width: number, spp: number): Float32Array {
  const rowBytes = width * spp * 4;
  const rows = bytes.length / rowBytes;
  const out = new Float32Array(width * spp * rows);
  const view = new DataView(out.buffer);
  for (let row = 0; row < rows; row++) {
    const src = bytes.subarray(row * rowBytes, (row + 1) * rowBytes);
    for (let i = 1; i < rowBytes; i++) src[i] = ((src[i] ?? 0) + (src[i - 1] ?? 0)) & 0xff;
    const count = width * spp;
    for (let k = 0; k < count; k++) {
      // Bytes are stored most significant first across four planes of `count` bytes.
      const value = ((src[k] ?? 0) << 24) | ((src[count + k] ?? 0) << 16) | ((src[2 * count + k] ?? 0) << 8);
      view.setUint32((row * count + k) * 4, (value | (src[3 * count + k] ?? 0)) >>> 0, true);
    }
  }
  return out;
}

/** The georeferencing of a raster from its GeoTIFF tags. */
function georeference(tags: Tags): Pick<Raster, 'westDeg' | 'northDeg' | 'pixelWidthDeg' | 'pixelHeightDeg'> {
  const scale = numbers(tags, 33550);
  const tie = numbers(tags, 33922);
  if (!scale || !tie || tie.length < 6) throw new Error('GeoTIFF: missing ModelPixelScale or ModelTiepoint');
  const [sx = 0, sy = 0] = scale;
  const [i = 0, j = 0, , x = 0, y = 0] = tie;
  const keys = numbers(tags, 34735) ?? [];
  let pixelIsPoint = false;
  for (let k = 4; k + 3 < keys.length; k += 4) if (keys[k] === 1025 && keys[k + 3] === 2) pixelIsPoint = true;
  const shift = pixelIsPoint ? 0.5 : 0;
  return {
    westDeg: x - (i + shift) * sx,
    northDeg: y + (j + shift) * sy,
    pixelWidthDeg: sx,
    pixelHeightDeg: sy,
  };
}

function decompress(tags: Tags, chunk: Uint8Array, expectedBytes: number): Uint8Array {
  const compression = one(tags, 259, 1);
  if (compression === 1) return chunk;
  if (compression === 5) return decodeLzw(chunk, expectedBytes);
  if (compression === 8 || compression === 32946) return new Uint8Array(inflateSync(chunk));
  throw new Error(`TIFF: unsupported compression ${compression} (convert the source with GDAL in Docker)`);
}

/** Layout of the raster's chunks (tiles, or strips as full-width tiles). */
interface Layout {
  chunkWidth: number;
  chunkHeight: number;
  offsets: number[];
  counts: number[];
  across: number;
}

function layout(tags: Tags, width: number, height: number): Layout {
  const tileOffsets = numbers(tags, 324);
  if (tileOffsets) {
    const chunkWidth = one(tags, 322);
    return {
      chunkWidth,
      chunkHeight: one(tags, 323),
      offsets: tileOffsets,
      counts: numbers(tags, 325) ?? [],
      across: Math.ceil(width / chunkWidth),
    };
  }
  return {
    chunkWidth: width,
    chunkHeight: one(tags, 278, height),
    offsets: numbers(tags, 273) ?? [],
    counts: numbers(tags, 279) ?? [],
    across: 1,
  };
}

function allocate(format: number, bits: number, size: number): Raster['data'] {
  if (format === 3 && bits === 32) return new Float32Array(size);
  if (bits === 8 && format !== 2) return new Uint8Array(size);
  if (bits === 16) return format === 2 ? new Int16Array(size) : new Uint16Array(size);
  throw new Error(`TIFF: unsupported sample format ${format} with ${bits} bits`);
}

function chunkSamples(bytes: Uint8Array, target: Raster['data'], little: boolean): Raster['data'] {
  if (target instanceof Uint8Array) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = target.BYTES_PER_ELEMENT;
  const out = new (target.constructor as new (n: number) => Raster['data'])(Math.floor(bytes.length / size));
  for (let i = 0; i < out.length; i++) {
    if (target instanceof Float32Array) out[i] = view.getFloat32(i * 4, little);
    else if (target instanceof Int16Array) out[i] = view.getInt16(i * 2, little);
    else out[i] = view.getUint16(i * 2, little);
  }
  return out;
}

/** Decodes the first image of a GeoTIFF file. */
export function readGeoTiff(file: Uint8Array): Raster {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const little = view.getUint16(0, false) === 0x4949;
  if (view.getUint16(2, little) !== 42) throw new Error('TIFF: not a classic TIFF file (BigTIFF is not supported)');
  const tags = readTags(view, little);
  const width = one(tags, 256);
  const height = one(tags, 257);
  const spp = one(tags, 277, 1);
  const bits = one(tags, 258, 8);
  if (one(tags, 284, 1) !== 1) throw new Error('TIFF: only chunky (interleaved) samples are supported');
  const predictor = one(tags, 317, 1);
  const data = allocate(one(tags, 339, 1), bits, width * height * spp);
  const chunks = layout(tags, width, height);
  const bytesPerPixel = (spp * bits) / 8;
  for (let index = 0; index < chunks.offsets.length; index++) {
    const offset = chunks.offsets[index] ?? 0;
    const raw = file.subarray(offset, offset + (chunks.counts[index] ?? 0));
    const expected = chunks.chunkWidth * chunks.chunkHeight * bytesPerPixel;
    const bytes = decompress(tags, raw, expected);
    let samples: Raster['data'];
    if (predictor === 3) samples = undoFloatingPoint(new Uint8Array(bytes), chunks.chunkWidth, spp);
    else {
      samples = chunkSamples(bytes, data, little);
      if (predictor === 2 && !(samples instanceof Float32Array)) undoHorizontal(samples, chunks.chunkWidth, spp);
    }
    const x0 = (index % chunks.across) * chunks.chunkWidth;
    const y0 = Math.floor(index / chunks.across) * chunks.chunkHeight;
    const rows = Math.min(chunks.chunkHeight, height - y0);
    const cols = Math.min(chunks.chunkWidth, width - x0);
    for (let r = 0; r < rows; r++) {
      const from = r * chunks.chunkWidth * spp;
      data.set(samples.subarray(from, from + cols * spp), ((y0 + r) * width + x0) * spp);
    }
  }
  const noDataText = tags.get(42113);
  const noData = typeof noDataText === 'string' && noDataText.trim() !== '' ? Number(noDataText) : undefined;
  return {
    width,
    height,
    samplesPerPixel: spp,
    data,
    ...georeference(tags),
    ...(noData === undefined ? {} : { noData }),
  };
}
