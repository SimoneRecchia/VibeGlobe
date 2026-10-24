// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Reading OpenStreetMap PBF extracts (https://wiki.openstreetmap.org/wiki/PBF_Format): blobs of zlib-compressed
 * primitive blocks with dense nodes, nodes and ways. Relations are not read (multipolygon buildings are a follow-up).
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { ProtoReader } from './protobuf.js';

/** A node with tags. */
export interface OsmNode {
  id: number;
  lon: number;
  lat: number;
  tags: Record<string, string>;
}

/** A way: tags and node references. */
export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  refs: number[];
}

/** Callbacks of a PBF scan; omit what is not needed so it is not decoded. */
export interface OsmVisitor {
  node?: (node: OsmNode) => void;
  way?: (way: OsmWay) => void;
}

/** Random access to a PBF file's bytes. */
export interface ByteSource {
  size: number;
  read: (offset: number, length: number) => Uint8Array;
}

/** A byte source over a file, read block by block so extracts larger than memory stream through. */
export function fileSource(path: string): ByteSource & { close: () => void } {
  const fd = openSync(path, 'r');
  return {
    size: fstatSync(fd).size,
    read: (offset, length) => {
      const out = new Uint8Array(length);
      readSync(fd, out, 0, length, offset);
      return out;
    },
    close: () => closeSync(fd),
  };
}

/** A byte source over bytes in memory. */
export function memorySource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length) };
}

/** The data blobs of a PBF file (`OSMData` blocks), decompressed. */
function* pbfBlocks(source: ByteSource): Generator<Uint8Array> {
  let at = 0;
  while (at + 4 <= source.size) {
    const lengthBytes = source.read(at, 4);
    const headerLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0);
    const header = new ProtoReader(source.read(at + 4, headerLength));
    let type = '';
    let size = 0;
    header.forEach((tag, wire) => {
      if (tag === 1) type = header.string();
      else if (tag === 3) size = header.varint();
      else header.skip(wire);
    });
    const blobStart = at + 4 + headerLength;
    at = blobStart + size;
    if (type !== 'OSMData') continue;
    const blob = new ProtoReader(source.read(blobStart, size));
    let data: Uint8Array | undefined;
    blob.forEach((tag, wire) => {
      if (tag === 1) data = blob.bytes();
      else if (tag === 3) data = new Uint8Array(inflateSync(blob.bytes()));
      else blob.skip(wire);
    });
    if (data) yield data;
  }
}

interface Block {
  strings: string[];
  granularity: number;
  latOffset: number;
  lonOffset: number;
  groups: ProtoReader[];
}

function readBlock(data: Uint8Array): Block {
  const block: Block = { strings: [], granularity: 100, latOffset: 0, lonOffset: 0, groups: [] };
  const reader = new ProtoReader(data);
  reader.forEach((tag, wire) => {
    if (tag === 1) {
      const table = reader.message();
      table.forEach((t, w) => (t === 1 ? block.strings.push(table.string()) : table.skip(w)));
    } else if (tag === 2) block.groups.push(reader.message());
    else if (tag === 17) block.granularity = reader.varint();
    else if (tag === 19) block.latOffset = reader.varint();
    else if (tag === 20) block.lonOffset = reader.varint();
    else reader.skip(wire);
  });
  return block;
}

function coordinate(block: Block, value: number, offset: number): number {
  return (offset + block.granularity * value) * 1e-9;
}

function readDense(block: Block, dense: ProtoReader, visit: (node: OsmNode) => void): void {
  let ids: number[] = [];
  let lats: number[] = [];
  let lons: number[] = [];
  let keysVals: number[] = [];
  dense.forEach((tag, wire) => {
    if (tag === 1) ids = dense.packed(true);
    else if (tag === 8) lats = dense.packed(true);
    else if (tag === 9) lons = dense.packed(true);
    else if (tag === 10) keysVals = dense.packed(false);
    else dense.skip(wire);
  });
  let id = 0;
  let lat = 0;
  let lon = 0;
  let kv = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i] ?? 0;
    lat += lats[i] ?? 0;
    lon += lons[i] ?? 0;
    const tags: Record<string, string> = {};
    while (kv < keysVals.length && keysVals[kv] !== 0) {
      tags[block.strings[keysVals[kv] ?? 0] ?? ''] = block.strings[keysVals[kv + 1] ?? 0] ?? '';
      kv += 2;
    }
    kv++;
    visit({ id, lat: coordinate(block, lat, block.latOffset), lon: coordinate(block, lon, block.lonOffset), tags });
  }
}

function tagsOf(block: Block, keys: number[], vals: number[]): Record<string, string> {
  const tags: Record<string, string> = {};
  keys.forEach((k, i) => (tags[block.strings[k] ?? ''] = block.strings[vals[i] ?? 0] ?? ''));
  return tags;
}

function readNode(block: Block, node: ProtoReader): OsmNode {
  let id = 0;
  let lat = 0;
  let lon = 0;
  let keys: number[] = [];
  let vals: number[] = [];
  node.forEach((tag, wire) => {
    if (tag === 1) id = node.svarint();
    else if (tag === 2) keys = node.packed(false);
    else if (tag === 3) vals = node.packed(false);
    else if (tag === 8) lat = node.svarint();
    else if (tag === 9) lon = node.svarint();
    else node.skip(wire);
  });
  return {
    id,
    lat: coordinate(block, lat, block.latOffset),
    lon: coordinate(block, lon, block.lonOffset),
    tags: tagsOf(block, keys, vals),
  };
}

function readWay(block: Block, way: ProtoReader): OsmWay {
  let id = 0;
  let keys: number[] = [];
  let vals: number[] = [];
  let deltas: number[] = [];
  way.forEach((tag, wire) => {
    if (tag === 1) id = way.varint();
    else if (tag === 2) keys = way.packed(false);
    else if (tag === 3) vals = way.packed(false);
    else if (tag === 8) deltas = way.packed(true);
    else way.skip(wire);
  });
  let ref = 0;
  return { id, tags: tagsOf(block, keys, vals), refs: deltas.map((d) => (ref += d)) };
}

/** Scans a PBF file, calling the visitor for every node and way. */
export function scanPbf(source: ByteSource, visitor: OsmVisitor): void {
  for (const data of pbfBlocks(source)) {
    const block = readBlock(data);
    for (const group of block.groups) {
      group.forEach((tag, wire) => {
        if (tag === 1 && visitor.node) visitor.node(readNode(block, group.message()));
        else if (tag === 2 && visitor.node) readDense(block, group.message(), visitor.node);
        else if (tag === 3 && visitor.way) visitor.way(readWay(block, group.message()));
        else group.skip(wire);
      });
    }
  }
}
