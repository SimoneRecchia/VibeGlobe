// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Tiles copied from a remote PMTiles archive (OpenFreeMap's planet vector tiles, Mapterhorn's terrain) or an XYZ tile
 * service of the same tiling (NASA's Blue Marble from GIBS, F686): each tile of the build's area and levels is read,
 * never the whole archive, and written as it is.
 */
import { join } from 'node:path';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import type { DatasetConfig, PmtilesSource, XyzSource } from '../config/schema.js';
import { tileExtension } from '../output/metadata.js';
import { type Area, areaTiles } from '../tiles/area.js';
import type { TileCoord } from '../tiles/mercator.js';
import type { DatasetFolders } from './raster-dataset.js';

/** Tiles read at once from the archive. */
const CONCURRENCY = 16;

/** A PMTiles source over HTTP range requests with an injected fetch (tests, the pipeline's proxy settings). */
function rangeSource(url: string, fetchImpl: typeof fetch): Source {
  return {
    getKey: () => url,
    async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
      const response = await fetchImpl(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const etag = response.headers.get('ETag') ?? undefined;
      return { data: await response.arrayBuffer(), ...(etag ? { etag } : {}) };
    },
  };
}

/** An archive of a dataset's source. */
export function openArchive(source: PmtilesSource, fetchImpl: typeof fetch): PMTiles {
  return new PMTiles(rangeSource(source.url, fetchImpl));
}

/** One tile's bytes from the source, or undefined where it holds none. */
function tileReader(
  source: PmtilesSource | XyzSource,
  fetchImpl: typeof fetch,
): (tile: TileCoord) => Promise<Uint8Array | undefined> {
  if (source.type === 'pmtiles') {
    const archive = openArchive(source, fetchImpl);
    return async ({ z, x, y }) => {
      const found = await archive.getZxy(z, x, y);
      return found && new Uint8Array(found.data);
    };
  }
  return async ({ z, x, y }) => {
    const url = source.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const response = await fetchImpl(url);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

/** Copies a dataset's tiles from its archive or tile service into its tile folder; returns built and skipped counts. */
export async function extractTiles(
  dataset: DatasetConfig,
  area: Area,
  folders: DatasetFolders,
  fetchImpl: typeof fetch,
  tilesAt?: (z: number) => Iterable<TileCoord>,
): Promise<{ built: number; skipped: number }> {
  const source = dataset.source;
  if (source.type !== 'pmtiles' && source.type !== 'xyz') throw new Error(`${dataset.id}: not a tile source`);
  const read = tileReader(source, fetchImpl);
  const extension = tileExtension(dataset);
  const counts = { built: 0, skipped: 0 };
  for (let z = dataset.minZoom; z <= dataset.maxZoom; z++) {
    const queue = [...(tilesAt?.(z) ?? areaTiles(area, z))];
    let levelBuilt = 0;
    const worker = async (): Promise<void> => {
      for (let tile = queue.pop(); tile !== undefined; tile = queue.pop()) {
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        const path = join(folders.tiles, `${key}.${extension}`);
        if (folders.log.check('tile', key, path) === 'done') {
          counts.skipped++;
          continue;
        }
        const found = await read(tile);
        // Tiles the source does not hold (open sea in some archives) are not written.
        if (!found) continue;
        folders.log.write('tile', key, path, found);
        levelBuilt++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    counts.built += levelBuilt;
    folders.report(`z${z}: ${levelBuilt} tiles copied from the source`);
  }
  return counts;
}
