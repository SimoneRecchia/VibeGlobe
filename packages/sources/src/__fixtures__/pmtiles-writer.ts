// Writes small PMTiles v3 archives in memory for the PMTiles conformance suite, from the specification
// (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md): clustered or not, with gzip or plain
// directories, with or without leaf directories.
import { gzipSync } from 'fflate';
import { zxyToTileId } from 'pmtiles';

/** Choices of {@link writePmtiles}. */
export interface ArchiveOptions {
  readonly tileType?: number;
  readonly clustered?: boolean;
  readonly gzipDirectories?: boolean;
  /** Entries per leaf directory; 0 (default) keeps every entry in the root. */
  readonly leafSize?: number;
  readonly bounds?: readonly [number, number, number, number];
  readonly metadata?: Record<string, unknown>;
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

function varints(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

function directory(entries: readonly Entry[], gzip: boolean): Uint8Array {
  const out: number[] = [];
  varints(out, entries.length);
  let last = 0;
  for (const e of entries) {
    varints(out, e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) varints(out, e.runLength);
  for (const e of entries) varints(out, e.length);
  entries.forEach((e, i) => {
    const previous = entries[i - 1];
    varints(out, previous && e.offset === previous.offset + previous.length ? 0 : e.offset + 1);
  });
  const bytes = Uint8Array.from(out);
  return gzip ? gzipSync(bytes) : bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The root directory, and the leaf directories when `leafSize` is above 0. */
function directories(entries: Entry[], gzip: boolean, leafSize: number): { root: Uint8Array; leaves: Uint8Array[] } {
  if (leafSize <= 0) return { root: directory(entries, gzip), leaves: [] };
  const leaves: Uint8Array[] = [];
  const rootEntries: Entry[] = [];
  let leafOffset = 0;
  for (let i = 0; i < entries.length; i += leafSize) {
    const chunk = entries.slice(i, i + leafSize);
    const leaf = directory(chunk, gzip);
    rootEntries.push({ tileId: chunk[0]?.tileId ?? 0, offset: leafOffset, length: leaf.length, runLength: 0 });
    leaves.push(leaf);
    leafOffset += leaf.length;
  }
  return { root: directory(rootEntries, gzip), leaves };
}

/** A PMTiles v3 archive holding `tiles` keyed by `z/x/y`. */
export function writePmtiles(
  tiles: ReadonlyMap<string, Uint8Array>,
  options: ArchiveOptions = {},
): Uint8Array<ArrayBuffer> {
  const sorted = [...tiles].map(([key, bytes]) => {
    const [z = 0, x = 0, y = 0] = key.split('/').map(Number);
    return { tileId: zxyToTileId(z, x, y), z, bytes };
  });
  sorted.sort((a, b) => a.tileId - b.tileId);
  // Unclustered archives store the tile data in reverse order, so offsets do not follow tile ids.
  const order = options.clustered === false ? [...sorted].reverse() : sorted;
  const offsets = new Map<number, number>();
  let dataLength = 0;
  for (const t of order) {
    offsets.set(t.tileId, dataLength);
    dataLength += t.bytes.length;
  }
  const entries: Entry[] = sorted.map((t) => ({
    tileId: t.tileId,
    offset: offsets.get(t.tileId) ?? 0,
    length: t.bytes.length,
    runLength: 1,
  }));
  const gzip = options.gzipDirectories ?? true;
  const { root, leaves } = directories(entries, gzip, options.leafSize ?? 0);
  const plainJson = new TextEncoder().encode(JSON.stringify(options.metadata ?? {}));
  const json = gzip ? gzipSync(plainJson) : plainJson;
  const leafBytes = concat(leaves);
  const data = concat(order.map((t) => t.bytes));
  const rootOffset = 127;
  const jsonOffset = rootOffset + root.length;
  const leafOffset = jsonOffset + json.length;
  const dataOffset = leafOffset + leafBytes.length;
  const header = new DataView(new ArrayBuffer(127));
  new Uint8Array(header.buffer).set(new TextEncoder().encode('PMTiles'));
  header.setUint8(7, 3);
  const u64 = (at: number, value: number): void => header.setBigUint64(at, BigInt(value), true);
  u64(8, rootOffset);
  u64(16, root.length);
  u64(24, jsonOffset);
  u64(32, json.length);
  u64(40, leafOffset);
  u64(48, leafBytes.length);
  u64(56, dataOffset);
  u64(64, data.length);
  u64(72, entries.length);
  u64(80, entries.length);
  u64(88, entries.length);
  header.setUint8(96, options.clustered === false ? 0 : 1);
  header.setUint8(97, gzip ? 2 : 1);
  header.setUint8(98, 1);
  header.setUint8(99, options.tileType ?? 2);
  const zooms = sorted.map((t) => t.z);
  header.setUint8(100, Math.min(...zooms));
  header.setUint8(101, Math.max(...zooms));
  const [w, s, e, n] = options.bounds ?? [-180, -85, 180, 85];
  [w, s, e, n].forEach((v, i) => header.setInt32(102 + 4 * i, Math.round(v * 1e7), true));
  return concat([new Uint8Array(header.buffer), root, json, leafBytes, data]);
}

/** A fetch that serves `bytes` at `url` with HTTP range requests, counting the requests it answers. */
export function rangeServer(url: string, bytes: Uint8Array): { fetch: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const serve: typeof fetch = (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    const range = new Headers(init?.headers).get('Range') ?? '';
    requests.push(`${target} ${range}`);
    if (target !== url) return Promise.resolve(new Response(null, { status: 404 }));
    const match = /bytes=(\d+)-(\d+)/.exec(range);
    if (!match) return Promise.resolve(new Response(bytes.slice(), { status: 200 }));
    const start = Number(match[1]);
    const end = Math.min(bytes.length - 1, Number(match[2]));
    return Promise.resolve(new Response(bytes.slice(start, end + 1), { status: 206 }));
  };
  return { fetch: serve, requests };
}
