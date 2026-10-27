// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { FeatureIssue, Geometry, ParsedFeatures, Position, VectorFeature } from './features.js';

/** Deepest nesting of geometry collections accepted. */
const MAX_DEPTH = 16;

class InvalidGeometry extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function position(value: unknown): Position {
  if (!Array.isArray(value) || value.length < 2) throw new InvalidGeometry('a position needs longitude and latitude');
  const [lon, lat, height] = value as unknown[];
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat))
    throw new InvalidGeometry('a coordinate is not a finite number');
  // Longitudes beyond ±180 occur in antimeridian-crossing data and are kept; latitudes are bounded.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 540) throw new InvalidGeometry(`position ${lon}, ${lat} is out of range`);
  if (typeof height === 'number' && Number.isFinite(height)) return [lon, lat, height];
  return [lon, lat];
}

function positions(value: unknown, minimum: number): Position[] {
  if (!Array.isArray(value)) throw new InvalidGeometry('coordinates are not an array');
  if (value.length < minimum) throw new InvalidGeometry(`needs at least ${minimum} positions`);
  return value.map(position);
}

function ring(value: unknown): Position[] {
  const out = positions(value, 4);
  const first = out[0];
  const last = out[out.length - 1];
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1])
    throw new InvalidGeometry('a polygon ring is not closed');
  return out;
}

function list<T>(value: unknown, item: (v: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new InvalidGeometry('coordinates are not an array');
  return value.map(item);
}

/** Validates and copies one geometry; throws {@link InvalidGeometry} with the reason. */
function geometry(value: unknown, depth = 0): Geometry {
  const g = record(value);
  if (!g) throw new InvalidGeometry('the geometry is not an object');
  const c = g['coordinates'];
  switch (g['type']) {
    case 'Point':
      return { type: 'Point', coordinates: position(c) };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: positions(c, 0) };
    case 'LineString':
      return { type: 'LineString', coordinates: positions(c, 2) };
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: list(c, (l) => positions(l, 2)) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: list(c, ring) };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: list(c, (p) => list(p, ring)) };
    case 'GeometryCollection':
      if (depth >= MAX_DEPTH) throw new InvalidGeometry('geometry collections are nested too deeply');
      return { type: 'GeometryCollection', geometries: list(g['geometries'], (child) => geometry(child, depth + 1)) };
    default:
      throw new InvalidGeometry(`unknown geometry type '${String(g['type'])}'`);
  }
}

function feature(value: unknown): VectorFeature {
  const f = record(value);
  if (!f || f['type'] !== 'Feature') throw new InvalidGeometry('not a Feature object');
  const id = f['id'];
  const properties = record(f['properties']) ?? {};
  const g = f['geometry'] === null || f['geometry'] === undefined ? null : geometry(f['geometry']);
  return {
    ...(typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? { id } : {}),
    geometry: g,
    properties,
  };
}

/**
 * Parses a GeoJSON document (RFC 7946; F236): a FeatureCollection, a Feature or a bare geometry, with every geometry
 * type, feature ids and properties, coordinates as WGS84 longitude and latitude. Invalid features (wrong nesting,
 * non-numeric coordinates, unclosed rings) are reported in `issues` and the valid ones are kept. It never throws, so
 * it runs as a worker task.
 */
export function parseGeoJson(input: string | Uint8Array | ArrayBuffer): ParsedFeatures {
  let document: unknown;
  try {
    document = JSON.parse(typeof input === 'string' ? input : new TextDecoder().decode(input));
  } catch (error) {
    return {
      features: [],
      issues: [{ index: -1, message: `not JSON: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  const root = record(document);
  const items: unknown[] =
    root?.['type'] === 'FeatureCollection'
      ? Array.isArray(root['features'])
        ? root['features']
        : []
      : root?.['type'] === 'Feature'
        ? [root]
        : [{ type: 'Feature', properties: {}, geometry: document }];
  if (root?.['type'] === 'FeatureCollection' && !Array.isArray(root['features']))
    return { features: [], issues: [{ index: -1, message: 'the FeatureCollection has no features array' }] };
  const features: VectorFeature[] = [];
  const issues: FeatureIssue[] = [];
  items.forEach((item, index) => {
    try {
      features.push(feature(item));
    } catch (error) {
      issues.push({ index, message: error instanceof InvalidGeometry ? error.message : String(error) });
    }
  });
  return { features, issues };
}
