/**
 * Data-layer geometry at the antimeridian and the poles (F368). On the flat map ±180° are opposite edges, so a segment
 * or triangle spanning them must be cut there, or it is drawn the wrong way around the world; on the globe the cut is
 * invisible. Rings are unwrapped (each longitude within 180° of the previous) before triangulation, so a polygon across
 * the antimeridian is one shape, and a ring around a pole is closed through the pole.
 */
import type { FeatureGeometry, LayerOrigin } from '@vibeglobe/core';
import { vertexOf, type Triangle, type Vertex } from './layer-subdivision.js';

/** Where the segment a–b crosses the antimeridian, as the two cut ends (east edge, west edge), or undefined. */
function crossing(a: Vertex, b: Vertex): [Vertex, Vertex] | undefined {
  const d = b[0] - a[0];
  if (Math.abs(d) <= 180) return undefined;
  // Going east across +180 (b far west) or west across −180 (b far east).
  const unwrappedB = b[0] + (d < 0 ? 360 : -360);
  const edge = d < 0 ? 180 : -180;
  const t = (edge - a[0]) / (unwrappedB - a[0]);
  const lat = a[1] + t * (b[1] - a[1]);
  const height = a[2] + t * (b[2] - a[2]);
  return [
    [edge, lat, height],
    [-edge, lat, height],
  ];
}

/** A segment as one or two pieces that never span the antimeridian. */
export function splitAtAntimeridian(a: Vertex, b: Vertex): [Vertex, Vertex][] {
  const cut = crossing(a, b);
  return cut
    ? [
        [a, cut[0]],
        [cut[1], b],
      ]
    : [[a, b]];
}

/**
 * A ring's longitudes made continuous (each within 180° of the previous) in place; a ring around a pole, whose
 * longitudes then turn by a whole circle, is closed through that pole (where its latitudes lie).
 * @returns the ring, with the pole points appended when it encloses one.
 */
export function unwrapRing(ring: Vertex[]): Vertex[] {
  for (let i = 1; i < ring.length; i++) {
    const previous = ring[i - 1]?.[0] ?? 0;
    const v = ring[i];
    if (!v) continue;
    while (v[0] - previous > 180) v[0] -= 360;
    while (v[0] - previous < -180) v[0] += 360;
  }
  const first = ring[0];
  const last = ring.at(-1);
  if (!first || !last) return ring;
  // Closing back to the first vertex: a remaining jump of a whole circle means the ring encloses a pole.
  let close = first[0] - last[0];
  while (close > 180) close -= 360;
  while (close < -180) close += 360;
  const turn = last[0] + close - first[0];
  if (Math.abs(turn) < 180) return ring;
  const meanLat = ring.reduce((sum, v) => sum + v[1], 0) / ring.length;
  const pole = meanLat >= 0 ? 90 : -90;
  return [...ring, [last[0] + close, last[1], last[2]], [last[0] + close, pole, last[2]], [first[0], pole, first[2]]];
}

/** The part of a polygon on one side of a vertical line, by Sutherland–Hodgman (`keep` tests a vertex). */
function clip(polygon: Vertex[], x: number, keep: (v: Vertex) => boolean): Vertex[] {
  const out: Vertex[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (!a || !b) continue;
    const inA = keep(a);
    const inB = keep(b);
    if (inA) out.push(a);
    if (inA !== inB) {
      const t = (x - a[0]) / (b[0] - a[0]);
      out.push([x, a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return out;
}

/** A convex polygon as a fan of triangles. */
function fan(polygon: Vertex[]): Triangle[] {
  const out: Triangle[] = [];
  const [first] = polygon;
  if (!first) return out;
  for (let i = 1; i + 1 < polygon.length; i++) {
    const b = polygon[i];
    const c = polygon[i + 1];
    if (b && c) out.push([first, b, c]);
  }
  return out;
}

/**
 * A triangle of unwrapped longitudes (any range) cut at every antimeridian it spans, each piece shifted by whole
 * circles into −180°…180°, so none spans the map's edges. Triangles within one circle are returned as they are.
 */
export function wrapTriangle(triangle: Triangle): Triangle[] {
  const lons = triangle.map((v) => v[0]);
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  // The circles [k·360 − 180, k·360 + 180] the triangle touches.
  const first = Math.floor((west + 180) / 360);
  const last = Math.floor((east + 180 - 1e-9) / 360);
  if (first === last) {
    const shift = -360 * first;
    return [triangle.map(([lon, lat, h]) => [lon + shift, lat, h]) as Triangle];
  }
  const out: Triangle[] = [];
  for (let k = first; k <= last; k++) {
    const low = k * 360 - 180;
    const high = k * 360 + 180;
    let piece = clip([...triangle], low, (v) => v[0] >= low);
    piece = clip(piece, high, (v) => v[0] <= high);
    for (const t of fan(piece)) out.push(t.map(([lon, lat, h]) => [lon - 360 * k, lat, h]) as Triangle);
  }
  return out;
}

/** The longitude of a batch's origin, degrees (its plane center is Web Mercator x = a·λ). */
export function originLonDeg(origin: LayerOrigin): number {
  return ((origin.planeCenter[0] ?? 0) / 6_378_137) * (180 / Math.PI);
}

/** `lonDeg` moved by whole circles to within 180° of `referenceDeg` (F368: the flat map is continuous there). */
export function nearestLon(lonDeg: number, referenceDeg: number): number {
  return lonDeg + 360 * Math.round((referenceDeg - lonDeg) / 360);
}

/** A longitude in −180°…180°, for terrain lookups. */
export function wrappedLon(lonDeg: number): number {
  return ((((lonDeg + 180) % 360) + 360) % 360) - 180;
}

/**
 * A polygon's rings (parts `firstPart` to `lastPart` of `geometry`) with continuous longitudes, the outer ring's first
 * vertex nearest `originLon` and each hole's nearest the outer ring's, a ring around a pole closed through it; with the
 * hole starts earcut takes.
 */
export function unwrappedPolygon(
  geometry: FeatureGeometry,
  firstPart: number,
  lastPart: number,
  originLon: number,
): { vertices: Vertex[]; holes: number[] } {
  const vertices: Vertex[] = [];
  const holes: number[] = [];
  let reference = originLon;
  for (let part = firstPart; part < lastPart; part++) {
    const start = geometry.partStarts[part] ?? 0;
    const stop = geometry.partStarts[part + 1] ?? geometry.positions.length / 3;
    const ring: Vertex[] = [];
    for (let i = start; i < stop; i++) ring.push(vertexOf(geometry, i));
    const head = ring[0];
    if (head) head[0] = nearestLon(head[0], reference);
    const unwrapped = unwrapRing(ring);
    if (part === firstPart) reference = unwrapped[0]?.[0] ?? reference;
    else holes.push(vertices.length);
    vertices.push(...unwrapped);
  }
  return { vertices, holes };
}

/** Longitude shifts to draw a ring at: its own, and the neighboring world copies when it spans every longitude. */
export function worldCopies(vertices: readonly Vertex[]): number[] {
  const lons = vertices.map((v) => v[0]);
  return Math.max(...lons) - Math.min(...lons) >= 359.999 ? [0, -360, 360] : [0];
}
