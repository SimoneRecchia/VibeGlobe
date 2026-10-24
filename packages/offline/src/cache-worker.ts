// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The cache worker program (F273): hosts the IndexedDB tile store so its transactions run off the main thread. The
 * page talks to it through `workerStore()`.
 */
import { indexedDbStore } from './idb-store.js';
import type { CacheStore } from './types.js';
import type { CacheWorkerMessage, CacheWorkerRequest } from './worker-store.js';

interface WorkerScope {
  onmessage: ((event: MessageEvent<CacheWorkerRequest>) => void) | null;
  postMessage(message: CacheWorkerMessage, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
let store: CacheStore | undefined;

function storeFor(request: CacheWorkerRequest): CacheStore {
  if (request.op === 'init' || !store) {
    store?.close();
    store = indexedDbStore({
      ...(request.op === 'init' && request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
      ...(request.op === 'init' && request.database !== undefined ? { database: request.database } : {}),
      onLost: (reason) => scope.postMessage({ id: -1, lost: reason }),
    });
  }
  return store;
}

async function handle(request: CacheWorkerRequest): Promise<unknown> {
  const target = storeFor(request);
  switch (request.op) {
    case 'init':
      return (await target.usage()).bytes;
    case 'get':
      return target.get(request.key);
    case 'put':
      return target.put(request.key, request.tile);
    case 'delete':
      return target.delete(request.key);
    case 'deletePrefix':
      return target.deletePrefix(request.prefix);
    case 'usage':
      return target.usage();
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  handle(request).then(
    (value) => {
      const bytes = (value as { bytes?: unknown } | undefined)?.bytes;
      scope.postMessage({ id: request.id, ok: true, value }, bytes instanceof ArrayBuffer ? [bytes] : []);
    },
    (error: unknown) => scope.postMessage({ id: request.id, ok: false, error: String(error) }),
  );
};
