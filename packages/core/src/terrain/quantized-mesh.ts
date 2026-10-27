// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The quantized-mesh-1.0 terrain format (F127): a little-endian header, zig-zag delta-encoded vertex coordinates,
 * high-water-mark triangle indices in 16 or 32 bits, edge vertex lists and length-prefixed extensions. Decoded to its
 * triangles, then rasterized to the height grid every terrain source uses (ADR 0006 §5). Pure functions; every read
 * is bounds-checked, so malformed bytes throw a `RangeError` instead of reading garbage (F131).
 */
import type { HeightGrid } from './heightmap.js';
import { sampleHeight } from './sample-height.js';

/** Quantized coordinates run from 0 to 32767 across the tile and the height range. */
const QUANTIZED_MAX = 32767;
/** Header bytes: center (3 × f64), min and max height (2 × f32), bounding sphere (4 × f64), horizon point (3 × f64). */
const HEADER_BYTES = 88;

/** A decoded quantized-mesh tile. */
export interface QuantizedMesh {
  readonly minHeightMeters: number;
  readonly maxHeightMeters: number;
  /** Per vertex, 0 at the west or south edge to 1 at the east or north edge. */
  readonly u: Float64Array;
  readonly v: Float64Array;
  readonly heightsMeters: Float64Array;
  /** Three vertex indices per triangle. */
  readonly indices: Uint32Array;
  /** Vertices on each edge. */
  readonly west: Uint32Array;
  readonly south: Uint32Array;
  readonly east: Uint32Array;
  readonly north: Uint32Array;
  /** Ids of every extension the tile carries, in order; unknown ones are skipped by their length. */
  readonly extensions: readonly number[];
  /** Unit normals from the oct-encoded vertex normals extension (id 1), three per vertex. */
  readonly normals?: Float32Array;
  /**
   * The water mask extension (id 2): one value for the whole tile (0 land, 255 water), or 256 × 256 values, rows from
   * the north.
   */
  readonly waterMask?: number | Uint8Array;
  /** The parsed JSON of the metadata extension (id 4), which may declare the availability of child tiles (F128). */
  readonly metadata?: unknown;
}

/** Extension id of oct-encoded vertex normals (quantized-mesh-1.0). */
export const EXTENSION_OCT_NORMALS = 1;
/** Extension id of the water mask. */
export const EXTENSION_WATER_MASK = 2;
/** Extension id of the JSON metadata. */
export const EXTENSION_METADATA = 4;
const WATER_MASK_SIZE = 256;

/** A bounds-checked little-endian reader. */
class Reader {
  private readonly view: DataView;
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  need(count: number, what: string): void {
    if (count < 0 || count > this.remaining) throw new RangeError(`quantized-mesh: truncated ${what}`);
  }

  skip(count: number, what: string): void {
    this.need(count, what);
    this.offset += count;
  }

  align(to: number): void {
    const pad = (to - (this.offset % to)) % to;
    this.skip(Math.min(pad, this.remaining), 'padding');
  }

  u8(): number {
    this.need(1, 'byte');
    return this.view.getUint8(this.offset++);
  }

  u32(what: string): number {
    this.need(4, what);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32(what: string): number {
    this.need(4, what);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** `count` unsigned integers of `bytes` bytes each. */
  uints(count: number, bytes: 2 | 4, what: string): Uint32Array {
    this.need(count * bytes, what);
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++, this.offset += bytes)
      out[i] = bytes === 2 ? this.view.getUint16(this.offset, true) : this.view.getUint32(this.offset, true);
    return out;
  }
}

/** Undoes the zig-zag delta encoding of one coordinate array in place, checking the 0–32767 range. */
function unzigzag(values: Uint32Array, what: string): void {
  let value = 0;
  for (let i = 0; i < values.length; i++) {
    const delta = values[i] ?? 0;
    value += (delta >> 1) ^ -(delta & 1);
    if (value < 0 || value > QUANTIZED_MAX) throw new RangeError(`quantized-mesh: ${what} out of range`);
    values[i] = value;
  }
}

/** Decodes high-water-mark encoded indices in place, checking each against the vertex count. */
function highWaterMark(indices: Uint32Array, vertexCount: number): void {
  let highest = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = indices[i] ?? 0;
    const index = highest - code;
    if (index < 0 || index >= vertexCount) throw new RangeError('quantized-mesh: index out of range');
    indices[i] = index;
    if (code === 0) highest++;
  }
}

