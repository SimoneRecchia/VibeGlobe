// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  DEFAULT_DATABASE,
  isQuotaError,
  openDatabase,
  prefixRange,
  requestResult,
  StorageUnavailableError,
  TILE_INDEX,
  TILES,
  transactionDone,
} from './idb.js';
import type { CachedTile, CacheStore, StorageUsage } from './types.js';

/** Options of {@link indexedDbStore}. */
export interface IndexedDbStoreOptions {
  /** Largest total of tile bytes (default 512 MiB); least-recently-used tiles are evicted beyond it (F274). */
  readonly maxBytes?: number;
  /** Database name (default `vibeglobe-offline`). */
  readonly database?: string;
  /** The IndexedDB factory; the global `indexedDB` by default. */
  readonly indexedDB?: IDBFactory;
  /**
   * Called when the browser closed or deleted the database while it was open (F275): the cached tiles are gone. The
   * store reopens an empty database on its next use.
   */
  readonly onLost?: (reason: string) => void;
}

/** Default size limit of the persistent cache. */
export const DEFAULT_CACHE_BYTES = 512 * 1024 * 1024;

/** After an eviction the cache shrinks to this fraction of its limit, so evictions do not run on every write. */
const EVICT_TO = 0.9;

/**
 * Other tabs write to the same database with byte counts of their own: the total is read again from the size index
 * after this fraction of the limit was written here, so the shared database stays within its limit.
 */
const RESUM_EVERY = 0.05;

interface IndexRecord {
  readonly size: number;
  readonly accessMs: number;
}

/** A persistent {@link CacheStore} in IndexedDB with least-recently-used eviction to a byte limit (F273, F274). */
export function indexedDbStore(options: IndexedDbStoreOptions = {}): CacheStore {
  return new IndexedDbStore(options);
}

