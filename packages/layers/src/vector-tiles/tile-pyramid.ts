// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Which vector tiles to request and draw (F442; ADR 0041). Beyond a source's `maxzoom` the deepest tile is overzoomed:
 * the target tile reads a sub-square of it, scaled up, and no deeper tile is requested. Tiles outside the source's
 * bounds or zoom range are never requested. While a visible tile is not ready, its nearest ready ancestor is drawn
 * in its place, clipped to the visible tile's square, so every visible square is covered by exactly one tile and
 * translucent layers never blend twice.
 */

/** A tile address in the Web Mercator (XYZ) scheme. */
export interface TileId {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

/** A source's coverage: zoom range and bounds `[west, south, east, north]` in degrees (the TileJSON fields). */
export interface SourceCoverage {
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly bounds?: readonly [number, number, number, number];
}

/** The tile key used in caches and request logs. */
export function tileKey(tile: TileId): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** The ancestor of a tile at zoom `z` (≤ the tile's zoom). */
export function ancestorAt(tile: TileId, z: number): TileId {
  const d = tile.z - z;
  return { z, x: Math.floor(tile.x / 2 ** d), y: Math.floor(tile.y / 2 ** d) };
}

/** How to read a target tile from a source tile at a lower zoom: scale and offset in source tile units. */
export interface OverzoomTransform {
  readonly source: TileId;
  /** 2^(target zoom − source zoom). */
  readonly scale: number;
  /** The target's top-left corner in the source tile, in fractions of the source tile (0–1). */
  readonly offsetX: number;
  readonly offsetY: number;
}

/** The source tile a target tile is read from, overzoomed when the target lies beyond `maxzoom`. */
export function overzoom(target: TileId, coverage: SourceCoverage): OverzoomTransform {
  const sourceZoom = Math.min(target.z, coverage.maxzoom);
  const source = ancestorAt(target, sourceZoom);
  const scale = 2 ** (target.z - sourceZoom);
  return { source, scale, offsetX: target.x / scale - source.x, offsetY: target.y / scale - source.y };
}

/** Maps a point of the source tile (0–`extent`) into the target tile's coordinates (0–`extent`). */
export function toTargetTile(transform: OverzoomTransform, extent: number, x: number, y: number): [number, number] {
  return [(x - transform.offsetX * extent) * transform.scale, (y - transform.offsetY * extent) * transform.scale];
}

function lonToX(lonDeg: number, z: number): number {
  return ((lonDeg + 180) / 360) * 2 ** z;
}

function latToY(latDeg: number, z: number): number {
  const clamped = Math.max(-85.0511287798, Math.min(85.0511287798, latDeg));
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

/** Whether a source has data for this tile: within its zoom range (before overzoom) and its bounds. */
export function inCoverage(tile: TileId, coverage: SourceCoverage): boolean {
  if (tile.z < coverage.minzoom || tile.z > coverage.maxzoom) return false;
  const n = 2 ** tile.z;
  if (tile.x < 0 || tile.y < 0 || tile.x >= n || tile.y >= n) return false;
  if (coverage.bounds === undefined) return true;
  const [west, south, east, north] = coverage.bounds;
  return (
    tile.x + 1 > lonToX(west, tile.z) &&
    tile.x < lonToX(east, tile.z) &&
    tile.y + 1 > latToY(north, tile.z) &&
    tile.y < latToY(south, tile.z)
  );
}

/** The tiles to request for the visible target tiles: overzoomed to `maxzoom`, in coverage, without duplicates. */
export function tilesToRequest(visible: readonly TileId[], coverage: SourceCoverage): TileId[] {
  const out = new Map<string, TileId>();
  for (const target of visible) {
    const { source } = overzoom(target, coverage);
    if (inCoverage(source, coverage)) out.set(tileKey(source), source);
  }
  return [...out.values()];
}

/** One draw: a ready source tile, drawn clipped to the square of `target`. */
export interface TileDraw {
  readonly tile: TileId;
  readonly target: TileId;
  /** True when the tile stands in for a target whose own tile is not ready. */
  readonly standIn: boolean;
}

/**
 * What to draw for the visible target tiles: each target's own source tile when ready, otherwise its nearest ready
 * ancestor (down to `minzoom`), clipped to the target's square. Targets out of coverage draw nothing.
 */
export function tilesToDraw(
  visible: readonly TileId[],
  coverage: SourceCoverage,
  isReady: (tile: TileId) => boolean,
): TileDraw[] {
  const draws: TileDraw[] = [];
  for (const target of visible) {
    const { source } = overzoom(target, coverage);
    if (!inCoverage(source, coverage)) continue;
    for (let z = source.z; z >= coverage.minzoom; z--) {
      const candidate = ancestorAt(source, z);
      if (isReady(candidate)) {
        draws.push({ tile: candidate, target, standIn: z < source.z });
        break;
      }
    }
  }
  return draws;
}

/**
 * The tiles to keep loaded although no visible target needs them directly: the stand-ins drawn this frame. A cache
 * evicts every other tile first, so a parent is not dropped while its children load.
 */
export function retainedTiles(draws: readonly TileDraw[]): Set<string> {
  return new Set(draws.filter((d) => d.standIn).map((d) => tileKey(d.tile)));
}

/** Units per tile side of vector tile buckets (`BUCKET_EXTENT`). */
const EXTENT_UNITS = 4096;

/** The square of `target` in the units of `tile` (its ancestor or itself). */
export function clipOf(tile: TileId, target: TileId): [number, number, number, number] {
  const scale = 2 ** (target.z - tile.z);
  const size = EXTENT_UNITS / scale;
  const x = (target.x - tile.x * scale) * size;
  const y = (target.y - tile.y * scale) * size;
  return [x, y, x + size, y + size];
}
