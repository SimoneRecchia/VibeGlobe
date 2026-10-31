// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Polygon coverage of a source (land, a country's borders): which tiles it is asked for, and in `clip` mode which
 * pixels of a tile across the border are its own. A source that answers only inside its area returns `noData`
 * elsewhere, so the next source of the layer (or the layer below) is drawn there.
 */
import { WGS84 } from '../geodesy/wgs84.js';
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
  /**
   * In `clip` mode, and with {@link CoverageArea.keyOutside}: the area's border fades over this many pixels of a tile,
   * from transparent at the border to opaque inside it, so it shows no edge between this source and the layer below
   * (default 0: a sharp border).
   */
  readonly featherPx?: number;
  /**
   * Pixels of this color outside the area are transparent, the others stay (every tile is asked for): the fill a
   * source gives its water, keyed out over the sea so the layer below shows there while the source's own coastline and
   * the lakes inside the area stay (the Europe preset's WorldCover, KB-231).
   */
  readonly keyOutside?: KeyColor;
  /**
   * Pixels of this color are transparent everywhere, inside the area too, fading out over a second tolerance so the
   * noise of lossy tiles around them goes too; with `clip`, the pixels outside the area go as well (F636). For a fill
   * that is never real imagery, such as a package's no-data water, where the area's outline does not follow the coast.
   */
  readonly keyEverywhere?: KeyColor;
  /**
   * The sea, for imagery whose water is real near the coast and a flat fill farther out, each ending in rectangles (the
   * Europe preset's WorldCover, KB-303): pixels of water's colors (blue and green above red, not bright) outside `land`
   * are transparent, fading back in over `featherMeters` inside it, so one sea shows below while the land's own pixels
   * stay, with its lakes and shadows. Gaps narrower than the feather between `land`'s polygons (borders simplified one
   * country at a time) count as land.
   */
  readonly keySea?: { readonly land: readonly PolygonDeg[]; readonly featherMeters: number };
}

/** A color the decoder matches per pixel: sRGB channels and the largest difference per channel (JPEG noise). */
export interface KeyColor {
  readonly rgb: readonly [number, number, number];
  /** Default 8. */
  readonly tolerance?: number;
}

/**
 * The area's outline over one tile, for the decoder's mask (F618): every ring of the polygons crossing the tile, as
 * `x, y` pairs in tile units (0 to 1, `x` east, `y` south from the tile's north edge); filled with the even-odd rule.
 */
