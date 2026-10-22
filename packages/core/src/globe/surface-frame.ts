import { DrawList, drawOnBaseImage } from '../imagery/draw-list.js';
import { DEFAULT_FADE_MS } from '../imagery/fades.js';
import {
  PHASE_SCHEDULING,
  PHASE_SELECTION,
  PHASE_UPDATE,
  PHASE_UPLOAD,
  type Observability,
} from '../diagnostics/observability.js';
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

/** ADR 0006's τ_imagery: the largest an imagery texel may look, in render-target pixels. */
const MAX_TEXEL_ERROR_PX = 1.5;

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
    maxTexelErrorPx: MAX_TEXEL_ERROR_PX,
  };
  private imagery: ImageryRuntime | undefined;

  private readonly fadeMs: number;
  /** The camera of the last traced move. */
  private lastCamera = '';
  /** Engine time of the frame being prepared, in an array so passing it boxes nothing (ADR 0018). */
  private readonly nowMs = new Float64Array(1);

  constructor(
    options: GlobeOptions,
    private readonly clock: { timeInto(out: Float64Array): void },
    private readonly observability: Observability,
  ) {
    this.selection.maxScreenErrorPx = options.maxScreenErrorPx ?? 1;
    this.selection.minLevel = options.minSurfaceLevel ?? 2;
    this.fadeMs = options.imageryFadeMs ?? DEFAULT_FADE_MS;
  }

  /**
   * Starts the options' tiled imagery, if any: from now on tiles refine until their texels are small enough (F081) and
   * are textured with the layers' tiles.
   */
  startImagery(options: GlobeOptions, renderer: RendererBackend, callbacks: ImageryCallbacks): void {
    const { imagery: sources, workers } = options;
    if (!sources || sources.length === 0 || !workers) return;
    const logger = this.observability.logger;
    const imagery = new ImageryRuntime(
      sources,
      workers,
      options.memory ?? {},
      renderer,
      {
        requestFrame: () => callbacks.requestFrame(),
        tileError: (event) => {
          logger.log('warn', `${event.sourceId}: tile ${event.level}/${event.x}/${event.y} ${event.reason}`);
          callbacks.tileError(event);
        },
      },
      this.observability,
    );
    this.imagery = imagery;
    this.selection.imageryTexelsPerTile = imagery.texelsPerTile;
    this.selection.imageryMaxLevel = imagery.maxLevel;
  }

  /** Selects this frame's tiles and returns their draws, fades at the clock's time included. */
  prepare(camera: Camera, cache: SurfaceCache): TileDrawList {
    const { timer, tracer } = this.observability;
    timer.end(PHASE_UPDATE);
    if (tracer.enabled) this.traceCamera(camera);
    this.clock.timeInto(this.nowMs);
    const count = selectQuadtreeTiles(camera, this.selection, this.tiles);
    this.draws.reserve(count);
    cache.prepare(this.tiles, count, this.draws.meshKeys);
    drawOnBaseImage(this.draws, this.tiles, count);
    timer.end(PHASE_SELECTION);
    if (this.imagery) {
      this.imagery.draw(this.draws, this.tiles, count, camera, this.nowMs, this.fadeMs, timer);
    } else {
      timer.end(PHASE_SCHEDULING);
      timer.end(PHASE_UPLOAD);
    }
    return this.draws;
  }

  /** Traces the camera's eye (ECEF meters) when it moved since the last traced frame (F121). */
  private traceCamera(camera: Camera): void {
    const eye = camera.eyeEcef;
    const subject = `${(eye[0] ?? 0).toFixed(1)},${(eye[1] ?? 0).toFixed(1)},${(eye[2] ?? 0).toFixed(1)}`;
    if (subject === this.lastCamera) return;
    this.lastCamera = subject;
    this.observability.tracer.record('camera', 'move', subject);
  }

  /**
   * Sets render-target pixels per CSS pixel (device pixel ratio × resolution scale): imagery texels are judged in
   * render-target pixels, so a sharper canvas gets finer imagery (F109, M3 plan §2.5).
   */
  setPixelRatio(pixelRatio: number): void {
    this.selection.maxTexelErrorPx = MAX_TEXEL_ERROR_PX / pixelRatio;
  }

  /** True once the pinned imagery base is resident (always without imagery): `ready` waits for it (F084). */
  get baseReady(): boolean {
    return this.imagery?.baseReady ?? true;
  }

  /** The imagery counters, if there is imagery. */
  imageryStats(): ImageryStats | undefined {
    return this.imagery?.stats();
  }

  /** True while a tile cross-fades: the next frame changes the picture (F105). */
  get fading(): boolean {
    return this.imagery?.fading ?? false;
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
