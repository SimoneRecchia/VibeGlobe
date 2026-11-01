// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { geodeticArrayToEcef } from '../geodesy/ecef.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { cappedMercatorInto, mercatorScaleInto } from '../view/morph.js';
import { quadtreeRowLatitudeRad, QUADTREE_SEGMENTS, type QuadtreeTile } from './surface-quadtree.hot.js';

/** Geometry of one surface tile for the renderer: float32 offsets from a float64 origin (ADR 0004). */
export interface TileMeshData {
  /** Tile key, unique per tile. */
  readonly key: number;
  /** Tile origin, ECEF meters (float64). */
  readonly originEcef: Float64Array;
  /** Vertex offsets from the origin, xyz per vertex, meters. */
  readonly positions: Float32Array;
  /**
   * Tile-local texture coordinates, three per vertex (M3 plan §2.4): u east and v south across the tile, 0 to 1, with
   * v once in the tile's own rows (Mercator y for a Mercator tile) and once linear in latitude. Draws map them into an
   * imagery texture through a per-draw transform.
   */
  readonly uvs: Float32Array;
  /**
   * The ellipsoid normal at each vertex, xyz (ECEF directions), along which the renderer displaces terrain heights
   * (ADR 0006 §5); skirt vertices carry the normal of their own position, doubled to mark them.
   */
  readonly normals: Float32Array;
  /**
   * The flat-map endpoint of the morph (ADR 0008), four per vertex: the offset east and north from
   * {@link TileMeshData.planeCenter} in capped Web Mercator meters, the vertex's own drop below the surface in meters
   * (the skirt depth, 0 elsewhere) and the Mercator scale factor k(φ) that scales its terrain height.
   */
  readonly planes: Float32Array;
  /** The capped Web Mercator x and y of the tile's plane center, meters (float64). */
  readonly planeCenter: Float64Array;
  /** Triangle indices, shared by every tile with the same grid size. */
  readonly indices: Uint16Array;
  /** Approximate bytes of vertex data, for memory accounting. */
  readonly byteLength: number;
}

/** Grid segments per tile edge; 16 keeps the chord sag of a root tile under the refinement threshold quickly. */
export const TILE_SEGMENTS = QUADTREE_SEGMENTS;
const GRID = TILE_SEGMENTS + 1;
const SURFACE_VERTICES = GRID * GRID;
const SKIRT_VERTICES = 4 * GRID;
/** How far out a skirt reaches by default, per meter it hangs down (KB-069). */
const SKIRT_OUTWARD = 4;

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
const geodetic = new Float64Array(3);
const mercator = new Float64Array(2);
const scale = new Float64Array(2);

/** Where a mesh at a position (radians) is measured from: its ECEF origin and its capped Mercator plane center. */
export function meshOrigin(lonRad: number, latRad: number): Pick<TileMeshData, 'originEcef' | 'planeCenter'> {
  geodetic[0] = lonRad;
  geodetic[1] = latRad;
  geodetic[2] = 0;
  const planeCenter = new Float64Array(2);
  cappedMercatorInto(geodetic, planeCenter);
  return { originEcef: geodeticArrayToEcef(geodetic, new Float64Array(3)), planeCenter };
}

/**
 * Writes vertex `index` of a mesh measured from `origin` at `position` (radians, and the drop below the surface in
 * meters): its offset, unit ellipsoid normal and plane endpoint data (see {@link TileMeshData}). Layer geometry writes
 * its vertices with it too (ADR 0037). Allocates nothing.
 */
export function writeMeshVertex(
  out: Pick<TileMeshData, 'positions' | 'normals' | 'planes'>,
  index: number,
  position: Float64Array,
  origin: Pick<TileMeshData, 'originEcef' | 'planeCenter'>,
): void {
  const lonRad = position[0] ?? 0;
  const latRad = position[1] ?? 0;
  geodeticArrayToEcef(position, vertex);
  for (let i = 0; i < 3; i++) out.positions[index * 3 + i] = (vertex[i] ?? 0) - (origin.originEcef[i] ?? 0);
  const cosLat = Math.cos(latRad);
  out.normals[index * 3] = cosLat * Math.cos(lonRad);
  out.normals[index * 3 + 1] = cosLat * Math.sin(lonRad);
  out.normals[index * 3 + 2] = Math.sin(latRad);
  cappedMercatorInto(position, mercator);
  scale[0] = latRad;
  mercatorScaleInto(scale);
  out.planes[index * 4] = (mercator[0] ?? 0) - (origin.planeCenter[0] ?? 0);
  out.planes[index * 4 + 1] = (mercator[1] ?? 0) - (origin.planeCenter[1] ?? 0);
  out.planes[index * 4 + 2] = position[2] ?? 0;
  out.planes[index * 4 + 3] = scale[1] ?? 1;
}

/**
 * Doubles the normals of the skirt vertices: the renderer tells them apart by that length and lowers them further
 * where a tile shows terrain coarser than its level's (`TileDrawLayer.skirtMeters`); it normalizes every normal.
 */
function markSkirts(normals: Float32Array): void {
  for (let i = SURFACE_VERTICES * 3; i < (SURFACE_VERTICES + SKIRT_VERTICES) * 3; i++)
    normals[i] = (normals[i] ?? 0) * 2;
}

