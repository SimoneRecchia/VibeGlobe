// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Web Mercator (EPSG:3857) XYZ tile math: the grid every pipeline output and offline package uses. */

/** Latitude limit of the square Web Mercator world, in degrees. */
const MAX_MERCATOR_LAT_DEG = 85.0511287798066;

/** One XYZ tile: `x` grows east, `y` grows south, both from 0 to `2^z − 1`. */
export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** A geographic rectangle in degrees; `west > east` is not allowed (split areas crossing the antimeridian). */
export interface BBoxDeg {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** An inclusive rectangle of tiles at one zoom level. */
export interface TileRange {
  z: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Fractional tile column of a longitude at zoom `z`. */
export function lonToTileX(lonDeg: number, z: number): number {
  return ((lonDeg + 180) / 360) * 2 ** z;
}

/** Fractional tile row of a latitude at zoom `z`, clamped to the Mercator square. */
export function latToTileY(latDeg: number, z: number): number {
  const lat = Math.max(-MAX_MERCATOR_LAT_DEG, Math.min(MAX_MERCATOR_LAT_DEG, latDeg));
  const sin = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** z;
}

/** Longitude of a fractional tile column at zoom `z`. */
export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

/** Latitude of a fractional tile row at zoom `z`. */
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** Geographic bounds of a tile. */
export function tileBounds(tile: TileCoord): BBoxDeg {
  return {
    west: tileXToLon(tile.x, tile.z),
    east: tileXToLon(tile.x + 1, tile.z),
    north: tileYToLat(tile.y, tile.z),
    south: tileYToLat(tile.y + 1, tile.z),
  };
}

/**
 * The tiles at zoom `z` that intersect a bounding box with positive area. Edges that fall exactly on a tile border
 * do not pull in the neighbor beyond it.
 */
export function tileRange(bbox: BBoxDeg, z: number): TileRange {
  const last = 2 ** z - 1;
  const clamp = (v: number): number => Math.max(0, Math.min(last, v));
  const edge = (v: number): number => Math.ceil(snapToTileEdge(v)) - 1;
  return {
    z,
    minX: clamp(Math.floor(snapToTileEdge(lonToTileX(bbox.west, z)))),
    maxX: clamp(edge(lonToTileX(bbox.east, z))),
    minY: clamp(Math.floor(snapToTileEdge(latToTileY(bbox.north, z)))),
    maxY: clamp(edge(latToTileY(bbox.south, z))),
  };
}

/** Rounds a fractional tile coordinate within 1e-9 of a tile edge onto it (degree round trips are not exact). */
export function snapToTileEdge(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-9 ? rounded : value;
}

/** Number of tiles in a range. */
export function rangeCount(range: TileRange): number {
  return (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
}

/** Every tile of a range, row by row. */
export function* rangeTiles(range: TileRange): Generator<TileCoord> {
  for (let y = range.minY; y <= range.maxY; y++) {
    for (let x = range.minX; x <= range.maxX; x++) yield { z: range.z, x, y };
  }
}

/** Validates a bounding box: finite, ordered, within longitude ±180 and latitude ±90. */
export function bboxProblems(bbox: BBoxDeg): string[] {
  const problems: string[] = [];
  const values = [bbox.west, bbox.south, bbox.east, bbox.north];
  if (!values.every(Number.isFinite)) return ['bounding box values must be finite numbers'];
  if (bbox.west < -180 || bbox.east > 180) problems.push('longitudes must lie within [-180, 180]');
  if (bbox.south < -90 || bbox.north > 90) problems.push('latitudes must lie within [-90, 90]');
  if (bbox.west >= bbox.east) problems.push('west must be less than east (split areas crossing the antimeridian)');
  if (bbox.south >= bbox.north) problems.push('south must be less than north');
  return problems;
}

/** Parses `west,south,east,north`. */
export function parseBBox(text: string): BBoxDeg {
  const parts = text.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4) throw new Error(`bounding box "${text}" must be west,south,east,north`);
  const [west, south, east, north] = parts as [number, number, number, number];
  const bbox = { west, south, east, north };
  const problems = bboxProblems(bbox);
  if (problems.length > 0) throw new Error(`bounding box "${text}": ${problems.join('; ')}`);
  return bbox;
}
