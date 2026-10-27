// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Tiles copied from a remote PMTiles archive (OpenFreeMap's planet vector tiles, Mapterhorn's terrain): each tile of
 * the build's area and levels is read with range requests, never the whole archive, and written as it is.
 */
import { join } from 'node:path';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import type { DatasetConfig, PmtilesSource } from '../config/schema.js';
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

/** Copies a dataset's tiles from its archive into its tile folder; returns built and skipped counts. */
export async function extractPmtilesDataset(
  dataset: DatasetConfig,
  area: Area,
  folders: DatasetFolders,
  fetchImpl: typeof fetch,
  tilesAt?: (z: number) => Iterable<TileCoord>,
): Promise<{ built: number; skipped: number }> {
  if (dataset.source.type !== 'pmtiles') throw new Error(`${dataset.id}: not a PMTiles source`);
  const archive = openArchive(dataset.source, fetchImpl);
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
        const found = await archive.getZxy(tile.z, tile.x, tile.y);
        // Tiles the archive does not hold (open sea in some archives) are not written.
        if (!found) continue;
        folders.log.write('tile', key, path, new Uint8Array(found.data));
        levelBuilt++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    counts.built += levelBuilt;
    folders.report(`z${z}: ${levelBuilt} tiles copied from the archive`);
  }
  return counts;
}
