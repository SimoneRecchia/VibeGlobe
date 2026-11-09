// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  DEFAULT_DATABASE,
  isQuotaError,
  openDatabase,
  watchLoss,
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

/** The most tiles one write transaction holds: a read that comes after it waits for these alone. */
const WRITES_PER_TRANSACTION = 16;

interface IndexRecord {
  readonly size: number;
  readonly accessMs: number;
}

/** A tile waiting for the next write transaction, and its `put`'s answer. */
interface Write {
  readonly tile: CachedTile;
  readonly done: (result: 'stored' | 'quota') => void;
  readonly failed: (error: unknown) => void;
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
  /**
   * Tiles waiting to be written. One write transaction runs at a time and the tiles that arrive meanwhile share the
   * next ones: a write transaction holds back every read that comes after it, so one per tile queued each frame's
   * reads, misses included, behind the writes of the tiles before (400 tiles: 380 ms against 17 ms without writes).
   */
  private readonly writes = new Map<string, Write>();
  private flushing: Promise<void> | undefined;

  constructor(private readonly options: IndexedDbStoreOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_CACHE_BYTES;
    this.factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  }

  async get(key: string): Promise<CachedTile | undefined> {
    // A tile still waiting for its transaction reads back as written; a copy, since the caller may transfer its bytes.
    const waiting = this.writes.get(key)?.tile;
    if (waiting) return { ...waiting, bytes: waiting.bytes.slice(0) };
    const db = await this.open();
    const tile = (await requestResult(db.transaction(TILES).objectStore(TILES).get(key))) as CachedTile | undefined;
    if (tile) this.touch(key);
    return tile;
  }

  put(key: string, tile: CachedTile): Promise<'stored' | 'quota'> {
    if (tile.bytes.byteLength > this.maxBytes) return Promise.resolve('quota');
    return new Promise((done, failed) => {
      this.writes.get(key)?.done('stored');
      this.writes.set(key, { tile, done, failed });
      void this.flush();
    });
  }

  async delete(key: string): Promise<void> {
    await this.flush();
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
    await this.flush();
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
    await this.flush();
    await this.resum(await this.open());
    return { bytes: this.bytes, quotaBytes: this.maxBytes };
  }

  close(): void {
    // The waiting tiles' transaction starts before the store closes, and the connection closes once it ends.
    const last = this.flush();
    const db = this.db;
    this.closed = true;
    this.db = undefined;
    void last.then(() => db?.then((open) => open.close())).catch(() => undefined);
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
    watchLoss(db, (reason) => {
      this.db = undefined;
      this.bytes = 0;
      this.touched.clear();
      for (const write of this.writes.values()) write.failed(new StorageUnavailableError(reason));
      this.writes.clear();
      this.options.onLost?.(reason);
    });
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
    this.touchTimer ??= setTimeout(() => void this.flush().catch(() => undefined), 500);
  }

  /** Writes the waiting tiles and access times, a transaction at a time, until none waits. */
  private flush(): Promise<void> {
    if (!this.flushing && (this.writes.size > 0 || this.touched.size > 0)) this.flushing = this.writeWaiting();
    return this.flushing ?? Promise.resolve();
  }

  private async writeWaiting(): Promise<void> {
    try {
      while (this.writes.size > 0 || this.touched.size > 0) {
        clearTimeout(this.touchTimer);
        this.touchTimer = undefined;
        await this.open().then(
          (db) => this.commit(db),
          (error: unknown) => this.drop(error),
        );
      }
    } finally {
      this.flushing = undefined;
    }
  }

  /** Fails the waiting tiles' `put`s with `error`. */
  private drop(error: unknown): void {
    for (const write of this.writes.values()) write.failed(error);
    this.writes.clear();
    this.touched.clear();
  }

  /** One transaction with the first waiting tiles (up to 16) and every access time, then the eviction they call for. */
  private async commit(db: IDBDatabase): Promise<void> {
    const writes = [...this.writes].slice(0, WRITES_PER_TRANSACTION);
    for (const [key] of writes) this.writes.delete(key);
    const touched = [...this.touched];
    this.touched.clear();
    await this.write(db, writes, touched).catch((error: unknown) => {
      for (const [, write] of writes) write.failed(error);
    });
  }

  private async write(db: IDBDatabase, writes: [string, Write][], touched: [string, number][]): Promise<void> {
    // A cache can lose its last writes in a power cut: relaxed durability spares a disk flush per transaction.
    const tx = db.transaction([TILES, TILE_INDEX], 'readwrite', { durability: 'relaxed' });
    const tiles = tx.objectStore(TILES);
    const index = tx.objectStore(TILE_INDEX);
    const accessMs = Date.now();
    let grown = 0;
    let written = 0;
    for (const [key, { tile }] of writes) {
      const size = tile.bytes.byteLength;
      const previous = index.get(key);
      previous.onsuccess = () => (grown += size - ((previous.result as IndexRecord | undefined)?.size ?? 0));
      tiles.put(tile, key);
      index.put({ size, accessMs } satisfies IndexRecord, key);
      written += size;
    }
    for (const [key, at] of touched) {
      const request = index.get(key);
      request.onsuccess = () => {
        const record = request.result as IndexRecord | undefined;
        if (record) index.put({ size: record.size, accessMs: at } satisfies IndexRecord, key);
      };
    }
    try {
      await transactionDone(tx);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      // The browser quota: make room for the next writes (F274).
      await this.evict(Math.floor(this.bytes * 0.75));
      for (const [, write] of writes) write.done('quota');
      return;
    }
    this.bytes += grown;
    this.writtenSinceSum += written;
    if (this.writtenSinceSum >= this.maxBytes * RESUM_EVERY) await this.resum(db);
    if (this.bytes > this.maxBytes) await this.evict(Math.floor(this.maxBytes * EVICT_TO));
    for (const [, write] of writes) write.done('stored');
  }
}
