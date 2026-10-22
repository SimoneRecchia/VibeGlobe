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

/** Package records, file chunks and built-package tiles in IndexedDB (ADR 0029). */
export class PackageStorage {
  private db: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly factory: IDBFactory | undefined,
    private readonly database = DEFAULT_DATABASE,
    private readonly onLost?: (reason: string) => void,
  ) {}

  /** Every package record. */
  async records(): Promise<PackageRecord[]> {
    const db = await this.open();
    return (await requestResult(db.transaction(PACKAGES).objectStore(PACKAGES).getAll())) as PackageRecord[];
  }

  /** One package record. */
  async record(id: string): Promise<PackageRecord | undefined> {
    const db = await this.open();
    return (await requestResult(db.transaction(PACKAGES).objectStore(PACKAGES).get(id))) as PackageRecord | undefined;
  }

  /** Writes a package record. */
  async putRecord(record: PackageRecord, key = record.manifest.id): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(PACKAGES, 'readwrite');
    tx.objectStore(PACKAGES).put(record, key);
    await transactionDone(tx);
  }

  /** Deletes a package record. */
  async deleteRecord(key: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(PACKAGES, 'readwrite');
    tx.objectStore(PACKAGES).delete(key);
    await transactionDone(tx);
  }

  /** Stores one chunk of a file of a package version. */
  async putChunk(prefix: string, path: string, index: number, chunk: Blob): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(PACKAGE_FILES, 'readwrite');
    tx.objectStore(PACKAGE_FILES).put(chunk, chunkKey(prefix, path, index));
    await transactionDone(tx);
  }

  /** One stored chunk. */
  async chunk(prefix: string, path: string, index: number): Promise<Blob | undefined> {
    const db = await this.open();
    const store = db.transaction(PACKAGE_FILES).objectStore(PACKAGE_FILES);
    return (await requestResult(store.get(chunkKey(prefix, path, index)))) as Blob | undefined;
  }

  /** Indices of the chunks of a file already stored (a resumed install skips them, F308). */
  async storedChunks(prefix: string, path: string): Promise<Set<number>> {
    const db = await this.open();
    const store = db.transaction(PACKAGE_FILES).objectStore(PACKAGE_FILES);
    const keys = (await requestResult(store.getAllKeys(prefixRange(`${prefix}${path}#`)))) as string[];
    return new Set(keys.map((key) => Number(key.slice(key.lastIndexOf('#') + 1))));
  }

  /** Stores a tile of a built package. */
  async putTile(prefix: string, tileId: string, tile: StoredPackageTile): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(PACKAGE_TILES, 'readwrite');
    tx.objectStore(PACKAGE_TILES).put(tile, `${prefix}${tileId}`);
    await transactionDone(tx);
  }

  /** A tile of a built package. */
  async tile(prefix: string, tileId: string): Promise<StoredPackageTile | undefined> {
    const db = await this.open();
    const store = db.transaction(PACKAGE_TILES).objectStore(PACKAGE_TILES);
    return (await requestResult(store.get(`${prefix}${tileId}`))) as StoredPackageTile | undefined;
  }

  /** Keys of the tiles stored under a prefix, without the prefix. */
  async tileIds(prefix: string): Promise<Set<string>> {
    const db = await this.open();
    const store = db.transaction(PACKAGE_TILES).objectStore(PACKAGE_TILES);
    const keys = (await requestResult(store.getAllKeys(prefixRange(prefix)))) as string[];
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

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new StorageUnavailableError('IndexedDB is not available'));
    const factory = this.factory;
    this.db ??= openDatabase(factory, this.database).then(
      (db) => {
        const lost = (reason: string): void => {
          db.close();
          this.db = undefined;
          this.onLost?.(reason);
        };
        db.onclose = () => lost('the browser closed the database');
        db.onversionchange = () => lost('the database is being deleted or upgraded elsewhere');
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