function writeUvs(uvs: Float32Array, index: number, u: number, vOwn: number, vGeographic: number): void {
  uvs[index * 3] = u;
  uvs[index * 3 + 1] = vOwn;
  uvs[index * 3 + 2] = vGeographic;
}

/** Calls `write` for every skirt vertex with the row and column of the edge vertex it hangs from. */
function writeSkirts(write: (index: number, row: number, col: number) => void): void {
  const edges = skirtEdges();
  for (let side = 0; side < 4; side++) {
    const edge = edges[side] ?? [];
    for (let i = 0; i < GRID; i++) {
      const source = edge[i] ?? 0;
      write(SURFACE_VERTICES + side * GRID + i, Math.floor(source / GRID), source % GRID);
    }
  }
}

/**
 * Builds the mesh of a geographic tile spanning [west, east] × [south, north] (radians) on the ellipsoid, rows linear in
 * latitude, with skirts of `skirtDepthMeters` that hide cracks between neighbors of different levels.
 */
export function buildTileMesh(
  key: number,
  westRad: number,
  southRad: number,
  eastRad: number,
  northRad: number,
  skirtDepthMeters: number,
): TileMeshData {
  const rows = Array.from({ length: GRID }, (_, row) => northRad + ((southRad - northRad) * row) / TILE_SEGMENTS);
  return buildMesh(key, westRad, eastRad, rows, skirtDepthMeters, 0);
}

/**
 * Builds the mesh of a surface-quadtree tile (ADR 0006 §1): rows at {@link quadtreeRowLatitudeRad}, so a Mercator
 * tile's rows are evenly spaced in Mercator y, with skirts of `skirtDepthMeters` reaching `skirtReachMeters` out from
 * the edge (four times the depth by default). Texture coordinates still address the equirectangular base imagery until
 * imagery tiles arrive (M3 plan, increment 1).
 */
export function buildQuadtreeTileMesh(
  tile: QuadtreeTile,
  skirtDepthMeters: number,
  skirtReachMeters = SKIRT_OUTWARD * skirtDepthMeters,
): TileMeshData {
  const rows = Array.from({ length: GRID }, (_, row) => quadtreeRowLatitudeRad(tile, row));
  return buildMesh(
    tile.key,
    tile.westRad,
    tile.eastRad,
    rows,
    skirtDepthMeters,
    skirtReachMeters / WGS84.semiMajorAxisMeters,
  );
}

/** The mesh of a tile whose grid rows lie at `rowLatitudes`, its skirts reaching `outwardRad` out from the edge. */
function buildMesh(
  key: number,
  westRad: number,
  eastRad: number,
  rowLatitudes: readonly number[],
  skirtDepthMeters: number,
  outwardRad: number,
): TileMeshData {
  const origin = meshOrigin((westRad + eastRad) / 2, rowLatitudes[TILE_SEGMENTS / 2] ?? 0);
  const positions = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 3);
  const uvs = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 3);
  const normals = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 3);
  const planes = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 4);
  const northRad = rowLatitudes[0] ?? 0;
  const heightRad = northRad - (rowLatitudes[TILE_SEGMENTS] ?? 0);
  const vertices = { positions, normals, planes };
  // Skirts reach outward, so the skirts of neighbors overlap below the surface and close the corners and slivers where
  // tiles of different levels meet (KB-069); a skirt hangs at most a fraction of a percent of the radius down, so it
  // stays inside the ellipsoid.
  const write = (index: number, row: number, col: number, heightMeters: number): void => {
    let lonRad = westRad + ((eastRad - westRad) * col) / TILE_SEGMENTS;
    let latRad = rowLatitudes[row] ?? 0;
    if (heightMeters < 0) {
      const lonOut = outwardRad / Math.max(0.01, Math.cos(latRad));
      lonRad += col === 0 ? -lonOut : col === TILE_SEGMENTS ? lonOut : 0;
      latRad += row === 0 ? outwardRad : row === TILE_SEGMENTS ? -outwardRad : 0;
      latRad = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, latRad));
    }
    geodetic[0] = lonRad;
    geodetic[1] = latRad;
    geodetic[2] = heightMeters;
    writeMeshVertex(vertices, index, geodetic, origin);
    // Rows are uniform in the tile's own scheme (Mercator y for the Mercator root, latitude for the caps).
    const vGeographic = row === 0 ? 0 : row === TILE_SEGMENTS ? 1 : (northRad - latRad) / heightRad;
    writeUvs(uvs, index, col / TILE_SEGMENTS, row / TILE_SEGMENTS, vGeographic);
  };
  for (let row = 0; row < GRID; row++) for (let col = 0; col < GRID; col++) write(row * GRID + col, row, col, 0);
  writeSkirts((index, row, col) => write(index, row, col, -skirtDepthMeters));
  markSkirts(normals);
  const indices = tileIndices();
  const byteLength = positions.byteLength + uvs.byteLength + normals.byteLength + planes.byteLength;
  const { originEcef, planeCenter } = origin;
  return { key, originEcef, positions, uvs, normals, planes, planeCenter, indices, byteLength };
}
