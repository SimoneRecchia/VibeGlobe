/**
 * The sources of a style (ADR 0131): TileJSON read when a source names one, tile URL templates resolved against the
 * style's URL, coverage (zoom range and bounds) for the tile pyramid.
 */
import type { SourceCoverage, TileId } from './tile-pyramid.js';
import type { StyleSourceJson } from './vector-style.js';

/** A vector source, resolved. */
export interface SourceInfo {
  readonly templates: readonly string[];
  readonly scheme: 'xyz' | 'tms';
  readonly coverage: SourceCoverage;
}

/** Fetches and parses a JSON document; throws on HTTP errors. */
export async function json(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** A source with its TileJSON read; undefined for sources other than vector ones. */
export async function resolveSource(
  source: StyleSourceJson,
  base: string | undefined,
  fetchImpl: typeof fetch,
): Promise<SourceInfo | undefined> {
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
