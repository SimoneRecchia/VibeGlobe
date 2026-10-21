/**
 * @hotpath Runs every frame for every drawn surface tile and imagery layer; results go into typed arrays, no doubles
 * cross a call boundary (ADR 0018).
 * @benchmark benchmarks/run.ts
 */
import { MERCATOR_ROOT, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';

/**
 * Where a surface tile samples one imagery layer (M3 plan §2.5): the source tile and the affine map from the surface
 * tile's own coordinates (u east, v south, 0–1 across the tile; v in Mercator y for Mercator layers, in latitude for
 * geographic ones) into that source tile's texture coordinates: `source = surface · scale + offset` per axis. This
 * is the offset of the source level in a mapping.
 */
export const MAPPING_LEVEL = 0;
/** Offset of the source tile's column. */
export const MAPPING_X = 1;
/** Offset of the source tile's row, from the north. */
export const MAPPING_Y = 2;
/** Offset of the u scale. */
export const MAPPING_SCALE_U = 3;
/** Offset of the v scale. */
export const MAPPING_SCALE_V = 4;
/** Offset of the u offset. */
export const MAPPING_OFFSET_U = 5;
/** Offset of the v offset; a mapping takes seven values. */
export const MAPPING_OFFSET_V = 6;

/**
 * The Web Mercator tile at `level` (at most the surface tile's level) that contains a Mercator surface tile, written at
 * `offset` of `out`. Returns false for a tile outside the Mercator root (the polar caps have no Mercator imagery) or
 * a level above the surface tile's.
 */
export function mapMercator(tile: QuadtreeTile, level: number, out: Float64Array, offset: number): boolean {
  if (tile.root !== MERCATOR_ROOT || level > tile.level || level < 0) return false;
  const shift = tile.level - level;
  const cells = 2 ** shift;
  const x = Math.floor(tile.x / cells);
  const y = Math.floor(tile.y / cells);
  const scale = 1 / cells;
  out[offset + MAPPING_LEVEL] = level;
  out[offset + MAPPING_X] = x;
  out[offset + MAPPING_Y] = y;
  out[offset + MAPPING_SCALE_U] = scale;
  out[offset + MAPPING_SCALE_V] = scale;
  out[offset + MAPPING_OFFSET_U] = (tile.x - x * cells) * scale;
  out[offset + MAPPING_OFFSET_V] = (tile.y - y * cells) * scale;
  return true;
}

/**
 * The deepest geographic tile (two root tiles, rows from the north) at or above `maxLevel` that contains the whole
 * surface tile, written at `offset` of `out`: longitudes map linearly, and latitudes too, through the surface tile's
 * geographic v. Returns false when no single tile contains it (a surface tile spanning both hemispheres' root tiles).
 */
export function mapGeographic(tile: QuadtreeTile, maxLevel: number, out: Float64Array, offset: number): boolean {
  const width = tile.eastRad - tile.westRad;
  const height = tile.northRad - tile.southRad;
  // Nudged inward so a surface edge on a geographic tile edge belongs to the tile inside it.
  const west = tile.westRad + width * 1e-9;
  const east = tile.eastRad - width * 1e-9;
  const north = tile.northRad - height * 1e-9;
  const south = tile.southRad + height * 1e-9;
  for (let level = maxLevel; level >= 0; level--) {
    const step = Math.PI / 2 ** level;
    const x = Math.floor((west + Math.PI) / step);
    const y = Math.floor((Math.PI / 2 - north) / step);
    if (Math.floor((east + Math.PI) / step) !== x || Math.floor((Math.PI / 2 - south) / step) !== y) continue;
    const tileWest = -Math.PI + x * step;
    const tileNorth = Math.PI / 2 - y * step;
    out[offset + MAPPING_LEVEL] = level;
    out[offset + MAPPING_X] = x;
    out[offset + MAPPING_Y] = y;
    out[offset + MAPPING_SCALE_U] = width / step;
    out[offset + MAPPING_SCALE_V] = height / step;
    out[offset + MAPPING_OFFSET_U] = (tile.westRad - tileWest) / step;
    out[offset + MAPPING_OFFSET_V] = (tileNorth - tile.northRad) / step;
    return true;
  }
  return false;
}

/**
 * The ancestor of a mapping `levels` levels up, in place: the source tile's parent chain and the UV transform into it
 * (F083: a missing tile is drawn from its best available ancestor, upsampled). Works for both schemes, whose children
 * split each axis in two.
 */
export function mapAncestor(out: Float64Array, offset: number, levels: number): void {
  const cells = 2 ** levels;
  const x = out[offset + MAPPING_X] ?? 0;
  const y = out[offset + MAPPING_Y] ?? 0;
  const ancestorX = Math.floor(x / cells);
  const ancestorY = Math.floor(y / cells);
  out[offset + MAPPING_LEVEL] = (out[offset + MAPPING_LEVEL] ?? 0) - levels;
  out[offset + MAPPING_X] = ancestorX;
  out[offset + MAPPING_Y] = ancestorY;
  out[offset + MAPPING_SCALE_U] = (out[offset + MAPPING_SCALE_U] ?? 1) / cells;
  out[offset + MAPPING_SCALE_V] = (out[offset + MAPPING_SCALE_V] ?? 1) / cells;
  out[offset + MAPPING_OFFSET_U] = ((out[offset + MAPPING_OFFSET_U] ?? 0) + (x - ancestorX * cells)) / cells;
  out[offset + MAPPING_OFFSET_V] = ((out[offset + MAPPING_OFFSET_V] ?? 0) + (y - ancestorY * cells)) / cells;
}
