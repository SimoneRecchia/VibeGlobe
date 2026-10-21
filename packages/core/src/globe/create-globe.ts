import { solveAnchor } from '../camera/anchor.js';
import { Camera } from '../camera/camera.js';
import { projectToScreen } from '../camera/projection.js';
import { groundZoomFromMercatorZoom, mercatorZoomFromGroundZoom } from '../camera/zoom.js';
import { geodeticToEcef, type GeodeticRad } from '../geodesy/ecef.js';
import { wrapLongitudeRad } from '../projections/longitude.js';
import { SurfaceCache } from '../surface/surface-cache.js';
import { selectSurfaceTiles, type SurfaceTile } from '../surface/surface-selection.hot.js';
import { applyView, clampRange, currentView, readCameraState, wrapDegrees } from './camera-state.js';
import { Emitter } from './emitter.js';
import { GlobeError } from './errors.js';
import { buildDebugMesh } from './debug-mesh.js';
import type {
  BackendName,
  DebugShape,
  RendererStats,
  CameraState,
  Controls,
  GeoPosition,
  Globe,
  GlobeEvents,
  GlobeOptions,
  NavigationApi,
  RendererBackend,
  RendererCapabilities,
  RendererEvents,
  ResourceCounts,
  ScreenPoint,
  ViewInit,
} from './types.js';
import { DEFAULT_VIEW, validateOptions, validateView, type ValidView } from './validation.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
/** Surface tile keys are exact integers up to level 25 (surfaceTileKey). */
const MAX_LEVEL = 25;

/**
 * Creates a globe engine instance in a container (architecture §2). The returned object is usable at once; `ready`
 * resolves after the first complete frame. Invalid options throw a GlobeError synchronously.
 */
export function createGlobe(options: GlobeOptions): Globe {
  return new GlobeEngine(validateOptions(options));
}

