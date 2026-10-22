// Deterministic terrain tiles for tests (M4 plan §2): one analytic height function served in every encoding, so
// tests compare rendered relief and elevation queries with exact heights. Generated on request, nothing downloaded.
import { PNG } from 'pngjs';
import { fixturePosition, type FixtureTile } from './generate.ts';

/** Terrain encodings the fixture server serves. */
export type TerrainEncoding = 'terrarium' | 'terrain-rgb' | 'quantized-mesh' | 'float32' | 'rgb24';

const DEG = Math.PI / 180;

/** The Alps-like test peak: 4,000 m at 45.83° N, 6.86° E, falling off over about 30 km. */
const PEAK = { lonRad: 6.86 * DEG, latRad: 45.83 * DEG, heightMeters: 4000, radiusRad: 0.27 * DEG };
/** A sharp ridge along 46.5° N between 7° and 10° E, 1,500 m high, 2 km wide. */
const RIDGE = {
  latRad: 46.5 * DEG,
  westRad: 7 * DEG,
  eastRad: 10 * DEG,
  heightMeters: 1500,
  halfWidthRad: 0.009 * DEG,
};

/**
 * The fixture height in meters at a position: rolling hills everywhere (±300 m), a 4,000 m peak and a sharp ridge
 * in the Alps, and −200 m depressions so negative heights are covered too.
 */
export function fixtureHeightMeters(lonRad: number, latRad: number): number {
  let h = 300 * Math.sin(3 * lonRad) * Math.cos(5 * latRad) - 50;
  const d = Math.hypot((lonRad - PEAK.lonRad) * Math.cos(latRad), latRad - PEAK.latRad);
  h += PEAK.heightMeters * Math.exp(-((d / PEAK.radiusRad) ** 2));
  if (lonRad >= RIDGE.westRad && lonRad <= RIDGE.eastRad) {
    const across = Math.abs(latRad - RIDGE.latRad) / RIDGE.halfWidthRad;
    if (across < 1) h += RIDGE.heightMeters * (1 - across);
  }
  return h;
}

/** The fixture geoid's undulation, meters: smooth, so a 1° grid interpolates it within millimeters (F133). */
export function fixtureUndulationMeters(lonRad: number, latRad: number): number {
  return 30 + 20 * Math.sin(2 * lonRad) * Math.cos(latRad);
}

/** The fixture geoid as a `VGEOID1` grid file (ADR 0026): 1° steps, rows from 90° N, columns from 180° W. */
export function fixtureGeoidFile(): Buffer {
  const rows = 181;
  const columns = 360;
  const out = Buffer.alloc(16 + rows * columns * 4);
  out.write('VGEOID1\0', 0, 'latin1');
  out.writeUInt32LE(rows, 8);
  out.writeUInt32LE(columns, 12);
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < columns; col++) {
      const value = fixtureUndulationMeters(((col - 180) * Math.PI) / 180, ((90 - row) * Math.PI) / 180);
      out.writeFloatLE(value, 16 + (row * columns + col) * 4);
    }
  return out;
}

/**
 * Heights of a tile's (size)² samples at pixel centers, north row first: above the ellipsoid, or above the fixture
 * geoid with `geoid`.
 */
function samples(tile: FixtureTile, size: number, geoid = false): Float64Array {
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const { lonRad, latRad } = fixturePosition(tile, (x + 0.5) / size, (y + 0.5) / size);
      const h = fixtureHeightMeters(lonRad, latRad);
      out[y * size + x] = geoid ? h - fixtureUndulationMeters(lonRad, latRad) : h;
    }
  return out;
}

/** Encodes heights as a Terrarium or Terrain-RGB PNG. */
function heightPng(heights: Float64Array, size: number, encoding: 'terrarium' | 'terrain-rgb'): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i] ?? 0;
    let r: number;
    let g: number;
    let b: number;
    if (encoding === 'terrarium') {
      // In 1/256 m steps, rounded once, so the fraction never rounds up to 256 without carrying.
      const v = Math.round((h + 32768) * 256);
      r = Math.floor(v / 65536);
      g = Math.floor(v / 256) % 256;
      b = v % 256;
    } else {
      const v = Math.round((h + 10000) * 10);
      r = Math.floor(v / 65536);
      g = Math.floor(v / 256) % 256;
      b = v % 256;
    }
    png.data.set([r, g, b, 255], i * 4);
  }
  return PNG.sync.write(png);
}

/**
 * Raw 24-bit RGB samples with a formula of their own, the first custom encoding of F132: height =
 * (R × 65536 + G × 256 + B) / 100 − 50000 meters, three bytes per sample, rows from the north.
 */
function rgb24Tile(heights: Float64Array): Buffer {
  const out = Buffer.alloc(heights.length * 3);
  heights.forEach((h, i) => {
    const v = Math.round((h + 50000) * 100);
    out[i * 3] = Math.floor(v / 65536);
    out[i * 3 + 1] = Math.floor(v / 256) % 256;
    out[i * 3 + 2] = v % 256;
  });
  return out;
}

/** Raw little-endian float32 heights, the second custom encoding of F132. */
function float32Tile(heights: Float64Array): Buffer {
  const out = Buffer.alloc(heights.length * 4);
  heights.forEach((h, i) => out.writeFloatLE(h, i * 4));
  return out;
}

