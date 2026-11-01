// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { NetworkPool } from '../scheduler/network-pool.js';
import { acquireWorkerPool } from '../scheduler/worker-pool.js';
import type { WorkerPoolLease } from '../scheduler/worker-pool-types.js';
import type { WorkerEndpointFactory } from '../scheduler/worker-protocol.js';
import type { RendererBackend } from './types.js';

/** The page's network pool, shared by every engine instance (ADR 0007: limits per host hold page-wide; F095). */
let pagePool: { pool: NetworkPool; users: number } | undefined;

/**
 * Takes a share of the page's network pool (also for render extensions on a globe without imagery, track D hook 4) and a
 * lease on the worker pool of `workers`, both on `host`'s clock and timers.
 */
export function acquirePools(
  workers: WorkerEndpointFactory,
  host: RendererBackend['host'],
): { network: NetworkPool; lease: WorkerPoolLease } {
  const timers = {
    set: (callback: () => void, delayMs: number) => host.setTimer(callback, delayMs),
    clear: (handle: unknown) => host.clearTimer(handle),
  };
  pagePool ??= {
    pool: new NetworkPool({ now: () => host.now(), setTimer: timers.set, clearTimer: timers.clear, adaptive: true }),
    users: 0,
  };
  pagePool.users++;
  return { network: pagePool.pool, lease: acquireWorkerPool(workers, { timers }) };
}

/** Releases a share of the network pool taken with {@link acquirePools}. */
export function releaseNetworkPool(pool: NetworkPool): void {
  if (pagePool?.pool !== pool || --pagePool.users > 0) return;
  pool.dispose();
  pagePool = undefined;
}
