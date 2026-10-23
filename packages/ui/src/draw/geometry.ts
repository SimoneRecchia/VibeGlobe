/** Shapes of the drawing tools (F407–F410) and the plane geometry their editing and validation need. */

/** A longitude and latitude, degrees. */
export type LonLat = readonly [longitudeDeg: number, latitudeDeg: number];

/** What a shape is. */
export type ShapeKind = 'point' | 'line' | 'polygon';

/** A drawn shape: its vertices (a polygon's ring is open: the first vertex is not repeated). */
export interface DrawnShape {
  readonly id: string;
  readonly kind: ShapeKind;
  readonly coordinates: readonly LonLat[];
}

/** A GeoJSON feature of a drawn shape. */
export interface DrawnFeature {
  readonly type: 'Feature';
  readonly id: string;
  readonly geometry:
    | { readonly type: 'Point'; readonly coordinates: LonLat }
    | { readonly type: 'LineString'; readonly coordinates: readonly LonLat[] }
    | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly LonLat[])[] };
  readonly properties: { readonly kind: ShapeKind };
}

/** The GeoJSON feature of a shape (a polygon's ring closed, as GeoJSON wants). */
export function toFeature(shape: DrawnShape): DrawnFeature {
  const { id, kind, coordinates } = shape;
  const first = coordinates[0] ?? [0, 0];
  const geometry: DrawnFeature['geometry'] =
    kind === 'point'
      ? { type: 'Point', coordinates: first }
      : kind === 'line'
        ? { type: 'LineString', coordinates }
        : { type: 'Polygon', coordinates: [[...coordinates, first]] };
  return { type: 'Feature', id, geometry, properties: { kind } };
}

/** The fewest vertices a finished shape of each kind has. */
export const MIN_VERTICES: Readonly<Record<ShapeKind, number>> = { point: 1, line: 2, polygon: 3 };

/** A point on the screen, CSS pixels. */
export interface ScreenXY {
  readonly xPx: number;
  readonly yPx: number;
}

/** Squared distance from `p` to the segment from `a` to `b`. */
export function segmentDistanceSquared(p: ScreenXY, a: ScreenXY, b: ScreenXY): number {
  const dx = b.xPx - a.xPx;
  const dy = b.yPx - a.yPx;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.xPx - a.xPx) * dx + (p.yPx - a.yPx) * dy) / length));
  const x = a.xPx + t * dx - p.xPx;
  const y = a.yPx + t * dy - p.yPx;
  return x * x + y * y;
}

/** Whether `p` lies inside the polygon through `ring` (even-odd rule). */
export function insideRing(p: ScreenXY, ring: readonly ScreenXY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    if (a.yPx > p.yPx !== b.yPx > p.yPx && p.xPx < ((b.xPx - a.xPx) * (p.yPx - a.yPx)) / (b.yPx - a.yPx) + a.xPx)
      inside = !inside;
  }
  return inside;
}

/** Whether the open segments a–b and c–d cross (touching end points do not count). */
function segmentsCross(a: LonLat, b: LonLat, c: LonLat, d: LonLat): boolean {
  const orient = (p: LonLat, q: LonLat, r: LonLat): number =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/**
 * Whether the closed ring through `ring` crosses itself: two edges that are not neighbours intersect. Longitudes are
 * unwrapped around the first vertex, so a ring across the antimeridian is judged as drawn.
 */
export function ringSelfIntersects(ring: readonly LonLat[]): boolean {
  const origin = ring[0]?.[0] ?? 0;
  const points = ring.map(([lon, lat]): LonLat => [((lon - origin + 540) % 360) - 180 + origin, lat]);
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = points[i];
      const b = points[(i + 1) % n];
      const c = points[j];
      const d = points[(j + 1) % n];
      if (a && b && c && d && segmentsCross(a, b, c, d)) return true;
    }
  return false;
}
