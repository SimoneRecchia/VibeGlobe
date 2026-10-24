// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Packed tile keys (docs/plan/api.md, ADR 0006): one exact integer per tile of a quadtree pyramid, with the root it
 * belongs to (0 Web Mercator or a source's own scheme, 1 north polar cap, 2 south polar cap). Keys stay exact doubles
 * up to level {@link MAX_TILE_LEVEL} for pyramids of at most two root tiles.
 */

/** A tile of a quadtree pyramid: its root, level, column (from the west) and row (from the north). */
export interface TileCoord {
  root: 0 | 1 | 2;
  level: number;
  x: number;
  y: number;
}

/** A packed tile key: an exact integer, unique per root, level, column and row. */
export type TileKey = number;

/** The deepest level whose keys are exact: with two root tiles, 3 · 2 · (4^26 − 1) / 3 + 2 < 2^53. */
export const MAX_TILE_LEVEL = 25;

const ROOTS = 3;

/** Tiles in all levels above `level`, for a pyramid of `rootTiles` tiles at level 0. */
function tilesAbove(level: number, rootTiles: number): number {
  return (rootTiles * (4 ** level - 1)) / 3;
}

/**
 * Packs a tile into its key. `rootTilesX` and `rootTilesY` are the pyramid's tiles at level 0 (1 × 1 for Web Mercator,
 * 2 × 1 for geographic); throws a RangeError for a tile outside the pyramid or below {@link MAX_TILE_LEVEL}.
 */
export function packTileKey(coord: TileCoord, rootTilesX: number, rootTilesY: number): TileKey {
  const { root, level, x, y } = coord;
  const columns = rootTilesX * 2 ** level;
  const rows = rootTilesY * 2 ** level;
  if (
    !Number.isInteger(level) ||
    level < 0 ||
    level > MAX_TILE_LEVEL ||
    rootTilesX * rootTilesY > 2 ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x >= columns ||
    y < 0 ||
    y >= rows ||
    (root !== 0 && root !== 1 && root !== 2)
  ) {
    throw new RangeError(`No tile ${JSON.stringify(coord)} in a ${rootTilesX} × ${rootTilesY} pyramid`);
  }
  return (tilesAbove(level, rootTilesX * rootTilesY) + y * columns + x) * ROOTS + root;
}

/** Unpacks a key made by {@link packTileKey} with the same root tiles into `out`, and returns `out`. */
export function unpackTileKey(key: TileKey, rootTilesX: number, rootTilesY: number, out: TileCoord): TileCoord {
  const rootTiles = rootTilesX * rootTilesY;
  const root = key % ROOTS;
  const index = (key - root) / ROOTS;
  let level = 0;
  while (level < MAX_TILE_LEVEL && tilesAbove(level + 1, rootTiles) <= index) level++;
  const inLevel = index - tilesAbove(level, rootTiles);
  const columns = rootTilesX * 2 ** level;
  out.root = root as 0 | 1 | 2;
  out.level = level;
  out.y = Math.floor(inLevel / columns);
  out.x = inLevel - out.y * columns;
  return out;
}

/** The parent tile's coordinates in `out` (same root); a level-0 tile has none and returns undefined. */
export function parentTile(coord: TileCoord, out: TileCoord): TileCoord | undefined {
  if (coord.level === 0) return undefined;
  out.root = coord.root;
  out.level = coord.level - 1;
  out.x = Math.floor(coord.x / 2);
  out.y = Math.floor(coord.y / 2);
  return out;
}

/** The four children in reading order (north-west, north-east, south-west, south-east), written into `out`. */
export function childTiles(coord: TileCoord, out: [TileCoord, TileCoord, TileCoord, TileCoord]): typeof out {
  for (let i = 0; i < 4; i++) {
    const child = out[i] as TileCoord;
    child.root = coord.root;
    child.level = coord.level + 1;
    child.x = coord.x * 2 + (i % 2);
    child.y = coord.y * 2 + (i >> 1);
  }
  return out;
}
