/**
 * `addVectorTiles` (ADR 0131): loads a MapLibre style without edits (F444), its URL or its JSON, validates it with
 * JSON paths (F451), reads its sources (TileJSON, GeoJSON data), and starts the layer's runtime.
 */
import type { Globe } from '@vibeglobe/core';
import { json, resolveSource, type SourceInfo } from './style-sources.js';
import type { VectorTileLayer, VectorTilesOptions } from './vector-tile-api.js';
import { startVectorTileLayer } from './vector-tile-layer.js';
import { VectorStyle } from './vector-style.js';

/** Logs a problem the way the engine's log does (until extensions can use it: hook request D (1)). */
function warn(text: string): void {
  (globalThis as { console?: { warn(text: string): void } }).console?.warn(`[vibeglobe] vector tiles: ${text}`);
}

/** Loads a style and draws it on the globe; resolves once the style and its sources are read. Call after `ready`. */
export async function addVectorTiles(globe: Globe, options: VectorTilesOptions): Promise<VectorTileLayer> {
  const baseFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const base =
    typeof options.style === 'string'
      ? new URL(options.style, globalThis.location?.href).href
      : globalThis.location?.href;
  const styleJson = typeof options.style === 'string' ? await json(base ?? options.style, baseFetch) : options.style;
  const transform = options.transformUrl;
  const fetchImpl: typeof fetch =
    transform === undefined ? baseFetch : (input, init) => baseFetch(transform(String(input)), init);
  const style = VectorStyle.load(styleJson);
  for (const problem of style.problems) warn(`style ${problem.path}: ${problem.message}`);
  const resolved = new Map<string, SourceInfo | undefined>();
  for (const [id, source] of Object.entries(style.sources)) {
    try {
      resolved.set(id, await resolveSource(source, base, fetchImpl, id));
    } catch (error) {
      style.problems.push({ path: `sources.${id}`, message: String(error) });
      warn(`style source ${id}: ${String(error)}`);
    }
  }
  return startVectorTileLayer(globe, { ...options, fetch: fetchImpl }, style, resolved);
}
