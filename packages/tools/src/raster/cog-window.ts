// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Windowed reading of cloud-optimized GeoTIFFs over HTTP (ADR 0026): the header is read with one range request, then
 * only the internal tiles of one overview level that intersect a bounding box. They are kept compressed, as they
 * are, in a small local GeoTIFF that the built-in reader opens like any other file; tiles outside the window are
 * absent (no data).
 */
import type { BBoxDeg } from '../tiles/mercator.js';
import { TIFF_TYPE_SIZES } from '@vibeglobe/core/decoders';

/** Bytes read with the first request; COG headers (every IFD, before the image data) fit in it. */
const HEADER_BYTES = 1 << 20;

type Fetch = typeof fetch;

/** One parsed IFD entry: type, count and the raw 4-byte value field. */
interface Entry {
  type: number;
  count: number;
  value: Uint8Array;
}

async function range(fetchImpl: Fetch, url: string, start: number, length: number): Promise<Uint8Array> {
  const response = await fetchImpl(url, { headers: { range: `bytes=${start}-${start + length - 1}` } });
  if (response.status === 404) throw Object.assign(new Error(`${url}: HTTP 404`), { status: 404 });
  if (response.status !== 206 && response.status !== 200) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A server that ignores ranges sends the whole file.
  return response.status === 200 ? bytes.subarray(start, start + length) : bytes;
}

/** The IFDs of a little-endian classic TIFF header, with their entries. */
function parseIfds(header: Uint8Array): Map<number, Entry>[] {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint16(0, false) !== 0x4949 || view.getUint16(2, true) !== 42)
    throw new Error('COG: only little-endian classic TIFF is supported');
  const ifds: Map<number, Entry>[] = [];
  for (let at = view.getUint32(4, true); at !== 0 && at + 2 <= header.length;) {
    const count = view.getUint16(at, true);
    const entries = new Map<number, Entry>();
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      entries.set(view.getUint16(e, true), {
        type: view.getUint16(e + 2, true),
        count: view.getUint32(e + 4, true),
        value: header.subarray(e + 8, e + 12),
      });
    }
    ifds.push(entries);
    at = view.getUint32(at + 2 + count * 12, true);
  }
  return ifds;
}

/** The values of an entry (numbers), read from the header or with one more range request. */
async function values(entry: Entry, header: Uint8Array, fetchImpl: Fetch, url: string): Promise<number[]> {
  const size = TIFF_TYPE_SIZES[entry.type] ?? 1;
  const bytes = entry.count * size;
  const offset = new DataView(entry.value.buffer, entry.value.byteOffset, 4).getUint32(0, true);
  const data =
    bytes <= 4
      ? entry.value
      : offset + bytes <= header.length
        ? header.subarray(offset, offset + bytes)
        : await range(fetchImpl, url, offset, bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: number[] = [];
  for (let i = 0; i < entry.count; i++) {
    const at = i * size;
    if (entry.type === 3) out.push(view.getUint16(at, true));
    else if (entry.type === 4) out.push(view.getUint32(at, true));
    else if (entry.type === 12) out.push(view.getFloat64(at, true));
    else out.push(view.getUint8(at));
  }
  return out;
}

/** A tag to write: tag number, TIFF type and values. */
type Tag = [number, number, number[]];

/** Writes a little-endian classic TIFF with one tiled image whose tiles are given already compressed. */
export function writeTiledTiff(tags: Tag[], tiles: (Uint8Array | undefined)[]): Uint8Array {
  const offsetsTag: Tag = [324, 4, tiles.map(() => 0)];
  const countsTag: Tag = [325, 4, tiles.map((t) => t?.length ?? 0)];
  const all: Tag[] = [...tags.filter(([tag]) => tag !== 324 && tag !== 325), offsetsTag, countsTag].sort(
    (a, b) => a[0] - b[0],
  );
  const ifdBytes = 2 + all.length * 12 + 4;
  const extraBytes = all.reduce((n, [, type, vals]) => {
    const size = vals.length * (TIFF_TYPE_SIZES[type] ?? 1);
    return n + (size > 4 ? size + (size % 2) : 0);
  }, 0);
  let dataAt = 8 + ifdBytes + extraBytes;
  const offsets = tiles.map((tile) => {
    if (!tile || tile.length === 0) return 0;
    const at = dataAt;
    dataAt += tile.length;
    return at;
  });
  const out = new Uint8Array(dataAt);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x4949, false);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, all.length, true);
  let extraAt = 8 + ifdBytes;
  all.forEach(([tag, type, vals], i) => {
    const written = tag === 324 ? offsets : vals;
    const e = 10 + i * 12;
    const size = TIFF_TYPE_SIZES[type] ?? 1;
    view.setUint16(e, tag, true);
    view.setUint16(e + 2, type, true);
    view.setUint32(e + 4, written.length, true);
    let at = e + 8;
    if (written.length * size > 4) {
      view.setUint32(e + 8, extraAt, true);
      at = extraAt;
      extraAt += written.length * size + ((written.length * size) % 2);
    }
    written.forEach((v, k) => {
      if (type === 3) view.setUint16(at + k * 2, v, true);
      else if (type === 4) view.setUint32(at + k * 4, v, true);
      else if (type === 12) view.setFloat64(at + k * 8, v, true);
      else view.setUint8(at + k, v);
    });
  });
  tiles.forEach((tile, i) => {
    if (tile && tile.length > 0) out.set(tile, offsets[i] ?? 0);
  });
  return out;
}

