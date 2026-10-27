// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Places laid-out vector tile geometry on the globe and the flat map (ADR 0131): every vertex in tile units gets the
 * attributes a surface tile vertex carries (offsets from the tile's origin, ellipsoid normal, Web Mercator plane
 * offsets; ADR 0008, ADR 0037), so the renderer morphs it with the surface's precision. It runs in the
 * `layout-vector-tile` worker task. Long edges are split first, so fills and lines follow the globe's curvature:
 * a straight chord between distant vertices would cut under the surface.
 */
import { layerOrigin, writeLayerVertex, type LayerOrigin } from '@vibeglobe/core';
import { tessellateFill, type ClipRect, type FillGeometry, type TilePoint, type TileRing } from './fill-tessellate.js';
import type { TileId } from './tile-pyramid.js';

/** The attributes of each vertex: offsets from the tile origin, normals (both xyz) and planes (four per vertex). */
export interface GlobeVertices {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly planes: Float32Array;
}

const RAD_TO_DEG = 180 / Math.PI;

/** Longitude and latitude in degrees of a point in a tile's units (`extent` per tile side). */
export function tileToLonLat(tile: TileId, extent: number, x: number, y: number, out: number[] = [0, 0]): number[] {
  const n = 2 ** tile.z;
  const wx = (tile.x + x / extent) / n;
  const wy = (tile.y + y / extent) / n;
  out[0] = wx * 360 - 180;
  out[1] = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * RAD_TO_DEG;
  return out;
}

/** The origin of a tile's meshes: its center, on the surface's precision path (ADR 0004). */
export function tileOrigin(tile: TileId): LayerOrigin {
  const [lon, lat] = tileToLonLat(tile, 1, 0.5, 0.5);
  return layerOrigin(lon ?? 0, lat ?? 0);
}

/**
 * Globe attributes for `count` points read from `xy` (x, y at `stride` floats per vertex), relative to the tile's
 * origin. Latitudes beyond the Web Mercator limit cannot occur: tile units map inside it.
 */
export function globeVertices(tile: TileId, extent: number, xy: Float32Array, stride: number): GlobeVertices {
  const count = Math.floor(xy.length / stride);
  const out: GlobeVertices = {
    positions: new Float32Array(count * 3),
    normals: new Float32Array(count * 3),
    planes: new Float32Array(count * 4),
  };
  const origin = tileOrigin(tile);
  const lonLat = [0, 0];
  for (let i = 0; i < count; i++) {
    tileToLonLat(tile, extent, xy[i * stride] ?? 0, xy[i * stride + 1] ?? 0, lonLat);
    writeLayerVertex(out, i, lonLat[0] ?? 0, lonLat[1] ?? 0, origin);
  }
  return out;
}

/**
 * The longest edge, in tile units, that stays close enough to the globe at a tile's zoom: its chord sag is a fraction
 * of what the renderer's depth pull absorbs at the distance that zoom is viewed from. 90 · 2^(−z/2) pieces per tile
 * side (4° at zoom 0, 1° at zoom 4); from zoom 13 on a tile needs no split.
 */
export function maxEdgeUnits(zoom: number, extent: number): number {
  const pieces = 90 * 2 ** (-zoom / 2);
  return pieces <= 1 ? Infinity : extent / Math.ceil(pieces);
}

/** A line with points inserted so that no segment is longer than `maxLength` (tile units). */
export function densifyLine(line: readonly TilePoint[], maxLength: number): TilePoint[] {
  if (!Number.isFinite(maxLength) || line.length < 2) return [...line];
  const out: TilePoint[] = [];
  for (let i = 0; i < line.length; i++) {
    const b = line[i] as TilePoint;
    const a = line[i - 1];
    if (a !== undefined) {
      const pieces = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxLength);
      for (let k = 1; k < pieces; k++) {
        const t = k / pieces;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    out.push(b);
  }
  return out;
}

function bounds(rings: readonly TileRing[]): ClipRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

/** The `i`-th grid line of cells `cellUnits` wide, a whole division of the tile extent: computed exactly. */
function edge(i: number, cellUnits: number): number {
  return (i * 4096) / Math.round(4096 / cellUnits);
}

/**
 * Fill triangles clipped to `clip` and to a grid of `cellUnits` squares (aligned on the tile's origin), so that no
 * triangle is larger than a cell. Cells share their clipped edges exactly, so the pieces meet without cracks.
 */
export function subdividedFill(rings: readonly TileRing[], clip: ClipRect, cellUnits: number): FillGeometry {
  if (!Number.isFinite(cellUnits)) return tessellateFill(rings, clip);
  const box = bounds(rings);
  const positions: number[] = [];
  const indices: number[] = [];
  const x0 = Math.floor(Math.max(box.minX, clip.minX) / cellUnits);
  const x1 = Math.ceil(Math.min(box.maxX, clip.maxX) / cellUnits);
  const y0 = Math.floor(Math.max(box.minY, clip.minY) / cellUnits);
  const y1 = Math.ceil(Math.min(box.maxY, clip.maxY) / cellUnits);
  for (let cy = y0; cy < y1; cy++) {
    for (let cx = x0; cx < x1; cx++) {
      // Bounds computed the same way in every tile, so cells meet exactly at the tile edges.
      const cell = {
        minX: Math.max(clip.minX, edge(cx, cellUnits)),
        minY: Math.max(clip.minY, edge(cy, cellUnits)),
        maxX: Math.min(clip.maxX, edge(cx + 1, cellUnits)),
        maxY: Math.min(clip.maxY, edge(cy + 1, cellUnits)),
      };
      const piece = tessellateFill(rings, cell);
      const base = positions.length / 2;
      for (const value of piece.positions) positions.push(value);
      for (const index of piece.indices) indices.push(base + index);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
