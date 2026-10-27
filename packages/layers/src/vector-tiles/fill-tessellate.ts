// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Polygon tessellation of vector-tile geometry in tile coordinates (y down, 0 to `extent`), run in workers (F443):
 * rings are grouped into polygons by winding (MVT 2.1: exterior rings clockwise in screen space), clipped to the tile
 * extent plus a buffer, and triangulated with earcut (ISC; ADR 0041). Clipping at a buffer slightly beyond the tile
 * edge, then at the exact edge when drawing, leaves no gap and no double-drawn band at tile edges (F440).
 */
import earcut from 'earcut';

/** A point in tile coordinates. */
export type TilePoint = readonly [number, number];
/** A ring or line in tile coordinates. */
export type TileRing = readonly TilePoint[];

/** Triangles over 2D vertices: `positions` holds x, y pairs, `indices` index them three at a time. */
export interface FillGeometry {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/** The axis-aligned rectangle geometry is clipped to. */
export interface ClipRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The clip rectangle of a tile with a buffer in tile units on every side (MapLibre's default buffer is 128 of 4096). */
export function tileClipRect(extent: number, buffer: number): ClipRect {
  return { minX: -buffer, minY: -buffer, maxX: extent + buffer, maxY: extent + buffer };
}

/** Twice the signed area in tile coordinates; positive for rings clockwise on screen (y down), MVT exteriors. */
export function signedArea(ring: TileRing): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (a !== undefined && b !== undefined) sum += (b[0] - a[0]) * (b[1] + a[1]);
  }
  return -sum;
}

/** Groups MVT rings into polygons: each exterior ring followed by its holes; zero-area rings are dropped. */
export function classifyRings(rings: readonly TileRing[]): TileRing[][] {
  const polygons: TileRing[][] = [];
  let current: TileRing[] | undefined;
  let exteriorSign = 0;
  for (const ring of rings) {
    const area = signedArea(ring);
    if (area === 0) continue;
    if (exteriorSign === 0) exteriorSign = Math.sign(area);
    if (Math.sign(area) === exteriorSign || current === undefined) {
      current = [ring];
      polygons.push(current);
    } else {
      current.push(ring);
    }
  }
  return polygons;
}

type Edge = 'minX' | 'maxX' | 'minY' | 'maxY';
const EDGES: readonly Edge[] = ['minX', 'maxX', 'minY', 'maxY'];

function inside(p: TilePoint, edge: Edge, rect: ClipRect): boolean {
  if (edge === 'minX') return p[0] >= rect.minX;
  if (edge === 'maxX') return p[0] <= rect.maxX;
  if (edge === 'minY') return p[1] >= rect.minY;
  return p[1] <= rect.maxY;
}

function intersect(a: TilePoint, b: TilePoint, edge: Edge, rect: ClipRect): TilePoint {
  const vertical = edge === 'minX' || edge === 'maxX';
  const value = rect[edge];
  const t = vertical ? (value - a[0]) / (b[0] - a[0]) : (value - a[1]) / (b[1] - a[1]);
  return vertical ? [value, a[1] + t * (b[1] - a[1])] : [a[0] + t * (b[0] - a[0]), value];
}

/** Clips a closed ring to a rectangle (Sutherland–Hodgman); the result is open (no repeated first point). */
export function clipRing(ring: TileRing, rect: ClipRect): TilePoint[] {
  let points: TilePoint[] = [...ring];
  const first = points[0];
  const last = points.at(-1);
  if (first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]) points.pop();
  for (const edge of EDGES) {
    const input = points;
    points = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i] as TilePoint;
      const previous = input[(i + input.length - 1) % input.length] as TilePoint;
      const currentIn = inside(current, edge, rect);
      if (currentIn !== inside(previous, edge, rect)) points.push(intersect(previous, current, edge, rect));
      if (currentIn) points.push(current);
    }
    if (points.length === 0) break;
  }
  return points;
}

/**
 * Tessellates a vector-tile polygon feature (all its rings, in MVT order) into triangles, clipped to `rect`.
 * Triangles keep the exterior winding, so every fill is drawn once per tile.
 */
export function tessellateFill(rings: readonly TileRing[], rect: ClipRect): FillGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const polygon of classifyRings(rings)) {
    const flat: number[] = [];
    const holes: number[] = [];
    polygon.forEach((ring, index) => {
      const clipped = clipRing(ring, rect);
      if (clipped.length < 3) {
        if (index === 0) flat.length = 0;
        return;
      }
      if (index > 0) holes.push(flat.length / 2);
      for (const [x, y] of clipped) flat.push(x, y);
    });
    if (flat.length < 6 || (holes.length > 0 && holes[0] === 0)) continue;
    const base = positions.length / 2;
    for (const index of earcut(flat, holes, 2)) indices.push(base + index);
    positions.push(...flat);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** The area covered by a fill's triangles, in square tile units (used by tests and by coverage checks). */
export function fillArea(geometry: FillGeometry): number {
  let area = 0;
  const p = geometry.positions;
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const a = (geometry.indices[i] ?? 0) * 2;
    const b = (geometry.indices[i + 1] ?? 0) * 2;
    const c = (geometry.indices[i + 2] ?? 0) * 2;
    const ax = p[a] ?? 0;
    const ay = p[a + 1] ?? 0;
    area += Math.abs(((p[b] ?? 0) - ax) * ((p[c + 1] ?? 0) - ay) - ((p[c] ?? 0) - ax) * ((p[b + 1] ?? 0) - ay)) / 2;
  }
  return area;
}
