import { Camera } from '../camera/camera.js';
import { projectToScreen } from '../camera/projection.js';
import { groundZoomFromMercatorZoom, mercatorZoomFromGroundZoom } from '../camera/zoom.js';
import { geodeticToEcef, type GeodeticRad } from '../geodesy/ecef.js';
import { SurfaceCache } from '../surface/surface-cache.js';
import { selectQuadtreeTiles, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import {
  applyView,
  currentView,
  newCameraState,
  readCameraState,
  requestedCameraState,
  wrapDegrees,
  writeCameraState,
} from './camera-state.js';
import { Emitter } from './emitter.js';
import { GlobeError } from './errors.js';
import { dragCamera, zoomCamera } from './navigation.hot.js';
import { buildDebugMesh, validateDebugShapes } from './debug-mesh.js';
import { EngineClock } from './engine-clock.js';
import { FrameWaits } from './frame-waits.js';
import { describeSurfaceTiles, NO_RENDERER_STATS, surfaceStats } from './diagnostics.js';
import type {
  BackendName,
  CameraState,
  Controls,
  DebugMeshData,
  DebugShape,
  FrameCapture,
  GeoPosition,
  Globe,
  GlobeEvents,
  GlobeOptions,
  NavigationApi,
  RendererBackend,
  RendererCapabilities,
  RendererEvents,
  RendererStats,
  SurfaceStats,
  SurfaceTileInfo,
  ResourceCounts,
  ScreenPoint,
  ViewInit,
} from './types.js';
import {
  DEFAULT_VIEW,
  isScreenPoint,
  validateHandler,
  validateResolutionScale,
  validateScreenPoint,
  validateOptions,
  validatePosition,
  validateView,
  type ValidView,
} from './validation.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
/** Surface tile keys are exact integers up to level 25 (quadtreeTileKey). */
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
  private readonly tiles: QuadtreeTile[] = [];
  /** Tiles the last drawn frame selected. */
  private tileCount = 0;
  private readonly keys: number[] = [];
  private renderer: RendererBackend | undefined;
  private surface: SurfaceCache | undefined;
  private controls: Controls | undefined;
  private controlsElement: unknown;
  private readonly cleanups: (() => void)[] = [];
  private frameId: number | undefined;
  private frames = 0;
  private readonly framePayload = { frameNumber: 0, tiles: 0 };
  private readonly idlePayload = { frameNumber: 0 };
  /** The debug quads, kept for a renderer that does not exist yet. */
  private debugMeshes: DebugMeshData[] = [];
  /** The camera-change payload, reused every frame (KB-037). */
  private readonly cameraPayload = newCameraState();
  private readonly selection = { maxScreenErrorPx: 1, maxLevel: MAX_LEVEL, minLevel: 2 };
  /**
   * Bound once, so scheduling a frame allocates no closure; a bound method rather than an arrow function, so no wrapper
   * function has to wait for the optimizing compiler (it is called only once per frame).
   */
  /** The timestamp of the frame being drawn, for the clock (in an array: ADR 0018). */
  private readonly frameTime = new Float64Array(1);
  private readonly onFrame = (timeMs: number): void => {
    this.frameTime[0] = timeMs;
    this.frame();
  };
  private readonly clock: EngineClock;
  private dirty = true;
  private visible = true;
  private imageryLoaded = false;
  private destroyed = false;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: GlobeError) => void) | undefined;
  /** The requested view until the renderer gives the viewport its size; then the camera holds it. */
  private pendingView: ValidView | undefined;
  /** True while the container has no size (hidden, collapsed): no frame runs and the camera keeps its pose (KB-050). */
  private collapsed = false;
  /** Why the renderer gave up, once it has (KB-051). */
  private failure: GlobeError | undefined;
  private readonly captureWaits = new FrameWaits(this.emitter);
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
    this.clock = new EngineClock(options.manualClockStepMs ?? 0);
    this.selection.maxScreenErrorPx = options.maxScreenErrorPx ?? 1;
    this.selection.minLevel = options.minSurfaceLevel ?? 2;
    this.pendingView = validateView(options.view ?? {}, DEFAULT_VIEW);
    this.navigation = {
      // Input plug-ins call these every frame: invalid input is ignored, never thrown.
      grab: (point) => (isScreenPoint(point) ? this.pick(point) : undefined),
      dragTo: (anchor, point) => this.dragTo(anchor, point),
      zoomAt: (point, deltaZoom) => this.zoomAt(point, deltaZoom),
      requestUpdate: () => this.requestRender(),
    };
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.start().catch((error: unknown) =>
        this.failStart(
          error instanceof GlobeError
            ? error
            : new GlobeError('renderer-failed', 'The renderer failed to start', { cause: error }),
        ),
      );
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
    // Before the viewport has a size, range and altitude are unknown (types.ts, Globe.camera).
    return pending ? requestedCameraState(pending) : readCameraState(this.cam);
  }

  get frameNumber(): number {
    return this.frames;
  }

  get timeMs(): number {
    return this.clock.timeMs;
  }

  /** Reports that nothing will be drawn: the error event, waiting captures, and `ready` if no frame was drawn. */
  private failStart(error: GlobeError): void {
    this.failure = error;
    this.captureWaits.end(error);
    this.emitter.emit('error', error);
    const reject = this.rejectReady;
    if (!this.resolveReady || !reject) return;
    this.resolveReady = undefined;
    reject(error);
  }

  private async start(): Promise<void> {
    const events: RendererEvents = {
      deviceLost: (reason) => this.emitter.emit('device-lost', { reason }),
      deviceRestored: () => {
        this.attachControls();
        this.emitter.emit('device-restored', {});
        this.requestRender();
      },
      backendFallback: (reason) => this.emitter.emit('backend-fallback', { reason }),
      // Nothing is drawn any more: a first frame that never came will not come (KB-036), nor a frame to capture.
      failed: (error) => this.failStart(error),
    };
    const renderer = await this.options.renderer(this.options.container, events);
    if (this.destroyed) {
      renderer.destroy();
      return;
    }
    this.renderer = renderer;
    this.surface = new SurfaceCache(renderer);
    if (this.debugMeshes.length > 0) renderer.setDebugMeshes(this.debugMeshes);
    this.syncSize();
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
    this.attachControls();
    await renderer.setBaseImagery(this.options.baseImageryUrl);
    if (this.destroyed) return;
    this.imageryLoaded = true;
    this.requestRender();
  }

  /** Attaches the controls to the renderer's input element, again when a recovery replaced it (KB-020). */
  private attachControls(): void {
    const factory = this.options.controls;
    const element = this.renderer?.inputElement;
    if (!factory || (this.controls && element === this.controlsElement)) return;
    this.controls?.destroy();
    this.controlsElement = element;
    this.controls = factory(element, this.navigation);
  }

  private syncSize(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const { widthPx, heightPx } = renderer.host.containerSize();
    // A container without a size (hidden, collapsed) has no viewport: frames stop and the camera keeps its pose, so its
    // range survives whatever sizes the container passes through (KB-046, KB-050).
    this.collapsed = widthPx <= 0 || heightPx <= 0;
    if (this.collapsed) return;
    const pixelRatio = renderer.host.pixelRatio() * this.resolutionScale;
    this.cam.widthPx = widthPx;
    this.cam.heightPx = heightPx;
    this.frameView.widthPx = this.cam.widthPx;
    this.frameView.heightPx = this.cam.heightPx;
    this.frameView.pixelRatio = pixelRatio;
    renderer.resize(this.cam.widthPx, this.cam.heightPx, pixelRatio);
    this.dirty = true;
    // The requested view becomes a camera once the viewport has a size: its zoom depends on it (KB-034).
    if (this.pendingView) {
      applyView(this.cam, this.pendingView);
      this.pendingView = undefined;
      // The eye is known from now on, before any frame (KB-047).
      this.cam.update();
    }
  }

  /** Draws a frame now when one can be drawn (instead of on the next display frame), else requests one. */
  private renderNow(): void {
    const renderer = this.renderer;
    if (!renderer || !this.visible || !this.imageryLoaded) {
      this.requestRender();
      return;
    }
    this.drawNow(renderer);
  }

  /** Draws a frame right away instead of at the next display frame. */
  private drawNow(renderer: RendererBackend): void {
    if (this.frameId !== undefined) renderer.host.cancelFrame(this.frameId);
    this.frameTime[0] = renderer.host.now();
    this.frame();
  }

  requestRender(): void {
    this.assertAlive();
    this.dirty = true;
    const renderer = this.renderer;
    if (!renderer || this.inFrame || this.frameId !== undefined || !this.visible || !this.imageryLoaded) return;
    this.frameId = renderer.host.requestFrame(this.onFrame);
  }

  private frame(): void {
    this.frameId = undefined;
    const renderer = this.renderer;
    const surface = this.surface;
    if (this.destroyed || !renderer || !surface || !this.visible) return;
    // Size checks and the input recorded since the last frame are handled here, inside the frame: what they change is
    // drawn by this frame, not by another one.
    this.clock.advance(this.frameTime);
    this.inFrame = true;
    renderer.host.checkSize?.();
    // Until the requested view has a viewport there is no camera to draw or report (KB-040).
    if (!this.waiting) this.controls?.update?.();
    this.inFrame = false;
    this.dirty = false;
    // A frame not drawn takes no step of the manual clock (KB-058).
    if (this.waiting) return this.clock.skipped();
    this.cam.update();
    const count = selectQuadtreeTiles(this.cam, this.selection, this.tiles);
    surface.prepare(this.tiles, count, this.keys);
    // A renderer that is recovering draws nothing: no frame, no events, and `ready` waits for a drawn one.
    if (!renderer.render(this.frameView, this.keys, count)) return this.clock.skipped();
    this.tileCount = count;
    this.frames++;
    // Payloads are built only for listeners, and the frame payload is reused: the steady-state frame allocates nothing.
    if (this.emitter.has('frame')) {
      this.framePayload.frameNumber = this.frames;
      this.framePayload.tiles = count;
      this.emitter.emit('frame', this.framePayload);
    }
    if (this.emitter.has('camera-change'))
      this.emitter.emit('camera-change', writeCameraState(this.cam, this.cameraPayload));
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
    this.resolutionScale = validateResolutionScale(scale);
    this.syncSize();
    this.requestRender();
  }

  jumpTo(target: ViewInit): void {
    this.assertAlive();
    const keepRange = typeof target === 'object' && target !== null && target.zoom === undefined;
    // While the container has no size a jump with a zoom is kept as a request, like before start (KB-046); one without
    // keeps the camera's range, which needs no viewport (KB-056).
    const pending = this.pendingView ?? (this.collapsed && !keepRange ? currentView(this.cam) : undefined);
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
    return this.pick(validateScreenPoint(point));
  }

  /** The position under a valid screen point; none before the viewport has a size. */
  private pick(point: ScreenPoint): GeoPosition | undefined {
    if (this.waiting) return undefined;
    this.cam.update();
    if (!this.cam.pickEllipsoid(point.xPx, point.yPx, pick)) return undefined;
    return { longitudeDeg: wrapDegrees(pick.longitudeRad * DEG), latitudeDeg: pick.latitudeRad * DEG, heightMeters: 0 };
  }

  geoToScreen(position: GeoPosition): ScreenPoint | undefined {
    this.assertAlive();
    validatePosition(position);
    if (this.waiting) return undefined;
    this.cam.update();
    geodeticToEcef(position.longitudeDeg * RAD, position.latitudeDeg * RAD, position.heightMeters ?? 0, ecefScratch);
    if (!projectToScreen(this.cam, ecefScratch, screenScratch)) return undefined;
    return { xPx: screenScratch[0] ?? 0, yPx: screenScratch[1] ?? 0 };
  }

  private dragTo(anchor: GeoPosition, point: ScreenPoint): void {
    this.assertAlive();
    if (!this.waiting && dragCamera(this.cam, anchor, point)) this.requestRender();
  }

  private zoomAt(point: ScreenPoint, deltaZoom: number): void {
    this.assertAlive();
    if (!this.waiting && zoomCamera(this.cam, point, deltaZoom)) this.requestRender();
  }

  on<E extends keyof GlobeEvents>(event: E, handler: (payload: GlobeEvents[E]) => void): () => void {
    this.assertAlive();
    validateHandler(event, handler);
    return this.emitter.on(event, handler);
  }

  resourceCounts(): ResourceCounts {
    return this.renderer?.resourceCounts() ?? { meshes: 0, textures: 0, gpuBytes: 0, vertexArrays: 0, contexts: 0 };
  }

  rendererStats(): RendererStats {
    return this.renderer?.stats() ?? NO_RENDERER_STATS;
  }

  surfaceTiles(): SurfaceTileInfo[] {
    return describeSurfaceTiles(this.tiles, this.tileCount);
  }

  surfaceStats(): SurfaceStats {
    return surfaceStats(this.tiles, this.tileCount, this.selection);
  }

  setDebugShapes(shapes: readonly DebugShape[]): void {
    this.assertAlive();
    validateDebugShapes(shapes);
    this.debugMeshes = shapes.map((shape) => buildDebugMesh(shape));
    // Before the renderer exists they are kept and handed over when it starts (KB-042).
    this.renderer?.setDebugMeshes(this.debugMeshes);
    this.requestRender();
  }

  async captureFrame(): Promise<FrameCapture> {
    this.assertAlive();
    await this.ready;
    for (;;) {
      const renderer = this.renderer;
      if (this.destroyed || !renderer) throw new GlobeError('destroyed', 'The globe was destroyed');
      if (this.failure) throw this.failure;
      const drawn = this.frames;
      // Drawn and read in one task: the canvas keeps the frame only until the browser presents it.
      this.drawNow(renderer);
      if (this.frames > drawn) return renderer.capture();
      // Nothing could be drawn (a recovery, a container without a size): wait for a drawn frame (KB-051).
      await this.captureWaits.next();
    }
  }

  /** True while there is no camera to draw or query: before the first size, and while the container has none. */
  private get waiting(): boolean {
    return this.pendingView !== undefined || this.collapsed;
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
    // The canvas holds its GPU context, whose device holds the renderer (KB-053).
    this.controlsElement = undefined;
    for (const cleanup of this.cleanups) cleanup();
    this.surface?.clear();
    this.renderer?.destroy();
    this.captureWaits.end(new GlobeError('destroyed', 'The globe was destroyed'));
    this.emitter.clear();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new GlobeError('destroyed', 'This globe was destroyed');
  }
}

const ecefScratch = new Float64Array(3);
const screenScratch = new Float64Array(2);
const pick: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