export interface TileMask {
  readonly points: Float64Array;
  /** The end of each ring in `points`, in pairs. */
  readonly ringEnds: Uint32Array;
  /** The border's fade, in pixels of the tile, inward ({@link CoverageArea.featherPx}). */
  readonly featherPx?: number;
  /**
   * When set, only pixels of this color are masked; the others stay ({@link CoverageArea.keyOutside}). With
   * `everywhere`, the pixels of this color are transparent inside the outline too, and the others are masked by it
   * ({@link CoverageArea.keyEverywhere}).
   */
  readonly key?: {
    readonly rgb: readonly [number, number, number];
    readonly tolerance: number;
    readonly everywhere?: boolean;
  };
  /**
   * The land's outline over the tile and its fade in pixels of the tile ({@link CoverageArea.keySea}): water's colors
   * outside it are transparent; with no ring, the whole tile is sea.
   */
  readonly sea?: { readonly points: Float64Array; readonly ringEnds: Uint32Array; readonly featherPx: number };
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
   * In `clip` mode and with a key, the outline of the area over a requested tile, or undefined for a tile wholly
   * inside it (no mask needed; with a feather, farther inside than the fade) and in the other modes; with `keySea`, the
   * land's outline too, unless the tile lies inside the land beyond its fade. `mercator`: the tile's rows are Web
   * Mercator (else geographic, linear in latitude); `tileSizePx` scales the feathers (default 256).
   */
  mask(extent: TileRectangleRad, mercator: boolean, tileSizePx?: number): TileMask | undefined;
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

/**
 * The rings of the polygons crossing a tile in its units; undefined when one polygon holds the whole tile grown by
 * `margin` (a fraction of the tile on each side: the feather's reach).
 */
function tileMask(
  polygons: readonly PreparedPolygon[],
  e: TileRectangleRad,
  mercator: boolean,
  margin: number,
): Omit<TileMask, 'featherPx' | 'key'> | undefined {
  const dx = (e.eastRad - e.westRad) * margin;
  const dy = (e.northRad - e.southRad) * margin;
  const grown = {
    westRad: e.westRad - dx,
    eastRad: e.eastRad + dx,
    southRad: e.southRad - dy,
    northRad: e.northRad + dy,
  };
  const crossing: Float64Array[] = [];
  for (const polygon of polygons) {
    if (rectangleInside(polygon, grown)) return undefined;
    if (rectangleOverlaps(polygon, grown)) crossing.push(...polygon.rings);
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

/** A tile's own outline, for the mask of a tile wholly inside an area keyed everywhere or keying the sea. */
const WHOLE_TILE = Float64Array.of(0, 0, 1, 0, 1, 1, 0, 1);
const WHOLE_TILE_END = Uint32Array.of(4);

/** The land's outline over a tile with its fade in pixels; undefined for a tile inside the land beyond the fade. */
function seaMask(
  land: readonly PreparedPolygon[],
  e: TileRectangleRad,
  mercator: boolean,
  featherMeters: number,
  tileSizePx: number,
): TileMask['sea'] {
  const tileMeters = (e.eastRad - e.westRad) * WGS84.semiMajorAxisMeters * Math.cos((e.northRad + e.southRad) / 2);
  const outline = tileMask(land, e, mercator, featherMeters / tileMeters);
  return outline && { ...outline, featherPx: (featherMeters / tileMeters) * tileSizePx };
}

/** Prepares an area for tile tests: done once per source, the tests themselves allocate nothing. */
export function coverageTest(area: CoverageArea): CoverageTest {
  const polygons = area.polygons.map(prepare);
  const overlap = area.tiles === 'overlap' || area.tiles === 'clip';
  const clip = area.tiles === 'clip';
  const everywhere = area.keyEverywhere && {
    rgb: area.keyEverywhere.rgb,
    tolerance: area.keyEverywhere.tolerance ?? 8,
    everywhere: true,
  };
  const key =
    everywhere ?? (area.keyOutside && { rgb: area.keyOutside.rgb, tolerance: area.keyOutside.tolerance ?? 8 });
  const featherPx = Math.max(0, area.featherPx ?? 0);
  const land = area.keySea?.land.map(prepare);
  return {
    rectangles: polygons.map((p) => ({ westRad: p.west, southRad: p.south, eastRad: p.east, northRad: p.north })),
    covers(extent: TileRectangleRad): boolean {
      if (key && !everywhere) return true;
      for (const polygon of polygons)
        if (overlap ? rectangleOverlaps(polygon, extent) : rectangleInside(polygon, extent)) return true;
      return false;
    },
    mask(extent: TileRectangleRad, mercator: boolean, tileSizePx = 256): TileMask | undefined {
      if (!clip && !key && !land) return undefined;
      const sea = land && seaMask(land, extent, mercator, area.keySea?.featherMeters ?? 0, tileSizePx);
      const seaPart = sea ? { sea } : {};
      // A key everywhere and the sea's key mask the tiles wholly inside the area too, the whole tile as their outline.
      const outline = clip || key ? tileMask(polygons, extent, mercator, featherPx / tileSizePx) : undefined;
      if (!outline)
        return everywhere || sea
          ? { points: WHOLE_TILE, ringEnds: WHOLE_TILE_END, ...(everywhere ? { key: everywhere } : {}), ...seaPart }
          : undefined;
      return { ...outline, ...(featherPx > 0 ? { featherPx } : {}), ...(key ? { key } : {}), ...seaPart };
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
