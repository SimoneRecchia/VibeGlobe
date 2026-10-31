// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Data-layer geometry at the antimeridian and the poles (F368). Rings are unwrapped (each longitude within 180° of the
 * previous) before triangulation, so a polygon across the antimeridian is one shape on the flat map's continuous
 * longitudes, and a ring around a pole is closed through the pole.
 */
import type { FeatureGeometry, LayerOrigin } from '@vibeglobe/core';
import { vertexOf, type Vertex } from './layer-subdivision.js';

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