/** Maps an oct-encoded byte (0–255) to −1…1. */
function snorm(byte: number): number {
  return Math.max(-1, Math.min(1, (byte / 255) * 2 - 1));
}

/** Decodes the oct-encoded normals (two bytes per vertex) to unit vectors. */
function octNormals(body: Uint8Array, vertexCount: number): Float32Array {
  if (body.length !== vertexCount * 2) throw new RangeError('quantized-mesh: normals do not match the vertex count');
  const out = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    let x = snorm(body[i * 2] ?? 0);
    let y = snorm(body[i * 2 + 1] ?? 0);
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      const ox = x;
      x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
      y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
    }
    const length = Math.hypot(x, y, z);
    out[i * 3] = x / length;
    out[i * 3 + 1] = y / length;
    out[i * 3 + 2] = z / length;
  }
  return out;
}

function readWaterMask(body: Uint8Array): number | Uint8Array {
  if (body.length === 1) return body[0] ?? 0;
  if (body.length === WATER_MASK_SIZE * WATER_MASK_SIZE) return body.slice();
  throw new RangeError('quantized-mesh: water mask is neither 1 nor 256 × 256 bytes');
}

/** Decodes UTF-8 bytes (core has no TextDecoder); a malformed sequence becomes U+FFFD. */
function utf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i++] ?? 0;
    const extra = b0 < 0x80 ? 0 : b0 >= 0xf0 ? 3 : b0 >= 0xe0 ? 2 : b0 >= 0xc0 ? 1 : -1;
    if (extra < 0) {
      out += '\ufffd';
      continue;
    }
    let code = extra === 0 ? b0 : b0 & (0x3f >> extra);
    for (let k = 0; k < extra; k++) code = (code << 6) | ((bytes[i++] ?? 0) & 0x3f);
    out += String.fromCodePoint(code > 0x10ffff ? 0xfffd : code);
  }
  return out;
}

function readMetadata(body: Uint8Array): unknown {
  if (body.length < 4) throw new RangeError('quantized-mesh: truncated metadata');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const length = view.getUint32(0, true);
  if (length > body.length - 4) throw new RangeError('quantized-mesh: truncated metadata');
  try {
    return JSON.parse(utf8(body.subarray(4, 4 + length))) as unknown;
  } catch {
    throw new RangeError('quantized-mesh: metadata is not JSON');
  }
}

