// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The engine's vector feature structures, which the GeoJSON, KML and GPX adapters produce (in workers) and data
 * layers consume: GeoJSON-shaped geometries in WGS84 degrees, heights in meters.
 */

/** Longitude and latitude in degrees, with an optional height in meters. */
export type Position = readonly [number, number] | readonly [number, number, number];

/** A geometry: the seven GeoJSON types. */
export type Geometry =
  | { readonly type: 'Point'; readonly coordinates: Position }
  | { readonly type: 'MultiPoint'; readonly coordinates: readonly Position[] }
  | { readonly type: 'LineString'; readonly coordinates: readonly Position[] }
  | { readonly type: 'MultiLineString'; readonly coordinates: readonly (readonly Position[])[] }
  /** The first ring is the outer boundary, the others are holes; every ring is closed. */
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Position[])[] }
  | { readonly type: 'MultiPolygon'; readonly coordinates: readonly (readonly (readonly Position[])[])[] }
  | { readonly type: 'GeometryCollection'; readonly geometries: readonly Geometry[] };

/** A feature: an optional id, a geometry (null for features without one) and properties. */
export interface VectorFeature {
  readonly id?: string | number;
  readonly geometry: Geometry | null;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** A problem with one feature (by its index in the document), or with the whole document (index -1). */
export interface FeatureIssue {
  readonly index: number;
  readonly message: string;
}

/** What a vector parser returns: the valid features, and the problems with the others. It never throws. */
export interface ParsedFeatures {
  readonly features: readonly VectorFeature[];
  readonly issues: readonly FeatureIssue[];
}
