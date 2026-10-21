import { drawImagery, type ImageryLayer } from '../imagery/imagery-draws.js';
import type { DrawList } from '../imagery/draw-list.js';
import { ImageryLoader } from '../imagery/imagery-loader.js';
import type { ImagerySource } from '../imagery/imagery-source.js';
import { NetworkPool } from '../scheduler/network-pool.js';
import { acquireWorkerPool } from '../scheduler/worker-pool.js';
import type { WorkerPoolLease } from '../scheduler/worker-pool-types.js';
import type { WorkerEndpointFactory } from '../scheduler/worker-protocol.js';
import type { Camera } from '../camera/camera.js';
import type { QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { RendererBackend } from './types.js';

/** Texture handles of layer `i` start at `i × HANDLES_PER_LAYER`. */
const HANDLES_PER_LAYER = 1 << 22;

/**
 * The imagery of one engine instance (M3 plan §2.3): a loader per layer over a network pool and a lease on the shared
 * worker pool. Each frame wants tiles between {@link ImageryRuntime.beginFrame} and {@link ImageryRuntime.endFrame}.
 */
export class ImageryRuntime {
  readonly layers: ImageryLayer[];
  /** Texels along a tile edge of the finest layer, for the selection's texel refinement. */
  readonly texelsPerTile: number;
  /** The finest level any layer serves. */
  readonly maxLevel: number;
  private readonly network: NetworkPool;
  private readonly lease: WorkerPoolLease;

  constructor(
    sources: readonly ImagerySource[],
    workers: WorkerEndpointFactory,
    renderer: RendererBackend,
    requestFrame: () => void,
  ) {
    const host = renderer.host;
    this.network = new NetworkPool({
      now: () => host.now(),
      setTimer: (callback, delayMs) => host.setTimer(callback, delayMs),
      clearTimer: (handle) => host.clearTimer(handle),
    });
    this.lease = acquireWorkerPool(workers, {
      timers: {
        set: (callback, delayMs) => host.setTimer(callback, delayMs),
        clear: (handle) => host.clearTimer(handle),
      },
    });
    const pool = this.lease.pool;
    this.layers = sources.map((source, index) => ({
      source,
      loader: new ImageryLoader({
        source,
        network: this.network,
        workers: pool,
        handleBase: index * HANDLES_PER_LAYER,
        uploadTexture: (handle, tile) => renderer.uploadTexture(handle, tile),
        requestFrame,
        now: () => host.now(),
        setTimer: (callback, delayMs) => host.setTimer(callback, delayMs),
        random: Math.random,
      }),
    }));
    this.texelsPerTile = Math.max(0, ...sources.map((source) => source.tileSizePx));
    this.maxLevel = Math.max(0, ...sources.map((source) => source.maxLevel));
  }

  /** True while any layer still loads a wanted tile: `idle` waits for it (ADR 0007). */
  get busy(): boolean {
    for (const layer of this.layers) if (layer.loader.busy) return true;
    return false;
  }

  /** Wants the frame's imagery and writes the draws of the tiles it covers (the base image stays elsewhere). */
  draw(list: DrawList, tiles: readonly QuadtreeTile[], count: number, camera: Camera): void {
    for (const layer of this.layers) layer.loader.beginFrame();
    drawImagery(list, tiles, count, this.layers, camera);
    for (const layer of this.layers) layer.loader.endFrame();
    this.lease.pool.update();
  }

  /** Cancels every request and task and releases the worker pool share. */
  destroy(): void {
    for (const layer of this.layers) layer.loader.destroy();
    this.network.dispose();
    this.lease.release();
  }
}