/** The extensions after the edge lists, each an id byte and a 32-bit length; unknown ones are skipped. */
function readExtensions(
  reader: Reader,
  bytes: Uint8Array,
  vertexCount: number,
): Pick<QuantizedMesh, 'extensions' | 'normals' | 'waterMask' | 'metadata'> {
  const extensions: number[] = [];
  let normals: Float32Array | undefined;
  let waterMask: number | Uint8Array | undefined;
  let metadata: unknown;
  while (reader.remaining > 0) {
    const id = reader.u8();
    const length = reader.u32('extension length');
    reader.need(length, 'extension');
    const body = bytes.subarray(reader.offset, reader.offset + length);
    extensions.push(id);
    if (id === EXTENSION_OCT_NORMALS) normals = octNormals(body, vertexCount);
    else if (id === EXTENSION_WATER_MASK) waterMask = readWaterMask(body);
    else if (id === EXTENSION_METADATA) metadata = readMetadata(body);
    reader.skip(length, 'extension');
  }
  return {
    extensions,
    ...(normals ? { normals } : {}),
    ...(waterMask !== undefined ? { waterMask } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Decodes a quantized-mesh-1.0 tile (uncompressed bytes; HTTP gzip is undone by the browser). */
export function decodeQuantizedMesh(bytes: Uint8Array): QuantizedMesh {
  const reader = new Reader(bytes);
  reader.skip(24, 'header');
  const minHeightMeters = reader.f32('header');
  const maxHeightMeters = reader.f32('header');
  reader.skip(HEADER_BYTES - 32, 'header');
  if (!(maxHeightMeters >= minHeightMeters)) throw new RangeError('quantized-mesh: invalid height range');
  const vertexCount = reader.u32('vertex count');
  if (vertexCount < 3) throw new RangeError('quantized-mesh: fewer than three vertices');
  const qu = reader.uints(vertexCount, 2, 'u');
  const qv = reader.uints(vertexCount, 2, 'v');
  const qh = reader.uints(vertexCount, 2, 'heights');
  unzigzag(qu, 'u');
  unzigzag(qv, 'v');
  unzigzag(qh, 'height');
  const indexBytes = vertexCount > 65536 ? 4 : 2;
  reader.align(indexBytes);
  const triangleCount = reader.u32('triangle count');
  const indices = reader.uints(triangleCount * 3, indexBytes, 'indices');
  highWaterMark(indices, vertexCount);
  const edge = (what: string): Uint32Array => {
    const list = reader.uints(reader.u32(what), indexBytes, what);
    for (const index of list) if (index >= vertexCount) throw new RangeError(`quantized-mesh: ${what} out of range`);
    return list;
  };
  const west = edge('west edge');
  const south = edge('south edge');
  const east = edge('east edge');
  const north = edge('north edge');
  const { extensions, normals, waterMask, metadata } = readExtensions(reader, bytes, vertexCount);
  const u = new Float64Array(vertexCount);
  const v = new Float64Array(vertexCount);
  const heightsMeters = new Float64Array(vertexCount);
  const range = maxHeightMeters - minHeightMeters;
  for (let i = 0; i < vertexCount; i++) {
    u[i] = (qu[i] ?? 0) / QUANTIZED_MAX;
    v[i] = (qv[i] ?? 0) / QUANTIZED_MAX;
    heightsMeters[i] = minHeightMeters + ((qh[i] ?? 0) / QUANTIZED_MAX) * range;
  }
  return {
    minHeightMeters,
    maxHeightMeters,
    u,
    v,
    heightsMeters,
    indices,
    west,
    south,
    east,
    north,
    extensions,
    ...(normals ? { normals } : {}),
    ...(waterMask !== undefined ? { waterMask } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * Rasterizes a mesh to a grid of `cells`² cells (rows from the north, as {@link HeightGrid}): each grid vertex takes
 * the height of the triangle that contains it, interpolated barycentrically. A vertex no triangle covers (a gap in a
 * malformed mesh) takes the mesh's minimum height.
 */
export function rasterizeQuantizedMesh(mesh: QuantizedMesh, cells: number): HeightGrid {
  const side = cells + 1;
  const heights = new Float32Array(side * side).fill(Number.NaN);
  const { u, v, heightsMeters: h, indices } = mesh;
  const eps = 1e-9;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] ?? 0;
    const b = indices[t + 1] ?? 0;
    const c = indices[t + 2] ?? 0;
    // Grid coordinates: x east, y south (row 0 is the north edge, v = 1).
    const ax = (u[a] ?? 0) * cells;
    const ay = (1 - (v[a] ?? 0)) * cells;
    const bx = (u[b] ?? 0) * cells;
    const by = (1 - (v[b] ?? 0)) * cells;
    const cx = (u[c] ?? 0) * cells;
    const cy = (1 - (v[c] ?? 0)) * cells;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < eps) continue;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - eps));
    const x1 = Math.min(cells, Math.floor(Math.max(ax, bx, cx) + eps));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - eps));
    const y1 = Math.min(cells, Math.floor(Math.max(ay, by, cy) + eps));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const wa = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / area;
        const wb = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / area;
        const wc = 1 - wa - wb;
        if (wa < -eps || wb < -eps || wc < -eps) continue;
        heights[y * side + x] = wa * (h[a] ?? 0) + wb * (h[b] ?? 0) + wc * (h[c] ?? 0);
      }
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const value = Number.isNaN(heights[i] ?? Number.NaN) ? mesh.minHeightMeters : (heights[i] ?? 0);
    heights[i] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { cells, heightsMeters: heights, minMeters: min, maxMeters: max };
}

/** The largest |grid surface − vertex height| over a mesh's vertices: what rasterizing it to `grid` lost (F134). */
export function meshGridErrorMeters(mesh: QuantizedMesh, grid: HeightGrid): number {
  let worst = 0;
  for (let i = 0; i < mesh.heightsMeters.length; i++) {
    const error = Math.abs(sampleHeight(grid, mesh.u[i] ?? 0, 1 - (mesh.v[i] ?? 0)) - (mesh.heightsMeters[i] ?? 0));
    if (error > worst) worst = error;
  }
  return worst;
}
