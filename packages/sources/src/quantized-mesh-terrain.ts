// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { readLayerJson, readRanges, TerrainAvailability } from '@vibeglobe/core/decoders';
import {
  GEOGRAPHIC_TILING,
  WEB_MERCATOR_TILING,
  WGS84,
  type TerrainSource,
  type TileCoord,
  type TileRequest,
  type TimeoutsMs,
  type VerticalDatum,
} from '@vibeglobe/core';
import { fetchTransport } from './fetch-transport.js';
import {
  type Attribution,
  CUSTOM_PROFILE,
  type DescribedSource,
  type ProviderProfile,
  SourceConfigError,
} from './metadata.js';

/** Options of {@link quantizedMeshTerrain}. */
export interface QuantizedMeshTerrainOptions {
  /** Unique per engine instance. */
  id: string;
  /** The URL of the source's `layer.json`; tile URL templates in it are relative to it. */
  url: string;
  /** What the heights are measured from; the WGS84 ellipsoid by default (F133). */
  datum?: VerticalDatum;
  /** `fetch` for `layer.json` and the tiles; the global one by default (injectable for tests). */
  fetchImpl?: typeof fetch;
  maxRequestsPerHost?: number;
  multiplexed?: boolean;
  timeoutsMs?: TimeoutsMs;
  /** Credits shown while the terrain is in view (F254); none by default. */
  attribution?: readonly Attribution[];
  /** The provider's rules; everything enabled by default. */
  profile?: ProviderProfile;
}

/** The extensions the engine decodes, by their `layer.json` and `Accept` names. */
const KNOWN_EXTENSIONS = ['octvertexnormals', 'watermask', 'metadata'] as const;
/** Height samples along a level-0 tile edge that the usual quantized-mesh geometric error assumes. */
const LEVEL_ZERO_SAMPLES = 65;

/** The `Accept` header of tile requests: the extensions `layer.json` declares and the engine decodes, only those. */
function acceptHeader(declared: readonly string[]): string {
  const extensions = KNOWN_EXTENSIONS.filter((name) => declared.includes(name));
  const type =
    extensions.length > 0
      ? `application/vnd.quantized-mesh;extensions=${extensions.join('-')}`
      : 'application/vnd.quantized-mesh';
  return `${type},application/octet-stream;q=0.9`;
}

/** The source's `layer.json`, or a {@link SourceConfigError} saying whether it could not be loaded or read (KB-327). */
async function loadLayerJson(id: string, url: string, fetchImpl: typeof fetch) {
  let text: string;
  try {
    const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    throw new SourceConfigError(
      'unreachable-layer',
      `quantized-mesh source '${id}': cannot load layer.json (${String(error)})`,
    );
  }
  try {
    return readLayerJson(JSON.parse(text));
  } catch (error) {
    throw new SourceConfigError(
      'invalid-layer',
      `quantized-mesh source '${id}': invalid layer.json (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * A quantized-mesh-1.0 terrain source (F127, F128): reads its `layer.json` (tiling scheme, zoom range, URL templates,
 * extensions, availability), never requests a tile outside the declared availability, learns deeper availability from
 * the metadata extension of loaded tiles, and asks for the declared extensions only. Rejects with a
 * {@link SourceConfigError} (`unreachable-layer`, `invalid-layer`) when `layer.json` cannot be loaded or read.
 */
export async function quantizedMeshTerrain(
  options: QuantizedMeshTerrainOptions,
): Promise<TerrainSource & DescribedSource> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const layer = await loadLayerJson(options.id, options.url, fetchImpl);
  const availability = new TerrainAvailability(layer);
  const tiling = layer.scheme === 'geographic' ? GEOGRAPHIC_TILING : WEB_MERCATOR_TILING;
  const base = new URL(options.url, globalThis.location?.href);
  const templates = layer.tiles.map((template) =>
    new URL(template, base).href.replace(/%7B/g, '{').replace(/%7D/g, '}'),
  );
  const levelZeroErrorMeters =
    (2 * Math.PI * WGS84.semiMajorAxisMeters * 0.25) / (LEVEL_ZERO_SAMPLES * tiling.rootTilesX);
  return {
    id: options.id,
    tiling,
    minLevel: layer.minZoom,
    maxLevel: layer.maxZoom,
    transport: fetchTransport(fetchImpl, { Accept: acceptHeader(layer.extensions) }),
    decoder: { kind: 'quantized-mesh' },
    attribution: options.attribution ?? [],
    profile: options.profile ?? CUSTOM_PROFILE,
    datum: options.datum ?? { kind: 'ellipsoid' },
    geometricErrorMeters: (level) => levelZeroErrorMeters / 2 ** level,
    ...(options.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: options.maxRequestsPerHost }),
    ...(options.multiplexed === undefined ? {} : { multiplexed: options.multiplexed }),
    ...(options.timeoutsMs === undefined ? {} : { timeoutsMs: options.timeoutsMs }),
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' | 'unknown' {
      const status = availability.status(coord.level, coord.x, coord.y);
      if (status !== 'available') return status === 'unknown' ? 'unknown' : 'noData';
      const hostIndex = templates.length > 1 ? (coord.x + coord.y) % templates.length : 0;
      // quantized-mesh rows count from the south (TMS).
      out.url = (templates[hostIndex] ?? '')
        .replace('{z}', String(coord.level))
        .replace('{x}', String(coord.x))
        .replace('{y}', String(2 ** coord.level - 1 - coord.y))
        .replace('{version}', layer.version);
      out.hostIndex = hostIndex;
      return out;
    },
    tileMetadata(coord: TileCoord, metadata: unknown): void {
      const available = (metadata as { available?: unknown } | null)?.available;
      if (available !== undefined)
        availability.addFromMetadata(coord.level + 1, readRanges(available, 'available'), coord);
    },
  };
}
