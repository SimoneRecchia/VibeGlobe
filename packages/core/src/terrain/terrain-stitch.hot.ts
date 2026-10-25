// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @hotpath Runs over every drawn tile every frame with terrain, looking up four neighbors each.
 * @benchmark benchmarks/run.ts
 */
import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import type { DrawList } from '../imagery/draw-list.js';
import { WEB_MERCATOR_MAX_LATITUDE_RAD } from '../projections/web-mercator.js';
import { MERCATOR_ROOT, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { TerrainLayer } from './terrain-draws.js';

/** Levels up from a tile's own that a coarser neighbor is looked for. */
const MAX_LEVELS_UP = 8;

const drawOf = new IntegerKeyMap<number>(512);
const keyAt = new Float64Array(1);
/** Neighbor offsets in columns and rows, in the order of `TileDrawLayer.stitchEdges`: north, east, south, west. */
const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

/** The draw showing the tile of `root`, `level`, column `x` and row `y`, or -1. */
function drawAt(root: number, level: number, x: number, y: number): number {
  const n = 2 ** level;
  keyAt[0] = ((4 ** level - 1) / 3 + y * n + x) * 3 + root;
  return drawOf.getAt(keyAt, 0) ?? -1;
}

/**
 * Stitches terrain edges between draws of different detail (KB-178): a draw next to neighbors showing coarser terrain
 * gets, in `stitchTextures` and `stitchTransforms`, the ancestor of its own terrain tile at the coarsest of those
 * neighbors' levels, and `stitchEdges` marks the edges that sample it. That ancestor is the neighbor's terrain tile or
 * the one next to it (whose edge heights the data matches), so the edge follows the neighbor's heights exactly instead
 * of leaving a wall of skirt. Polar cap tiles over a Web Mercator terrain get `heightScales` fading the 85.05° edge
 * row's heights to the ellipsoid at the pole (KB-180).
 */
export function stitchTerrainEdges(
  list: DrawList,
  tiles: readonly QuadtreeTile[],
  count: number,
  layer: TerrainLayer,
): void {
  const terrain = list.terrain;
  const edges = terrain.stitchEdges;
  const scales = terrain.heightScales;
  const loader = layer.loader;
  edges.fill(0, 0, count * 4);
  terrain.stitchTextures.fill(-1, 0, count);
  scales.fill(1, 0, count * 2);
  drawOf.clear();
  const mercatorTerrain = layer.source.tiling.crs === 'EPSG:3857';
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    if (!tile || (terrain.levels[index] ?? -1) < 0) continue;
    keyAt[0] = tile.key;
    drawOf.setAt(keyAt, 0, index);
    if (mercatorTerrain && tile.root !== MERCATOR_ROOT) {
      scales[index * 2] = capScale(tile.northRad);
      scales[index * 2 + 1] = capScale(tile.southRad);
    }
  }
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    const own = terrain.levels[index] ?? -1;
    if (!tile || own < 0) continue;
    const n = 2 ** tile.level;
    let coarsest = own;
    for (let edge = 0; edge < 4; edge++) {
      let y = tile.y + (DY[edge] ?? 0);
      if (y < 0 || y >= n) continue;
      let x = tile.x + (edge === 1 ? tile.span : (DX[edge] ?? 0));
      x = x < 0 ? x + n : x >= n ? x - n : x;
      let other = -1;
      for (let up = 0; up <= MAX_LEVELS_UP && up <= tile.level; up++) {
        other = drawAt(tile.root, tile.level - up, x, y);
        if (other >= 0) break;
        x >>= 1;
        y >>= 1;
      }
      const theirs = other < 0 ? own : (terrain.levels[other] ?? own);
      if (theirs >= own) continue;
      // The neighbor's level plus one until the stitch texture is known (0 stays "no coarser neighbor").
      edges[index * 4 + edge] = theirs + 1;
      if (theirs < coarsest) coarsest = theirs;
    }
    if (coarsest === own || !stitchTo(list, index, coarsest, loader)) edges.fill(0, index * 4, index * 4 + 4);
  }
}

/**
 * Points draw `index`'s stitch texture at the ancestor at `level` of its terrain tile, resident and kept this frame,
 * with its UV transform; marks the edges whose neighbor shows that level (1) and clears the others. False when the
 * ancestor is not resident.
 */
function stitchTo(list: DrawList, index: number, level: number, loader: TerrainLayer['loader']): boolean {
  const terrain = list.terrain;
  const coord = loader.coordOf(terrain.textures[index] ?? -1);
  if (!coord) return false;
  const up = coord.level - level;
  const x = coord.x >> up;
  const y = coord.y >> up;
  const handle = loader.readyHandle(level, x, y);
  if (handle < 0) return false;
  loader.markDrawn(handle);
  terrain.stitchTextures[index] = handle;
  const factor = 2 ** -up;
  const at = index * 4;
  const transforms = terrain.stitchTransforms;
  const own = terrain.uvTransforms;
  transforms[at] = (own[at] ?? 0) * factor;
  transforms[at + 1] = (own[at + 1] ?? 0) * factor;
  transforms[at + 2] = ((own[at + 2] ?? 0) + coord.x - x * 2 ** up) * factor;
  transforms[at + 3] = ((own[at + 3] ?? 0) + coord.y - y * 2 ** up) * factor;
  const edges = terrain.stitchEdges;
  for (let edge = 0; edge < 4; edge++) {
    edges[at + edge] = edges[at + edge] === level + 1 ? 1 : 0;
  }
  return true;
}

/** The share of the 85.05° edge row's heights a polar cap keeps at latitude `latRad`: 1 at the edge, 0 at the pole. */
function capScale(latRad: number): number {
  const share = (Math.PI / 2 - Math.abs(latRad)) / (Math.PI / 2 - WEB_MERCATOR_MAX_LATITUDE_RAD);
  return share < 0 ? 0 : share > 1 ? 1 : share;
}
