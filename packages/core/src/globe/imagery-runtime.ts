import { rgba8Bytes } from '../cache/byte-size.js';
import { DEFAULT_UPLOAD_BUDGET } from '../cache/upload-queue.hot.js';
import { PHASE_SCHEDULING, PHASE_UPLOAD, type Observability, type PhaseTimer } from '../diagnostics/observability.js';
import { RamTier } from '../cache/ram-tier.js';
import { Residency } from '../cache/residency.hot.js';
import type { Camera } from '../camera/camera.js';
import { drawImagery, stackOf, type ImageryLayer, type StackLayer } from '../imagery/imagery-draws.js';
import type { StackEntry } from '../imagery/imagery-stack.js';
import { runtimeCredits, type ImageryCallbacks, type RuntimeCredits } from './runtime-credits.js';
import { BASE_TEXTURE, type DrawList } from '../imagery/draw-list.js';
import { ImageryFades } from '../imagery/fades.js';
import {
  ImageryLoader,
  type DecodeTask,
  type ImageryLoaderOptions,
  type TileMemory,
} from '../imagery/imagery-loader.hot.js';
import { imageryDecodeTask, type ImagerySource, type TileSource } from '../imagery/imagery-source.js';
import { NetworkPool } from '../scheduler/network-pool.js';
import { acquireWorkerPool } from '../scheduler/worker-pool.js';
import type { WorkerPool, WorkerPoolLease } from '../scheduler/worker-pool-types.js';
import type { WorkerEndpointFactory } from '../scheduler/worker-protocol.js';
import type { QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import {
  drawTerrain,
  recordShownTerrain,
  gridErrorsByLevel,
  MAX_TERRAIN_MORPH_LEVELS,
  deepenFallbackSkirts,
  ShownLevels,
  type TerrainLayer,
} from '../terrain/terrain-draws.js';
import type { HeightGrid } from '../terrain/heightmap.js';
import { heightTile } from '../terrain/height-tile.js';
import { toEllipsoidal } from '../terrain/vertical-datum.js';
import type { TileCoord } from '../tiling/tile-key.js';
import { FINEST_FAILED, TerrainHeights, type ElevationSample } from '../terrain/terrain-heights.js';
import { emptyLoaderStats, terrainStatsOf } from './diagnostics.js';
import { GlobeError } from './errors.js';
import type { TerrainSource } from '../terrain/terrain-source.js';
import type { ImageryStats, MemoryOptions, RendererBackend, TerrainStats } from './types.js';

/** Texture handles of layer `i` start at `i × HANDLES_PER_LAYER`. */
const HANDLES_PER_LAYER = 1 << 22;
/** ADR 0007's defaults: 512 MiB of GPU memory and 256 MiB of encoded tiles in RAM. */
const DEFAULT_GPU_BUDGET_BYTES = 512 * 1024 * 1024;
const DEFAULT_RAM_BUDGET_BYTES = 256 * 1024 * 1024;
/** Evictions per frame outside admissions (ADR 0007): at most 64 tiles or 1 ms. */
const TRIM_TILES = 64;
const TRIM_MS = 1;
/** The extent of a terrain tile being converted to ellipsoidal heights. */
const extent = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };

/** Elevation queries load at the priority class after visible tiles (ADR 0007). */
const ELEVATION_QUERY_CLASS = 2 * 1024;

/** The part of `AbortSignal` the engine uses; core has no DOM types. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** An asynchronous elevation query waiting for its finest tile. */
interface PendingElevation {
  readonly lonRad: number;
  readonly latRad: number;
  readonly resolve: (sample: ElevationSample) => void;
  readonly reject: (error: GlobeError) => void;
  readonly signal: AbortSignalLike | undefined;
  onAbort: () => void;
}

/** Height-grid cells of a quantized-mesh tile, which has no grid of its own (ADR 0006 §5). */
const MESH_GRID_CELLS = 64;
/** Terrain tiles at this level and coarser form the terrain's pinned base: a few hundred kilobytes (F084). */
const TERRAIN_PINNED_LEVEL = 2;

/**
 * How a terrain source's tiles decode: built-in encodings in the worker pool, their grid adding at most half the
 * level's geometric error (ADR 0006); a custom decoder inline between frames (ADR 0027, F132).
 */
