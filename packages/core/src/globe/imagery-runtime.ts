import { rgba8Bytes } from '../cache/byte-size.js';
import { RamTier } from '../cache/ram-tier.js';
import { Residency } from '../cache/residency.hot.js';
import type { Camera } from '../camera/camera.js';
import { drawImagery, type ImageryLayer } from '../imagery/imagery-draws.js';
import type { DrawList } from '../imagery/draw-list.js';
import { ImageryLoader, type ImageryLoaderStats, type TileMemory } from '../imagery/imagery-loader.js';
import type { ImagerySource } from '../imagery/imagery-source.js';
import { NetworkPool } from '../scheduler/network-pool.js';
import { acquireWorkerPool } from '../scheduler/worker-pool.js';
import type { WorkerPoolLease } from '../scheduler/worker-pool-types.js';
import type { WorkerEndpointFactory } from '../scheduler/worker-protocol.js';
import type { QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { ImageryStats, MemoryOptions, RendererBackend, TileErrorEvent } from './types.js';

/** Texture handles of layer `i` start at `i × HANDLES_PER_LAYER`. */
const HANDLES_PER_LAYER = 1 << 22;
/** ADR 0007's defaults: 512 MiB of GPU memory and 256 MiB of encoded tiles in RAM. */
const DEFAULT_GPU_BUDGET_BYTES = 512 * 1024 * 1024;
const DEFAULT_RAM_BUDGET_BYTES = 256 * 1024 * 1024;
/** Evictions per frame outside admissions (ADR 0007): at most 64 tiles or 1 ms. */
const TRIM_TILES = 64;
const TRIM_MS = 1;

/** The page's network pool, shared by every engine instance (ADR 0007: limits per host hold page-wide; F095). */
let pagePool: { pool: NetworkPool; users: number } | undefined;

function acquireNetworkPool(host: RendererBackend['host']): NetworkPool {
  pagePool ??= {
    pool: new NetworkPool({
      now: () => host.now(),
      setTimer: (callback, delayMs) => host.setTimer(callback, delayMs),
      clearTimer: (handle) => host.clearTimer(handle),
    }),
    users: 0,
  };
  pagePool.users++;
  return pagePool.pool;
}

function releaseNetworkPool(pool: NetworkPool): void {
  if (pagePool?.pool !== pool || --pagePool.users > 0) return;
  pool.dispose();
  pagePool = undefined;
}

/** What the runtime reports to its engine instance. */
export interface ImageryCallbacks {
  /** Something arrived that changes the picture or the queue. */
  requestFrame(): void;
  /** A tile failed for good; its ancestors stay drawn (F112). */
  tileError(event: TileErrorEvent): void;
}

/**
 * The deepest pinned level of each source, coarse first across sources: levels 0..N whose cumulative GPU size keeps
 * the sum over every base source within 1/8 of the GPU budget (M3 plan §3, risk 8).
 */
function pinnedLevels(sources: readonly ImagerySource[], gpuBudgetBytes: number): number[] {
  const levels = sources.map(() => -1);
  let used = 0;
  for (let level = 0; level <= 25; level++) {
    let added = false;
    for (const [index, source] of sources.entries()) {
      if (levels[index] !== level - 1) continue;
      const tiles = source.tiling.rootTilesX * source.tiling.rootTilesY * 4 ** level;
      const bytes = tiles * rgba8Bytes(source.tileSizePx, source.tileSizePx);
      if (used + bytes > gpuBudgetBytes / 8) continue;
      used += bytes;
      levels[index] = level;
      added = true;
    }
    if (!added) break;
  }
  return levels;
}

/**
 * The imagery of one engine instance (M3 plan §2.3): a loader per layer over a network pool, a lease on the shared
 * worker pool, and the memory they share (GPU residency and RAM tier, ADR 0007). Each frame wants tiles between the
 * loaders' begin and end inside {@link ImageryRuntime.draw}.
 */
export class ImageryRuntime {
  readonly layers: ImageryLayer[];
  /** Texels along a tile edge of the finest layer, for the selection's texel refinement. */
  readonly texelsPerTile: number;
  /** The finest level any layer serves. */
  readonly maxLevel: number;
  private readonly network: NetworkPool;
  private readonly lease: WorkerPoolLease;
  private readonly residency: Residency;
  private readonly ram: RamTier;
  private frame = 0;

  constructor(
    sources: readonly ImagerySource[],
    workers: WorkerEndpointFactory,
    memory: MemoryOptions,
    renderer: RendererBackend,
    callbacks: ImageryCallbacks,
  ) {
    const host = renderer.host;
    this.network = acquireNetworkPool(host);
    this.lease = acquireWorkerPool(workers, {
      timers: {
        set: (callback, delayMs) => host.setTimer(callback, delayMs),
        clear: (handle) => host.clearTimer(handle),
      },
    });
    const gpuBudgetBytes = memory.gpuBudgetBytes ?? DEFAULT_GPU_BUDGET_BYTES;
    this.residency = new Residency({
      budgetBytes: gpuBudgetBytes,
      onEvict: (handle) => this.loaderOf(handle)?.evicted(handle % HANDLES_PER_LAYER),
      nowMs: () => host.now(),
    });
    // Dropping a tile's bytes drops its GPU copy too (ADR 0007 §Tiers), so tiles the frame keeps keep their bytes.
    this.ram = new RamTier({
      budgetBytes: memory.ramBudgetBytes ?? DEFAULT_RAM_BUDGET_BYTES,
      canEvict: (handle) => !this.residency.isKept(handle as number),
      onEvict: (handle) => {
        if (this.residency.release(handle as number))
          this.loaderOf(handle as number)?.evicted((handle as number) % HANDLES_PER_LAYER);
      },
    });
    const shared: TileMemory = { residency: this.residency, ram: this.ram, frame: () => this.frame };
    const pinned = pinnedLevels(sources, gpuBudgetBytes);
    const pool = this.lease.pool;
    this.layers = sources.map((source, index) => ({
      source,
      loader: new ImageryLoader({
        source,
        network: this.network,
        workers: pool,
        memory: shared,
        handleBase: index * HANDLES_PER_LAYER,
        pinnedLevel: pinned[index] ?? -1,
        compressedFormats: renderer.capabilities.compressedTextureFormats,
        uploadTexture: (handle, tile) => renderer.uploadTexture(handle, tile),
        releaseTexture: (handle) => renderer.releaseTexture(handle),
        requestFrame: () => callbacks.requestFrame(),
        tileError: (source, level, x, y, reason) => callbacks.tileError({ sourceId: source.id, level, x, y, reason }),
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

  /** True once every layer's pinned base is resident: the globe is complete when zoomed out (F084). */
  get baseReady(): boolean {
    for (const layer of this.layers) if (!layer.loader.pinnedComplete) return false;
    return true;
  }

  /** Wants the frame's imagery and writes the draws of the tiles it covers (the base image stays elsewhere). */
  draw(list: DrawList, tiles: readonly QuadtreeTile[], count: number, camera: Camera): void {
    this.frame++;
    this.residency.startFrame(this.frame);
    for (const layer of this.layers) layer.loader.beginFrame();
    drawImagery(list, tiles, count, this.layers, camera);
    for (const layer of this.layers) layer.loader.endFrame();
    this.residency.trim(this.frame, TRIM_TILES, TRIM_MS);
    this.lease.pool.update();
  }

  /** The counters of `Globe.imageryStats()`. */
  stats(): ImageryStats {
    const loaders: ImageryLoaderStats = {
      queued: 0,
      loading: 0,
      decoding: 0,
      ready: 0,
      failed: 0,
      noData: 0,
      requested: 0,
      uploads: 0,
      uploadMsLastFrame: 0,
      uploadBytesLastFrame: 0,
      uploadsPending: 0,
      pinnedSettled: 0,
      pinnedTotal: 0,
    };
    for (const layer of this.layers) layer.loader.addStats(loaders);
    return {
      ...loaders,
      gpuBytes: this.residency.usedBytes,
      gpuBudgetBytes: this.residency.budgetBytes,
      ramBytes: this.ram.usedBytes,
      ramBudgetBytes: this.ram.budgetBytes,
      ramHits: this.ram.hits,
      ramMisses: this.ram.misses,
      evicted: this.residency.evictedCount,
      refused: this.residency.refusedCount,
    };
  }

  /** Cancels every request and task and releases the worker pool share. */
  destroy(): void {
    for (const layer of this.layers) layer.loader.destroy();
    releaseNetworkPool(this.network);
    this.lease.release();
    this.ram.clear();
  }

  private loaderOf(handle: number): ImageryLoader | undefined {
    return this.layers[Math.floor(handle / HANDLES_PER_LAYER)]?.loader;
  }
}
