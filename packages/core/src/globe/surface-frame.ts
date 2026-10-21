import { DrawList, drawOnBaseImage } from '../imagery/draw-list.js';
import type { SurfaceCache } from '../surface/surface-cache.js';
import { selectQuadtreeTiles, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { Camera } from '../camera/camera.js';
import { describeSurfaceTiles, surfaceStats } from './diagnostics.js';
import { ImageryRuntime, type ImageryCallbacks } from './imagery-runtime.js';
import type {
  GlobeOptions,
  ImageryStats,
  RendererBackend,
  SurfaceStats,
  SurfaceTileInfo,
  TileDrawList,
} from './types.js';

/** Surface tile keys are exact integers up to level 25 (quadtreeTileKey). */
const MAX_LEVEL = 25;

/**
 * The surface part of a frame: selects the quadtree tiles for the camera, makes sure their meshes exist and fills the
 * draw list the renderer draws, reusing every array (ADR 0018). Keeps what the last drawn frame selected for the
 * diagnostics API.
 */
export class SurfaceFrame {
  private readonly tiles: QuadtreeTile[] = [];
  private readonly draws = new DrawList();
  private readonly selection = {
    maxScreenErrorPx: 1,
    maxLevel: MAX_LEVEL,
    minLevel: 2,
    imageryTexelsPerTile: 0,
    imageryMaxLevel: 0,
  };
  private imagery: ImageryRuntime | undefined;

  constructor(maxScreenErrorPx: number, minLevel: number) {
    this.selection.maxScreenErrorPx = maxScreenErrorPx;
    this.selection.minLevel = minLevel;
  }

  /**
   * Starts the options' tiled imagery, if any: from now on tiles refine until their texels are small enough (F081) and
   * are textured with the layers' tiles.
   */
  startImagery(options: GlobeOptions, renderer: RendererBackend, callbacks: ImageryCallbacks): void {
    const { imagery: sources, workers } = options;
    if (!sources || sources.length === 0 || !workers) return;
    const imagery = new ImageryRuntime(sources, workers, options.memory ?? {}, renderer, callbacks);
    this.imagery = imagery;
    this.selection.imageryTexelsPerTile = imagery.texelsPerTile;
    this.selection.imageryMaxLevel = imagery.maxLevel;
  }

  /** Selects this frame's tiles and returns their draws. */
  prepare(camera: Camera, cache: SurfaceCache): TileDrawList {
    const count = selectQuadtreeTiles(camera, this.selection, this.tiles);
    this.draws.reserve(count);
    cache.prepare(this.tiles, count, this.draws.meshKeys);
    drawOnBaseImage(this.draws, this.tiles, count);
    this.imagery?.draw(this.draws, this.tiles, count, camera);
    return this.draws;
  }

  /** True once the pinned imagery base is resident (always without imagery): `ready` waits for it (F084). */
  get baseReady(): boolean {
    return this.imagery?.baseReady ?? true;
  }

  /** The imagery counters, if there is imagery. */
  imageryStats(): ImageryStats | undefined {
    return this.imagery?.stats();
  }

  /** True while imagery the view wants is still loading. */
  get loading(): boolean {
    return this.imagery?.busy ?? false;
  }

  /** Stops loading imagery. */
  destroy(): void {
    this.imagery?.destroy();
    this.imagery = undefined;
  }

  /** Records that the prepared frame was drawn; returns its tile count. */
  drawn(): number {
    return this.draws.count;
  }

  /** The tiles of the last drawn frame (`Globe.surfaceTiles`). */
  describe(camera: Camera): SurfaceTileInfo[] {
    return describeSurfaceTiles(this.tiles, this.draws, camera, this.selection);
  }

  /** Selection counters of the last drawn frame (`Globe.surfaceStats`). */
  stats(): SurfaceStats {
    return surfaceStats(this.tiles, this.draws, this.selection);
  }
}
