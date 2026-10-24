// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Geodesic measurement on the WGS84 ellipsoid, built on core's geodesics (Karney), and the readout text of lengths and
 * areas with automatic unit scaling.
 */
import { geodesicInverse, geodesicPathLengthMeters, geodesicPolygonArea } from '@vibeglobe/core/geodesy';
import type { LonLat } from './format.js';

/** Distance and bearings between two points. */
export interface GeodesicMeasurement {
  /** Length of the shortest geodesic, in meters. */
  readonly distanceMeters: number;
  /** Bearing at the start, clockwise from north, in [0, 360) degrees. */
  readonly initialBearingDeg: number;
  /** Bearing of travel at the end, clockwise from north, in [0, 360) degrees. */
  readonly finalBearingDeg: number;
}

function bearing(azimuthDeg: number): number {
  const wrapped = ((azimuthDeg % 360) + 360) % 360;
  return wrapped === 360 ? 0 : wrapped;
}

/**
 * Distance and bearings along the shortest geodesic from `from` to `to`.
 *
 * @param from - Start, WGS84 degrees.
 * @param to - End, WGS84 degrees.
 */
export function measureDistance(from: LonLat, to: LonLat): GeodesicMeasurement {
  const result = geodesicInverse(from.longitudeDeg, from.latitudeDeg, to.longitudeDeg, to.latitudeDeg);
  return {
    distanceMeters: result.distanceMeters,
    initialBearingDeg: bearing(result.initialAzimuthDeg),
    finalBearingDeg: bearing(result.finalAzimuthDeg),
  };
}

/** Length of a path of geodesic segments through `points`, in meters (0 for fewer than two points). */
export function measurePathLength(points: readonly LonLat[]): number {
  return geodesicPathLengthMeters(points);
}

/**
 * Unsigned area of the geodesic polygon through `points` (do not repeat the first point), in square meters, and its
 * perimeter in meters; 0 for fewer than three points.
 */
export function measureArea(points: readonly LonLat[]): { areaSquareMeters: number; perimeterMeters: number } {
  if (points.length < 3) return { areaSquareMeters: 0, perimeterMeters: measurePathLength(points) * 2 };
  const { areaSquareMeters, perimeterMeters } = geodesicPolygonArea(points);
  return { areaSquareMeters: Math.abs(areaSquareMeters), perimeterMeters };
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: value >= 1000 ? 6 : 3 }).format(value);
}

/**
 * A length for display, scaled to meters below 1 km and kilometers above, with three significant digits (six from
 * 1,000 up), in the number format of `locale`: `850 m`, `1.23 km`, `1,23 km` in Italian.
 *
 * @param meters - Length in meters.
 * @param locale - BCP 47 locale of the number format (default 'en').
 */
export function formatLength(meters: number, locale = 'en'): string {
  return Math.abs(meters) < 999.5 ? `${formatNumber(meters, locale)} m` : `${formatNumber(meters / 1000, locale)} km`;
}

/**
 * An area for display, scaled to square meters below 1 km² and square kilometers above, as {@link formatLength}.
 *
 * @param squareMeters - Area in square meters.
 * @param locale - BCP 47 locale of the number format (default 'en').
 */
export function formatArea(squareMeters: number, locale = 'en'): string {
  return Math.abs(squareMeters) < 999_500
    ? `${formatNumber(squareMeters, locale)} m²`
    : `${formatNumber(squareMeters / 1e6, locale)} km²`;
}
