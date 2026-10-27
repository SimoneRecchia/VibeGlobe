// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { CachedTile, CacheStore, StorageUsage } from './types.js';

/** Messages to the cache worker. */
export type CacheWorkerRequest =
  | { readonly id: number; readonly op: 'init'; readonly maxBytes?: number; readonly database?: string }
  | { readonly id: number; readonly op: 'get' | 'delete'; readonly key: string }
  | { readonly id: number; readonly op: 'put'; readonly key: string; readonly tile: CachedTile }
  | { readonly id: number; readonly op: 'deletePrefix'; readonly prefix: string }
  | { readonly id: number; readonly op: 'usage' };

/** Messages from the cache worker: an answer, or the database was lost. */
export type CacheWorkerMessage =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string }
  | { readonly id: -1; readonly lost: string };

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** Options of {@link workerStore}. */
export interface WorkerStoreOptions {
  /** The worker running `@vibeglobe/offline/cache-worker.js`; the bundled one by default. */
  readonly worker?: Worker;
  readonly maxBytes?: number;
  readonly database?: string;
  readonly onLost?: (reason: string) => void;
}

/** The cache worker bundled with the package, resolved by the application's bundler. */
function bundledWorker(): Worker {
  return new Worker(new URL('./cache-worker.js', import.meta.url), { type: 'module', name: 'vibeglobe-cache' });
}

/**
 * A {@link CacheStore} whose IndexedDB transactions and copies run in a dedicated worker, so tile reads and writes
 * stay off the main thread (F273). Tile bytes are transferred, never copied, across the boundary.
 */
export function workerStore(options: WorkerStoreOptions = {}): CacheStore {
  const worker = options.worker ?? bundledWorker();
  let next = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  worker.onmessage = (event: MessageEvent<CacheWorkerMessage>) => {
    const message = event.data;
    if ('lost' in message) {
      options.onLost?.(message.lost);
      return;
    }
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) call?.resolve(message.value);
    else call?.reject(new Error(message.error));
  };
  /** Why later calls fail at once: a worker that failed (a missing script, a CSP refusal) or was closed never answers. */
  let failure: string | undefined;
  const fail = (reason: string): void => {
    failure = reason;
    for (const call of pending.values()) call.reject(new Error(reason));
    pending.clear();
  };
  worker.onerror = () => fail('the cache worker failed');
  const send = <T>(request: WithoutId<CacheWorkerRequest>, transfer: Transferable[] = []): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (failure !== undefined) {
        reject(new Error(failure));
        return;
      }
      const id = next++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...request, id }, transfer);
    });
  void send({
    op: 'init',
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.database === undefined ? {} : { database: options.database }),
  }).catch(() => undefined);
  return {
    get: (key) => send<CachedTile | undefined>({ op: 'get', key }),
    put: (key, tile) => send<'stored' | 'quota'>({ op: 'put', key, tile }, [tile.bytes]),
    delete: (key) => send<undefined>({ op: 'delete', key }).then(() => undefined),
    deletePrefix: (prefix) => send<number>({ op: 'deletePrefix', prefix }),
    usage: () => send<StorageUsage>({ op: 'usage' }),
    close() {
      worker.terminate();
      fail('the cache store is closed');
    },
  };
}