/** The grid vertices of a quantized-mesh tile: quantized u, v and heights, and two triangles per cell. */
function meshGrid(
  tile: FixtureTile,
  cells: number,
): { columns: number[][]; triangles: number[]; min: number; max: number } {
  const side = cells + 1;
  const heights: number[] = [];
  const us: number[] = [];
  const vs: number[] = [];
  for (let row = 0; row < side; row++)
    for (let col = 0; col < side; col++) {
      const { lonRad, latRad } = fixturePosition(tile, col / cells, row / cells);
      heights.push(fixtureHeightMeters(lonRad, latRad));
      us.push(Math.round((col / cells) * 32767));
      vs.push(Math.round((1 - row / cells) * 32767));
    }
  const min = Math.min(...heights);
  const max = Math.max(...heights) + 1e-3;
  const qh = heights.map((h) => Math.round(((h - min) / (max - min)) * 32767));
  const triangles: number[] = [];
  for (let row = 0; row < cells; row++)
    for (let col = 0; col < cells; col++) {
      const nw = row * side + col;
      const sw = nw + side;
      triangles.push(nw, nw + 1, sw + 1, nw, sw + 1, sw);
    }
  return { columns: [us, vs, qh], triangles, min, max };
}

/**
 * A quantized-mesh-1.0 tile triangulating a regular (n + 1)² grid of vertices from edge to edge, cells split along the
 * north-west to south-east diagonal, with edge lists and no extensions.
 */
function quantizedMesh(tile: FixtureTile, cells: number, extensions: QuantizedMeshExtensions = {}): Buffer {
  const side = cells + 1;
  const n = side * side;
  const { columns, triangles, min, max } = meshGrid(tile, cells);
  // High-water-mark encoding needs vertices numbered in order of first use: renumber the grid vertices that way.
  const order = new Int32Array(n).fill(-1);
  let next = 0;
  for (const index of triangles) if ((order[index] ?? -1) < 0) order[index] = next++;
  const renumbered = (index: number): number => order[index] ?? 0;
  const out = Buffer.alloc(88 + 4 + n * 6 + 4 + triangles.length * 2 + 4 * (4 + side) * 2 + 16);
  out.writeFloatLE(min, 24);
  out.writeFloatLE(max, 28);
  let o = 88;
  out.writeUInt32LE(n, o);
  o += 4;
  for (const values of columns) {
    const byUse = new Array<number>(n);
    values.forEach((value, i) => (byUse[renumbered(i)] = value));
    let previous = 0;
    for (const value of byUse) {
      const delta = value - previous;
      previous = value;
      out.writeUInt16LE(((delta << 1) ^ (delta >> 31)) & 0xffff, o);
      o += 2;
    }
  }
  out.writeUInt32LE(triangles.length / 3, o);
  o += 4;
  let highest = 0;
  for (const vertex of triangles) {
    const index = renumbered(vertex);
    out.writeUInt16LE(highest - index, o);
    o += 2;
    if (index === highest) highest++;
  }
  const range = Array.from({ length: side }, (_, i) => i);
  for (const list of [
    range.map((i) => i * side),
    range.map((i) => cells * side + i),
    range.map((i) => i * side + cells),
    range,
  ]) {
    out.writeUInt32LE(list.length, o);
    o += 4;
    for (const index of list) {
      out.writeUInt16LE(renumbered(index), o);
      o += 2;
    }
  }
  return Buffer.concat([out.subarray(0, o), extensionBytes(extensions, side * side)]);
}

/** The extensions a quantized-mesh fixture tile carries (what the request's Accept header asked for). */
export interface QuantizedMeshExtensions {
  /** Oct-encoded normals, all pointing up (128, 128). */
  normals?: boolean;
  /** A one-byte water mask: all land. */
  waterMask?: boolean;
  /** The metadata extension's JSON (for example `{ available }` of the levels below the tile, F128). */
  metadata?: unknown;
}

/** The extension blocks of a tile: id, 32-bit length and body each, in the order the format lists them. */
function extensionBytes(extensions: QuantizedMeshExtensions, vertexCount: number): Buffer {
  const blocks: Buffer[] = [];
  const block = (id: number, body: Buffer): void => {
    const header = Buffer.alloc(5);
    header.writeUInt8(id, 0);
    header.writeUInt32LE(body.length, 1);
    blocks.push(header, body);
  };
  if (extensions.normals) block(1, Buffer.alloc(vertexCount * 2, 128));
  if (extensions.waterMask) block(2, Buffer.of(0));
  if (extensions.metadata !== undefined) {
    const json = Buffer.from(JSON.stringify(extensions.metadata), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(json.length, 0);
    block(4, Buffer.concat([length, json]));
  }
  return Buffer.concat(blocks);
}

/** A terrain tile in an encoding; heightmaps are `sizePx`² samples (256 or 512), meshes `cells`² cells. */
export function terrainTile(
  tile: FixtureTile,
  encoding: TerrainEncoding,
  sizePx = 256,
  cells = 32,
  extensions: QuantizedMeshExtensions = {},
  geoid = false,
): Buffer {
  if (encoding === 'quantized-mesh') return quantizedMesh(tile, cells, extensions);
  const heights = samples(tile, sizePx, geoid);
  if (encoding === 'float32') return float32Tile(heights);
  return encoding === 'rgb24' ? rgb24Tile(heights) : heightPng(heights, sizePx, encoding);
}
