// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Clustering in a worker (F373, F375): the `cluster-*` tasks keep each index in the worker that built it, so the
 * {@link workerClusterEngine} runs them in a pool of its own with one worker (the shared pool may send consecutive
 * tasks to different workers). The engine's worker program loads these tasks on the first one.
 */
import {
  acquireWorkerPool,
  type TaskFunction,
  type TaskTable,
  type WorkerEndpointFactory,
  type WorkerPoolLease,
} from '@vibeglobe/core';
import { localClusterEngine, type ClusterEngine, type ClusterItem, type ClusterOptions } from './cluster.js';

const engines = new Map<number, ClusterEngine>();

function engineOf(id: number): ClusterEngine {
  const engine = engines.get(id);
  if (!engine) throw Object.assign(new Error(`no cluster index ${String(id)}`), { code: 'invalid-input' });
  return engine;
}

const task =
  (run: (input: { id: number; [key: string]: unknown }) => Promise<unknown> | unknown): TaskFunction =>
  async (input) => ({ output: await run(input as { id: number }), transfer: [] });

/** The worker tasks of clustering: load, items, expansion zoom, leaves and destroy, by index id. */
export const CLUSTER_TASKS: TaskTable = Object.freeze({
  'cluster-load': task(async ({ id, lonLatDeg, options }) => {
    const engine = engines.get(id) ?? localClusterEngine();
    engines.set(id, engine);
    await engine.load(lonLatDeg as Float64Array, options as ClusterOptions);
    return true;
  }),
  'cluster-items': task(({ id, zoom }) => engineOf(id).items(zoom as number)),
  'cluster-expansion': task(({ id, clusterId }) => engineOf(id).expansionZoom(clusterId as number)),
  'cluster-leaves': task(({ id, clusterId }) => engineOf(id).leaves(clusterId as number)),
  'cluster-destroy': task(({ id }) => {
    engines.get(id)?.destroy();
    return engines.delete(id);
  }),
});

let nextId = 0;
const TIMERS = {
  set: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A cluster engine in a worker of the engine's worker program (`createWorkers()` of `@vibeglobe/worker`): the index
 * is built and queried off the main thread.
 */
export function workerClusterEngine(workers: WorkerEndpointFactory): ClusterEngine {
  const id = ++nextId;
  let lease: WorkerPoolLease | undefined = acquireWorkerPool(
    { ...workers, url: `${workers.url}#cluster`, maxWorkers: 1 },
    { timers: TIMERS, maxWorkers: 1 },
  );
  const run = <T>(name: string, input: object, transfer: readonly object[] = []): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (!lease) return reject(new Error('the cluster engine was destroyed'));
      lease.pool.run({ task: name, input: { id, ...input }, transfer }, (outcome) =>
        outcome.ok ? resolve(outcome.output as T) : reject(new Error(outcome.error.message)),
      );
    });
  return {
    async load(lonLatDeg: Float64Array, options: ClusterOptions) {
      // A copy goes over, so the layer keeps its positions.
      const copy = lonLatDeg.slice();
      await run<boolean>('cluster-load', { lonLatDeg: copy, options }, [copy.buffer]);
    },
    items: (zoom: number) => run<readonly ClusterItem[]>('cluster-items', { zoom }),
    expansionZoom: (clusterId: number) => run<number>('cluster-expansion', { clusterId }),
    leaves: (clusterId: number) => run<readonly number[]>('cluster-leaves', { clusterId }),
    destroy() {
      if (!lease) return;
      void run('cluster-destroy', {}).finally(() => {
        lease?.release();
        lease = undefined;
      });
    },
  };
}