function terrainDecodeTask(
  source: TerrainSource,
): (bytes: ArrayBuffer, contentType: string, coord: TileCoord) => DecodeTask {
  const decoder = source.decoder;
  return (bytes, _contentType, coord) => {
    if (decoder.kind === 'custom') {
      return { task: 'custom-terrain', input: undefined, run: () => heightTile(decoder.decode(bytes, coord)) };
    }
    return {
      task: 'decode-terrain',
      input: {
        bytes,
        encoding: decoder.kind,
        maxErrorMeters: source.geometricErrorMeters(coord.level) / 2,
        meshCells: MESH_GRID_CELLS,
      },
    };
  };
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
  /** Every source's loader, in the order of the stack's chains (texture handles are allocated by this index). */
  readonly layers: ImageryLayer[];
  /** The imagery stack, bottom first (ADR 0038): reordered in place by `Globe.imageryLayers.move`. */
  readonly stack: StackLayer[];
  /** The credits of the sources in view (F254). */
  readonly credits: RuntimeCredits;
  /** The terrain layer, when the engine has a terrain source (M4). */
  readonly terrain: TerrainLayer | undefined;
  /** The resident terrain grids, for elevation queries (F144, F145). */
  readonly heights: TerrainHeights | undefined;
  private readonly elevationQueries: PendingElevation[] = [];
  /** The lowest and highest height of every terrain tile uploaded so far, meters (selection bounds, F142). */
  terrainMinMeters = 0;
  terrainMaxMeters = 0;
  /** Main-thread milliseconds the last frame spent on terrain (F134). */
  private terrainMs = 0;
  /** Main-thread terrain work done since the last frame outside `draw` (F134): charged to the next frame's time. */
  private chargedMs = 0;
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
    entries: readonly StackEntry[],
    workers: WorkerEndpointFactory,
    memory: MemoryOptions,
    private readonly renderer: RendererBackend,
    private readonly callbacks: ImageryCallbacks,
    observability?: Observability,
    terrain?: TerrainSource,
  ) {
    const host = renderer.host;
    const sources = entries.flatMap((entry) => entry.sources);
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
    this.terrain = terrain && this.terrainLayer(terrain, loaderOptions(terrain, sources.length, TERRAIN_PINNED_LEVEL));
    this.layers = sources.map((source, index) => ({
      source,
      loader: new ImageryLoader({
        ...loaderOptions(source, index, pinned[index] ?? -1),
        decodeTask: imageryDecodeTask(source, renderer.capabilities.compressedTextureFormats),
      }),
      index,
    }));
    this.stack = stackOf(entries, this.layers);
    this.heights = this.terrain && new TerrainHeights(this.terrain);
    this.credits = runtimeCredits(sources, terrain, renderer, callbacks, observability);
    this.texelsPerTile = Math.max(0, ...sources.map((source) => source.tileSizePx));
    this.maxLevel = Math.max(0, ...sources.map((source) => source.maxLevel));
  }

  /** The terrain layer: its loader keeps CPU copies of the grids for queries and widens the height range. */
  private terrainLayer(source: TerrainSource, base: LoaderBase): TerrainLayer {
    const renderer = this.renderer;
    return {
      source,
      shown: new ShownLevels(),
      gridErrorMeters: gridErrorsByLevel(source),
      loader: new ImageryLoader({
        ...base,
        pinnedLevel: Math.min(base.pinnedLevel, source.maxLevel),
        uploadTexture: (handle, tile) => {
          renderer.uploadTexture(handle, tile);
          const grid = tile.image as HeightGrid;
          this.heights?.add(handle, grid);
          this.noteHeights(grid);
        },
        releaseTexture: (handle) => {
          renderer.releaseTexture(handle);
          this.heights?.remove(handle);
        },
        decodeTask: terrainDecodeTask(source),
        onDecoded: (coord, tile) => {
          const metadata = (tile.image as { metadata?: unknown }).metadata;
          if (metadata !== undefined) source.tileMetadata?.(coord, metadata);
          // Geoid heights become ellipsoidal before upload and queries (F133): a few thousand lookups per tile.
          if (source.datum.kind === 'geoid') {
            const start = renderer.host.now();
            const e = source.tiling.tileExtent(coord, extent);
            const mercator = source.tiling.crs === 'EPSG:3857';
            const grid = tile.image as HeightGrid;
            const converted = toEllipsoidal(grid, source.datum, e.westRad, e.southRad, e.eastRad, e.northRad, mercator);
            (tile as { image: unknown }).image = { ...grid, ...converted };
            this.chargedMs += renderer.host.now() - start;
          }
        },
      }),
    };
  }

  /**
   * Resolves with the height at a position from the finest terrain the source delivers there, loading it first
   * (F145): rejects with a GlobeError 'resource-failed' when that tile fails for good, 'aborted' when `signal` aborts.
   */
  queryElevation(lonRad: number, latRad: number, signal?: AbortSignalLike): Promise<ElevationSample> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new GlobeError('aborted', 'The elevation query was aborted'));
        return;
      }
      const query: PendingElevation = { lonRad, latRad, resolve, reject, signal, onAbort: () => undefined };
      query.onAbort = () => {
        const index = this.elevationQueries.indexOf(query);
        if (index >= 0) this.elevationQueries.splice(index, 1);
        reject(new GlobeError('aborted', 'The elevation query was aborted'));
      };
      signal?.addEventListener('abort', query.onAbort);
      this.elevationQueries.push(query);
      this.callbacks.requestFrame();
    });
  }

  /** Wants the tiles of pending elevation queries and settles those whose finest tile is resident or failed. */
  private serveElevationQueries(): void {
    const heights = this.heights;
    if (!heights || this.elevationQueries.length === 0) return;
    for (let i = this.elevationQueries.length - 1; i >= 0; i--) {
      const query = this.elevationQueries[i];
      if (!query) continue;
      const finest = heights.wantFinest(query.lonRad, query.latRad, ELEVATION_QUERY_CLASS);
      if (finest >= 0) continue;
      this.elevationQueries.splice(i, 1);
      query.signal?.removeEventListener('abort', query.onAbort);
      if (finest === FINEST_FAILED) {
        query.reject(new GlobeError('resource-failed', 'The terrain tile of the elevation query failed to load'));
      } else {
        query.resolve(heights.sample(query.lonRad, query.latRad, { heightMeters: 0, level: -1, noData: true }));
      }
    }
    // Queries are served between frames: one still waiting asks for the next, even when nothing else changes on screen
    // (a level that turned out to have no data moves the query to the next coarser one).
    if (this.elevationQueries.length > 0) this.callbacks.requestFrame();
  }

  /** Widens the height range by a terrain tile's. */
  private noteHeights(grid: HeightGrid): void {
    if (grid.minMeters < this.terrainMinMeters) this.terrainMinMeters = grid.minMeters;
    if (grid.maxMeters > this.terrainMaxMeters) this.terrainMaxMeters = grid.maxMeters;
  }

  /** The engine's time now, milliseconds. */
  now(): number {
    return this.renderer.host.now();
  }

  /** Adds main-thread terrain work done outside `draw` (selection relief ranges, collision) to its time (F134). */
  chargeTerrainMs(ms: number): void {
    this.chargedMs += ms;
  }

  /** True while any layer still loads a wanted tile or an elevation query waits: `idle` waits for it (ADR 0007). */
  get busy(): boolean {
    if (this.elevationQueries.length > 0) return true;
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
    drawImagery(list, tiles, count, this.stack, camera, this.credits.visible);
    this.fades.apply(list, list.imageryLayer, nowMs, fadeMs, this.keepTexture);
    const terrain = this.terrain;
    const host = this.renderer.host;
    let terrainStart = terrain ? host.now() : 0;
    if (terrain) {
      terrain.loader.beginFrame();
      drawTerrain(list, tiles, count, terrain, camera);
      this.terrainFades.apply(list, list.terrain, nowMs, fadeMs, this.keepTexture, MAX_TERRAIN_MORPH_LEVELS);
      recordShownTerrain(list, tiles, count, terrain);
      if (this.heights) deepenFallbackSkirts(list, tiles, count, terrain, this.heights);
      this.serveElevationQueries();
      this.terrainMs = host.now() - terrainStart + this.chargedMs;
      this.chargedMs = 0;
    }
    this.credits.afterFrame(list, count);
    for (const layer of this.layers) layer.loader.scheduleRequests();
    terrainStart = terrain ? host.now() : 0;
    terrain?.loader.scheduleRequests();
    if (terrain) this.terrainMs += host.now() - terrainStart;
    timer?.end(PHASE_SCHEDULING);
    for (const layer of this.layers) layer.loader.drainUploads();
    terrainStart = terrain ? host.now() : 0;
    terrain?.loader.drainUploads();
    if (terrain) this.terrainMs += host.now() - terrainStart;
    timer?.end(PHASE_UPLOAD);
    this.residency.trim(this.frame, TRIM_TILES, TRIM_MS);
    this.lease.pool.update();
  }

  /** Terrain tiles uploaded so far (0 without terrain), without allocating: it is read every frame. */
  terrainUploads(): number {
    return this.terrain?.loader.uploadedCount ?? 0;
  }

  /** A change of the imagery stack: the next frame shows it at once, without cross-fades (F243). */
  readonly stackChanged = (): void => ((this.fades.snapNext = true), this.callbacks.requestFrame());

  /** The counters of `Globe.terrainStats()`; undefined without terrain. */
  terrainStats(): TerrainStats | undefined {
    if (!this.terrain) return undefined;
    const loader = emptyLoaderStats();
    this.terrain.loader.addStats(loader);
    return terrainStatsOf(loader, DEFAULT_UPLOAD_BUDGET.maxBytes, this.terrainMs);
  }

  /** The counters of `Globe.imageryStats()`. */
  stats(): ImageryStats {
    const loaders = emptyLoaderStats();
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
    this.renderer.host.showCredits?.([]);
    for (const layer of this.layers) layer.loader.destroy();
    this.terrain?.loader.destroy();
    for (const query of this.elevationQueries.splice(0)) {
      query.signal?.removeEventListener('abort', query.onAbort);
      query.reject(new GlobeError('destroyed', 'The globe was destroyed'));
    }
    releaseNetworkPool(this.network);
    this.lease.release();
    this.ram.clear();
  }

  private loaderOf(handle: number): ImageryLoader | undefined {
    const index = Math.floor(handle / HANDLES_PER_LAYER);
    return index === this.layers.length ? this.terrain?.loader : this.layers[index]?.loader;
  }
}
