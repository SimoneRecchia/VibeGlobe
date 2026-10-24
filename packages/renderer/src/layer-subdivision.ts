// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
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

const RAD = Math.PI / 180;

/**
 * The great-circle arc between two positions, degrees: edges are measured on the ground, since near the poles a
 * degree of longitude is short (KB-103).
 */
function arcDeg(u: Vertex, v: Vertex): number {
  const sinLat = Math.sin(((v[1] - u[1]) * RAD) / 2);
  const sinLon = Math.sin(((v[0] - u[0]) * RAD) / 2);
  const h = sinLat * sinLat + Math.cos(u[1] * RAD) * Math.cos(v[1] * RAD) * sinLon * sinLon;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / RAD;
}

/** Points from `a` to `b` (degrees, meters) along the great circle, at most `stepDeg` of arc apart. */
export function greatCirclePoints(a: Vertex, b: Vertex, stepDeg: number): Vertex[] {
  const steps = Math.ceil(arcDeg(a, b) / stepDeg);
  if (steps <= 1) return [a, b];
  const unit = (v: Vertex): number[] => [
    Math.cos(v[1] * RAD) * Math.cos(v[0] * RAD),
    Math.cos(v[1] * RAD) * Math.sin(v[0] * RAD),
    Math.sin(v[1] * RAD),
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
    points.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD, a[2] + f * (b[2] - a[2])]);
  }
  points.push(b);
  return points;
}

/**
 * A triangle split at the midpoint of its longest edge until no edge exceeds `stepDeg` of arc: the long, thin
 * triangles of a triangulated ring become about as many pieces as their area and length need, not the square of
 * their length (KB-103).
 */
export function subdivide(triangle: Triangle, stepDeg: number): Triangle[] {
  const out: Triangle[] = [];
  const pending: Triangle[] = [triangle];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [a, b, c] = next;
    const ab = arcDeg(a, b);
    const bc = arcDeg(b, c);
    const ca = arcDeg(c, a);
    const longest = Math.max(ab, bc, ca);
    if (longest <= stepDeg) {
      out.push(next);
      continue;
    }
    // Rotated so that u–v is the longest edge, keeping the winding.
    const [u, v, w] = longest === ab ? [a, b, c] : longest === bc ? [b, c, a] : [c, a, b];
    const m: Vertex = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2];
    pending.push([u, m, w], [m, v, w]);
  }
  return out;
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
