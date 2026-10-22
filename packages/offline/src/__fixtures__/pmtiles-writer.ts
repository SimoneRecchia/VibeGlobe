// A minimal PMTiles v3 writer for fixture packages: uncompressed directories, one root directory, tiles in tile-id
// order. Written from the public specification (github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
import { zxyToTileId } from 'pmtiles';

/** One tile of a fixture archive. */
export interface FixtureTileBytes {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly bytes: Uint8Array;
}

function varint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

/** Writes a PMTiles v3 archive of PNG tiles with the given JSON metadata. */
export function writePmtiles(tiles: readonly FixtureTileBytes[], metadata: Record<string, unknown>): Uint8Array {
  const entries = tiles
    .map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), bytes: t.bytes, z: t.z }))
    .sort((a, b) => a.id - b.id);
  let offset = 0;
  const placed = entries.map((e) => {
    const at = offset;
    offset += e.bytes.length;
    return { ...e, offset: at };
  });
  const dir: number[] = [];
  varint(dir, placed.length);
  let last = 0;
  for (const e of placed) {
    varint(dir, e.id - last);
    last = e.id;
  }
  placed.forEach(() => varint(dir, 1));
  for (const e of placed) varint(dir, e.bytes.length);
  placed.forEach((e, i) => varint(dir, i > 0 ? 0 : e.offset + 1));
  const meta = new TextEncoder().encode(JSON.stringify(metadata));
  const rootOffset = 127;
  const metaOffset = rootOffset + dir.length;
  const dataOffset = metaOffset + meta.length;
  const out = new Uint8Array(dataOffset + offset);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('PMTiles'), 0);
  out[7] = 3;
  const u64 = (at: number, value: number): void => view.setBigUint64(at, BigInt(value), true);
  u64(8, rootOffset);
  u64(16, dir.length);
  u64(24, metaOffset);
  u64(32, meta.length);
  u64(40, 0);
  u64(48, 0);
  u64(56, dataOffset);
  u64(64, offset);
  u64(72, placed.length);
  u64(80, placed.length);
  u64(88, placed.length);
  out[96] = 1; // clustered
  out[97] = 1; // internal compression: none
  out[98] = 1; // tile compression: none
  out[99] = 2; // tile type: PNG
  const zooms = placed.map((e) => e.z);
  out[100] = Math.min(...zooms);
  out[101] = Math.max(...zooms);
  const bounds = (metadata['bounds'] as number[] | undefined) ?? [-180, -85, 180, 85];
  bounds.forEach((value, i) => view.setInt32(102 + i * 4, Math.round(value * 1e7), true));
  out[118] = out[100];
  out.set(new Uint8Array(dir), rootOffset);
  out.set(meta, metaOffset);
  for (const e of placed) out.set(e.bytes, dataOffset + e.offset);
  return out;
}
