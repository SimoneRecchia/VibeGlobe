/** Promise wrappers over IndexedDB and the database layout of the offline engine (ADR 0033). */

/** Name of the database every engine instance on the origin shares. */
export const DEFAULT_DATABASE = 'vibeglobe-offline';
const VERSION = 1;

/** Object store of cached tiles. */
export const TILES = 'tiles';
/** Object store of each cached tile's size and last access, kept apart so a read rewrites no tile bytes. */
export const TILE_INDEX = 'tile-index';
/** Object store of installed package records. */
export const PACKAGES = 'packages';
/** Object store of package files (Blobs) and partial downloads. */
export const PACKAGE_FILES = 'package-files';
/** Object store of the tiles of packages built in the browser. */
export const PACKAGE_TILES = 'package-tiles';

/** The database could not be used (missing, blocked, or closed by the browser). */
export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

/** Resolves a request's result. */
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when a transaction commits; rejects with its error (QuotaExceededError among them) when it aborts. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
    tx.onerror = () => undefined;
  });
}

/** True for the errors browsers raise when storage is full. */
export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** Time limit of opening the database: some Safari builds never answer (docs/research/offline-and-network.md). */
const OPEN_TIMEOUT_MS = 10_000;

/** Opens (and creates or upgrades) the database. */
export function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StorageUnavailableError('IndexedDB did not open in time')),
      OPEN_TIMEOUT_MS,
    );
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, VERSION);
    } catch (error) {
      clearTimeout(timer);
      reject(new StorageUnavailableError(`IndexedDB cannot be opened: ${String(error)}`));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(TILES);
      const index = db.createObjectStore(TILE_INDEX);
      index.createIndex('accessMs', 'accessMs');
      index.createIndex('size', 'size');
      db.createObjectStore(PACKAGES);
      db.createObjectStore(PACKAGE_FILES);
      db.createObjectStore(PACKAGE_TILES);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(new StorageUnavailableError(`IndexedDB open failed: ${String(request.error)}`));
    };
    request.onblocked = () => reject(new StorageUnavailableError('IndexedDB open is blocked by another connection'));
  });
}

/** An IDBKeyRange of every string key starting with `prefix`. */
export function prefixRange(prefix: string): IDBKeyRange | undefined {
  return prefix === '' ? undefined : IDBKeyRange.bound(prefix, `${prefix}￿`);
}
