// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  type TerrainSource,
  WEB_MERCATOR_TILING,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
} from '@vibeglobe/core';
import { PMTiles, TileType, type Header, type RangeResponse, type Source } from 'pmtiles';
import { archiveTransport, fetchRange, HttpStatusError, NetworkError, tileOfUrl } from './archive-transport.js';
import {
  type Attribution,
  CUSTOM_PROFILE,
  type DescribedImagerySource,
  type DescribedSource,
  type ProviderProfile,
  SourceConfigError,
} from './metadata.js';
import { coverageOf, inLevelsAndCoverage } from './tiling.js';
import {
  type ArchiveTerrainOptions,
  terrainFromArchive,
  vectorFromArchive,
  type VectorTileSource,
} from './archive-sources.js';

/** Options of {@link pmtilesImagery}. */
export interface PmtilesImageryOptions {
  /** Unique per engine instance. */
  readonly id: string;
  /** The archive: a URL read with HTTP range requests, or a local `File` or `Blob`. */
  readonly archive: string | Blob;
  /** Replaces the attribution recorded in the archive's metadata. */
  readonly attribution?: readonly Attribution[];
  readonly profile?: ProviderProfile;
  /** Headers sent with every range request (authentication). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
  /** The `fetch` used for range requests; the global one by default. */
  readonly fetch?: typeof fetch;
  /** Requests in flight to the archive's host (default 6). */
  readonly maxRequestsPerHost?: number;
}

const CONTENT_TYPES: Partial<Record<TileType, string>> = {
  [TileType.Mvt]: 'application/vnd.mapbox-vector-tile',
  [TileType.Png]: 'image/png',
  [TileType.Jpeg]: 'image/jpeg',
  [TileType.Webp]: 'image/webp',
  [TileType.Avif]: 'image/avif',
};

let blobCounter = 0;

/** The archive as a PMTiles byte source: range requests over `fetch`, or slices of a local `Blob`. */
function byteSource(options: PmtilesImageryOptions, init: RequestInit): Source {
  const archive = options.archive;
  if (typeof archive !== 'string') {
    const key = `blob-archive://${options.id}-${++blobCounter}`;
    return {
      getKey: () => key,
      getBytes: async (offset, length): Promise<RangeResponse> => ({
        data: await archive.slice(offset, offset + length).arrayBuffer(),
      }),
    };
  }
  const fetchImpl = options.fetch ?? ((input, requestInit) => fetch(input, requestInit));
  return {
    getKey: () => archive,
    getBytes: async (offset, length, signal): Promise<RangeResponse> => ({
      data: await fetchRange(fetchImpl, archive, offset, length, signal ? { ...init, signal } : init),
    }),
  };
}

/** The attribution recorded in the archive's JSON metadata (`attribution`, possibly HTML with a link). */
function recordedAttribution(metadata: unknown): Attribution[] {
  const raw = (metadata as { attribution?: unknown } | null)?.attribution;
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const link = /href="([^"]+)"/.exec(raw)?.[1];
  const text = raw.replace(/<[^>]*>/g, '').trim();
  return text.length === 0 ? [] : [link === undefined ? { text } : { text, url: link }];
}

/** What an archive may hold: raster images for imagery, anything for terrain and vector tiles (F328). */
export type ArchiveContent = 'raster' | 'any';

const RASTER = new Set([TileType.Png, TileType.Jpeg, TileType.Webp, TileType.Avif]);

/** Reads the header, checking that the archive is a PMTiles v3 archive of the expected content. */
async function openHeader(archive: PMTiles, id: string, content: ArchiveContent): Promise<Header> {
  let header: Header;
  try {
    header = await archive.getHeader();
  } catch (error) {
    throw new SourceConfigError(
      'unreadable-archive',
      `PMTiles source '${id}': cannot read the archive (${String(error)})`,
    );
  }
  if (content === 'raster' && !RASTER.has(header.tileType))
    throw new SourceConfigError(
      'not-raster',
      `PMTiles source '${id}': the archive holds tile type ${header.tileType}, not raster images`,
    );
  if (header.minZoom > header.maxZoom)
    throw new SourceConfigError('invalid-levels', `PMTiles source '${id}': minimum zoom above maximum zoom`);
  return header;
}

/**
 * A raster imagery source from a PMTiles v3 archive (F232), over HTTP range requests or from a local file. The
 * header, the root and the leaf directories are fetched once per archive and cached; tiles the archive lacks are no
 * data. Resolves once the header is read, so levels, coverage and attribution come from the archive itself.
 */
export function pmtilesImagery(options: PmtilesImageryOptions): Promise<DescribedImagerySource> {
  return pmtilesArchive(options, 'raster');
}

/** {@link pmtilesImagery} for any content; terrain and vector archives reuse its addressing and transport (F328). */
export async function pmtilesArchive(
  options: PmtilesImageryOptions,
  content: ArchiveContent,
): Promise<DescribedImagerySource> {
  const init: RequestInit = {
    ...(options.headers ? { headers: options.headers } : {}),
    credentials: options.credentials ?? 'omit',
    mode: 'cors',
  };
  const bytes = byteSource(options, init);
  let archive = new PMTiles(bytes);
  const header = await openHeader(archive, options.id, content);
  let metadata: unknown;
  try {
    metadata = await archive.getMetadata();
  } catch {
    metadata = undefined;
  }
  const contentType = CONTENT_TYPES[header.tileType] ?? 'application/octet-stream';
  const coverage = coverageOf(header.minLon, header.minLat, header.maxLon, header.maxLat);
  const base = typeof options.archive === 'string' ? options.archive : `blob-archive://${options.id}`;
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  const source: DescribedImagerySource = {
    id: options.id,
    tiling: WEB_MERCATOR_TILING,
    minLevel: header.minZoom,
    maxLevel: header.maxZoom,
    tileSizePx: 256,
    pixelRatio: 1,
    ...(coverage ? { coverage: [coverage] } : {}),
    decoder: 'image',
    maxRequestsPerHost: options.maxRequestsPerHost ?? 6,
    attribution: options.attribution ?? recordedAttribution(metadata),
    profile: options.profile ?? CUSTOM_PROFILE,
    transportRequired: true,
    transport: archiveTransport(async (url, signal) => {
      const tile = tileOfUrl(url);
      if (!tile) return undefined;
      try {
        const found = await archive.getZxy(tile.z, tile.x, tile.y, signal);
        return found ? { bytes: found.data, contentType } : undefined;
      } catch (error) {
        // The library caches failed directory reads: start over so a retry after a server error can succeed.
        if (error instanceof HttpStatusError || error instanceof NetworkError) archive = new PMTiles(bytes);
        throw error;
      }
    }),
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (!inLevelsAndCoverage(source, coord, extent)) return 'noData';
      out.url = `${base}#${coord.level}/${coord.x}/${coord.y}`;
      out.hostIndex = 0;
      return out;
    },
  };
  return source;
}

/** Terrain tiles (Terrarium, Terrain-RGB or quantized-mesh) from a PMTiles archive (F328). */
export async function pmtilesTerrain(
  options: PmtilesImageryOptions & ArchiveTerrainOptions,
): Promise<TerrainSource & DescribedSource> {
  return terrainFromArchive(await pmtilesArchive(options, 'any'), options);
}

/** Mapbox Vector Tiles from a PMTiles archive (F328). */
export async function pmtilesVector(options: PmtilesImageryOptions): Promise<VectorTileSource> {
  return vectorFromArchive(await pmtilesArchive(options, 'any'));
}
