/**
 * Vector format adapters as the data layers use them (F371): GeoJSON, KML and KMZ, and GPX through the M7 parsers of
 * `@vibeglobe/sources/vector` (ADR 0030). The parsers never throw: they keep the valid features and report the others
 * as issues. They run on the calling thread until the worker program registers `VECTOR_TASKS` (docs/parallel-tracks.md,
 * hook request of the source adapters track); Mapbox Vector Tiles are tiled data for the vector-tile layer (M13).
 */
import {
  parseGeoJson,
  parseGpx,
  parseKml,
  type FeatureIssue,
  type Geometry as SourceGeometry,
  type VectorFeature,
} from '@vibeglobe/sources/vector';
import type { Feature, Geometry } from './geojson.js';

/** Raw input of an adapter: the bytes of a file or response, text, or (GeoJSON only) an already parsed object. */
export type VectorInput = ArrayBuffer | Uint8Array | string | object;

/** What an adapter returns: the features it could read and one issue per feature (or document) it could not. */
export interface ParsedVectorData {
  readonly features: readonly Feature[];
  readonly issues: readonly FeatureIssue[];
}

/** Turns one vector format into features. */
export interface VectorFormatAdapter {
  /** Format name, for errors ('geojson', 'kml', 'gpx'). */
  readonly format: string;
  /** Parses untrusted input; never rejects for malformed data, which comes back as issues. */
  parse(input: VectorInput): Promise<ParsedVectorData>;
}

/**
 * Splits geometry collections into one feature per member, so each member draws with its own primitive family, and
 * multi-points into one point feature each, since a point batch draws one anchor per feature.
 */
function toFeatures(features: readonly VectorFeature[]): Feature[] {
  const out: Feature[] = [];
  const add = (feature: VectorFeature, geometry: SourceGeometry | null, suffix: string): void => {
    if (geometry?.type === 'GeometryCollection') {
      geometry.geometries.forEach((member, i) => add(feature, member, `${suffix}/${i}`));
      return;
    }
    if (geometry?.type === 'MultiPoint') {
      geometry.coordinates.forEach((coordinates, i) =>
        add(feature, { type: 'Point', coordinates } as SourceGeometry, `${suffix}/${i}`),
      );
      return;
    }
    const id = feature.id === undefined ? undefined : suffix === '' ? feature.id : `${String(feature.id)}${suffix}`;
    const base = { type: 'Feature' as const, geometry: geometry as Geometry | null, properties: feature.properties };
    out.push(id === undefined ? base : { ...base, id });
  };
  for (const feature of features) add(feature, feature.geometry, '');
  return out;
}

type Parser = (input: string | Uint8Array | ArrayBuffer) => {
  features: readonly VectorFeature[];
  issues: readonly FeatureIssue[];
};

function adapter(format: string, parser: Parser, acceptsObjects: boolean): VectorFormatAdapter {
  return {
    format,
    parse(input) {
      let source: string | Uint8Array | ArrayBuffer;
      if (typeof input === 'string' || input instanceof ArrayBuffer || input instanceof Uint8Array) source = input;
      else if (acceptsObjects) source = JSON.stringify(input);
      else
        return Promise.resolve({ features: [], issues: [{ index: -1, message: `${format}: expected text or bytes` }] });
      const parsed = parser(source);
      return Promise.resolve({ features: toFeatures(parsed.features), issues: parsed.issues });
    },
  };
}

/** GeoJSON (RFC 7946), from text, bytes or a parsed object. */
export const geojsonFormat: VectorFormatAdapter = adapter('geojson', parseGeoJson, true);
/** KML and KMZ placemarks (ground overlays and archive resources are not data-layer features). */
export const kmlFormat: VectorFormatAdapter = adapter('kml', parseKml, false);
/** GPX waypoints, routes and tracks. */
export const gpxFormat: VectorFormatAdapter = adapter('gpx', parseGpx, false);

/** Where vector data comes from: a URL, a File or Blob, or an in-memory object or text. */
export type VectorSource = URL | { readonly url: string } | Blob | VectorInput;

/**
 * Reads vector data from a URL, a File or Blob, or memory, and parses it with an adapter.
 * @param fetchFn the fetch implementation (the engine's transport rules apply to URLs).
 * @throws Error (a rejected promise) when a URL answers with an error status.
 */
export async function loadVectorData(
  source: VectorSource,
  adapter: VectorFormatAdapter,
  fetchFn: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<ParsedVectorData> {
  let input: VectorInput;
  if (
    source instanceof URL ||
    (typeof source === 'object' && 'url' in source && typeof source.url === 'string' && !(source instanceof Blob))
  ) {
    const url = source instanceof URL ? source.href : (source as { url: string }).url;
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`${adapter.format}: ${url} answered ${response.status}`);
    input = await response.arrayBuffer();
  } else if (typeof Blob !== 'undefined' && source instanceof Blob) {
    input = await source.arrayBuffer();
  } else {
    input = source as VectorInput;
  }
  return adapter.parse(input);
}
