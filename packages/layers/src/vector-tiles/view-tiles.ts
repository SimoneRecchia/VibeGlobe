// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The vector tiles a view needs (F441, F442; ADR 0131), from the surface tiles the engine drew: a Web Mercator
 * surface tile of level L (256-pixel tiles) is covered by the vector tile of zoom L − 1 (512-pixel tiles, the style
 * specification's convention). Where neighboring surface tiles map to a tile and to one of its descendants, the
 * coarser one is split until the targets partition the view, so every point is drawn by exactly one target.
 */
import { ancestorAt, tileKey, type TileId } from './tile-pyramid.js';

/** A surface tile as `Globe.surfaceTiles()` reports it. */
export interface SurfaceTileRef {
  readonly root: string;
  readonly level: number;
  readonly x: number;
  readonly y: number;
}

/** The four children of a tile. */
function children(tile: TileId): TileId[] {
  const z = tile.z + 1;
  const x = tile.x * 2;
  const y = tile.y * 2;
  return [
    { z, x, y },
    { z, x: x + 1, y },
    { z, x, y: y + 1 },
    { z, x: x + 1, y: y + 1 },
  ];
}

/**
 * Vector tile targets that partition the area of the surface tiles (polar caps have no vector tiles), refined where
 * `detail` asks for deeper tiles ({@link sampledTiles}).
 */
export function viewTargets(
  surface: readonly SurfaceTileRef[],
  maxZoom = 24,
  detail: readonly TileId[] = [],
): TileId[] {
  const set = new Map<string, TileId>();
  for (const tile of detail) set.set(tileKey(tile), tile);
  for (const s of surface) {
    if (s.root !== 'mercator') continue;
    const z = Math.min(maxZoom, Math.max(0, s.level - 1));
    const n = 2 ** s.level;
    // The surface may draw world copies on the flat map: wrap x into the world.
    const x = ((s.x % n) + n) % n;
    const tile = ancestorAt({ z: s.level, x, y: s.y }, z);
    set.set(tileKey(tile), tile);
  }
  // Every strict ancestor of a target: such a square is split into its children down to the targets.
  const ancestors = new Set<string>();
  for (const tile of set.values()) for (let z = tile.z - 1; z >= 0; z--) ancestors.add(tileKey(ancestorAt(tile, z)));
  const out: TileId[] = [];
  const emit = (tile: TileId): void => {
    if (ancestors.has(tileKey(tile))) for (const child of children(tile)) emit(child);
    else out.push(tile);
  };
  for (const tile of set.values()) {
    let isRoot = true;
    for (let z = tile.z - 1; z >= 0 && isRoot; z--) if (set.has(tileKey(ancestorAt(tile, z)))) isRoot = false;
    if (isRoot) emit(tile);
  }
  return dedupe(out);
}

function dedupe(tiles: readonly TileId[]): TileId[] {
  const seen = new Map<string, TileId>();
  for (const tile of tiles) seen.set(tileKey(tile), tile);
  return [...seen.values()];
}

/** What sampling the view needs from the globe. */
export interface ViewSampler {
  screenToGeo(point: { xPx: number; yPx: number }): { longitudeDeg: number; latitudeDeg: number } | undefined;
}

const SAMPLE_COLUMNS = 12;
const SAMPLE_ROWS = 9;
/** CSS pixels a vector tile should span at most (the style specification's 512-pixel tiles). */
const TILE_PX = 512;

function mercator(lonDeg: number, latDeg: number): [number, number] {
  const clamped = Math.max(-85.0511287798, Math.min(85.0511287798, latDeg));
  const s = Math.sin((clamped * Math.PI) / 180);
  return [(lonDeg + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

/**
 * Tiles of the detail the view needs, from a grid of screen samples: at each sample, the zoom at which a 512-pixel
 * tile matches the ground's scale there (the geometric mean of the scales along both screen axes, measured to the
 * next sample of the grid), as the tile of that zoom containing the sample. Each sample is picked once: the scale
 * comes from its grid neighbors rather than from extra picks a pixel away, which tripled the picks of every frame
 * (KB-210). Combined with the surface's coverage by {@link viewTargets}, so no area is left without a tile.
 */
export function sampledTiles(view: ViewSampler, widthPx: number, heightPx: number, maxZoom = 24): TileId[] {
  const out: TileId[] = [];
  const stepX = widthPx / SAMPLE_COLUMNS;
  const stepY = heightPx / SAMPLE_ROWS;
  const columns = SAMPLE_COLUMNS + 1;
  const grid: ([number, number] | undefined)[] = [];
  for (let row = 0; row <= SAMPLE_ROWS; row++)
    for (let col = 0; col <= SAMPLE_COLUMNS; col++) {
      const here = view.screenToGeo({
        xPx: Math.min(widthPx - 2, col * stepX),
        yPx: Math.min(heightPx - 2, row * stepY),
      });
      grid.push(here && mercator(here.longitudeDeg, here.latitudeDeg));
    }
  const at = (row: number, col: number) => grid[row * columns + col];
  for (let row = 0; row <= SAMPLE_ROWS; row++) {
    for (let col = 0; col <= SAMPLE_COLUMNS; col++) {
      const p = at(row, col);
      // The neighbors to the right and below, or to the left and above on the grid's last column and row.
      const r = at(row, col < SAMPLE_COLUMNS ? col + 1 : col - 1);
      const d = at(row < SAMPLE_ROWS ? row + 1 : row - 1, col);
      if (p === undefined || r === undefined || d === undefined) continue;
      const perPx = Math.sqrt(
        (Math.hypot(r[0] - p[0], r[1] - p[1]) / stepX) * (Math.hypot(d[0] - p[0], d[1] - p[1]) / stepY),
      );
      if (!(perPx > 0)) continue;
      const z = Math.max(0, Math.min(maxZoom, Math.round(Math.log2(1 / (perPx * TILE_PX)))));
      const n = 2 ** z;
      out.push({ z, x: Math.min(n - 1, Math.floor(p[0] * n)), y: Math.min(n - 1, Math.max(0, Math.floor(p[1] * n))) });
    }
  }
  return out;
}
