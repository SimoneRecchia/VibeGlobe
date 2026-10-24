/**
 * The sources of a style (ADR 0131): TileJSON read when a source names one, GeoJSON data read (F444), tile URL templates resolved against the
 * style's URL, coverage (zoom range and bounds) for the tile pyramid.
 */
import type { TileTransport } from '@vibeglobe/core';
import { GEOJSON_SCHEME } from './geojson-tiles.js';
import type { SourceCoverage, TileId } from './tile-pyramid.js';
import type { StyleSourceJson } from './vector-style.js';

/** A vector or GeoJSON source, resolved. */
export interface SourceInfo {
  readonly templates: readonly string[];
  readonly scheme: 'xyz' | 'tms';
  readonly coverage: SourceCoverage;
  /** A GeoJSON source's data, cut into tiles locally (`geojson://` URLs, F444). */
  readonly geojson?: unknown;
}

/** Fetches and parses a JSON document; throws on HTTP errors. */
export async function json(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** A source with its TileJSON or GeoJSON data read; undefined for sources other than vector and GeoJSON ones. */
export async function resolveSource(
  source: StyleSourceJson,
  base: string | undefined,
  fetchImpl: typeof fetch,
  id = '',
): Promise<SourceInfo | undefined> {
  if (source.type === 'geojson') {
    const data = (source as { data?: unknown }).data;
    return {
      templates: [`${GEOJSON_SCHEME}${encodeURIComponent(id)}/{z}/{x}/{y}`],
      scheme: 'xyz',
      coverage: { minzoom: 0, maxzoom: source.maxzoom ?? 18 },
      geojson: typeof data === 'string' ? await json(new URL(data, base).href, fetchImpl) : data,
    };
  }
  let doc: StyleSourceJson = source;
  if (source.tiles === undefined && typeof source.url === 'string') {
    const url = new URL(source.url, base).href;
    doc = { ...((await json(url, fetchImpl)) as StyleSourceJson), ...source };
    doc = { ...doc, tiles: (doc.tiles ?? []).map((t) => new URL(t, url).href) };
  }
  if (source.type !== 'vector' || doc.tiles === undefined || doc.tiles.length === 0) return undefined;
  const bounds =
    Array.isArray(doc.bounds) && doc.bounds.length === 4 ? (doc.bounds as [number, number, number, number]) : undefined;
  return {
    templates: doc.tiles.map((t) =>
      (base === undefined ? t : new URL(t, base).href).replace(/%7B/g, '{').replace(/%7D/g, '}'),
    ),
    coverage: { minzoom: doc.minzoom ?? 0, maxzoom: doc.maxzoom ?? 22, ...(bounds ? { bounds } : {}) },
    scheme: doc.scheme ?? 'xyz',
  };
}

/** The URL of a tile from a source's templates (spread over them by position). */
export function tileUrl(source: SourceInfo, tile: TileId): string {
  const template = source.templates[(tile.x + tile.y) % source.templates.length] ?? '';
  const y = source.scheme === 'tms' ? 2 ** tile.z - 1 - tile.y : tile.y;
  return template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(y));
}

/** A transport that requests `transform(url)` instead of each URL; the transport itself without a transform. */
export function transformedTransport(
  transport: TileTransport,
  transform: ((url: string) => string) | undefined,
): TileTransport {
  if (transform === undefined) return transport;
  return {
    start: (request, timeouts, done) => transport.start({ ...request, url: transform(request.url) }, timeouts, done),
  };
}
