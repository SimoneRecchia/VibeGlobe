import type { TileCoord, TileRectangleRad, TilingScheme } from '@vibeglobe/core';

/** A box in degrees. */
export interface BoundsDeg {
  readonly westDeg: number;
  readonly southDeg: number;
  readonly eastDeg: number;
  readonly northDeg: number;
}

/** A polygon ring in degrees, `[longitude, latitude]` pairs; closed implicitly. */
export interface PolygonDeg {
  readonly polygonDeg: readonly (readonly [number, number])[];
}

/** The area of a package: a box or a polygon (F304, F305). */
export type PackageArea = BoundsDeg | PolygonDeg;

const DEG = Math.PI / 180;

/** The bounding box of an area. */
function boundsOf(area: PackageArea): BoundsDeg {
  if (!('polygonDeg' in area)) return area;
  const lons = area.polygonDeg.map((p) => p[0]);
  const lats = area.polygonDeg.map((p) => p[1]);
  return {
    westDeg: Math.min(...lons),
    southDeg: Math.min(...lats),
    eastDeg: Math.max(...lons),
    northDeg: Math.max(...lats),
  };
}

function insidePolygon(lon: number, lat: number, ring: PolygonDeg['polygonDeg']): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] ?? [0, 0];
    const [xj, yj] = ring[j] ?? [0, 0];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
): boolean {
  const orient = (p: readonly number[], q: readonly number[], r: readonly number[]): number =>
    Math.sign(
      ((q[0] ?? 0) - (p[0] ?? 0)) * ((r[1] ?? 0) - (p[1] ?? 0)) -
        ((q[1] ?? 0) - (p[1] ?? 0)) * ((r[0] ?? 0) - (p[0] ?? 0)),
    );
  return orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b);
}

/** True when a tile's extent and an area overlap (touching edges do not count for boxes). */
function tileIntersects(area: PackageArea, extent: TileRectangleRad): boolean {
  const w = extent.westRad / DEG;
  const s = extent.southRad / DEG;
  const e = extent.eastRad / DEG;
  const n = extent.northRad / DEG;
  const box = boundsOf(area);
  if (w >= box.eastDeg || e <= box.westDeg || s >= box.northDeg || n <= box.southDeg) return false;
  if (!('polygonDeg' in area)) return true;
  const ring = area.polygonDeg;
  if (ring.some(([lon, lat]) => lon > w && lon < e && lat > s && lat < n)) return true;
  const corners = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ] as const;
  if (corners.some(([lon, lat]) => insidePolygon(lon, lat, ring))) return true;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] ?? [0, 0];
    const b = ring[(i + 1) % ring.length] ?? [0, 0];
    for (let k = 0; k < 4; k++)
      if (segmentsCross(a, b, corners[k] ?? [0, 0], corners[(k + 1) % 4] ?? [0, 0])) return true;
  }
  return false;
}

/** Every tile of `levels` that intersects the area, coarse levels first. */
export function* tilesOfArea(
  tiling: TilingScheme,
  area: PackageArea,
  minLevel: number,
  maxLevel: number,
): Generator<TileCoord> {
  const box = boundsOf(area);
  const corner: TileCoord = { root: 0, level: 0, x: 0, y: 0 };
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  for (let level = minLevel; level <= maxLevel; level++) {
    const nw = { ...tiling.tileAt(box.westDeg * DEG, box.northDeg * DEG, level, corner) };
    const se = { ...tiling.tileAt(box.eastDeg * DEG, box.southDeg * DEG, level, corner) };
    for (let y = nw.y; y <= se.y; y++) {
      for (let x = nw.x; x <= se.x; x++) {
        const coord: TileCoord = { root: nw.root, level, x, y };
        if (tileIntersects(area, tiling.tileExtent(coord, extent))) yield coord;
      }
    }
  }
}
