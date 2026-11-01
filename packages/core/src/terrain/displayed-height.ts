// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { DrawList } from '../imagery/draw-list.js';
import { TILE_SEGMENTS } from '../surface/surface-mesh.js';
import { MERCATOR_ROOT, quadtreeRowLatitudeRad, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { sampleHeight } from './sample-height.js';
import type { TerrainHeights } from './terrain-heights.js';
import { mercatorY } from './vertical-datum.js';

/** The height of one draw layer's grid at tile coordinates, through transform `at` of `transforms`. */
function layerHeight(
  heights: TerrainHeights,
  handle: number,
  transforms: Float32Array,
  at: number,
  u: number,
  v: number,
): number {
  const grid = handle >= 0 ? heights.grid(handle) : undefined;
  // A tile drawn without terrain lies on the ellipsoid; NaN tells the caller nothing resident is shown there.
  if (!grid) return Number.NaN;
  const tu = u * (transforms[at] ?? 1) + (transforms[at + 2] ?? 0);
  const tv = v * (transforms[at + 1] ?? 1) + (transforms[at + 3] ?? 0);
  return sampleHeight(grid, tu, tv);
}

/**
 * The height a drawn tile's vertex shows (ADR 0006 §4): its terrain and the terrain it morphs from, mixed by the
 * morph's progress, exactly as the vertex shader does; NaN where the tile shows no terrain.
 */
function vertexHeight(
  list: DrawList,
  tile: QuadtreeTile,
  i: number,
  heights: TerrainHeights,
  col: number,
  row: number,
): number {
  const terrain = list.terrain;
  const u = col / TILE_SEGMENTS;
  // The mesh's rows are even in the tile's own rows; a geographic texture is read at the row's latitude.
  const vOwn = row / TILE_SEGMENTS;
  const vGeographic =
    tile.root === MERCATOR_ROOT
      ? (tile.northRad - quadtreeRowLatitudeRad(tile, row)) / (tile.northRad - tile.southRad)
      : vOwn;
  const at = i * 4;
  const to = layerHeight(
    heights,
    terrain.textures[i] ?? -1,
    terrain.uvTransforms,
    at,
    u,
    terrain.geographic[i] === 1 ? vGeographic : vOwn,
  );
  const fade = terrain.fades[i] ?? 1;
  if (fade >= 1) return to;
  const from = layerHeight(
    heights,
    terrain.fromTextures[i] ?? -1,
    terrain.fromUvTransforms,
    at,
    u,
    terrain.fromGeographic[i] === 1 ? vGeographic : vOwn,
  );
  // Mid-morph, a side without terrain is the ellipsoid, as the shader draws it.
  const fromMeters = from === from ? from : 0;
  const toMeters = to === to ? to : 0;
  return fromMeters + (toMeters - fromMeters) * fade;
}

/**
 * The height of the surface as the frame draws it at a position (ADR 0006 §4): in the drawn tile containing it, the
 * plane of the mesh triangle under it through its vertices' heights ({@link vertexHeight}), the cells split along the
 * north-east to south-west diagonal as `tileIndices` does. A grid finer than the mesh is drawn only at the vertices,
 * so the surface between them is the mesh's, not the grid's (KB-219). NaN where no drawn tile contains the position,
 * or the tile containing it shows no terrain. Allocates nothing.
 */
export function displayedHeightMeters(
  list: DrawList,
  tiles: readonly QuadtreeTile[],
  heights: TerrainHeights,
  lonRad: number,
  latRad: number,
): number {
  for (let i = 0; i < list.count; i++) {
    const tile = tiles[i];
    if (!tile || lonRad < tile.westRad || lonRad > tile.eastRad || latRad < tile.southRad || latRad > tile.northRad)
      continue;
    const x = ((lonRad - tile.westRad) / (tile.eastRad - tile.westRad)) * TILE_SEGMENTS;
    let vOwn = (tile.northRad - latRad) / (tile.northRad - tile.southRad);
    if (tile.root === MERCATOR_ROOT) {
      const top = mercatorY(tile.northRad);
      vOwn = (mercatorY(latRad) - top) / (mercatorY(tile.southRad) - top);
    }
    const y = vOwn * TILE_SEGMENTS;
    const col = x >= TILE_SEGMENTS ? TILE_SEGMENTS - 1 : x < 0 ? 0 : Math.floor(x);
    const row = y >= TILE_SEGMENTS ? TILE_SEGMENTS - 1 : y < 0 ? 0 : Math.floor(y);
    const fx = x - col;
    const fy = y - row;
    const north = vertexHeight(list, tile, i, heights, col + 1, row);
    const south = vertexHeight(list, tile, i, heights, col, row + 1);
    if (fx + fy <= 1) {
      const corner = vertexHeight(list, tile, i, heights, col, row);
      return corner + fx * (north - corner) + fy * (south - corner);
    }
    const corner = vertexHeight(list, tile, i, heights, col + 1, row + 1);
    return corner + (1 - fx) * (south - corner) + (1 - fy) * (north - corner);
  }
  return Number.NaN;
}
