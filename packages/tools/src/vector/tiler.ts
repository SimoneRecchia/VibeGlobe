// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Cutting features into vector tiles: projection to tile units, clipping with a buffer, quantization, winding. */
import { latToTileY, lonToTileX } from '../tiles/mercator.js';
import type { VectorFeature } from './features.js';
import { EXTENT, type TileFeature } from './mvt.js';

/** Buffer around each tile, in tile units (features are clipped to [−BUFFER, EXTENT + BUFFER]). */
const BUFFER = 64;

type Point = [number, number];

/** Clips a polyline to a rectangle; returns the pieces inside. */
export function clipLine(points: Point[], min: number, max: number): Point[][] {
  const pieces: Point[][] = [];
  let current: Point[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    let visible = true;
    for (const [p, q] of [
      [-dx, a[0] - min],
      [dx, max - a[0]],
      [-dy, a[1] - min],
      [dy, max - a[1]],
    ] as const) {
      if (p === 0) {
        if (q < 0) visible = false;
      } else if (p < 0) t0 = Math.max(t0, q / p);
      else t1 = Math.min(t1, q / p);
    }
    if (!visible || t0 > t1) {
      if (current.length > 1) pieces.push(current);
      current = [];
      continue;
    }
    const start: Point = [a[0] + t0 * dx, a[1] + t0 * dy];
    const end: Point = [a[0] + t1 * dx, a[1] + t1 * dy];
    if (current.length === 0) current.push(start);
    current.push(end);
    if (t1 < 1) {
      pieces.push(current);
      current = [];
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
}

/** Clips a closed ring to a rectangle (Sutherland–Hodgman); returns the clipped ring, closed, or empty. */
export function clipRing(ring: Point[], min: number, max: number): Point[] {
  let points = ring.slice(0, -1);
  const edges: [(p: Point) => boolean, (a: Point, b: Point) => Point][] = [
    [(p) => p[0] >= min, (a, b) => [min, a[1] + ((b[1] - a[1]) * (min - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= max, (a, b) => [max, a[1] + ((b[1] - a[1]) * (max - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= min, (a, b) => [a[0] + ((b[0] - a[0]) * (min - a[1])) / (b[1] - a[1]), min]],
    [(p) => p[1] <= max, (a, b) => [a[0] + ((b[0] - a[0]) * (max - a[1])) / (b[1] - a[1]), max]],
  ];
  for (const [inside, cross] of edges) {
    const out: Point[] = [];
    points.forEach((p, i) => {
      const previous = points[(i + points.length - 1) % points.length] as Point;
      if (inside(p)) {
        if (!inside(previous)) out.push(cross(previous, p));
        out.push(p);
      } else if (inside(previous)) out.push(cross(previous, p));
    });
    points = out;
    if (points.length === 0) return [];
  }
  return points.length >= 3 ? [...points, points[0] as Point] : [];
}

/** Rounds to integer tile units and drops repeated points. */
function quantize(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const [x, y] of points) {
    const q: Point = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  return out;
}

/** Twice the signed area in tile coordinates (y down): positive for clockwise rings, as MVT wants exteriors. */
function signedArea(ring: Point[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x0, y0] = ring[i] as Point;
    const [x1, y1] = ring[i + 1] as Point;
    sum += x0 * y1 - x1 * y0;
  }
  return sum;
}

/** The parts of a feature inside one tile, in tile units, or `undefined` when nothing of it is inside. */
export function featureInTile(feature: VectorFeature, z: number, x: number, y: number): TileFeature | undefined {
  const local: Point[] = feature.coordinates.map(([lon, lat]) => [
    (lonToTileX(lon, z) - x) * EXTENT,
    (latToTileY(lat, z) - y) * EXTENT,
  ]);
  const type = feature.type === 'point' ? 1 : feature.type === 'line' ? 2 : 3;
  let parts: Point[][];
  if (type === 1) {
    const [px, py] = (local[0] ?? [0, 0]).map(Math.round) as Point;
    parts = px >= 0 && px < EXTENT && py >= 0 && py < EXTENT ? [[[px, py]]] : [];
  } else if (type === 2) {
    parts = clipLine(local, -BUFFER, EXTENT + BUFFER)
      .map(quantize)
      .filter((p) => p.length > 1);
  } else {
    const ring = quantize(clipRing(local, -BUFFER, EXTENT + BUFFER));
    const area = signedArea(ring);
    parts = ring.length >= 4 && area !== 0 ? [area > 0 ? ring : [...ring].reverse()] : [];
  }
  return parts.length > 0 ? { id: feature.id, type, parts, properties: feature.properties } : undefined;
}

/** The range of tiles at zoom `z` a feature's buffered bounding box touches. */
export function featureTileRange(
  feature: VectorFeature,
  z: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = feature.coordinates.map(([lon]) => lonToTileX(lon, z));
  const ys = feature.coordinates.map(([, lat]) => latToTileY(lat, z));
  const pad = BUFFER / EXTENT;
  const last = 2 ** z - 1;
  const clamp = (v: number): number => Math.max(0, Math.min(last, v));
  return {
    minX: clamp(Math.floor(Math.min(...xs) - pad)),
    maxX: clamp(Math.floor(Math.max(...xs) + pad)),
    minY: clamp(Math.floor(Math.min(...ys) - pad)),
    maxY: clamp(Math.floor(Math.max(...ys) + pad)),
  };
}
