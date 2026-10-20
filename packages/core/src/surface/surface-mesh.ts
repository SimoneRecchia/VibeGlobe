import { geodeticToEcef } from '../geodesy/ecef.js';

/** Geometry of one surface tile for the renderer: float32 offsets from a float64 origin (ADR 0004). */
export interface TileMeshData {
  /** Tile key, unique per tile. */
  readonly key: number;
  /** Tile origin, ECEF meters (float64). */
  readonly originEcef: Float64Array;
  /** Vertex offsets from the origin, xyz per vertex, meters. */
  readonly positions: Float32Array;
  /** Texture coordinates into the equirectangular base imagery, uv per vertex. */
  readonly uvs: Float32Array;
  /** Triangle indices, shared by every tile with the same grid size. */
  readonly indices: Uint16Array;
  /** Approximate bytes of vertex data, for memory accounting. */
  readonly byteLength: number;
}

/** Grid segments per tile edge; 16 keeps the chord sag of a root tile under the refinement threshold quickly. */
export const TILE_SEGMENTS = 16;
const GRID = TILE_SEGMENTS + 1;
const SURFACE_VERTICES = GRID * GRID;
const SKIRT_VERTICES = 4 * GRID;

let sharedIndices: Uint16Array | undefined;

/** Indices of the tile grid plus its four skirts, built once and shared by every tile. */
export function tileIndices(): Uint16Array {
  if (sharedIndices) return sharedIndices;
  const quads = TILE_SEGMENTS * TILE_SEGMENTS + 4 * TILE_SEGMENTS;
  const indices = new Uint16Array(quads * 6);
  let n = 0;
  const quad = (a: number, b: number, c: number, d: number): void => {
    indices.set([a, c, b, b, c, d], n);
    n += 6;
  };
  for (let row = 0; row < TILE_SEGMENTS; row++) {
    for (let col = 0; col < TILE_SEGMENTS; col++) {
      const a = row * GRID + col;
      quad(a, a + 1, a + GRID, a + GRID + 1);
    }
  }
  const edges = skirtEdges();
  for (let side = 0; side < 4; side++) {
    const edge = edges[side] ?? [];
    for (let i = 0; i < TILE_SEGMENTS; i++) {
      const top0 = edge[i] ?? 0;
      const top1 = edge[i + 1] ?? 0;
      const skirt0 = SURFACE_VERTICES + side * GRID + i;
      quad(top0, top1, skirt0, skirt0 + 1);
    }
  }
  sharedIndices = indices;
  return indices;
}

/** Surface vertex indices along the north, east, south and west edges, in the order their skirts are stored. */
function skirtEdges(): number[][] {
  const north: number[] = [];
  const east: number[] = [];
  const south: number[] = [];
  const west: number[] = [];
  for (let i = 0; i < GRID; i++) {
    north.push(i);
    east.push(i * GRID + TILE_SEGMENTS);
    south.push(TILE_SEGMENTS * GRID + (TILE_SEGMENTS - i));
    west.push((TILE_SEGMENTS - i) * GRID);
  }
  return [north, east, south, west];
}

const vertex = new Float64Array(3);

/**
 * Builds the mesh of a geographic tile spanning [west, east] × [south, north] (radians) on the ellipsoid, with skirts
 * of `skirtDepthMeters` that hide cracks between neighbors of different levels.
 */
export function buildTileMesh(
  key: number,
  westRad: number,
  southRad: number,
  eastRad: number,
  northRad: number,
  skirtDepthMeters: number,
): TileMeshData {
  const originEcef = new Float64Array(3);
  geodeticToEcef((westRad + eastRad) / 2, (southRad + northRad) / 2, 0, originEcef);
  const positions = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 3);
  const uvs = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 2);
  const write = (index: number, lonRad: number, latRad: number, heightMeters: number): void => {
    geodeticToEcef(lonRad, latRad, heightMeters, vertex);
    for (let i = 0; i < 3; i++) positions[index * 3 + i] = (vertex[i] ?? 0) - (originEcef[i] ?? 0);
    uvs[index * 2] = (lonRad + Math.PI) / (2 * Math.PI);
    // three.js flips images vertically on upload, so v grows northward from the bottom row.
    uvs[index * 2 + 1] = (latRad + Math.PI / 2) / Math.PI;
  };
  for (let row = 0; row < GRID; row++) {
    const latRad = northRad + ((southRad - northRad) * row) / TILE_SEGMENTS;
    for (let col = 0; col < GRID; col++) {
      write(row * GRID + col, westRad + ((eastRad - westRad) * col) / TILE_SEGMENTS, latRad, 0);
    }
  }
  const edges = skirtEdges();
  for (let side = 0; side < 4; side++) {
    const edge = edges[side] ?? [];
    for (let i = 0; i < GRID; i++) {
      const source = edge[i] ?? 0;
      const row = Math.floor(source / GRID);
      const col = source % GRID;
      const latRad = northRad + ((southRad - northRad) * row) / TILE_SEGMENTS;
      write(
        SURFACE_VERTICES + side * GRID + i,
        westRad + ((eastRad - westRad) * col) / TILE_SEGMENTS,
        latRad,
        -skirtDepthMeters,
      );
    }
  }
  const indices = tileIndices();
  return { key, originEcef, positions, uvs, indices, byteLength: positions.byteLength + uvs.byteLength };
}
