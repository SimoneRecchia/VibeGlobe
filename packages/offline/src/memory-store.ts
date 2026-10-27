// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { CachedTile, CacheStore, StorageUsage } from './types.js';

/** Options of {@link memoryStore}. */
export interface MemoryStoreOptions {
  /** Largest total of tile bytes; least-recently-used tiles are evicted beyond it. */
  readonly maxBytes?: number;
}

/**
 * A {@link CacheStore} in memory, least recently used first out: the reference implementation of the contract, and the
 * store used where browser storage is missing. Its contents do not survive the page.
 */
export function memoryStore(options: MemoryStoreOptions = {}): CacheStore {
  // A Map iterates in insertion order: re-inserting on access keeps the least recently used first.
  const tiles = new Map<string, CachedTile>();
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  let bytes = 0;
  const remove = (key: string): void => {
    const tile = tiles.get(key);
    if (!tile) return;
    bytes -= tile.bytes.byteLength;
    tiles.delete(key);
  };
  return {
    get(key) {
      const tile = tiles.get(key);
      if (tile) {
        tiles.delete(key);
        tiles.set(key, tile);
      }
      return Promise.resolve(tile);
    },
    put(key, tile) {
      if (tile.bytes.byteLength > maxBytes) return Promise.resolve('quota');
      remove(key);
      tiles.set(key, { ...tile, bytes: tile.bytes.slice(0) });
      bytes += tile.bytes.byteLength;
      for (const oldest of tiles.keys()) {
        if (bytes <= maxBytes) break;
        remove(oldest);
      }
      return Promise.resolve('stored');
    },
    delete(key) {
      remove(key);
      return Promise.resolve();
    },
    deletePrefix(prefix) {
      let removed = 0;
      for (const key of [...tiles.keys()]) {
        if (!key.startsWith(prefix)) continue;
        remove(key);
        removed++;
      }
      return Promise.resolve(removed);
    },
    usage(): Promise<StorageUsage> {
      return Promise.resolve({ bytes, quotaBytes: Number.isFinite(maxBytes) ? maxBytes : undefined });
    },
    close() {
      tiles.clear();
      bytes = 0;
    },
  };
}
