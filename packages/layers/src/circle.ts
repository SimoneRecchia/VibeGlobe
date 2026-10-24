// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { FeatureGeometry } from '@vibeglobe/core';
import { geodesicDirect } from '@vibeglobe/core/geodesy';
import type { Position } from './geojson.js';

/** Outline vertices of a circle or ellipse: fine enough that its chords stay within 0.1% of the radius. */
const SEGMENTS = 96;

/** A finite number property, or the fallback. */
function numberOf(properties: Readonly<Record<string, unknown>>, name: string, fallback: number): number {
  const value = properties[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The outline of a geodesic circle or ellipse on the WGS84 ellipsoid (F356): around `center`, each outline point at
 * the ellipse's radius in its direction, along the geodesic from the center, so the shape keeps its true ground size
 * at any latitude. Properties: `radiusMeters` (the semi-major axis, default 1,000 m), `minorRadiusMeters` (default:
 * a circle) and `rotationDeg` (the major axis's azimuth, clockwise from north, default 0).
 */
export function ellipseGeometry(center: Position, properties: Readonly<Record<string, unknown>>): FeatureGeometry {
  const a = Math.abs(numberOf(properties, 'radiusMeters', 1000));
  const b = Math.abs(numberOf(properties, 'minorRadiusMeters', a));
  const rotation = numberOf(properties, 'rotationDeg', 0);
  const positions = new Float64Array((SEGMENTS + 1) * 3);
  for (let i = 0; i <= SEGMENTS; i++) {
    // Counterclockwise seen from above: azimuths decreasing.
    const theta = (-2 * Math.PI * (i % SEGMENTS)) / SEGMENTS;
    const radius = (a * b) / Math.hypot(b * Math.cos(theta), a * Math.sin(theta));
    const point = geodesicDirect(center[0] ?? 0, center[1] ?? 0, rotation + (theta * 180) / Math.PI, radius);
    positions[i * 3] = point.longitudeDeg;
    positions[i * 3 + 1] = point.latitudeDeg;
    positions[i * 3 + 2] = center[2] ?? 0;
  }
  return { positions, partStarts: Uint32Array.of(0), polygonStarts: Uint32Array.of(0) };
}
