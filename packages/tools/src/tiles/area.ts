// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Areas a build or package covers (a bounding box or a polygon) and the exact tile sets they select. */
import {
  type BBoxDeg,
  type TileCoord,
  latToTileY,
  lonToTileX,
  rangeCount,
  type TileRange,
  rangeTiles,
  snapToTileEdge,
  tileRange,
  tileXToLon,
  tileYToLat,
} from './mercator.js';

/** A polygon ring as `[lonDeg, latDeg]` pairs; the closing point may be repeated or omitted. */
export type Ring = [number, number][];

/** An area: a bounding box, or a polygon (outer ring first, holes after) with its bounding box. */
export type Area = { kind: 'bbox'; bbox: BBoxDeg } | { kind: 'polygon'; rings: Ring[]; bbox: BBoxDeg };

/**
 * Builds a polygon area from rings under the even-odd rule (outer rings and holes; several outer rings make a
 * multipolygon); its bounding box covers every ring.
 */
export function polygonArea(rings: Ring[]): Area {
  if (rings.length === 0 || rings.some((ring) => ring.length < 3))
    throw new Error('a polygon needs rings with at least 3 points');
  for (const [lon, lat] of rings.flat()) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90)
      throw new Error(`polygon point ${lon},${lat} is outside [-180, 180] × [-90, 90]`);
  }
  const lons = rings.flat().map((p) => p[0]);
  const lats = rings.flat().map((p) => p[1]);
  const bbox = { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
  return { kind: 'polygon', rings, bbox };
}

/** A ring in fractional tile coordinates of zoom `z`. */
export function ringToTileSpace(ring: Ring, z: number): Ring {
  return ring.map(([lon, lat]) => [snapToTileEdge(lonToTileX(lon, z)), snapToTileEdge(latToTileY(lat, z))]);
}

/** Whether segment a–b crosses the open square [x, x+1] × [y, y+1]. */
function segmentHitsSquare(a: [number, number], b: [number, number], x: number, y: number): boolean {
  // Liang–Barsky clipping of the segment against the square; a touch along the border does not count.
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: [number, number][] = [
    [-dx, a[0] - x],
    [dx, x + 1 - a[0]],
    [-dy, a[1] - y],
    [dy, y + 1 - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q <= 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t1 - t0 > 1e-12;
}

/** Marks every tile whose open square an edge of the rings crosses. */
export function edgeTiles(rings: Ring[], range: TileRange, mark: (x: number, y: number) => void): void {
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j] as [number, number];
      const b = ring[i] as [number, number];
      const x0 = Math.max(range.minX, Math.floor(Math.min(a[0], b[0])));
      const x1 = Math.min(range.maxX, Math.ceil(Math.max(a[0], b[0])) - 1);
      const y0 = Math.max(range.minY, Math.floor(Math.min(a[1], b[1])));
      const y1 = Math.min(range.maxY, Math.ceil(Math.max(a[1], b[1])) - 1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) if (segmentHitsSquare(a, b, x, y)) mark(x, y);
      }
    }
  }
}

/** Marks every tile whose center lies inside the rings (even-odd), row by row. */
export function interiorTiles(rings: Ring[], range: TileRange, mark: (x: number, y: number) => void): void {
  for (let y = range.minY; y <= range.maxY; y++) {
    const py = y + 0.5;
    const crossings: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i] as [number, number];
        const [xj, yj] = ring[j] as [number, number];
        if (yi > py !== yj > py) crossings.push(((xj - xi) * (py - yi)) / (yj - yi) + xi);
      }
    }
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(range.minX, Math.ceil((crossings[k] ?? 0) - 0.5));
      const to = Math.min(range.maxX, Math.floor((crossings[k + 1] ?? 0) - 0.5));
      for (let x = from; x <= to; x++) mark(x, y);
    }
  }
}

/**
 * The tiles at zoom `z` that intersect the area with positive area. A tile meets a polygon either because an edge
 * crosses it or because it lies inside, so edge traversal plus a center scanline finds them all.
 */
export function* areaTiles(area: Area, z: number): Generator<TileCoord> {
  const range = tileRange(area.bbox, z);
  if (area.kind === 'bbox') {
    yield* rangeTiles(range);
    return;
  }
  const rings = area.rings.map((ring) => ringToTileSpace(ring, z));
  const width = 2 ** z;
  const marked = new Set<number>();
  const mark = (x: number, y: number): void => void marked.add(y * width + x);
  edgeTiles(rings, range, mark);
  interiorTiles(rings, range, mark);
  for (const key of [...marked].sort((p, q) => p - q)) yield { z, x: key % width, y: Math.floor(key / width) };
}

/** Exact tile count of the area at zoom `z`. */
export function areaTileCount(area: Area, z: number): number {
  if (area.kind === 'bbox') return rangeCount(tileRange(area.bbox, z));
  let count = 0;
  for (const iterator = areaTiles(area, z); !iterator.next().done;) count++;
  return count;
}

/** The part of an area inside a bounding box (the box itself when the area is a bounding box). */
export function clipArea(area: Area, box: BBoxDeg): Area {
  const bbox = intersectBBox(area.bbox, box);
  if (!bbox) throw new Error('the sample area does not overlap the region');
  return area.kind === 'bbox' ? { kind: 'bbox', bbox } : { ...area, bbox };
}

/** Intersection of two bounding boxes, or `undefined` when they do not overlap with positive area. */
export function intersectBBox(a: BBoxDeg, b: BBoxDeg): BBoxDeg | undefined {
  const box = {
    west: Math.max(a.west, b.west),
    south: Math.max(a.south, b.south),
    east: Math.min(a.east, b.east),
    north: Math.min(a.north, b.north),
  };
  return box.west < box.east && box.south < box.north ? box : undefined;
}

/** The geographic extent of the area's tiles at zoom `z` (to the poles when the tiles reach the Mercator edge). */
export function coverage(area: Area, z: number): BBoxDeg {
  const range = tileRange(area.bbox, z);
  const last = 2 ** z - 1;
  return {
    west: tileXToLon(range.minX, z),
    east: tileXToLon(range.maxX + 1, z),
    north: range.minY === 0 ? 90 : tileYToLat(range.minY, z),
    south: range.maxY === last ? -90 : tileYToLat(range.maxY + 1, z),
  };
}
