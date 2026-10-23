import type { FeatureGeometry } from '@vibeglobe/core';

/** The longest edge, degrees, drawn as one straight piece: shorter ones stay within a few meters of the surface. */
export const MAX_STEP_DEG = 1;
/** On the terrain: pieces of about a kilometer, at most this many across a feature. */
export const DRAPE_STEP_DEG = 0.01;
/** On the terrain, the most pieces across a feature's extent (so large drapes stay affordable). */
export const MAX_DRAPE_PIECES = 100;

/** A position: longitude and latitude in degrees, height in meters. */
export type Vertex = [number, number, number];
/** Three positions. */
export type Triangle = [Vertex, Vertex, Vertex];

/** Points from `a` to `b` (degrees, meters) along the great circle, at most {@link MAX_STEP_DEG} apart. */
export function greatCirclePoints(a: Vertex, b: Vertex, stepDeg: number): Vertex[] {
  const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / stepDeg);
  if (steps <= 1) return [a, b];
  const rad = Math.PI / 180;
  const unit = (v: Vertex): number[] => [
    Math.cos(v[1] * rad) * Math.cos(v[0] * rad),
    Math.cos(v[1] * rad) * Math.sin(v[0] * rad),
    Math.sin(v[1] * rad),
  ];
  const p = unit(a);
  const q = unit(b);
  const angle = Math.acos(
    Math.min(1, Math.max(-1, (p[0] ?? 0) * (q[0] ?? 0) + (p[1] ?? 0) * (q[1] ?? 0) + (p[2] ?? 0) * (q[2] ?? 0))),
  );
  const points: Vertex[] = [a];
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const wa = angle > 1e-12 ? Math.sin((1 - f) * angle) / Math.sin(angle) : 1 - f;
    const wb = angle > 1e-12 ? Math.sin(f * angle) / Math.sin(angle) : f;
    const x = wa * (p[0] ?? 0) + wb * (q[0] ?? 0);
    const y = wa * (p[1] ?? 0) + wb * (q[1] ?? 0);
    const z = wa * (p[2] ?? 0) + wb * (q[2] ?? 0);
    points.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad, a[2] + f * (b[2] - a[2])]);
  }
  points.push(b);
  return points;
}

/** A triangle split in four at its edge midpoints (degrees) until no edge exceeds {@link MAX_STEP_DEG}. */
export function subdivide(triangle: Triangle, stepDeg: number): Triangle[] {
  const [a, b, c] = triangle;
  const span = (u: Vertex, v: Vertex): number => Math.max(Math.abs(u[0] - v[0]), Math.abs(u[1] - v[1]));
  if (Math.max(span(a, b), span(b, c), span(c, a)) <= stepDeg) return [triangle];
  const mid = (u: Vertex, v: Vertex): Vertex => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2];
  const ab = mid(a, b);
  const bc = mid(b, c);
  const ca = mid(c, a);
  return [
    ...subdivide([a, ab, ca], stepDeg),
    ...subdivide([ab, b, bc], stepDeg),
    ...subdivide([ca, bc, c], stepDeg),
    ...subdivide([ab, bc, ca], stepDeg),
  ];
}

/** The larger side of a feature's longitude and latitude bounding box, degrees. */
export function extentOf(geometry: FeatureGeometry): number {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let i = 0; i * 3 < geometry.positions.length; i++) {
    const lon = geometry.positions[i * 3] ?? 0;
    const lat = geometry.positions[i * 3 + 1] ?? 0;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return Math.max(east - west, north - south, 0);
}

/** Vertex `i` of a feature's geometry. */
export function vertexOf(geometry: FeatureGeometry, i: number): [number, number, number] {
  return [geometry.positions[i * 3] ?? 0, geometry.positions[i * 3 + 1] ?? 0, geometry.positions[i * 3 + 2] ?? 0];
}

/** Calls `visit` with the vertex range of every part (line or ring) of a feature's geometry. */
export function forEachPart(geometry: FeatureGeometry, visit: (start: number, end: number) => void): void {
  for (let part = 0; part < geometry.partStarts.length; part++)
    visit(geometry.partStarts[part] ?? 0, geometry.partStarts[part + 1] ?? geometry.positions.length / 3);
}
