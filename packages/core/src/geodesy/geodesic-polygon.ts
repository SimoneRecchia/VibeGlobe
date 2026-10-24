// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Lengths of geodesic polylines and areas of geodesic polygons on the WGS84 ellipsoid, after C. F. F. Karney,
 * "Algorithms for geodesics", J. Geodesy 87 (2013): a polygon's area is the sum of the areas S12 between
 * each edge and the equator, corrected by half the ellipsoid's area when the polygon encircles a pole.
 */
import { longitudeDifferenceDeg } from './geodesic-angles.js';
import { OUT_AREA, OUT_DISTANCE, solveInverse } from './geodesic-inverse.js';
import { GEOD_C2_SQUARE_METERS } from './geodesic-series.js';

/** A point on the ellipsoid, in degrees. */
export interface GeodesicPoint {
  /** Longitude, in degrees. */
  readonly longitudeDeg: number;
  /** Latitude, in degrees. */
  readonly latitudeDeg: number;
}

/** Area and perimeter of a geodesic polygon. */
export interface GeodesicPolygonArea {
  /**
   * Signed area in square meters: positive when the vertices run counter-clockwise (the enclosed region lies to the
   * left of each edge), negative when clockwise; in (-A/2, A/2] for the ellipsoid's total area A.
   */
  areaSquareMeters: number;
  /** Length of the closed boundary, closing edge included, in meters. */
  perimeterMeters: number;
}

/** Total area of the WGS84 ellipsoid, 4πc², in square meters. */
export const ELLIPSOID_AREA_SQUARE_METERS = 4 * Math.PI * GEOD_C2_SQUARE_METERS;

/**
 * Length of the polyline joining the points by shortest geodesics, in meters (0 for fewer than two points).
 *
 * @param points - Vertices in order, in degrees.
 */
export function geodesicPathLengthMeters(points: readonly GeodesicPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    if (from === undefined || to === undefined) continue;
    length +=
      solveInverse(from.longitudeDeg, from.latitudeDeg, to.longitudeDeg, to.latitudeDeg, false)[OUT_DISTANCE] ?? NaN;
  }
  return length;
}

/** Reduces an area to (-A/2, A/2] for the ellipsoid's total area A. */
function reduceArea(areaSquareMeters: number): number {
  const reduced = areaSquareMeters % ELLIPSOID_AREA_SQUARE_METERS;
  if (reduced > ELLIPSOID_AREA_SQUARE_METERS / 2) return reduced - ELLIPSOID_AREA_SQUARE_METERS;
  return reduced <= -ELLIPSOID_AREA_SQUARE_METERS / 2 ? reduced + ELLIPSOID_AREA_SQUARE_METERS : reduced;
}

/**
 * Area and perimeter of the polygon whose edges are the shortest geodesics between consecutive points, the last point
 * joined back to the first (do not repeat the first point). Correct for polygons that cross the antimeridian or
 * encircle a pole; the area's sign follows the orientation (counter-clockwise positive). Edges should be shorter than
 * half the Earth's circumference, as between any reasonably sampled vertices.
 *
 * @param points - Vertices in order, in degrees.
 */
export function geodesicPolygonArea(points: readonly GeodesicPoint[]): GeodesicPolygonArea {
  let perimeter = 0;
  // Σ S12 with Neumaier's compensated summation: edge areas reach 1e14 m² while the result is wanted to the m².
  let areaSum = 0;
  let areaCompensation = 0;
  let longitudeTurnDeg = 0;
  for (let i = 0; i < points.length; i++) {
    const from = points[i];
    const to = points[(i + 1) % points.length];
    if (from === undefined || to === undefined) continue;
    const edge = solveInverse(from.longitudeDeg, from.latitudeDeg, to.longitudeDeg, to.latitudeDeg, true);
    perimeter += edge[OUT_DISTANCE] ?? NaN;
    const edgeArea = edge[OUT_AREA] ?? NaN;
    const sum = areaSum + edgeArea;
    areaCompensation += Math.abs(areaSum) >= Math.abs(edgeArea) ? areaSum - sum + edgeArea : edgeArea - sum + areaSum;
    areaSum = sum;
    longitudeTurnDeg += longitudeDifferenceDeg(from.longitudeDeg, to.longitudeDeg);
  }
  // Σ S12 measures each edge against the equator: it equals minus the enclosed area, unless the boundary winds once
  // around the pole axis (an odd number of turns), when the hemisphere between the equator and the pole is added.
  const turns = Math.round(longitudeTurnDeg / 360);
  const poleTerm = turns % 2 === 0 ? 0 : (Math.sign(turns) * ELLIPSOID_AREA_SQUARE_METERS) / 2;
  return {
    areaSquareMeters: reduceArea(poleTerm - (areaSum + areaCompensation)),
    perimeterMeters: perimeter,
  };
}