/** Tags copied from the full-resolution image (georeferencing, no data) when reading an overview. */
const GEO_TAGS = [33922, 34735, 34736, 34737];
/** Tags copied from the chosen level. */
const IMAGE_TAGS = [256, 257, 258, 259, 262, 277, 284, 317, 322, 323, 338, 339, 42113];

/** Result of a window read. */
export interface CogWindow {
  /** A standalone GeoTIFF holding the window's tiles of the chosen level. */
  file: Uint8Array;
  /** Bytes transferred. */
  transferred: number;
  /** Internal tiles read. */
  tiles: number;
}

/**
 * Reads the tiles of overview `level` (0 = full resolution) of the COG at `url` that intersect `bbox`. A missing file
 * rejects with an error whose `status` is 404.
 */
export async function readCogWindow(fetchImpl: Fetch, url: string, bbox: BBoxDeg, level: number): Promise<CogWindow> {
  const header = await range(fetchImpl, url, 0, HEADER_BYTES);
  let transferred = header.length;
  const ifds = parseIfds(header);
  const full = ifds[0];
  const image = ifds[level];
  if (!full || !image) throw new Error(`${url}: no overview level ${level}`);
  const read = async (entries: Map<number, Entry>, tag: number): Promise<number[]> => {
    const entry = entries.get(tag);
    return entry ? values(entry, header, fetchImpl, url) : [];
  };
  const [width0 = 1] = await read(full, 256);
  const [width = 1] = await read(image, 256);
  const [height = 1] = await read(image, 257);
  const [tileWidth = 256] = await read(image, 322);
  const [tileHeight = 256] = await read(image, 323);
  const [sx = 0, sy = 0] = await read(full, 33550);
  const [, , , west = 0, north = 0] = await read(full, 33922);
  const factor = width0 / width;
  const across = Math.ceil(width / tileWidth);
  const down = Math.ceil(height / tileHeight);
  const col = (lon: number): number => Math.floor((lon - west) / (sx * factor) / tileWidth);
  const row = (lat: number): number => Math.floor((north - lat) / (sy * factor) / tileHeight);
  const offsets = await read(image, 324);
  const counts = await read(image, 325);
  const tiles: (Uint8Array | undefined)[] = new Array<Uint8Array | undefined>(across * down).fill(undefined);
  let fetched = 0;
  for (let r = Math.max(0, row(bbox.north)); r <= Math.min(down - 1, row(bbox.south)); r++) {
    for (let c = Math.max(0, col(bbox.west)); c <= Math.min(across - 1, col(bbox.east)); c++) {
      const i = r * across + c;
      if (!counts[i]) continue;
      tiles[i] = await range(fetchImpl, url, offsets[i] ?? 0, counts[i] ?? 0);
      transferred += counts[i] ?? 0;
      fetched++;
    }
  }
  const tags: Tag[] = [];
  for (const tag of IMAGE_TAGS) {
    const entry = image.get(tag) ?? (tag === 42113 ? full.get(tag) : undefined);
    if (entry) tags.push([tag, entry.type, await values(entry, header, fetchImpl, url)]);
  }
  tags.push([33550, 12, [sx * factor, sy * factor, 0]]);
  for (const tag of GEO_TAGS) {
    const entry = full.get(tag);
    if (entry && entry.type !== 2) tags.push([tag, entry.type, await values(entry, header, fetchImpl, url)]);
  }
  return { file: writeTiledTiff(tags, tiles), transferred, tiles: fetched };
}
