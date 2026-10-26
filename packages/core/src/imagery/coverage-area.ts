// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Polygon coverage of a source (land, a country's borders): which tiles it is asked for, and in `clip` mode which
 * pixels of a tile across the border are its own. A source that answers only inside its area returns `noData`
 * elsewhere, so the next source of the layer (or the layer below) is drawn there.
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
   * Which tiles are asked for: `inside` (default) only tiles wholly inside the area, so the source below shows at the
   * edge; `overlap` every tile that touches the area, for sources whose tiles are transparent outside it; `clip` every
   * tile that touches it, with the pixels of a tile across the border that lie outside the area made transparent
   * when it is decoded, for sources whose tiles carry opaque filler beyond it (white or black around a country's
   * orthophoto): the layers below show there (F618, KB-209).
   */
  readonly tiles?: 'inside' | 'overlap' | 'clip';
}

/**
 * The area's outline over one tile, for the decoder's mask (F618): every ring of the polygons crossing the tile, as
 * `x, y` pairs in tile units (0 to 1, `x` east, `y` south from the tile's north edge); filled with the even-odd rule.
 */
export interface TileMask {
  readonly points: Float64Array;
  /** The end of each ring in `points`, in pairs. */
  readonly ringEnds: Uint32Array;
}

/** A GeoJSON geometry, feature or feature collection of polygons, the form country borders come in. */
export type GeoJsonArea =
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly (readonly number[])[])[] }
  | { readonly type: 'MultiPolygon'; readonly coordinates: readonly (readonly (readonly (readonly number[])[])[])[] }
  | { readonly type: 'Feature'; readonly geometry: GeoJsonArea | null }
  | { readonly type: 'FeatureCollection'; readonly features: readonly { readonly geometry: GeoJsonArea | null }[] };

/** A tested area: the bounding rectangles of its polygons and the tile test. */
export interface CoverageTest {
  /** One rectangle per polygon, in radians: tiles outside all of them are never asked for. */
  readonly rectangles: readonly TileRectangleRad[];
  /** True when the tile with this extent (radians) is to be requested. */
  covers(extent: TileRectangleRad): boolean;
  /**
   * In `clip` mode, the outline of the area over a requested tile, or undefined for a tile wholly inside it (no mask
   * needed) and in the other modes. `mercator`: the tile's rows are Web Mercator (else geographic, linear in latitude).
   */
  mask(extent: TileRectangleRad, mercator: boolean): TileMask | undefined;
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

/** Web Mercator's northing of a latitude, radians, clamped to the projection's square. */
function mercatorY(latRad: number): number {
  const limit = 1.4844222297453324;
  const lat = latRad > limit ? limit : latRad < -limit ? -limit : latRad;
  return Math.log(Math.tan(Math.PI / 4 + lat / 2));
}

/** The rings of the polygons crossing a tile in its units; undefined when one polygon holds the whole tile. */
function tileMask(polygons: readonly PreparedPolygon[], e: TileRectangleRad, mercator: boolean): TileMask | undefined {
  const crossing: Float64Array[] = [];
  for (const polygon of polygons) {
    if (rectangleInside(polygon, e)) return undefined;
    if (rectangleOverlaps(polygon, e)) crossing.push(...polygon.rings);
  }
  const top = mercator ? mercatorY(e.northRad) : e.northRad;
  const height = (mercator ? mercatorY(e.southRad) : e.southRad) - top;
  const width = e.eastRad - e.westRad;
  const pairs = crossing.reduce((sum, ring) => sum + ring.length / 2, 0);
  const points = new Float64Array(pairs * 2);
  const ringEnds = new Uint32Array(crossing.length);
  let at = 0;
  crossing.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i += 2) {
      const lat = ring[i + 1] ?? 0;
      points[at * 2] = ((ring[i] ?? 0) - e.westRad) / width;
      points[at * 2 + 1] = ((mercator ? mercatorY(lat) : lat) - top) / height;
      at++;
    }
    ringEnds[r] = at;
  });
  return { points, ringEnds };
}

/** Prepares an area for tile tests: done once per source, the tests themselves allocate nothing. */
export function coverageTest(area: CoverageArea): CoverageTest {
  const polygons = area.polygons.map(prepare);
  const overlap = area.tiles === 'overlap' || area.tiles === 'clip';
  const clip = area.tiles === 'clip';
  return {
    rectangles: polygons.map((p) => ({ westRad: p.west, southRad: p.south, eastRad: p.east, northRad: p.north })),
    covers(extent: TileRectangleRad): boolean {
      for (const polygon of polygons)
        if (overlap ? rectangleOverlaps(polygon, extent) : rectangleInside(polygon, extent)) return true;
      return false;
    },
    mask(extent: TileRectangleRad, mercator: boolean): TileMask | undefined {
      return clip ? tileMask(polygons, extent, mercator) : undefined;
    },
  };
}

/** The polygons of a GeoJSON polygon, multipolygon, feature or feature collection (other geometries are ignored). */
function geoJsonPolygons(input: GeoJsonArea): PolygonDeg[] {
  const polygon = (rings: readonly (readonly (readonly number[])[])[]): PolygonDeg =>
    rings.map((ring) => ring.map((p) => [p[0] ?? 0, p[1] ?? 0] as const));
  switch (input.type) {
    case 'Polygon':
      return [polygon(input.coordinates)];
    case 'MultiPolygon':
      return input.coordinates.map(polygon);
    case 'Feature':
      return input.geometry ? geoJsonPolygons(input.geometry) : [];
    case 'FeatureCollection':
      return input.features.flatMap((f) => (f.geometry ? geoJsonPolygons(f.geometry) : []));
    default:
      return [];
  }
}

/**
 * A coverage area from GeoJSON (a country's borders as a Polygon, MultiPolygon, Feature or FeatureCollection) or an
 * area as it is; GeoJSON is clipped per pixel (`clip`) unless `tiles` says otherwise (F618).
 */
export function coverageArea(input: CoverageArea | GeoJsonArea, tiles?: CoverageArea['tiles']): CoverageArea {
  if ('polygons' in input) return tiles ? { ...input, tiles } : input;
  return { polygons: geoJsonPolygons(input), tiles: tiles ?? 'clip' };
}
