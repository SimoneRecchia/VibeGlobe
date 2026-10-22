import { DrawList, drawOnBaseImage, drawWithoutTerrain } from '../imagery/draw-list.js';
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
import { ImageryRuntime, type AbortSignalLike, type ImageryCallbacks } from './imagery-runtime.js';
import type { ElevationSample } from '../terrain/terrain-heights.js';
import { validatePosition } from './validation.js';
import { displayedHeightMeters } from '../terrain/displayed-height.js';
import { TERRAIN_LEVEL_OFFSET, terrainErrorsBySurfaceLevel, terrainHeightRange } from '../terrain/terrain-draws.js';
import type {
  GeoPosition,
  GlobeOptions,
  ImageryStats,
  RendererBackend,
  SurfaceStats,
  SurfaceTileInfo,
  TerrainStats,
  TileDrawList,
} from './types.js';

const DEG_TO_RAD = Math.PI / 180;
/** The eye's default clearance above the displayed terrain (F146). */
const DEFAULT_CLEARANCE_METERS = 10;

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
    terrainErrorMeters: undefined as Float64Array | undefined,
    terrainMaxLevel: 0,
    terrainMinMeters: 0,
    terrainMaxMeters: 0,
    terrainRange: undefined as ((tile: QuadtreeTile, out: Float64Array) => boolean) | undefined,
  };
  private imagery: ImageryRuntime | undefined;

  private readonly fadeMs: number;
  private readonly clearanceMeters: number;
  /** The camera of the last traced move. */
  private lastCamera = '';
  /** A synchronous elevation query's position in radians, in an array so passing it boxes nothing (ADR 0018). */
  private readonly queryRad = new Float64Array(2);
  /** The finest resident terrain under the eye, each frame. */
  private readonly eyeGround: ElevationSample = { heightMeters: 0, level: -1, noData: true };
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
    this.clearanceMeters = options.terrainClearanceMeters ?? DEFAULT_CLEARANCE_METERS;
  }

  /**
   * Starts the options' tiled imagery, if any: from now on tiles refine until their texels are small enough (F081) and
   * are textured with the layers' tiles.
   */
  startImagery(options: GlobeOptions, renderer: RendererBackend, callbacks: ImageryCallbacks): void {
    const { imagery: sources = [], terrain, workers } = options;
    if ((sources.length === 0 && !terrain) || !workers) return;
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
      terrain,
    );
    this.imagery = imagery;
    this.selection.imageryTexelsPerTile = imagery.texelsPerTile;
    this.selection.imageryMaxLevel = imagery.maxLevel;
    if (terrain) {
      this.selection.terrainErrorMeters = terrainErrorsBySurfaceLevel(terrain, MAX_LEVEL);
      this.selection.terrainMaxLevel = Math.min(MAX_LEVEL, terrain.maxLevel + TERRAIN_LEVEL_OFFSET);
      const { terrain: layer, heights } = imagery;
      if (layer && heights) this.selection.terrainRange = (tile, out) => terrainHeightRange(layer, heights, tile, out);
    }
  }

  /** The error of the terrain each surface level shows, once terrain is started (skirt depths, ADR 0006 §6). */
  get terrainErrorMeters(): Float64Array | undefined {
    return this.selection.terrainErrorMeters;
  }

  /**
   * Keeps the eye at least the clearance above the surface as this frame shows it (F146, F147): the camera's target is
   * raised along its normal by what the eye lacks, and lowered back to the ellipsoid when nothing is in the way.
   * Returns true when the pose changed (the camera needs an update). Allocates nothing.
   */
  keepAboveTerrain(camera: Camera): boolean {
    const heights = this.imagery?.heights;
    if (!heights) return false;
    const pose = camera.pose;
    const eye = camera.eyeGeodetic;
    const lift = pose.targetHeightMeters;
    const drawn = displayedHeightMeters(this.draws, this.tiles, heights, eye.longitudeRad, eye.latitudeRad);
    // The finest resident terrain under the eye: the eye never goes below it, even while the frame still shows coarser
    // relief there or draws nothing there (F146); the clearance is kept above the displayed surface, so finer terrain
    // lifts the eye as it morphs in (F147).
    this.queryRad[0] = eye.longitudeRad;
    this.queryRad[1] = eye.latitudeRad;
    const finest = heights.sampleAt(this.queryRad, this.eyeGround).heightMeters;
    const surface = drawn === drawn ? drawn : finest;
    camera.groundHeightMeters = surface;
    const floor = surface + this.clearanceMeters > finest ? surface + this.clearanceMeters : finest;
    const needed = floor - (eye.heightMeters - lift);
    const next = needed > 0 ? needed : 0;
    if (next === lift) return false;
    pose.targetHeightMeters = next;
    return true;
  }

  /** Selects this frame's tiles and returns their draws, fades at the clock's time included. */
  prepare(camera: Camera, cache: SurfaceCache): TileDrawList {
    const { timer, tracer } = this.observability;
    timer.end(PHASE_UPDATE);
    if (tracer.enabled) this.traceCamera(camera);
    this.clock.timeInto(this.nowMs);
    if (this.imagery) {
      this.selection.terrainMinMeters = this.imagery.terrainMinMeters;
      this.selection.terrainMaxMeters = this.imagery.terrainMaxMeters;
    }
    const count = selectQuadtreeTiles(camera, this.selection, this.tiles);
    this.draws.reserve(count);
    cache.prepare(this.tiles, count, this.draws.meshKeys);
    drawOnBaseImage(this.draws, this.tiles, count);
    drawWithoutTerrain(this.draws, count);
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

  /**
   * The height at a WGS84 position from the terrain in memory (F144); the ellipsoid, flagged no-data, without terrain.
   * Throws a GlobeError ('invalid-coordinate') for an invalid position.
   */
  elevationAt(position: GeoPosition, out: ElevationSample): ElevationSample {
    validatePosition(position);
    const heights = this.imagery?.heights;
    if (heights) {
      this.queryRad[0] = position.longitudeDeg * DEG_TO_RAD;
      this.queryRad[1] = position.latitudeDeg * DEG_TO_RAD;
      return heights.sampleAt(this.queryRad, out);
    }
    out.heightMeters = 0;
    out.level = -1;
    out.noData = true;
    return out;
  }

  /** The height at a WGS84 position from the finest terrain the source delivers (F145). */
  queryElevation(position: GeoPosition, signal?: AbortSignalLike): Promise<ElevationSample> {
    validatePosition(position);
    const imagery = this.imagery;
    if (imagery?.heights)
      return imagery.queryElevation(position.longitudeDeg * DEG_TO_RAD, position.latitudeDeg * DEG_TO_RAD, signal);
    return Promise.resolve({ heightMeters: 0, level: -1, noData: true });
  }

  /** The imagery counters, if there is imagery. */
  imageryStats(): ImageryStats | undefined {
    return this.imagery?.stats();
  }

  /** The terrain counters, if there is terrain. */
  terrainStats(): TerrainStats | undefined {
    return this.imagery?.terrainStats();
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
