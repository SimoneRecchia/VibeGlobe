// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { ImagerySource, TileCoord } from '@vibeglobe/core';
import { tileKey } from '../tiered-source.js';
import type { ProviderRules } from '../types.js';
import { tilesOfArea, type PackageArea } from './area.js';
import { sha256Hex } from './integrity.js';
import type { InstallOptions } from './installer.js';
import { PackageError, type PackageAttribution, type PackageManifest } from './manifest.js';
import { type PackageStorage, versionKey } from './package-storage.js';

/** One source of a package built in the browser. */
export interface PackageRequestSource {
  /** The source as given to the engine (not wrapped). */
  readonly source: ImagerySource;
  /** The provider's rules; packaging is refused when they forbid it (F319). */
  readonly rules?: ProviderRules;
  readonly layerId?: string;
  readonly license: string;
  readonly attribution: PackageAttribution;
}

/** A package to download in the browser: an area, a zoom range and sources (F289, F308). */
export interface PackageRequest {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly area: PackageArea;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly sources: readonly PackageRequestSource[];
}

/** What a build left out, and why (F289). */
export interface BuildReport {
  readonly included: readonly string[];
  readonly excluded: readonly { readonly sourceId: string; readonly reason: string }[];
  readonly tiles: number;
  readonly bytes: number;
}

/** What the builder asks of the engine: the effective packaging switch of each source. */
export interface BuildContext {
  readonly storage: PackageStorage;
  readonly fetch: typeof fetch;
  packagingAllowed(sourceId: string, layerId: string): boolean;
  globalPackagingAllowed(): boolean;
}

/** Average tile size assumed by estimates before anything is downloaded. */
const ESTIMATED_TILE_BYTES = 20 * 1024;

const CONCURRENCY = 6;
const ATTEMPTS = 3;

/** The tiles of a request's area for one source, within the source's levels. */
function* tilesFor(request: PackageRequest, source: ImagerySource): Generator<TileCoord> {
  const min = Math.max(request.minLevel, source.minLevel);
  const max = Math.min(request.maxLevel, source.maxLevel);
  yield* tilesOfArea(source.tiling, request.area, min, max);
}

/** The sources a request may package, refusing it before any download when a provider forbids packaging (F319). */
function checkPackaging(request: PackageRequest, context: BuildContext): Pick<BuildReport, 'included' | 'excluded'> {
  if (!context.globalPackagingAllowed())
    throw new PackageError('packaging-disabled', `package '${request.id}': offline packaging is switched off globally`);
  for (const { source, rules } of request.sources) {
    if (rules?.forbids.has('offlinePackaging'))
      throw new PackageError(
        'packaging-forbidden',
        `package '${request.id}': source '${source.id}' cannot be packaged, its provider profile '${rules.id}' forbids offline packaging`,
      );
  }
  const included: string[] = [];
  const excluded: { sourceId: string; reason: string }[] = [];
  for (const { source, layerId } of request.sources) {
    if (context.packagingAllowed(source.id, layerId ?? source.id)) included.push(source.id);
    else excluded.push({ sourceId: source.id, reason: 'offline packaging is switched off for this source' });
  }
  return { included, excluded };
}

/** Counts a request's tiles and estimates its size, downloading nothing. */
export function estimateRequest(request: PackageRequest): { tiles: number; bytes: number } {
  let tiles = 0;
  for (const { source } of request.sources) tiles += [...tilesFor(request, source)].length;
  return { tiles, bytes: tiles * ESTIMATED_TILE_BYTES };
}

async function download(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<Response | undefined> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit', ...(signal ? { signal } : {}) });
      if (response.status === 404 || response.status === 204) return undefined;
      if (response.ok) return response;
      if (attempt >= ATTEMPTS) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (signal?.aborted || attempt >= ATTEMPTS) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
}

interface Job {
  readonly source: ImagerySource;
  readonly coord: TileCoord;
  readonly id: string;
}

/** Downloads and stores one tile; resolves its size, 0 when the source has no data there. */
async function fetchTileInto(
  job: Job,
  request: PackageRequest,
  context: BuildContext,
  signal: AbortSignal | undefined,
): Promise<number> {
  const prefix = versionKey(request);
  const tileRequest = job.source.request(job.coord, { url: '', hostIndex: 0 });
  if (tileRequest === 'noData' || tileRequest === 'unknown') return 0;
  const response = await download(context.fetch, tileRequest.url, signal).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    throw new PackageError(
      'download-failed',
      `package '${request.id}': ${job.id} could not be downloaded (${String(error)})`,
    );
  });
  if (!response) return 0;
  const data = await response.arrayBuffer();
  await context.storage.putTile(prefix, job.id, {
    bytes: data,
    contentType: response.headers.get('Content-Type') ?? '',
    sha256: await sha256Hex(data),
  });
  return data.byteLength;
}

function manifestOf(request: PackageRequest, sources: readonly PackageRequestSource[]): PackageManifest {
  return {
    id: request.id,
    version: request.version,
    ...(request.name === undefined ? {} : { name: request.name }),
    area: request.area,
    files: [],
    sources: sources.map(({ source, license, attribution }) => ({
      sourceId: source.id,
      file: '',
      minLevel: Math.max(request.minLevel, source.minLevel),
      maxLevel: Math.min(request.maxLevel, source.maxLevel),
      license,
      attribution,
    })),
  };
}

/**
 * Downloads a request's tiles into browser storage as a package of kind `tiles`. Tiles stored by an interrupted build
 * of the same version are skipped (F308); each tile is stored with its SHA-256, checked when it is read.
 */
export async function buildPackage(
  request: PackageRequest,
  context: BuildContext,
  options: InstallOptions,
): Promise<{ manifest: PackageManifest; report: BuildReport }> {
  const { included, excluded } = checkPackaging(request, context);
  const prefix = versionKey(request);
  const done = await context.storage.tileIds(prefix);
  const sources = request.sources.filter((s) => included.includes(s.source.id));
  const jobs: Job[] = [];
  for (const { source } of sources)
    for (const coord of tilesFor(request, source)) jobs.push({ source, coord, id: tileKey(source.id, coord) });
  const totalBytes = jobs.length * ESTIMATED_TILE_BYTES;
  const count = { loaded: 0, resumed: 0, bytes: 0, tiles: 0 };
  const next = async (): Promise<void> => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const resumed = done.has(job.id);
      const size = resumed
        ? ((await context.storage.tile(prefix, job.id))?.bytes.byteLength ?? 0)
        : await fetchTileInto(job, request, context, options.signal);
      count.loaded++;
      if (resumed) count.resumed++;
      if (size > 0) count.tiles++;
      count.bytes += size;
      options.onProgress?.({
        packageId: request.id,
        totalBytes,
        loadedBytes: count.loaded * ESTIMATED_TILE_BYTES,
        resumedBytes: count.resumed * ESTIMATED_TILE_BYTES,
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
  return {
    manifest: manifestOf(request, sources),
    report: { included, excluded, tiles: count.tiles, bytes: count.bytes },
  };
}