class IndexedDbStore implements CacheStore {
  private readonly maxBytes: number;
  private readonly factory: IDBFactory | undefined;
  private db: Promise<IDBDatabase> | undefined;
  private bytes = 0;
  /** Bytes written by this instance since the total was last read from the database. */
  private writtenSinceSum = 0;
  private closed = false;
  /** Access times waiting to be written, batched so reads cost no write each. */
  private readonly touched = new Map<string, number>();
  private touchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: IndexedDbStoreOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_CACHE_BYTES;
    this.factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  }

  async get(key: string): Promise<CachedTile | undefined> {
    const db = await this.open();
    const tile = (await requestResult(db.transaction(TILES).objectStore(TILES).get(key))) as CachedTile | undefined;
    if (tile) this.touch(key);
    return tile;
  }

  async put(key: string, tile: CachedTile): Promise<'stored' | 'quota'> {
    const size = tile.bytes.byteLength;
    if (size > this.maxBytes) return 'quota';
    const db = await this.open();
    const tx = db.transaction([TILES, TILE_INDEX], 'readwrite');
    const index = tx.objectStore(TILE_INDEX);
    const previous = (requestResult(index.get(key)) as Promise<IndexRecord | undefined>).catch(() => undefined);
    tx.objectStore(TILES).put(tile, key);
    index.put({ size, accessMs: Date.now() } satisfies IndexRecord, key);
    try {
      await transactionDone(tx);
      this.bytes += size - ((await previous)?.size ?? 0);
      this.writtenSinceSum += size;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      // The browser quota: make room for the next writes (F274).
      await this.evict(Math.floor(this.bytes * 0.75));
      return 'quota';
    }
    if (this.writtenSinceSum >= this.maxBytes * RESUM_EVERY) await this.resum(db);
    if (this.bytes > this.maxBytes) await this.evict(Math.floor(this.maxBytes * EVICT_TO));
    return 'stored';
  }

  async delete(key: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([TILES, TILE_INDEX], 'readwrite');
    const index = tx.objectStore(TILE_INDEX);
    const old = (await requestResult(index.get(key))) as IndexRecord | undefined;
    index.delete(key);
    tx.objectStore(TILES).delete(key);
    await transactionDone(tx);
    if (old) this.bytes -= old.size;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const db = await this.open();
    const tx = db.transaction([TILES, TILE_INDEX], 'readwrite');
    const range = prefixRange(prefix);
    const request = tx.objectStore(TILE_INDEX).openCursor(range);
    let removed = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      this.bytes -= (cursor.value as IndexRecord).size;
      cursor.delete();
      removed++;
      cursor.continue();
    };
    tx.objectStore(TILES).delete(range ?? IDBKeyRange.lowerBound(''));
    await transactionDone(tx);
    return removed;
  }

  async usage(): Promise<StorageUsage> {
    await this.resum(await this.open());
    return { bytes: this.bytes, quotaBytes: this.maxBytes };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.touchTimer);
    void this.db?.then((db) => db.close()).catch(() => undefined);
    this.db = undefined;
  }

  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new StorageUnavailableError('the store is closed'));
    if (!this.factory) return Promise.reject(new StorageUnavailableError('IndexedDB is not available'));
    this.db ??= this.connect(this.factory).catch((error: unknown) => {
      this.db = undefined;
      throw error;
    });
    return this.db;
  }

  private async connect(factory: IDBFactory): Promise<IDBDatabase> {
    const db = await openDatabase(factory, this.options.database ?? DEFAULT_DATABASE);
    const lost = (reason: string): void => {
      db.close();
      this.db = undefined;
      this.bytes = 0;
      this.touched.clear();
      this.options.onLost?.(reason);
    };
    // The browser closes the connection when site data is cleared; another context deleting the database asks first.
    db.onclose = () => lost('the browser closed the database');
    db.onversionchange = () => lost('the database is being deleted or upgraded elsewhere');
    this.bytes = await this.sumSizes(db);
    return db;
  }

  /** Reads the total again, which includes the writes of other tabs. */
  private async resum(db: IDBDatabase): Promise<void> {
    this.writtenSinceSum = 0;
    this.bytes = await this.sumSizes(db);
  }

  /** The stored bytes, read from the size index alone. */
  private async sumSizes(db: IDBDatabase): Promise<number> {
    const tx = db.transaction(TILE_INDEX);
    const request = tx.objectStore(TILE_INDEX).index('size').openKeyCursor();
    let total = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      total += cursor.key as number;
      cursor.continue();
    };
    await transactionDone(tx);
    return total;
  }

  /** Deletes least-recently-used tiles until at most `targetBytes` remain. */
  private async evict(targetBytes: number): Promise<void> {
    await this.flushTouches();
    const db = await this.open();
    const tx = db.transaction([TILES, TILE_INDEX], 'readwrite');
    const tiles = tx.objectStore(TILES);
    const request = tx.objectStore(TILE_INDEX).index('accessMs').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || this.bytes <= targetBytes) return;
      this.bytes -= (cursor.value as IndexRecord).size;
      tiles.delete(cursor.primaryKey);
      cursor.delete();
      cursor.continue();
    };
    await transactionDone(tx);
  }

  private touch(key: string): void {
    this.touched.set(key, Date.now());
    this.touchTimer ??= setTimeout(() => void this.flushTouches().catch(() => undefined), 500);
  }

  private async flushTouches(): Promise<void> {
    clearTimeout(this.touchTimer);
    this.touchTimer = undefined;
    if (this.touched.size === 0) return;
    const entries = [...this.touched];
    this.touched.clear();
    const db = await this.open();
    const tx = db.transaction(TILE_INDEX, 'readwrite');
    const index = tx.objectStore(TILE_INDEX);
    for (const [key, accessMs] of entries) {
      const request = index.get(key);
      request.onsuccess = () => {
        const record = request.result as IndexRecord | undefined;
        if (record) index.put({ size: record.size, accessMs } satisfies IndexRecord, key);
      };
    }
    await transactionDone(tx);
  }
}
