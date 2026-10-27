// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { NetworkPool } from '../scheduler/network-pool.js';
import type { RendererBackend } from './types.js';

/** The page's network pool, shared by every engine instance (ADR 0007: limits per host hold page-wide; F095). */
let pagePool: { pool: NetworkPool; users: number } | undefined;

/** Takes a share of the page's network pool (also for render extensions on a globe without imagery, track D hook 4). */
export function acquireNetworkPool(host: RendererBackend['host']): NetworkPool {
  pagePool ??= {
    pool: new NetworkPool({
      now: () => host.now(),
      setTimer: (callback, delayMs) => host.setTimer(callback, delayMs),
      clearTimer: (handle) => host.clearTimer(handle),
      adaptive: true,
    }),
    users: 0,
  };
  pagePool.users++;
  return pagePool.pool;
}

/** Releases a share taken with {@link acquireNetworkPool}. */
export function releaseNetworkPool(pool: NetworkPool): void {
  if (pagePool?.pool !== pool || --pagePool.users > 0) return;
  pool.dispose();
  pagePool = undefined;
}
