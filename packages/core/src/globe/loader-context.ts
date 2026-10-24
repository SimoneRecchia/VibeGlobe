// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Observability } from '../diagnostics/observability.js';
import type { ImageryLoaderOptions, TileMemory } from '../imagery/imagery-loader.hot.js';
import type { TileSource } from '../imagery/imagery-source.js';
import type { NetworkPool } from '../scheduler/network-pool.js';
import type { WorkerPool } from '../scheduler/worker-pool-types.js';
import type { ImageryCallbacks } from './runtime-credits.js';
import type { RendererBackend } from './types.js';

/** What every loader of an engine instance shares. */
export interface LoaderContext {
  readonly network: NetworkPool;
  readonly pool: WorkerPool;
  readonly shared: TileMemory;
  readonly renderer: RendererBackend;
  readonly callbacks: ImageryCallbacks;
  readonly observability: Observability | undefined;
}

/** A loader's options except its decode task. */
export type LoaderBase = Omit<ImageryLoaderOptions, 'decodeTask'>;

/** The options of a loader of `source` whose texture handles start at `handleBase`. */
export function loaderBase(
  context: LoaderContext,
  source: TileSource,
  handleBase: number,
  pinnedLevel: number,
): LoaderBase {
  const { renderer, callbacks, observability } = context;
  const host = renderer.host;
  return {
    source,
    network: context.network,
    workers: context.pool,
    memory: context.shared,
    handleBase,
    pinnedLevel,
    prefetchRing: true,
    ...(observability ? { observability } : {}),
    uploadTexture: (handle, tile) => renderer.uploadTexture(handle, tile),
    releaseTexture: (handle) => renderer.releaseTexture(handle),
    requestFrame: () => callbacks.requestFrame(),
    tileError: (failed, level, x, y, reason) => callbacks.tileError({ sourceId: failed.id, level, x, y, reason }),
    now: () => host.now(),
    setTimer: (callback, delayMs) => host.setTimer(callback, delayMs),
    random: Math.random,
  };
}
