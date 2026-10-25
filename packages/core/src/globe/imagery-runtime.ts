// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { DEFAULT_UPLOAD_BUDGET } from '../cache/upload-queue.hot.js';
import { FlightPreload } from './flight-preload.js';
import { applyPixelRatio } from './imagery-variants.js';
import { loaderBase, type LoaderBase, type LoaderContext } from './loader-context.js';
import { PHASE_SCHEDULING, PHASE_UPLOAD, type Observability, type PhaseTimer } from '../diagnostics/observability.js';
import { RamTier } from '../cache/ram-tier.js';
import { Residency } from '../cache/residency.hot.js';
import type { Camera } from '../camera/camera.js';
import { drawImagery, preloadImagery, stackOf, type ImageryLayer, type StackLayer } from '../imagery/imagery-draws.js';
import { pinnedLevels, type StackEntry } from '../imagery/imagery-stack.js';
import { runtimeCredits, warnOfProfile, type ImageryCallbacks, type RuntimeCredits } from './runtime-credits.js';
import { BASE_TEXTURE, type DrawList } from '../imagery/draw-list.js';
import { ImageryFades } from '../imagery/fades.js';
import { ImageryLoader, type DecodeTask, type TileMemory } from '../imagery/imagery-loader.hot.js';
import { imageryDecodeTask, type ImagerySource } from '../imagery/imagery-source.js';
import { NetworkPool } from '../scheduler/network-pool.js';
import { acquireWorkerPool } from '../scheduler/worker-pool.js';
import { acquireNetworkPool, releaseNetworkPool } from './page-network.js';
import type { WorkerPoolLease } from '../scheduler/worker-pool-types.js';
import type { WorkerEndpointFactory } from '../scheduler/worker-protocol.js';
import type { QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { stitchTerrainEdges } from '../terrain/terrain-stitch.hot.js';
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

/**
 * The imagery of one engine instance (M3 plan §2.3): a loader per layer over a network pool, a lease on the shared
 * worker pool, and the memory they share (GPU residency and RAM tier, ADR 0007). Each frame wants tiles between the
 * loaders' begin and end inside {@link ImageryRuntime.draw}.
 */
export class ImageryRuntime {
  /** Every source's loader; texture handles are allocated by each one's `index` (`Globe.imageryLayers.add`, A2). */
  readonly layers: ImageryLayer[];
  /** The imagery stack, bottom first (ADR 0038): changed in place by `Globe.imageryLayers` (move, add, remove). */
  readonly stack: StackLayer[];
  /** The credits of the sources in view (F254), built again when a layer is added or removed. */
  credits: RuntimeCredits;
  /** What a new loader shares with the others, the terrain's handle index and the next free one (A2). */
  readonly loaderContext: LoaderContext;
  readonly terrainIndex: number;
  nextIndex: number;
  /** The tiles of a running flight's destination, wanted every frame until it ends (F286). */
  readonly preload = new FlightPreload();
  /** The tiles of the view a flight will show in about a second, loaded instead of the current view's (F287). */
  readonly ahead = new FlightPreload();
  /** The last render-target pixels per CSS pixel, for layers added later (F241). */
  pixelRatio = 1;
  private readonly byIndex = new Map<number, ImageryLoader>();
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
  texelsPerTile: number;
  /** The finest surface level any layer serves. */
  maxLevel: number;
  /** The page's request pool, with the link it measures (F300). */
  readonly network: NetworkPool;
  /** The engine's share of the page's worker pool (render extensions run their tasks on it too). */
  readonly lease: WorkerPoolLease;
  private readonly residency: Residency;
  private readonly ram: RamTier;
  private frame = 0;
  private readonly fades = new ImageryFades();
  /** Terrain height transitions (ADR 0006 §4, F138): the same mechanism as imagery's cross-fades. */
  private readonly terrainFades = new ImageryFades();
  /** The overlay slots' cross-fades (KB-155). */
  private readonly overlayFades = [new ImageryFades(), new ImageryFades()];
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
    this.network.bandwidth.adaptive = callbacks.adaptiveRequests !== false;
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
    const pinned = pinnedLevels(entries, gpuBudgetBytes);
    const pool = this.lease.pool;
    const context: LoaderContext = { network: this.network, pool, shared, renderer, callbacks, observability };
    this.loaderContext = context;
    this.terrainIndex = sources.length;
    this.nextIndex = sources.length + 1;
    this.terrain =
      terrain &&
      this.terrainLayer(
        terrain,
        loaderBase(context, terrain, sources.length * HANDLES_PER_LAYER, TERRAIN_PINNED_LEVEL),
      );
    this.layers = sources.map((source, index) => this.newLayer(source, index, pinned[index] ?? -1));
    this.stack = stackOf(entries, this.layers);
    this.heights = this.terrain && new TerrainHeights(this.terrain);
    this.credits = this.creditsOf();
    this.texelsPerTile = Math.max(0, ...sources.map((source) => source.tileSizePx));
    this.maxLevel = Math.max(0, ...sources.map((source) => source.maxLevel));
  }

  /** A loader for `source` under the texture handles of `index`, pinning its base down to `pinnedLevel` (−1: none). */
  newLayer(source: ImagerySource, index: number, pinnedLevel: number): ImageryLayer {
    const formats = this.renderer.capabilities.compressedTextureFormats;
    const loader = new ImageryLoader({
      ...loaderBase(this.loaderContext, source, index * HANDLES_PER_LAYER, pinnedLevel),
      decodeTask: imageryDecodeTask(source, formats),
    });
    this.byIndex.set(index, loader);
    warnOfProfile(this.renderer, source, this.loaderContext.observability);
    return { source, loader, index };
  }

  /** Forgets a layer's loader: its tiles are released and its requests cancelled (`Globe.imageryLayers.remove`). */
  dropLayer(layer: ImageryLayer): void {
    layer.loader.reload();
    layer.loader.destroy();
    this.byIndex.delete(layer.index);
    this.layers.splice(this.layers.indexOf(layer), 1);
  }

  /** The credits of the current layers and the terrain, by handle index (holes where layers were removed). */
  creditsOf(): RuntimeCredits {
    const sources: (ImagerySource | TerrainSource | undefined)[] = [];
    for (const layer of this.layers) sources[layer.index] = layer.source;
    if (this.terrain) sources[this.terrainIndex] = this.terrain.source;
    const { renderer, callbacks, observability } = this.loaderContext;
    return runtimeCredits(sources, this.terrain ? this.terrainIndex : -1, renderer, callbacks, observability);
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
    const overlays = this.overlayFades;
    return (
      this.fades.fading || this.terrainFades.fading || overlays[0]?.fading === true || overlays[1]?.fading === true
    );
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
    if (this.ahead.count > 0) preloadImagery(this.stack, this.ahead.tiles, this.ahead.count);
    if (this.preload.count > 0) preloadImagery(this.stack, this.preload.tiles, this.preload.count);
    this.fades.apply(list, list.imageryLayer, nowMs, fadeMs, this.keepTexture);
    for (let slot = 0; slot < list.overlays.length; slot++) {
      const overlay = list.overlays[slot];
      if (overlay) this.overlayFades[slot]?.apply(list, overlay, nowMs, fadeMs, this.keepTexture);
    }
    const terrain = this.terrain;
    const host = this.renderer.host;
    let terrainStart = terrain ? host.now() : 0;
    if (terrain) {
      terrain.loader.beginFrame();
      drawTerrain(list, tiles, count, terrain, camera);
      this.terrainFades.apply(list, list.terrain, nowMs, fadeMs, this.keepTexture, MAX_TERRAIN_MORPH_LEVELS);
      recordShownTerrain(list, tiles, count, terrain);
      if (this.heights) deepenFallbackSkirts(list, tiles, count, terrain, this.heights);
      stitchTerrainEdges(list, tiles, count, terrain);
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
  readonly stackChanged = (): void => {
    this.fades.snapNext = true;
    for (const fades of this.overlayFades) fades.snapNext = true;
    this.callbacks.requestFrame();
  };
  /** The list of layers changed: added, removed or moved (`imagery-layers-change`). */
  readonly layersChanged = (): void => this.callbacks.layersChange?.();

  /** The counters of `Globe.terrainStats()`; undefined without terrain. */
  terrainStats(): TerrainStats | undefined {
    if (!this.terrain) return undefined;
    const loader = emptyLoaderStats();
    this.terrain.loader.addStats(loader);
    return terrainStatsOf(loader, DEFAULT_UPLOAD_BUDGET.maxBytes, this.terrainMs);
  }

  /** Picks the high-DPI variants and level shifts for render-target pixels per CSS pixel `pixelRatio` (F240, F241). */
  setPixelRatio(pixelRatio: number): void {
    this.pixelRatio = pixelRatio;
    Object.assign(this, applyPixelRatio(this.layers, pixelRatio));
  }

  /** Reloads the loaders of every layer, and the terrain, whose source has this id (`Globe.reloadSource`). */
  reloadSource(sourceId: string, missingOnly?: boolean): boolean {
    let found = false;
    for (const layer of this.layers)
      if (layer.source.id === sourceId) {
        layer.loader.reload(missingOnly);
        found = true;
      }
    if (this.terrain?.source.id === sourceId) {
      this.terrain.loader.reload(missingOnly);
      found = true;
    }
    return found;
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
      bandwidthBitsPerSecond: this.network.bandwidth.bitsPerSecond,
      latencyMs: this.network.bandwidth.latencyMs,
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
    return index === this.terrainIndex ? this.terrain?.loader : this.byIndex.get(index);
  }
}