class GlobeEngine implements Globe {
  readonly ready: Promise<void>;
  readonly navigation: NavigationApi;
  private readonly emitter = new Emitter<GlobeEvents>();
  private readonly cam = new Camera();
  private readonly tiles: SurfaceTile[] = [];
  private readonly keys: number[] = [];
  private renderer: RendererBackend | undefined;
  private surface: SurfaceCache | undefined;
  private controls: Controls | undefined;
  private readonly cleanups: (() => void)[] = [];
  private frameId: number | undefined;
  private frames = 0;
  private readonly framePayload = { frameNumber: 0, tiles: 0 };
  private readonly idlePayload = { frameNumber: 0 };
  private readonly selection = { maxScreenErrorPx: 1, maxLevel: MAX_LEVEL };
  /**
   * Bound once, so scheduling a frame allocates no closure; a bound method rather than an arrow function, so no wrapper
   * function has to wait for the optimizing compiler (it is called only once per frame).
   */
  private readonly onFrame: () => void = this.frame.bind(this);
  private dirty = true;
  private visible = true;
  private imageryLoaded = false;
  private destroyed = false;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: GlobeError) => void) | undefined;
  /** The requested view until the renderer gives the viewport its size; then the camera holds it. */
  private pendingView: ValidView | undefined;
  /** True while a frame runs, so a size change found by its own check does not start a nested frame. */
  private inFrame = false;
  private resolutionScale: number;
  private readonly frameView = {
    view: this.cam.view,
    projection: this.cam.projection,
    eyeEcef: this.cam.eyeEcef,
    widthPx: 1,
    heightPx: 1,
    pixelRatio: 1,
  };

  constructor(private readonly options: GlobeOptions) {
    this.resolutionScale = options.resolutionScale ?? 1;
    this.selection.maxScreenErrorPx = options.maxScreenErrorPx ?? 1;
    this.pendingView = validateView(options.view ?? {}, DEFAULT_VIEW);
    this.navigation = {
      // Input plug-ins call these every frame: invalid input is ignored, never thrown.
      grab: (point) => (this.validPoint(point) ? this.pick(point) : undefined),
      dragTo: (anchor, point) => this.dragTo(anchor, point),
      zoomAt: (point, deltaZoom) => this.zoomAt(point, deltaZoom),
    };
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.start().catch((error: unknown) => {
        const globeError =
          error instanceof GlobeError
            ? error
            : new GlobeError('renderer-failed', 'The renderer failed to start', { cause: error });
        this.emitter.emit('error', globeError);
        reject(globeError);
      });
    });
    // Callers that never await `ready` must not see an unhandled rejection; the error event reports it.
    this.ready.catch(() => undefined);
  }

  get backend(): BackendName | undefined {
    return this.renderer?.capabilities.backend;
  }

  get capabilities(): RendererCapabilities | undefined {
    return this.renderer?.capabilities;
  }

  get camera(): CameraState {
    const pending = this.pendingView;
    if (!pending) return readCameraState(this.cam);
    // Before the viewport has a size, range and altitude are unknown (types.ts, Globe.camera).
    return {
      longitudeDeg: wrapDegrees(pending.longitudeDeg),
      latitudeDeg: pending.latitudeDeg,
      zoom: pending.zoom,
      altitudeMeters: Number.NaN,
      headingDeg: wrapDegrees(pending.headingDeg),
      tiltDeg: pending.tiltDeg,
      rollDeg: 0,
      rangeMeters: Number.NaN,
    };
  }

  get frameNumber(): number {
    return this.frames;
  }

  private async start(): Promise<void> {
    const events: RendererEvents = {
      deviceLost: (reason) => this.emitter.emit('device-lost', { reason }),
      deviceRestored: () => {
        this.emitter.emit('device-restored', {});
        this.requestRender();
      },
      backendFallback: (reason) => this.emitter.emit('backend-fallback', { reason }),
      failed: (error) => this.emitter.emit('error', error),
    };
    const renderer = await this.options.renderer(this.options.container, events);
    if (this.destroyed) {
      renderer.destroy();
      return;
    }
    this.renderer = renderer;
    this.surface = new SurfaceCache(renderer);
    this.syncSize();
    applyView(this.cam, this.pendingView ?? currentView(this.cam));
    this.pendingView = undefined;
    this.cleanups.push(
      renderer.host.observeSize(() => {
        this.syncSize();
        // A size change found by a frame's own check is drawn by that frame; any other is drawn right away, in the
        // resize callback, so the browser never paints the cleared canvas (KB-013).
        if (!this.inFrame) this.renderNow();
      }),
      renderer.host.observeVisibility((visible) => {
        this.visible = visible;
        if (visible) this.requestRender();
      }),
    );
    if (this.options.controls) this.controls = this.options.controls(renderer.inputElement, this.navigation);
    await renderer.setBaseImagery(this.options.baseImageryUrl);
    if (this.destroyed) return;
    this.imageryLoaded = true;
    this.requestRender();
  }

  private syncSize(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const { widthPx, heightPx } = renderer.host.containerSize();
    const pixelRatio = renderer.host.pixelRatio() * this.resolutionScale;
    this.cam.widthPx = Math.max(1, widthPx);
    this.cam.heightPx = Math.max(1, heightPx);
    this.frameView.widthPx = this.cam.widthPx;
    this.frameView.heightPx = this.cam.heightPx;
    this.frameView.pixelRatio = pixelRatio;
    renderer.resize(this.cam.widthPx, this.cam.heightPx, pixelRatio);
    this.dirty = true;
  }

  /** Draws a frame now when one can be drawn (instead of on the next display frame), else requests one. */
  private renderNow(): void {
    const renderer = this.renderer;
    if (!renderer || !this.visible || !this.imageryLoaded) {
      this.requestRender();
      return;
    }
    if (this.frameId !== undefined) renderer.host.cancelFrame(this.frameId);
    this.frame();
  }

  requestRender(): void {
    this.assertAlive();
    this.dirty = true;
    const renderer = this.renderer;
    if (!renderer || this.frameId !== undefined || !this.visible || !this.imageryLoaded) return;
    this.frameId = renderer.host.requestFrame(this.onFrame);
  }

  private frame(): void {
    this.frameId = undefined;
    const renderer = this.renderer;
    const surface = this.surface;
    if (this.destroyed || !renderer || !surface || !this.visible) return;
    this.inFrame = true;
    renderer.host.checkSize?.();
    this.inFrame = false;
    this.dirty = false;
    this.cam.update();
    const count = selectSurfaceTiles(this.cam, this.selection, this.tiles);
    surface.prepare(this.tiles, count, this.keys);
    renderer.render(this.frameView, this.keys, count);
    this.frames++;
    // Payloads are built only for listeners, and the frame payload is reused: the steady-state frame allocates nothing.
    if (this.emitter.has('frame')) {
      this.framePayload.frameNumber = this.frames;
      this.framePayload.tiles = count;
      this.emitter.emit('frame', this.framePayload);
    }
    if (this.emitter.has('camera-change')) this.emitter.emit('camera-change', readCameraState(this.cam));
    if (this.resolveReady) {
      this.resolveReady();
      this.resolveReady = undefined;
      this.emitter.emit('ready', { backend: renderer.capabilities.backend });
    }
    if (this.dirty) this.requestRender();
    else if (this.emitter.has('idle')) {
      this.idlePayload.frameNumber = this.frames;
      this.emitter.emit('idle', this.idlePayload);
    }
  }

  setResolutionScale(scale: number): void {
    this.assertAlive();
    if (typeof scale !== 'number' || !(scale >= 0.1 && scale <= 4)) {
      throw new GlobeError(
        'invalid-option',
        `resolutionScale must be a number between 0.1 and 4, got ${String(scale)}`,
      );
    }
    this.resolutionScale = scale;
    this.syncSize();
    this.requestRender();
  }

  jumpTo(target: ViewInit): void {
    this.assertAlive();
    const keepRange = typeof target === 'object' && target !== null && target.zoom === undefined;
    const pending = this.pendingView;
    let view;
    try {
      view = validateView(target, pending ?? currentView(this.cam));
    } catch (error) {
      // The view stays as it was; the error reaches both the caller and the error event.
      if (error instanceof GlobeError) this.emitter.emit('error', error);
      throw error;
    }
    if (pending) {
      // Not started yet: keep the request. A position-only jump keeps the ground scale, as it does after start.
      if (keepRange) {
        const groundZoom = groundZoomFromMercatorZoom(pending.zoom, pending.latitudeDeg * RAD);
        view.zoom = mercatorZoomFromGroundZoom(groundZoom, view.latitudeDeg * RAD);
      }
      this.pendingView = view;
      return;
    }
    applyView(this.cam, view, keepRange);
    this.cam.update();
    this.requestRender();
  }

  screenToGeo(point: ScreenPoint): GeoPosition | undefined {
    this.assertAlive();
    if (!this.validPoint(point)) {
      throw new GlobeError('invalid-coordinate', `A screen point needs finite xPx and yPx, got ${describe(point)}`);
    }
    return this.pick(point);
  }

  /** True for an object with finite xPx and yPx. */
  private validPoint(point: unknown): point is ScreenPoint {
    if (point === null || typeof point !== 'object') return false;
    const { xPx, yPx } = point as Partial<ScreenPoint>;
    return typeof xPx === 'number' && Number.isFinite(xPx) && typeof yPx === 'number' && Number.isFinite(yPx);
  }

  /** The position under a valid screen point; none before the viewport has a size. */
  private pick(point: ScreenPoint): GeoPosition | undefined {
    if (this.pendingView) return undefined;
    this.cam.update();
    if (!this.cam.pickEllipsoid(point.xPx, point.yPx, pick)) return undefined;
    return { longitudeDeg: wrapDegrees(pick.longitudeRad * DEG), latitudeDeg: pick.latitudeRad * DEG, heightMeters: 0 };
  }

  geoToScreen(position: GeoPosition): ScreenPoint | undefined {
    this.assertAlive();
    validatePosition(position);
    if (this.pendingView) return undefined;
    this.cam.update();
    geodeticToEcef(position.longitudeDeg * RAD, position.latitudeDeg * RAD, position.heightMeters ?? 0, ecefScratch);
    if (!projectToScreen(this.cam, ecefScratch, screenScratch)) return undefined;
    return { xPx: screenScratch[0] ?? 0, yPx: screenScratch[1] ?? 0 };
  }

  private dragTo(anchor: GeoPosition, point: ScreenPoint): void {
    this.assertAlive();
    // Input handling runs every frame of a drag: doubles travel in preallocated arrays, never as call arguments, which
    // V8 boxes (ADR 0018). Finiteness is tested as x − x === 0 (NaN for NaN and ±Infinity), not with Number.isFinite,
    // which V8's mid-tier compiler calls with a boxed argument.
    const lon = anchor.longitudeDeg;
    const lat = anchor.latitudeDeg;
    const height = anchor.heightMeters ?? 0;
    const x = point.xPx;
    const y = point.yPx;
    if (typeof lon !== 'number' || typeof lat !== 'number' || typeof height !== 'number') return;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (!(lon - lon === 0 && lat - lat === 0 && height - height === 0 && x - x === 0 && y - y === 0)) return;
    if (!(lat >= -90 && lat <= 90)) return;
    const pose = this.cam.pose;
    dragAnchor[0] = lon * RAD;
    dragAnchor[1] = lat * RAD;
    dragAnchor[2] = height;
    dragPixel[0] = x;
    dragPixel[1] = y;
    dragStart[0] = pose.targetLongitudeRad;
    dragStart[1] = pose.targetLatitudeRad;
    dragStart[2] = pose.headingRad;
    if (!solveAnchor(this.cam, dragAnchor, dragPixel)) {
      pose.targetLongitudeRad = dragStart[0] ?? 0;
      pose.targetLatitudeRad = dragStart[1] ?? 0;
      pose.headingRad = dragStart[2] ?? 0;
    }
    const targetLon = pose.targetLongitudeRad;
    if (!(targetLon >= -Math.PI && targetLon < Math.PI)) pose.targetLongitudeRad = wrapLongitudeRad(targetLon);
    this.cam.update();
    this.requestRender();
  }

  private zoomAt(point: ScreenPoint, deltaZoom: number): void {
    this.assertAlive();
    if (!Number.isFinite(deltaZoom) || !Number.isFinite(point.xPx) || !Number.isFinite(point.yPx)) return;
    const anchor = this.screenToGeo(point);
    const pose = this.cam.pose;
    pose.rangeMeters = clampRange(this.cam, pose.rangeMeters * 2 ** -deltaZoom);
    this.cam.update();
    if (anchor) this.dragTo(anchor, point);
    else this.requestRender();
  }

  on<E extends keyof GlobeEvents>(event: E, handler: (payload: GlobeEvents[E]) => void): () => void {
    this.assertAlive();
    return this.emitter.on(event, handler);
  }

  resourceCounts(): ResourceCounts {
    return this.renderer?.resourceCounts() ?? { meshes: 0, textures: 0, gpuBytes: 0 };
  }

  rendererStats(): RendererStats {
    return this.renderer?.stats() ?? { drawCalls: 0, triangles: 0, textureUploads: 0, matrixUpdates: 0 };
  }

  setDebugShapes(shapes: readonly DebugShape[]): void {
    this.assertAlive();
    const meshes = shapes.map((shape) => buildDebugMesh(shape));
    this.renderer?.setDebugMeshes(meshes);
    this.requestRender();
  }

  simulateDeviceLoss(): void {
    this.assertAlive();
    this.renderer?.simulateDeviceLoss();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.resolveReady) {
      this.resolveReady = undefined;
      this.rejectReady?.(new GlobeError('destroyed', 'The globe was destroyed before its first frame'));
    }
    if (this.frameId !== undefined) this.renderer?.host.cancelFrame(this.frameId);
    this.controls?.destroy();
    for (const cleanup of this.cleanups) cleanup();
    this.surface?.clear();
    this.renderer?.destroy();
    this.emitter.clear();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new GlobeError('destroyed', 'This globe was destroyed');
  }
}

