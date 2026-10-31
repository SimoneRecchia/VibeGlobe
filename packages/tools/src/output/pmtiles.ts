// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * PMTiles v3 writing and reading (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md), written from the
 * specification: tiles in Hilbert order, deduplicated by SHA-256, runs of identical tiles merged, gzip-compressed
 * directories with leaf directories when the root would not fit in the first 16 KiB.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { findTile, readVarint, zxyToTileId } from 'pmtiles';
import { gunzip, gzip } from './gzip.js';

/** PMTiles tile types. */
export const TILE_TYPES = { unknown: 0, mvt: 1, png: 2, jpeg: 3, webp: 4, avif: 5 } as const;
/** PMTiles compression codes. */
export const COMPRESSION = { unknown: 0, none: 1, gzip: 2 } as const;

/** Header fields a writer chooses. */
export interface PmtilesInfo {
  tileType: number;
  tileCompression: number;
  minZoom: number;
  maxZoom: number;
  bounds: { west: number; south: number; east: number; north: number };
  center: { lon: number; lat: number; zoom: number };
}

/** A directory entry. */
export interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

/** Hilbert tile id of z/x/y. */
export { zxyToTileId as tileId };

function pushVarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

/** Serializes and compresses a directory. */
export function encodeDirectory(entries: Entry[]): Uint8Array {
  const out: number[] = [];
  pushVarint(out, entries.length);
  let last = 0;
  for (const e of entries) {
    pushVarint(out, e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) pushVarint(out, e.runLength);
  for (const e of entries) pushVarint(out, e.length);
  entries.forEach((e, i) => {
    const previous = entries[i - 1];
    pushVarint(out, i > 0 && previous && e.offset === previous.offset + previous.length ? 0 : e.offset + 1);
  });
  return gzip(Uint8Array.from(out));
}

/** Decompresses and parses a directory. */
export function decodeDirectory(compressed: Uint8Array): Entry[] {
  const at = { buf: gunzip(compressed), pos: 0 };
  const count = readVarint(at);
  const entries: Entry[] = [];
  let last = 0;
  for (let i = 0; i < count; i++) {
    last += readVarint(at);
    entries.push({ tileId: last, offset: 0, length: 0, runLength: 0 });
  }
  for (const e of entries) e.runLength = readVarint(at);
  for (const e of entries) e.length = readVarint(at);
  entries.forEach((e, i) => {
    const value = readVarint(at);
    const previous = entries[i - 1];
    e.offset = value === 0 && previous ? previous.offset + previous.length : value - 1;
  });
  return entries;
}

/** Splits entries into a root directory and leaf directories so the header and root fit in 16 KiB. */
function directories(entries: Entry[]): { root: Uint8Array; leaves: Uint8Array } {
  const root = encodeDirectory(entries);
  if (root.length <= 16384 - 127) return { root, leaves: new Uint8Array() };
  for (let leafSize = 4096; ; leafSize *= 2) {
    const rootEntries: Entry[] = [];
    const leafParts: Uint8Array[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const leaf = encodeDirectory(entries.slice(i, i + leafSize));
      rootEntries.push({ tileId: entries[i]?.tileId ?? 0, offset, length: leaf.length, runLength: 0 });
      leafParts.push(leaf);
      offset += leaf.length;
    }
    const rootBytes = encodeDirectory(rootEntries);
    if (rootBytes.length <= 16384 - 127) return { root: rootBytes, leaves: Buffer.concat(leafParts) };
  }
}

/** A tile to write: its coordinates and a reader of its bytes. */
export interface PmtilesTile {
  z: number;
  x: number;
  y: number;
  read: () => Uint8Array;
}

function writeHeader(info: PmtilesInfo, sections: number[], counts: number[], compressed: boolean): Uint8Array {
  const header = new Uint8Array(127);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('PMTiles'), 0);
  header[7] = 3;
  sections.forEach((value, i) => view.setBigUint64(8 + i * 8, BigInt(value), true));
  counts.forEach((value, i) => view.setBigUint64(72 + i * 8, BigInt(value), true));
  header.set([1, compressed ? COMPRESSION.gzip : COMPRESSION.none, info.tileCompression, info.tileType], 96);
  header.set([info.minZoom, info.maxZoom], 100);
  const e7 = (deg: number): number => Math.round(deg * 1e7);
  [info.bounds.west, info.bounds.south, info.bounds.east, info.bounds.north].forEach((deg, i) =>
    view.setInt32(102 + i * 4, e7(deg), true),
  );
  header[118] = info.center.zoom;
  view.setInt32(119, e7(info.center.lon), true);
  view.setInt32(123, e7(info.center.lat), true);
  return header;
}

