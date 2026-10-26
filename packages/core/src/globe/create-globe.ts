// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { requestingTarget } from '../layers/layer-geometry.js';
import { extendGlobe, releaseExtensionPools, type ExtensionParts } from './render-extensions.js';
import { addModel } from '../layers/models.js';
import { Camera } from '../camera/camera.js';
import { SurfaceCache } from '../surface/surface-cache.js';
import { applyView, newCameraState, readCameraState, requestedCameraState } from './camera-state.js';
import { writeCameraState, writeFramePayload } from './camera-state.js';
import { Emitter } from './emitter.js';
import { GlobeError } from './errors.js';
import { debugMeshesOf } from './debug-mesh.js';
import { createObservability, PHASE_RENDER, type GlobeDiagnostics } from '../diagnostics/observability.js';
import { EngineClock } from './engine-clock.js';
import { FrameWaits, startedPromise } from './frame-waits.js';
import { rendererEvents } from './renderer-events.js';
import { EngineQuality, type QualityParts } from './engine-quality.js';
import { ViewCaptures, type CaptureParts } from './capture-view.js';
import { imageryLayersOf } from './imagery-layers.js';
import type { ImageryLayers } from '../imagery/imagery-stack.js';
import type { Credit } from '../imagery/credits.js';
import { Constraints, validateConstraints } from './constraints.hot.js';
import { NO_RENDERER_STATS, NO_RESOURCES } from './diagnostics.js';
import { SurfaceFrame } from './surface-frame.js';
import type { ViewMode } from '../view/view-state.js';
import type { ViewControl } from './view-control.js';
import { completedMovement, type Movements } from './movements.js';
import { wireView } from './view-wiring.js';
import type { ElevationSample } from '../terrain/terrain-heights.js';
import { createFrameView, renderDrawing, screenOf, type MutableFrameView } from './view-geometry.js';
import type {
  BackendName,
  CameraState,
  DebugMeshData,
  DebugShape,
  FrameCapture,
  GeoPosition,
  Globe,
  GlobeEvents,
  GlobeOptions,
  ImageryStats,
  TerrainStats,
  NavigationApi,
  RendererBackend,
  RendererCapabilities,
  RendererStats,
  SurfaceStats,
  SurfaceTileInfo,
  ResourceCounts,
} from './types.js';
import {
  DEFAULT_VIEW,
  validateHandler,
  validateResolutionScale,
  validateScreenPoint,
  validateOptions,
  validatePosition,
  validateView,
  type ValidView,
} from './validation.js';

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
  private readonly viewControl: ViewControl;
  private readonly movements: Movements;
  private readonly limits = new Constraints();
  private readonly emitter = new Emitter<GlobeEvents>();
  private readonly cam = new Camera();
  private renderer: RendererBackend | undefined;
  private surface: SurfaceCache | undefined;
  private readonly cleanups: (() => void)[] = [];
  private frameId: number | undefined;
  /** Frames drawn so far (`Globe.frameNumber`). */
  frameNumber = 0;
  /** The debug quads, kept for a renderer that does not exist yet. */
  private debugMeshes: DebugMeshData[] = [];
  private readonly framePayload = { frameNumber: 0, tiles: 0, zoom: 0.5 };
  private readonly idlePayload = { frameNumber: 0 };
  private readonly cameraPayload = newCameraState();
  /** The capture, quality and extension helpers in one field: each new field changes the class's layout (F064). */
  private readonly helpers: { captures: ViewCaptures; quality: EngineQuality; parts: ExtensionParts };
  private readonly surfaceFrame: SurfaceFrame;
  /** The timestamp of the frame being drawn, for the clock (in an array: ADR 0018). */
  private readonly frameTime = new Float64Array(1);
  /** Bound once, so scheduling a frame allocates no closure. */
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
  private readonly diag: ReturnType<typeof createObservability>;
  readonly diagnostics: GlobeDiagnostics;
  private readonly frameView: MutableFrameView;

  constructor(private readonly options: GlobeOptions) {
    this.resolutionScale = options.resolutionScale ?? 1;
    this.clock = new EngineClock(options.manualClockStepMs ?? 0);
    this.diag = createObservability(options.logLevel ?? 'warn', options.logSink, () => this.renderer?.host.now() ?? 0);
    this.diagnostics = this.diag.api;
    this.surfaceFrame = new SurfaceFrame(options, this.clock, this.diag);
    this.frameView = createFrameView(this.cam, this.surfaceFrame.view.morph);
    // The private parts the capture and quality helpers use, read when used.
    const parts: CaptureParts & QualityParts & ExtensionParts = {
      globe: this,
      check: (api) => (this.assertAlive(), this.surfaceFrame.refuseReadback(api)),
      waits: () => this.captureWaits,
      renderer: () => (this.destroyed ? undefined : this.renderer),
      failure: () => this.failure,
      draw: (renderer) => this.drawNow(renderer),
      camera: () => this.cam,
      frameView: () => this.frameView,
      surface: () => this.surfaceFrame,
      resolutionScale: () => this.resolutionScale,
      workers: options.workers,
      report: (error) => (this.diag.logger.log('error', error.message), this.emitter.emit('error', error)),
    };
    const quality = new EngineQuality(parts, options);
    this.helpers = { captures: new ViewCaptures(parts), quality, parts };
    this.pendingView = validateView(options.view ?? {}, DEFAULT_VIEW);
    ({ viewControl: this.viewControl, movements: this.movements } = wireView({
      cam: this.cam,
      surface: this.surfaceFrame,
      emitter: this.emitter,
      clock: this.clock,
      constraints: this.limits,
      setOpacity: (opacity) => this.renderer?.host.setOpacity?.(opacity),
      waiting: () => this.waiting,
      assertAlive: () => this.assertAlive(),
      requestRender: () => this.requestRender(),
    }));
    this.navigation = this.viewControl.navigation;
    if (options.constraints) this.setConstraints(options.constraints);
    if (options.view?.tiltDeg !== undefined) this.viewControl.chooseTilt(this.pendingView.tiltDeg);
    this.ready = startedPromise(
      (resolve, reject) => ((this.resolveReady = resolve), (this.rejectReady = reject)),
      () => this.start(),
      (error) => this.failStart(error),
    );
  }

  get backend(): BackendName | undefined {
    return this.renderer?.capabilities.backend;
  }

  get capabilities(): RendererCapabilities | undefined {
    return this.renderer?.capabilities;
  }

  get camera(): CameraState {
    // Before the viewport has a size, range and altitude are unknown (types.ts, Globe.camera).
    const view = this.surfaceFrame.view;
    return this.pendingView ? requestedCameraState(this.pendingView, view) : readCameraState(this.cam, view);
  }

  get constraints(): Globe['constraints'] {
    return this.limits.settings;
  }

  get reducedMotion(): boolean {
    return this.movements.reducedMotion;
  }

  get viewMode(): ViewMode {
    return this.surfaceFrame.view.mode;
  }

  readonly setViewMode: Globe['setViewMode'] = (mode) => this.assertAlive() ?? this.viewControl.setMode(mode);
  readonly setViewCurves: Globe['setViewCurves'] = (curves) => this.assertAlive() ?? this.viewControl.setCurves(curves);

  readonly credits = (): readonly Credit[] => this.surfaceFrame.imagery?.credits.list() ?? [];
  readonly refreshCredits = (): void => this.assertAlive() ?? this.surfaceFrame.imagery?.credits.refresh();

  get imageryLayers(): ImageryLayers {
    return imageryLayersOf(this.surfaceFrame);
  }

  get timeMs(): number {
    return this.clock.timeMs;
  }

  /** Reports that nothing will be drawn: the error event, waiting captures, and `ready` if no frame was drawn. */
  private failStart(error: GlobeError): void {
    this.failure = error;
    // A warning, not an error: the host receives the failure itself (the error event and `ready`) and decides how bad
    // it is; the engine puts no error in the console of a page that handles it (F055).
    this.diag.logger.log('warn', error.message);
    this.captureWaits.end(error);
    this.emitter.emit('error', error);
    const reject = this.rejectReady;
    if (!this.resolveReady || !reject) return;
    this.resolveReady = undefined;
    reject(error);
  }

  private async start(): Promise<void> {
    const events = rendererEvents(
      this.emitter,
      () => (this.attachControls(), this.requestRender()),
      (error) => this.failStart(error),
    );
    const renderer = await this.options.renderer(this.options.container, events);
    if (this.destroyed) return renderer.destroy();
    this.renderer = renderer;
    this.helpers.quality.attach(renderer);
    // Loads finishing after destroy ask for nothing.
    this.surfaceFrame.startImagery(this.options, renderer, {
      requestFrame: () => this.destroyed || this.requestRender(),
      tileError: (event) => this.emitter.emit('tile-error', event),
      creditsChange: (credits) => this.emitter.emit('credits-change', { credits }),
      layersChange: () => this.emitter.emit('imagery-layers-change', { layers: this.imageryLayers.list() }),
      sourceError: (error) => this.emitter.emit('error', error),
    });
    // After the terrain starts: its errors set the skirt depths.
    this.surface = new SurfaceCache(renderer, this.surfaceFrame.terrainErrorMeters);
    renderer.layers?.setGround?.(this.surfaceFrame.layerGround());
    renderer.layers?.onContentReady?.(() => this.requestRender());
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
      renderer.host.observeReducedMotion?.((reduce) => (this.movements.reducedMotion = reduce)) ?? (() => undefined),
    );
    this.attachControls();
    await renderer.setBaseImagery(this.options.baseImageryUrl);
    if (this.destroyed) return;
    this.imageryLoaded = true;
    this.requestRender();
  }

  /** Attaches the controls to the renderer's input element, again when a recovery replaced it (KB-020). */
  private attachControls(): void {
    this.viewControl.slot.attach(this.options.controls, this.renderer?.inputElement, this);
  }

  private syncSize(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const { widthPx, heightPx } = renderer.host.containerSize();
    // No size (hidden, collapsed), no viewport: frames stop and the camera keeps its pose and range (KB-046, KB-050).
    this.collapsed = widthPx <= 0 || heightPx <= 0;
    if (this.collapsed) return;
    const pixelRatio = renderer.host.pixelRatio() * this.resolutionScale;
    this.cam.widthPx = widthPx;
    this.cam.heightPx = heightPx;
    this.frameView.widthPx = this.cam.widthPx;
    this.frameView.heightPx = this.cam.heightPx;
    this.frameView.pixelRatio = pixelRatio;
    this.surfaceFrame.setPixelRatio(pixelRatio);
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
    if (!renderer || !this.visible || !this.imageryLoaded) return this.requestRender();
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
    // Size checks and input recorded since the last frame are handled inside the frame, which draws what they change.
    this.clock.advance(this.frameTime);
    this.diag.timer.begin();
    this.inFrame = true;
    renderer.host.checkSize?.();
    // Until the requested view has a viewport there is no camera to draw or report (KB-040).
    // A running movement steps to this frame's time first; input the controls apply then interrupts it (ADR 0036).
    if (!this.waiting) {
      this.movements.step();
      this.viewControl.updateControls();
      this.movements.afterInput();
      this.limits.apply(this.cam);
    }
    this.inFrame = false;
    // A frame the controls ask for during their update is drawn next; what they applied is drawn by this one.
    this.dirty = this.viewControl.takeUpdateRequest();
    // A frame not drawn takes no step of the manual clock (KB-058).
    if (this.waiting) return this.clock.skipped();
    this.cam.update();
    const draws = this.surfaceFrame.prepare(this.cam, surface);
    // A lift moved the camera after the selection: the next frame draws the new pose, until the lift settles (F146).
    if (this.surfaceFrame.keepAboveTerrain(this.cam)) this.dirty = true;
    // A renderer that is recovering draws nothing: no frame, no events, and `ready` waits for a drawn one.
    // Layers query the frame's own camera while it is drawn (KB-210).
    if (!renderDrawing(this.cam, renderer, this.frameView, draws)) return this.clock.skipped();
    this.diag.timer.end(PHASE_RENDER);
    const count = this.surfaceFrame.drawn();
    this.frameNumber++;
    if (this.emitter.has('frame')) {
      writeFramePayload(this.cam, this.framePayload, this.frameNumber, count);
      this.emitter.emit('frame', this.framePayload);
    }
    if (this.emitter.has('camera-change'))
      this.emitter.emit('camera-change', writeCameraState(this.cam, this.cameraPayload, this.surfaceFrame.view));
    // With imagery, `ready` waits for the pinned base: from then on zooming out always shows a complete picture (F084).
    if (this.resolveReady && this.surfaceFrame.baseReady) {
      this.resolveReady();
      this.resolveReady = undefined;
      this.emitter.emit('ready', { backend: renderer.capabilities.backend });
      this.diag.logger.log('info', `started on ${renderer.capabilities.backend}`);
    }
    if (this.dirty || this.surfaceFrame.fading || this.surfaceFrame.view.easing || this.movements.active)
      this.requestRender();
    else if (this.emitter.has('idle') && !this.surfaceFrame.loading) {
      this.idlePayload.frameNumber = this.frameNumber;
      this.emitter.emit('idle', this.idlePayload);
    }
  }

  setResolutionScale(scale: number): void {
    this.assertAlive();
    this.resolutionScale = validateResolutionScale(scale);
    this.syncSize();
    this.requestRender();
  }

  readonly jumpTo: Globe['jumpTo'] = (target) => {
    this.assertAlive();
    this.pendingView = this.movements.jump(target, this.pendingView, this.collapsed) ?? this.pendingView;
    return completedMovement();
  };

  readonly easeTo: Globe['easeTo'] = (target, options) => this.movements.start('ease', target, options);
  readonly flyTo: Globe['flyTo'] = (target, options) => this.movements.start('fly', target, options);
  readonly fitBounds: Globe['fitBounds'] = (bounds, options) => this.movements.fitBounds(bounds, options);
  readonly tour: Globe['tour'] = (waypoints, options) => this.movements.tour(waypoints, options);
  readonly orbit: Globe['orbit'] = (options) => this.movements.orbit(options);
  readonly rotateTo: Globe['rotateTo'] = (heading, options) => this.movements.rotateTo(heading, options);
  readonly tiltTo: Globe['tiltTo'] = (tilt, options) => this.movements.start('ease', { tiltDeg: tilt }, options);
  readonly setConstraints: Globe['setConstraints'] = (constraints) =>
    this.limits.set(validateConstraints(constraints), this.surfaceFrame.view) ?? this.requestRender();
  readonly resetToGlobe: Globe['resetToGlobe'] = (options) => this.movements.resetToGlobe(options);
  readonly goHome: Globe['goHome'] = (options) =>
    this.movements.goHome(this.options.home ?? this.options.view ?? DEFAULT_VIEW, options);

  readonly screenToGeo: Globe['screenToGeo'] = (point) =>
    this.assertAlive() ??
    this.viewControl.positionAt(validateScreenPoint(point), (λ, φ) => this.surfaceFrame.terrainHeightRad(λ, φ));
  readonly geoToScreen: Globe['geoToScreen'] = (position) =>
    this.assertAlive() ??
    validatePosition(position) ??
    (this.waiting ? undefined : screenOf(this.cam, this.surfaceFrame.view, position));

  on<E extends keyof GlobeEvents>(event: E, handler: (payload: GlobeEvents[E]) => void): () => void {
    this.assertAlive();
    validateHandler(event, handler);
    return this.emitter.on(event, handler);
  }

  // Diagnostics delegate to the renderer and the surface frame.
  readonly resourceCounts = (): ResourceCounts => this.renderer?.resourceCounts() ?? NO_RESOURCES;
  readonly rendererStats = (): RendererStats => this.renderer?.stats() ?? NO_RENDERER_STATS;
  readonly surfaceTiles = (): SurfaceTileInfo[] => this.surfaceFrame.describe(this.cam);
  readonly surfaceStats = (): SurfaceStats => this.surfaceFrame.stats();
  readonly imageryStats = (): ImageryStats | undefined => this.surfaceFrame.imageryStats();
  readonly reloadSource: Globe['reloadSource'] = (id, options) => this.surfaceFrame.reloadSource(id, options);
  readonly terrainStats = (): TerrainStats | undefined => this.surfaceFrame.terrainStats();
  readonly elevationAt = (position: GeoPosition, out?: ElevationSample): ElevationSample =>
    this.assertAlive() ?? this.surfaceFrame.elevationAt(position, out ?? { heightMeters: 0, level: -1, noData: true });
  readonly elevationAtAsync: Globe['elevationAtAsync'] = async (position, options = {}) =>
    this.assertAlive() ?? this.surfaceFrame.queryElevation(position, options.signal);
  readonly addModel: Globe['addModel'] = async (options) =>
    this.assertAlive() ?? addModel(this.renderer, options, () => this.requestRender());
  readonly layerTarget: Globe['layerTarget'] = () =>
    this.assertAlive() ?? requestingTarget(this.renderer?.layers, () => this.requestRender());
  readonly setDebugShapes = (shapes: readonly DebugShape[]): void => {
    this.debugMeshes = this.assertAlive() ?? debugMeshesOf(shapes);
    this.renderer?.setDebugMeshes(this.debugMeshes);
    this.requestRender();
  };
  readonly addRenderExtension: Globe['addRenderExtension'] = (c) =>
    this.assertAlive() ?? extendGlobe(this.helpers.parts, c);
  get qualitySettings(): Globe['qualitySettings'] {
    return this.helpers.quality.settings;
  }
  get atmosphere(): Globe['atmosphere'] {
    return this.helpers.quality.atmosphere;
  }
  readonly setQualitySettings: Globe['setQualitySettings'] = (s) => this.assertAlive() ?? this.helpers.quality.set(s);
  readonly setAtmosphere: Globe['setAtmosphere'] = (s) => this.assertAlive() ?? this.helpers.quality.setAtmosphere(s);
  readonly captureFrame = (): Promise<FrameCapture> => this.helpers.captures.frame();
  readonly captureView: Globe['captureView'] = (size) => this.helpers.captures.view(size);
  /** True while there is no camera to draw or query: before the first size, and while the container has none. */
  private get waiting(): boolean {
    return this.pendingView !== undefined || this.collapsed;
  }
  readonly simulateDeviceLoss = (): void => (this.assertAlive(), this.renderer?.simulateDeviceLoss());

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.resolveReady) {
      this.resolveReady = undefined;
      this.rejectReady?.(new GlobeError('destroyed', 'The globe was destroyed before its first frame'));
    }
    if (this.frameId !== undefined) this.renderer?.host.cancelFrame(this.frameId);
    this.viewControl.slot.destroy();
    for (const cleanup of this.cleanups) cleanup();
    this.surfaceFrame.destroy();
    this.surface?.clear();
    this.renderer?.destroy();
    releaseExtensionPools(this.helpers.parts);
    this.captureWaits.end(new GlobeError('destroyed', 'The globe was destroyed'));
    this.emitter.clear();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new GlobeError('destroyed', 'This globe was destroyed');
  }
}
