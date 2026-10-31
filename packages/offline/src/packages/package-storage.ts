// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  DEFAULT_DATABASE,
  openDatabase,
  PACKAGE_FILES,
  PACKAGE_TILES,
  PACKAGES,
  prefixRange,
  requestResult,
  StorageUnavailableError,
  transactionDone,
  watchLoss,
} from '../idb.js';
import type { PackageManifest } from './manifest.js';

/** An installed package as stored. */
export interface PackageRecord {
  readonly manifest: PackageManifest;
  /** `archive`: PMTiles or MBTiles files stored in chunks; `tiles`: tiles downloaded by the in-browser builder. */
  readonly kind: 'archive' | 'tiles';
  /** `partial` while an install runs or after it was interrupted (F308). */
  readonly state: 'partial' | 'complete';
  /** Where it came from, so `update` can fetch a newer version. */
  readonly manifestUrl?: string;
  readonly installedAtMs: number;
  /** Bytes stored for it. */
  readonly bytes: number;
}

/** A tile of a package built in the browser. */
export interface StoredPackageTile {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  readonly sha256: string;
}

/** The storage key prefix of one version of a package. */
export function versionKey(manifest: Pick<PackageManifest, 'id' | 'version'>): string {
  return `${manifest.id}@${manifest.version}/`;
}

/** Package records, file chunks and built-package tiles in IndexedDB (ADR 0033). */
export class PackageStorage {
  private db: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly factory: IDBFactory | undefined,
    private readonly database = DEFAULT_DATABASE,
    private readonly onLost?: (reason: string) => void,
  ) {}

  /** Every package record. */
  records(): Promise<PackageRecord[]> {
    return this.read(PACKAGES, (store) => store.getAll());
  }

  /** One package record. */
  record(id: string): Promise<PackageRecord | undefined> {
    return this.read(PACKAGES, (store) => store.get(id));
  }

  /** Writes a package record. */
  putRecord(record: PackageRecord, key = record.manifest.id): Promise<void> {
    return this.write(PACKAGES, (store) => store.put(record, key));
  }

  /** Deletes a package record. */
  deleteRecord(key: string): Promise<void> {
    return this.write(PACKAGES, (store) => store.delete(key));
  }

  /** Stores one chunk of a file of a package version. */
  putChunk(prefix: string, path: string, index: number, chunk: Blob): Promise<void> {
    return this.write(PACKAGE_FILES, (store) => store.put(chunk, chunkKey(prefix, path, index)));
  }

  /** One stored chunk. */
  chunk(prefix: string, path: string, index: number): Promise<Blob | undefined> {
    return this.read(PACKAGE_FILES, (store) => store.get(chunkKey(prefix, path, index)));
  }

  /** Indices of the chunks of a file already stored (a resumed install skips them, F308). */
  async storedChunks(prefix: string, path: string): Promise<Set<number>> {
    const keys = await this.read<string[]>(PACKAGE_FILES, (store) =>
      store.getAllKeys(prefixRange(`${prefix}${path}#`)),
    );
    return new Set(keys.map((key) => Number(key.slice(key.lastIndexOf('#') + 1))));
  }

  /** Stores a tile of a built package. */
  putTile(prefix: string, tileId: string, tile: StoredPackageTile): Promise<void> {
    return this.write(PACKAGE_TILES, (store) => store.put(tile, `${prefix}${tileId}`));
  }

  /** A tile of a built package. */
  tile(prefix: string, tileId: string): Promise<StoredPackageTile | undefined> {
    return this.read(PACKAGE_TILES, (store) => store.get(`${prefix}${tileId}`));
  }

  /** Keys of the tiles stored under a prefix, without the prefix. */
  async tileIds(prefix: string): Promise<Set<string>> {
    const keys = await this.read<string[]>(PACKAGE_TILES, (store) => store.getAllKeys(prefixRange(prefix)));
    return new Set(keys.map((key) => key.slice(prefix.length)));
  }

  /** Deletes every chunk and tile of a package version. */
  async deleteData(prefix: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([PACKAGE_FILES, PACKAGE_TILES], 'readwrite');
    const range = prefixRange(prefix);
    if (range) {
      tx.objectStore(PACKAGE_FILES).delete(range);
      tx.objectStore(PACKAGE_TILES).delete(range);
    }
    await transactionDone(tx);
  }

  /** Closes the connection. */
  close(): void {
    void this.db?.then((db) => db.close()).catch(() => undefined);
    this.db = undefined;
  }

  /** The result of one request on a store, in a read-only transaction. */
  private async read<T>(name: string, query: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.open();
    return (await requestResult(query(db.transaction(name).objectStore(name)))) as T;
  }

  /** Changes a store and resolves once the transaction commits. */
  private async write(name: string, change: (store: IDBObjectStore) => unknown): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(name, 'readwrite');
    change(tx.objectStore(name));
    await transactionDone(tx);
  }

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new StorageUnavailableError('IndexedDB is not available'));
    const factory = this.factory;
    this.db ??= openDatabase(factory, this.database).then(
      (db) => {
        watchLoss(db, (reason) => {
          this.db = undefined;
          this.onLost?.(reason);
        });
        return db;
      },
      (error: unknown) => {
        this.db = undefined;
        throw error;
      },
    );
    return this.db;
  }
}

function chunkKey(prefix: string, path: string, index: number): string {
  return `${prefix}${path}#${String(index).padStart(6, '0')}`;
}
