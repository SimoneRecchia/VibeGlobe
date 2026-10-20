import { solveAnchor } from '../camera/anchor.js';
import { Camera } from '../camera/camera.js';
import { projectToScreen } from '../camera/projection.js';
import { geodeticToEcef, type GeodeticRad } from '../geodesy/ecef.js';
import { wrapLongitudeRad } from '../projections/longitude.js';
import { SurfaceCache } from '../surface/surface-cache.js';
import { selectSurfaceTiles, type SurfaceTile } from '../surface/surface-selection.js';
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
import { DEFAULT_VIEW, validateOptions, validateView } from './validation.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const MAX_LEVEL = 26;

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
  private dirty = true;
  private visible = true;
  private imageryLoaded = false;
  private destroyed = false;
  private resolveReady: (() => void) | undefined;
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
    this.navigation = {
      grab: (point) => this.screenToGeo(point),
      dragTo: (anchor, point) => this.dragTo(anchor, point),
      zoomAt: (point, deltaZoom) => this.zoomAt(point, deltaZoom),
    };
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
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
    return readCameraState(this.cam);
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
    applyView(this.cam, validateView(this.options.view ?? {}, DEFAULT_VIEW));
    this.cleanups.push(
      renderer.host.observeSize(() => {
        this.syncSize();
        this.requestRender();
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

  requestRender(): void {
    this.assertAlive();
    this.dirty = true;
    const renderer = this.renderer;
    if (!renderer || this.frameId !== undefined || !this.visible || !this.imageryLoaded) return;
    this.frameId = renderer.host.requestFrame(() => this.frame());
  }

  private frame(): void {
    this.frameId = undefined;
    const renderer = this.renderer;
    const surface = this.surface;
    if (this.destroyed || !renderer || !surface || !this.visible) return;
    this.dirty = false;
    this.cam.update();
    const count = selectSurfaceTiles(
      this.cam,
      { maxScreenErrorPx: this.options.maxScreenErrorPx ?? 1, maxLevel: MAX_LEVEL },
      this.tiles,
    );
    surface.prepare(this.tiles, count, this.keys);
    renderer.render(this.frameView, this.keys, count);
    this.frames++;
    this.emitter.emit('frame', { frameNumber: this.frames, tiles: count });
    this.emitter.emit('camera-change', readCameraState(this.cam));
    if (this.resolveReady) {
      this.resolveReady();
      this.resolveReady = undefined;
      this.emitter.emit('ready', { backend: renderer.capabilities.backend });
    }
    if (this.dirty) this.requestRender();
    else this.emitter.emit('idle', { frameNumber: this.frames });
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
    let view;
    try {
      view = validateView(target, currentView(this.cam));
    } catch (error) {
      // The view stays as it was; the error reaches both the caller and the error event.
      if (error instanceof GlobeError) this.emitter.emit('error', error);
      throw error;
    }
    applyView(this.cam, view, keepRange);
    this.cam.update();
    this.requestRender();
  }

  screenToGeo(point: ScreenPoint): GeoPosition | undefined {
    this.assertAlive();
    if (!Number.isFinite(point.xPx) || !Number.isFinite(point.yPx)) return undefined;
    this.cam.update();
    if (!this.cam.pickEllipsoid(point.xPx, point.yPx, pick)) return undefined;
    return { longitudeDeg: wrapDegrees(pick.longitudeRad * DEG), latitudeDeg: pick.latitudeRad * DEG, heightMeters: 0 };
  }

  geoToScreen(position: GeoPosition): ScreenPoint | undefined {
    this.assertAlive();
    if (![position.longitudeDeg, position.latitudeDeg, position.heightMeters ?? 0].every(Number.isFinite))
      return undefined;
    this.cam.update();
    geodeticToEcef(position.longitudeDeg * RAD, position.latitudeDeg * RAD, position.heightMeters ?? 0, ecefScratch);
    if (!projectToScreen(this.cam, ecefScratch[0] ?? 0, ecefScratch[1] ?? 0, ecefScratch[2] ?? 0, screenScratch)) {
      return undefined;
    }
    return { xPx: screenScratch[0] ?? 0, yPx: screenScratch[1] ?? 0 };
  }

  private dragTo(anchor: GeoPosition, point: ScreenPoint): void {
    this.assertAlive();
    if (![anchor.longitudeDeg, anchor.latitudeDeg, point.xPx, point.yPx].every(Number.isFinite)) return;
    const pose = this.cam.pose;
    const before = [pose.targetLongitudeRad, pose.targetLatitudeRad, pose.headingRad] as const;
    const ok = solveAnchor(
      this.cam,
      anchor.longitudeDeg * RAD,
      anchor.latitudeDeg * RAD,
      anchor.heightMeters ?? 0,
      point.xPx,
      point.yPx,
    );
    if (!ok) [pose.targetLongitudeRad, pose.targetLatitudeRad, pose.headingRad] = before;
    pose.targetLongitudeRad = wrapLongitudeRad(pose.targetLongitudeRad);
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

const ecefScratch = new Float64Array(3);
const screenScratch = new Float64Array(2);
const pick: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
