// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Minimal GeoJSON types (RFC 7946) and conversion of geometries to the anchor position and flat vertex arrays the
 * batches hold.
 */
import type { FeatureGeometry } from './render-target.js';

/** A GeoJSON position: longitude, latitude, optional height in meters. */
export type Position = readonly number[];

/** GeoJSON geometries. */
export type Geometry =
  | { readonly type: 'Point'; readonly coordinates: Position }
  | { readonly type: 'MultiPoint'; readonly coordinates: readonly Position[] }
  | { readonly type: 'LineString'; readonly coordinates: readonly Position[] }
  | { readonly type: 'MultiLineString'; readonly coordinates: readonly (readonly Position[])[] }
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Position[])[] }
  | { readonly type: 'MultiPolygon'; readonly coordinates: readonly (readonly (readonly Position[])[])[] };

/** A GeoJSON feature. */
export interface Feature {
  readonly type: 'Feature';
  readonly id?: string | number;
  readonly geometry: Geometry | null;
  readonly properties?: Readonly<Record<string, unknown>> | null;
}

/** A GeoJSON feature collection. */
export interface FeatureCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly Feature[];
}

/** The family of primitive a geometry draws as. */
export type GeometryFamily = 'point' | 'line' | 'polygon';

/** The family of a geometry type. */
export function geometryFamily(geometry: Geometry): GeometryFamily {
  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint':
      return 'point';
    case 'LineString':
    case 'MultiLineString':
      return 'line';
    default:
      return 'polygon';
  }
}

function checkPosition(position: Position): void {
  const [lon, lat] = position;
  if (
    position.length < 2 ||
    typeof lon !== 'number' ||
    typeof lat !== 'number' ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90
  ) {
    throw new TypeError(`invalid position [${position.join(', ')}]`);
  }
}

/** Writes a position into `out` at `offset` as longitude, latitude and height (0 when absent). */
export function writePosition(position: Position, out: Float64Array, offset = 0): void {
  checkPosition(position);
  out[offset] = position[0] as number;
  out[offset + 1] = position[1] as number;
  out[offset + 2] = position[2] ?? 0;
}

function flatten(parts: readonly (readonly Position[])[], polygonStarts?: number[]): FeatureGeometry {
  const vertexCount = parts.reduce((sum, part) => sum + part.length, 0);
  const positions = new Float64Array(vertexCount * 3);
  const partStarts = new Uint32Array(parts.length);
  let vertex = 0;
  parts.forEach((part, i) => {
    partStarts[i] = vertex;
    for (const position of part) writePosition(position, positions, 3 * vertex++);
  });
  return polygonStarts === undefined
    ? { positions, partStarts }
    : { positions, partStarts, polygonStarts: Uint32Array.from(polygonStarts) };
}

/** Line or polygon geometry as flat arrays; undefined for points. */
export function toFeatureGeometry(geometry: Geometry): FeatureGeometry | undefined {
  switch (geometry.type) {
    case 'LineString':
      return flatten([geometry.coordinates]);
    case 'MultiLineString':
      return flatten(geometry.coordinates);
    case 'Polygon':
      return flatten(geometry.coordinates, [0]);
    case 'MultiPolygon': {
      const starts: number[] = [];
      let ring = 0;
      for (const polygon of geometry.coordinates) {
        starts.push(ring);
        ring += polygon.length;
      }
      return flatten(geometry.coordinates.flat(), starts);
    }
    default:
      return undefined;
  }
}

/**
 * The anchor of a geometry: the point itself, or the first vertex of a line or outer ring (where a label or pick event
 * refers to the feature as a whole).
 */
export function anchorOf(geometry: Geometry): Position {
  switch (geometry.type) {
    case 'Point':
      return geometry.coordinates;
    case 'MultiPoint':
    case 'LineString':
      return geometry.coordinates[0] ?? [0, 0];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates[0]?.[0] ?? [0, 0];
    case 'MultiPolygon':
      return geometry.coordinates[0]?.[0]?.[0] ?? [0, 0];
  }
}
