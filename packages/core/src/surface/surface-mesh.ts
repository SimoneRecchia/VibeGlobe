// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { geodeticToEcef } from '../geodesy/ecef.js';
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
const lonLat = new Float64Array(2);
const mercator = new Float64Array(2);
const scale = new Float64Array(2);

/** The capped Mercator x and y of a position into a new array, for a tile's plane center. */
export function planeCenterOf(lonRad: number, latRad: number): Float64Array {
  lonLat[0] = lonRad;
  lonLat[1] = latRad;
  const center = new Float64Array(2);
  cappedMercatorInto(lonLat, center);
  return center;
}

/** Writes a vertex's plane endpoint data (see {@link TileMeshData.planes}). */
export function writePlane(
  planes: Float32Array,
  index: number,
  lonRad: number,
  latRad: number,
  dropMeters: number,
  center: Float64Array,
): void {
  lonLat[0] = lonRad;
  lonLat[1] = latRad;
  cappedMercatorInto(lonLat, mercator);
  scale[0] = latRad;
  mercatorScaleInto(scale);
  planes[index * 4] = (mercator[0] ?? 0) - (center[0] ?? 0);
  planes[index * 4 + 1] = (mercator[1] ?? 0) - (center[1] ?? 0);
  planes[index * 4 + 2] = dropMeters;
  planes[index * 4 + 3] = scale[1] ?? 1;
}

/** Writes the unit ellipsoid normal at a geodetic position. */
export function writeNormal(normals: Float32Array, index: number, lonRad: number, latRad: number): void {
  const cosLat = Math.cos(latRad);
  normals[index * 3] = cosLat * Math.cos(lonRad);
  normals[index * 3 + 1] = cosLat * Math.sin(lonRad);
  normals[index * 3 + 2] = Math.sin(latRad);
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
  const uvs = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 3);
  const normals = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 3);
  const planes = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 4);
  const planeCenter = planeCenterOf((westRad + eastRad) / 2, (southRad + northRad) / 2);
  const write = (index: number, row: number, col: number, heightMeters: number): void => {
    const latRad = northRad + ((southRad - northRad) * row) / TILE_SEGMENTS;
    const lonRad = westRad + ((eastRad - westRad) * col) / TILE_SEGMENTS;
    geodeticToEcef(lonRad, latRad, heightMeters, vertex);
    writeNormal(normals, index, lonRad, latRad);
    writePlane(planes, index, lonRad, latRad, heightMeters, planeCenter);
    for (let i = 0; i < 3; i++) positions[index * 3 + i] = (vertex[i] ?? 0) - (originEcef[i] ?? 0);
    // Rows are linear in latitude: both v are the row fraction.
    writeUvs(uvs, index, col / TILE_SEGMENTS, row / TILE_SEGMENTS, row / TILE_SEGMENTS);
  };
  for (let row = 0; row < GRID; row++) for (let col = 0; col < GRID; col++) write(row * GRID + col, row, col, 0);
  writeSkirts((index, row, col) => write(index, row, col, -skirtDepthMeters));
  markSkirts(normals);
  const indices = tileIndices();
  const byteLength = positions.byteLength + uvs.byteLength + normals.byteLength + planes.byteLength;
  return { key, originEcef, positions, uvs, normals, planes, planeCenter, indices, byteLength };
}

/**
 * Builds the mesh of a surface-quadtree tile (ADR 0006 §1): rows at {@link quadtreeRowLatitudeRad}, so a Mercator
 * tile's rows are evenly spaced in Mercator y, with skirts of `skirtDepthMeters`. Texture coordinates still address the
 * equirectangular base imagery until imagery tiles arrive (M3 plan, increment 1).
 */
export function buildQuadtreeTileMesh(tile: QuadtreeTile, skirtDepthMeters: number): TileMeshData {
  const { westRad, eastRad } = tile;
  const originEcef = new Float64Array(3);
  geodeticToEcef((westRad + eastRad) / 2, quadtreeRowLatitudeRad(tile, TILE_SEGMENTS / 2), 0, originEcef);
  const positions = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 3);
  const uvs = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 3);
  const normals = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 3);
  const planes = new Float32Array((SURFACE_VERTICES + SKIRT_VERTICES) * 4);
  const rowLatitudes = Array.from({ length: GRID }, (_, row) => quadtreeRowLatitudeRad(tile, row));
  const northRad = rowLatitudes[0] ?? 0;
  const heightRad = northRad - (rowLatitudes[TILE_SEGMENTS] ?? 0);
  const planeCenter = planeCenterOf((westRad + eastRad) / 2, rowLatitudes[TILE_SEGMENTS / 2] ?? 0);
  // Skirts slope outward four times as far as they hang down, so the skirts of neighbors overlap below the surface and
  // close the corners and slivers where tiles of different levels meet (KB-069); a skirt hangs at most a fraction of
  // a percent of the radius down, so even at this slope it stays inside the ellipsoid.
  const outwardRad = (4 * skirtDepthMeters) / WGS84.semiMajorAxisMeters;
  const write = (index: number, row: number, col: number, heightMeters: number): void => {
    let lonRad = westRad + ((eastRad - westRad) * col) / TILE_SEGMENTS;
    let latRad = rowLatitudes[row] ?? 0;
    if (heightMeters < 0) {
      const lonOut = outwardRad / Math.max(0.01, Math.cos(latRad));
      lonRad += col === 0 ? -lonOut : col === TILE_SEGMENTS ? lonOut : 0;
      latRad += row === 0 ? outwardRad : row === TILE_SEGMENTS ? -outwardRad : 0;
      latRad = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, latRad));
    }
    geodeticToEcef(lonRad, latRad, heightMeters, vertex);
    writeNormal(normals, index, lonRad, latRad);
    writePlane(planes, index, lonRad, latRad, heightMeters, planeCenter);
    for (let i = 0; i < 3; i++) positions[index * 3 + i] = (vertex[i] ?? 0) - (originEcef[i] ?? 0);
    // Rows are uniform in the tile's own scheme (Mercator y for the Mercator root, latitude for the caps).
    const vGeographic = row === 0 ? 0 : row === TILE_SEGMENTS ? 1 : (northRad - latRad) / heightRad;
    writeUvs(uvs, index, col / TILE_SEGMENTS, row / TILE_SEGMENTS, vGeographic);
  };
  for (let row = 0; row < GRID; row++) for (let col = 0; col < GRID; col++) write(row * GRID + col, row, col, 0);
  writeSkirts((index, row, col) => write(index, row, col, -skirtDepthMeters));
  markSkirts(normals);
  const indices = tileIndices();
  const byteLength = positions.byteLength + uvs.byteLength + normals.byteLength + planes.byteLength;
  return { key: tile.key, originEcef, positions, uvs, normals, planes, planeCenter, indices, byteLength };
}
