// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Polygon coverage of a source (land, a country's borders): which tiles it is asked for. A source that answers only
 * inside its area returns `noData` elsewhere, so the next source of the layer (or the one below) is drawn there.
 */
import type { TileRectangleRad } from '../tiling/tiling-scheme.js';

/** A ring of `[longitudeDeg, latitudeDeg]` positions, closed or not, as in GeoJSON. */
export type RingDeg = readonly (readonly [number, number])[];

/** A polygon: its outer ring, then its holes, as in GeoJSON. */
export type PolygonDeg = readonly RingDeg[];

/** The area a source has data for. */
export interface CoverageArea {
  /** The polygons of the area (a GeoJSON MultiPolygon's coordinates). */
  readonly polygons: readonly PolygonDeg[];
  /**
   * Which tiles are asked for: `inside` (default) only tiles wholly inside the area, for sources whose tiles carry
   * opaque filler beyond it (JPEG orthophotos), so the source below shows at the edge; `overlap` every tile that
   * touches the area, for sources whose tiles are transparent outside it.
   */
  readonly tiles?: 'inside' | 'overlap';
}

/** A tested area: the bounding rectangles of its polygons and the tile test. */
export interface CoverageTest {
  /** One rectangle per polygon, in radians: tiles outside all of them are never asked for. */
  readonly rectangles: readonly TileRectangleRad[];
  /** True when the tile with this extent (radians) is to be requested. */
  covers(extent: TileRectangleRad): boolean;
}

const DEG = Math.PI / 180;

interface PreparedPolygon {
  readonly rings: readonly Float64Array[];
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

function prepare(polygon: PolygonDeg): PreparedPolygon {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const rings = polygon.map((ring) => {
    const out = new Float64Array(ring.length * 2);
    ring.forEach(([lon, lat], i) => {
      out[i * 2] = lon * DEG;
      out[i * 2 + 1] = lat * DEG;
    });
    return out;
  });
  const outer = rings[0] ?? new Float64Array(0);
  for (let i = 0; i < outer.length; i += 2) {
    west = Math.min(west, outer[i] ?? 0);
    east = Math.max(east, outer[i] ?? 0);
    south = Math.min(south, outer[i + 1] ?? 0);
    north = Math.max(north, outer[i + 1] ?? 0);
  }
  return { rings, west, south, east, north };
}

/** Even-odd test over every ring: inside the outer ring and outside its holes. */
function pointIn(polygon: PreparedPolygon, x: number, y: number): boolean {
  let inside = false;
  for (const ring of polygon.rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2] ?? 0;
      const yi = ring[i * 2 + 1] ?? 0;
      const xj = ring[j * 2] ?? 0;
      const yj = ring[j * 2 + 1] ?? 0;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The clipped parameter range of the segment in {@link segmentCrosses}; module scratch, so no call allocates. */
let clipStart = 0;
let clipEnd = 1;

/** Clips the range by one rectangle side `p·t ≤ q`; false once nothing is left. */
function clip(p: number, q: number): boolean {
  if (p === 0) return q > 0;
  const t = q / p;
  if (p < 0) clipStart = Math.max(clipStart, t);
  else clipEnd = Math.min(clipEnd, t);
  return clipStart < clipEnd;
}

/** True when the segment crosses the rectangle's interior (Liang–Barsky clipping). */
function segmentCrosses(e: TileRectangleRad, x0: number, y0: number, x1: number, y1: number): boolean {
  clipStart = 0;
  clipEnd = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  return (
    clip(-dx, x0 - e.westRad) && clip(dx, e.eastRad - x0) && clip(-dy, y0 - e.southRad) && clip(dy, e.northRad - y0)
  );
}

function edgesCross(polygon: PreparedPolygon, e: TileRectangleRad): boolean {
  for (const ring of polygon.rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      if (segmentCrosses(e, ring[j * 2] ?? 0, ring[j * 2 + 1] ?? 0, ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0))
        return true;
    }
  }
  return false;
}

/** True when the rectangle lies wholly inside the polygon: its center inside and no edge crossing it. */
function rectangleInside(polygon: PreparedPolygon, e: TileRectangleRad): boolean {
  if (e.westRad < polygon.west || e.eastRad > polygon.east || e.southRad < polygon.south || e.northRad > polygon.north)
    return false;
  return pointIn(polygon, (e.westRad + e.eastRad) / 2, (e.southRad + e.northRad) / 2) && !edgesCross(polygon, e);
}

/** True when the rectangle and the polygon share any area. */
function rectangleOverlaps(polygon: PreparedPolygon, e: TileRectangleRad): boolean {
  if (
    e.westRad >= polygon.east ||
    e.eastRad <= polygon.west ||
    e.southRad >= polygon.north ||
    e.northRad <= polygon.south
  )
    return false;
  if (pointIn(polygon, (e.westRad + e.eastRad) / 2, (e.southRad + e.northRad) / 2)) return true;
  return edgesCross(polygon, e);
}

/** Prepares an area for tile tests: done once per source, the tests themselves allocate nothing. */
export function coverageTest(area: CoverageArea): CoverageTest {
  const polygons = area.polygons.map(prepare);
  const overlap = area.tiles === 'overlap';
  return {
    rectangles: polygons.map((p) => ({ westRad: p.west, southRad: p.south, eastRad: p.east, northRad: p.north })),
    covers(extent: TileRectangleRad): boolean {
      for (const polygon of polygons)
        if (overlap ? rectangleOverlaps(polygon, extent) : rectangleInside(polygon, extent)) return true;
      return false;
    },
  };
}
