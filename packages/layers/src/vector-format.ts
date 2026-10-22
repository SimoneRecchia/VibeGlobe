/**
 * Vector format adapters as the data layers use them (F371). The M7 source-adapter track builds the GeoJSON, KML, GPX
 * and MVT adapters in `@vibeglobe/sources` (docs/parallel-tracks.md); until they reach `main`, this typed stub defines
 * the contract and {@link geojsonFormat} parses GeoJSON on the calling thread.
 */
import type { Feature, FeatureCollection, Geometry } from './geojson.js';

/** Raw input of an adapter: the bytes of a file or response, text, or an already parsed object. */
export type VectorInput = ArrayBuffer | Uint8Array | string | object;

/** Turns one vector format into GeoJSON features. */
export interface VectorFormatAdapter {
  /** Format name, for errors (for example 'geojson', 'kml', 'gpx', 'mvt'). */
  readonly format: string;
  /**
   * Parses the input; implementations parse in a worker.
   * @throws Error (as a rejected promise) for malformed input, naming the format and the problem.
   */
  parse(input: VectorInput): Promise<FeatureCollection>;
}

const GEOMETRY_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);

function fail(problem: string): never {
  throw new Error(`geojson: ${problem}`);
}

function checkGeometry(geometry: unknown, where: string): Geometry | null {
  if (geometry === null) return null;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (typeof g !== 'object' || typeof g.type !== 'string' || !GEOMETRY_TYPES.has(g.type)) {
    fail(`${where}: unsupported or missing geometry type`);
  }
  if (!Array.isArray(g.coordinates)) fail(`${where}: coordinates must be an array`);
  return g as Geometry;
}

function toFeature(value: unknown, where: string): Feature {
  const f = value as { type?: unknown; geometry?: unknown; properties?: unknown; id?: unknown };
  if (typeof f !== 'object' || f === null || f.type !== 'Feature') fail(`${where}: not a Feature`);
  const properties = f.properties === undefined || f.properties === null ? {} : f.properties;
  if (typeof properties !== 'object') fail(`${where}: properties must be an object`);
  const id = typeof f.id === 'string' || typeof f.id === 'number' ? f.id : undefined;
  const feature = {
    type: 'Feature' as const,
    geometry: checkGeometry(f.geometry, where),
    properties: properties as Record<string, unknown>,
  };
  return id === undefined ? feature : { ...feature, id };
}

function toCollection(value: unknown): FeatureCollection {
  const v = value as { type?: unknown; features?: unknown };
  if (typeof v !== 'object' || v === null) fail('not a GeoJSON object');
  if (v.type === 'FeatureCollection') {
    if (!Array.isArray(v.features)) fail('features must be an array');
    return { type: 'FeatureCollection', features: v.features.map((f, i) => toFeature(f, `feature ${i}`)) };
  }
  if (v.type === 'Feature') return { type: 'FeatureCollection', features: [toFeature(v, 'feature')] };
  if (typeof v.type === 'string' && GEOMETRY_TYPES.has(v.type)) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: checkGeometry(v, 'geometry'), properties: {} }],
    };
  }
  return fail(`unknown type ${String(v.type)}`);
}

/** The GeoJSON adapter stub (RFC 7946 structure checks; coordinates are validated when features are added). */
export const geojsonFormat: VectorFormatAdapter = {
  format: 'geojson',
  parse(input) {
    try {
      let value: unknown = input;
      if (input instanceof ArrayBuffer || input instanceof Uint8Array) value = new TextDecoder().decode(input);
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch (cause) {
          fail(`invalid JSON (${String(cause)})`);
        }
      }
      return Promise.resolve(toCollection(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
};

/** Where vector data comes from: a URL, a File or Blob, or an in-memory object or text. */
export type VectorSource = URL | { readonly url: string } | Blob | VectorInput;

/**
 * Reads vector data from a URL, a File or Blob, or memory, and parses it with an adapter.
 * @param fetchFn the fetch implementation (the engine's transport rules apply to URLs).
 */
export async function loadVectorData(
  source: VectorSource,
  adapter: VectorFormatAdapter,
  fetchFn: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<FeatureCollection> {
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
