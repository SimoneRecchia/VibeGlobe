import { rgba8Bytes } from '../cache/byte-size.js';
import { PHASE_SCHEDULING, PHASE_UPLOAD, type Observability, type PhaseTimer } from '../diagnostics/observability.js';
import { RamTier } from '../cache/ram-tier.js';
import { Residency } from '../cache/residency.hot.js';
import type { Camera } from '../camera/camera.js';
import { drawImagery, type ImageryLayer } from '../imagery/imagery-draws.js';
import { BASE_TEXTURE, type DrawList } from '../imagery/draw-list.js';
import { ImageryFades } from '../imagery/fades.js';
import {
  ImageryLoader,
  type ImageryLoaderOptions,
  type ImageryLoaderStats,
  type TileMemory,
} from '../imagery/imagery-loader.hot.js';
import { imageryDecodeTask, type ImagerySource, type TileSource } from '../imagery/imagery-source.js';
import { NetworkPool } from '../scheduler/network-pool.js';
import { acquireWorkerPool } from '../scheduler/worker-pool.js';
import type { WorkerPool, WorkerPoolLease } from '../scheduler/worker-pool-types.js';
import type { WorkerEndpointFactory } from '../scheduler/worker-protocol.js';
import type { QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { drawTerrain, type TerrainLayer } from '../terrain/terrain-draws.js';
import type { HeightGrid } from '../terrain/heightmap.js';
import type { TerrainSource } from '../terrain/terrain-source.js';
import type { ImageryStats, MemoryOptions, RendererBackend, TileErrorEvent } from './types.js';

/** Texture handles of layer `i` start at `i × HANDLES_PER_LAYER`. */
const HANDLES_PER_LAYER = 1 << 22;
/** ADR 0007's defaults: 512 MiB of GPU memory and 256 MiB of encoded tiles in RAM. */
const DEFAULT_GPU_BUDGET_BYTES = 512 * 1024 * 1024;
const DEFAULT_RAM_BUDGET_BYTES = 256 * 1024 * 1024;
/** Evictions per frame outside admissions (ADR 0007): at most 64 tiles or 1 ms. */
const TRIM_TILES = 64;
const TRIM_MS = 1;
/** Height-grid cells of a quantized-mesh tile, which has no grid of its own (ADR 0006 §5). */
const MESH_GRID_CELLS = 64;
/** Terrain tiles at this level and coarser form the terrain's pinned base: a few hundred kilobytes (F084). */
const TERRAIN_PINNED_LEVEL = 2;

/** The worker task of a terrain source's tiles; its grid adds at most half the level's geometric error (ADR 0006). */
function terrainDecodeTask(
  source: TerrainSource,
): (bytes: ArrayBuffer, contentType: string, level: number) => { task: string; input: unknown } {
  return (bytes, _contentType, level) => ({
    task: 'decode-terrain',
    input: {
      bytes,
      encoding: source.decoder.kind,
      maxErrorMeters: source.geometricErrorMeters(level) / 2,
      meshCells: MESH_GRID_CELLS,
    },
  });
}

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

/** What every loader of an engine instance shares. */
interface LoaderContext {
  readonly network: NetworkPool;
  readonly pool: WorkerPool;
  readonly shared: TileMemory;
  readonly renderer: RendererBackend;
  readonly callbacks: ImageryCallbacks;
  readonly observability: Observability | undefined;
}

/** A loader's options except its decode task. */
type LoaderBase = Omit<ImageryLoaderOptions, 'decodeTask'>;

/** The options of a loader of `source` whose texture handles start at `handleBase`. */
function loaderBase(context: LoaderContext, source: TileSource, handleBase: number, pinnedLevel: number): LoaderBase {
  const { renderer, callbacks, observability } = context;
  const host = renderer.host;
  return {
    source,
    network: context.network,
    workers: context.pool,
    memory: context.shared,
    handleBase,
    pinnedLevel,
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

/**
 * The imagery of one engine instance (M3 plan §2.3): a loader per layer over a network pool, a lease on the shared
 * worker pool, and the memory they share (GPU residency and RAM tier, ADR 0007). Each frame wants tiles between the
 * loaders' begin and end inside {@link ImageryRuntime.draw}.
 */
export class ImageryRuntime {
  readonly layers: ImageryLayer[];
  /** The terrain layer, when the engine has a terrain source (M4). */
  readonly terrain: TerrainLayer | undefined;
  /** The lowest and highest height of every terrain tile uploaded so far, meters (selection bounds, F142). */
  terrainMinMeters = 0;
  terrainMaxMeters = 0;
  /** Texels along a tile edge of the finest layer, for the selection's texel refinement. */
  readonly texelsPerTile: number;
  /** The finest level any layer serves. */
  readonly maxLevel: number;
  private readonly network: NetworkPool;
  private readonly lease: WorkerPoolLease;
  private readonly residency: Residency;
  private readonly ram: RamTier;
  private frame = 0;
  private readonly fades = new ImageryFades();
  /** Terrain height transitions (ADR 0006 §4, F138): the same mechanism as imagery's cross-fades. */
  private readonly terrainFades = new ImageryFades();
  /** Keeps a texture still faded from resident this frame. */
  private readonly keepTexture = (handle: number): void => {
    if (handle !== BASE_TEXTURE) this.loaderOf(handle)?.markDrawn(handle);
  };

  constructor(
    sources: readonly ImagerySource[],
    workers: WorkerEndpointFactory,
    memory: MemoryOptions,
    renderer: RendererBackend,
    callbacks: ImageryCallbacks,
    observability?: Observability,
    terrain?: TerrainSource,
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
    const context: LoaderContext = { network: this.network, pool, shared, renderer, callbacks, observability };
    const loaderOptions = (source: TileSource, index: number, pinnedLevel: number): LoaderBase =>
      loaderBase(context, source, index * HANDLES_PER_LAYER, pinnedLevel);
    this.layers = sources.map((source, index) => ({
      source,
      loader: new ImageryLoader({
        ...loaderOptions(source, index, pinned[index] ?? -1),
        decodeTask: imageryDecodeTask(source, renderer.capabilities.compressedTextureFormats),
      }),
    }));
    this.terrain = terrain && {
      source: terrain,
      loader: new ImageryLoader({
        ...loaderOptions(terrain, sources.length, Math.min(TERRAIN_PINNED_LEVEL, terrain.maxLevel)),
        uploadTexture: (handle, tile) => {
          renderer.uploadTexture(handle, tile);
          this.noteHeights(tile.image as HeightGrid);
        },
        decodeTask: terrainDecodeTask(terrain),
      }),
    };
    this.texelsPerTile = Math.max(0, ...sources.map((source) => source.tileSizePx));
    this.maxLevel = Math.max(0, ...sources.map((source) => source.maxLevel));
  }

  /** Widens the height range by a terrain tile's. */
  private noteHeights(grid: HeightGrid): void {
    if (grid.minMeters < this.terrainMinMeters) this.terrainMinMeters = grid.minMeters;
    if (grid.maxMeters > this.terrainMaxMeters) this.terrainMaxMeters = grid.maxMeters;
  }

  /** True while any layer still loads a wanted tile: `idle` waits for it (ADR 0007). */
  get busy(): boolean {
    for (const layer of this.layers) if (layer.loader.busy) return true;
    return this.terrain?.loader.busy ?? false;
  }

  /** True once every layer's pinned base is resident: the globe is complete when zoomed out (F084). */
  get baseReady(): boolean {
    for (const layer of this.layers) if (!layer.loader.pinnedComplete) return false;
    return this.terrain?.loader.pinnedComplete ?? true;
  }

  /** True while a tile of the last frame was cross-fading: the engine keeps drawing (F105). */
  get fading(): boolean {
    return this.fades.fading || this.terrainFades.fading;
  }

  /**
   * Wants the frame's imagery, writes the draws of the tiles it covers (the base image stays elsewhere) and their
   * cross-fades of `fadeMs` at engine time `nowMs[0]`.
   */
  draw(
    list: DrawList,
    tiles: readonly QuadtreeTile[],
    count: number,
    camera: Camera,
    nowMs: Float64Array,
    fadeMs: number,
    timer?: PhaseTimer,
  ): void {
    this.frame++;
    this.residency.startFrame(this.frame);
    for (const layer of this.layers) layer.loader.beginFrame();
    drawImagery(list, tiles, count, this.layers, camera);
    this.fades.apply(list, list.imageryLayer, nowMs, fadeMs, this.keepTexture);
    const terrain = this.terrain;
    if (terrain) {
      terrain.loader.beginFrame();
      drawTerrain(list, tiles, count, terrain, camera);
      this.terrainFades.apply(list, list.terrain, nowMs, fadeMs, this.keepTexture);
    }
    for (const layer of this.layers) layer.loader.scheduleRequests();
    terrain?.loader.scheduleRequests();
    timer?.end(PHASE_SCHEDULING);
    for (const layer of this.layers) layer.loader.drainUploads();
    terrain?.loader.drainUploads();
    timer?.end(PHASE_UPLOAD);
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
    this.terrain?.loader.addStats(loaders);
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
    this.terrain?.loader.destroy();
    releaseNetworkPool(this.network);
    this.lease.release();
    this.ram.clear();
  }

  private loaderOf(handle: number): ImageryLoader | undefined {
    const index = Math.floor(handle / HANDLES_PER_LAYER);
    return index === this.layers.length ? this.terrain?.loader : this.layers[index]?.loader;
  }
}