/** Appends one tile's entry, merging runs of identical consecutive tiles. */
function addEntry(entries: Entry[], id: number, offset: number, length: number): void {
  const last = entries[entries.length - 1];
  if (last && last.offset === offset && last.tileId + last.runLength === id) last.runLength++;
  else entries.push({ tileId: id, offset, length, runLength: 1 });
}

/** Writes a PMTiles archive; returns the number of addressed and unique tiles. */
export function writePmtiles(
  path: string,
  tiles: PmtilesTile[],
  info: PmtilesInfo,
  metadata: unknown,
): { addressed: number; contents: number } {
  const sorted = tiles.map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), tile: t })).sort((a, b) => a.id - b.id);
  const dataPath = `${path}.data-${process.pid}`;
  writeFileSync(dataPath, new Uint8Array());
  const seen = new Map<string, { offset: number; length: number }>();
  const entries: Entry[] = [];
  let dataLength = 0;
  for (const { id, tile } of sorted) {
    const bytes = tile.read();
    const hash = createHash('sha256').update(bytes).digest('hex');
    let place = seen.get(hash);
    if (!place) {
      place = { offset: dataLength, length: bytes.length };
      seen.set(hash, place);
      appendFileSync(dataPath, bytes);
      dataLength += bytes.length;
    }
    addEntry(entries, id, place.offset, place.length);
  }
  const { root, leaves } = directories(entries);
  const meta = gzip(new TextEncoder().encode(JSON.stringify(metadata)));
  const rootOffset = 127;
  const metaOffset = rootOffset + root.length;
  const leafOffset = metaOffset + meta.length;
  const dataOffset = leafOffset + leaves.length;
  const sections = [
    rootOffset,
    root.length,
    metaOffset,
    meta.length,
    leafOffset,
    leaves.length,
    dataOffset,
    dataLength,
  ];
  const header = writeHeader(info, sections, [sorted.length, entries.length, seen.size], true);
  writeFileSync(path, Buffer.concat([header, root, meta, leaves]));
  appendFileSync(path, readFileSync(dataPath));
  rmSync(dataPath, { force: true });
  return { addressed: sorted.length, contents: seen.size };
}

/** A parsed PMTiles archive held in memory or read from a file descriptor. */
export class PmtilesReader {
  readonly header: DataView;
  private readonly root: Entry[];

  constructor(
    private readonly read: (offset: number, length: number) => Uint8Array,
    /** Releases the underlying file, when there is one. */
    readonly close: () => void = () => undefined,
  ) {
    const bytes = read(0, 127);
    if (new TextDecoder().decode(bytes.subarray(0, 7)) !== 'PMTiles' || bytes[7] !== 3)
      throw new Error('not a PMTiles v3 archive');
    this.header = new DataView(bytes.buffer, bytes.byteOffset, 127);
    this.root = decodeDirectory(read(this.u64(8), this.u64(16)));
  }

  /** Opens an archive file. */
  static open(path: string): PmtilesReader {
    const fd = openSync(path, 'r');
    return new PmtilesReader(
      (offset, length) => {
        const out = new Uint8Array(length);
        readSync(fd, out, 0, length, offset);
        return out;
      },
      () => closeSync(fd),
    );
  }

  /** A little-endian 64-bit header field. */
  u64(at: number): number {
    return Number(this.header.getBigUint64(at, true));
  }

  /** The JSON metadata. */
  metadata(): unknown {
    return JSON.parse(new TextDecoder().decode(gunzip(this.read(this.u64(24), this.u64(32)))));
  }

  /** Every entry of every directory (leaves expanded), in tile-id order. */
  entries(): Entry[] {
    const leafBase = this.u64(40);
    return this.root.flatMap((e) =>
      e.runLength === 0 ? decodeDirectory(this.read(leafBase + e.offset, e.length)) : [e],
    );
  }

  /** The bytes of a tile, or `undefined` when the archive does not address it. */
  tile(z: number, x: number, y: number): Uint8Array | undefined {
    const id = zxyToTileId(z, x, y);
    let entry = findTile(this.root, id);
    if (entry?.runLength === 0)
      entry = findTile(decodeDirectory(this.read(this.u64(40) + entry.offset, entry.length)), id);
    return entry && entry.runLength > 0 ? this.read(this.u64(56) + entry.offset, entry.length) : undefined;
  }
}