/** Validates a WGS84 position given to a query; throws a typed GlobeError. */
function validatePosition(position: unknown): void {
  if (position === null || typeof position !== 'object') {
    throw new GlobeError('invalid-coordinate', `A position must be an object, got ${describe(position)}`);
  }
  const { longitudeDeg, latitudeDeg, heightMeters } = position as Partial<GeoPosition>;
  for (const [name, value] of [
    ['longitudeDeg', longitudeDeg],
    ['latitudeDeg', latitudeDeg],
    ['heightMeters', heightMeters ?? 0],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new GlobeError('invalid-coordinate', `${name} must be a finite number, got ${describe(value)}`);
    }
  }
  if ((latitudeDeg as number) < -90 || (latitudeDeg as number) > 90) {
    throw new GlobeError('invalid-coordinate', `latitudeDeg must be between -90 and 90, got ${String(latitudeDeg)}`);
  }
}

/** A short description of an invalid input for error messages. */
function describe(value: unknown): string {
  try {
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

const ecefScratch = new Float64Array(3);
const screenScratch = new Float64Array(2);
/** Drag inputs: the anchor (longitude, latitude in radians, height), the pixel and the pose to restore on failure. */
const dragAnchor = new Float64Array(3);
const dragPixel = new Float64Array(2);
const dragStart = new Float64Array(3);

const pick: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
