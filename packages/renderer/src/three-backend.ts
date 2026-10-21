import {
  GlobeError,
  IntegerKeyMap,
  type DebugMeshData,
  type DepthPath,
  type FrameView,
  type RendererBackend,
  type RendererCapabilities,
  type RendererEvents,
  type RendererStats,
  type RenderHost,
  type ResourceCounts,
  type TileMeshData,
} from '@vibeglobe/core';
import {
  LinearMipmapLinearFilter,
  Mesh,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Texture,
  WebGPURenderer,
  type MeshBasicNodeMaterial,
} from 'three/webgpu';
import { readCapabilities } from './capabilities.js';
import { CanvasSlot } from './canvas-slot.js';
import { createDebugEntry, type DebugEntry } from './debug-meshes.js';
import { createTileMesh } from './tile-mesh.js';
import { countVertexArrays, releaseVertexArraysWithBuffers, useFloatMultisampledDepth } from './webgl-compat.js';
import { patchIdentitySwizzle } from './webgpu-compat.js';
import { decodeBitmap, decodeImage, webgl2Usable, webgpuUsable } from './environment.js';
import { createSurfaceMaterial } from './surface-material.js';
import { depthPathOf, useFloatSceneDepth } from './depth.js';
import { placeEyeRelative } from './eye-relative.js';
import { EngineCamera } from './engine-camera.js';
import { countCalls, countMatrixUpdates, stopInternalLoop } from './three-hooks.js';
import { createWarmUpScene, webgpuSelfTest } from './warm-up.js';
import { createFailureMessage, RecoveryLimiter, releaseDevice, releaseRenderer } from './recovery.js';

interface TileEntry {
  readonly data: TileMeshData;
  readonly mesh: Mesh;
}

/** Which backend to use: automatic (WebGPU, falling back to WebGL2) or forced. */
export type BackendChoice = 'auto' | 'webgpu' | 'webgl2';

/**
 * Which depth path to use on WebGL2 (ADR 0005 §4): 'auto' uses hardware reversed-Z where `EXT_clip_control` exists
 * and the fragment-written path elsewhere; 'fragment' forces the latter, for tests and diagnostics. WebGPU always
 * uses hardware reversed-Z.
 */
export type DepthChoice = 'auto' | 'fragment';

/** How a backend is set up: the {@link RendererOptions} it uses. */
export interface BackendSettings {
  readonly choice: BackendChoice;
  readonly depth: DepthChoice;
  /** Measures each frame's GPU time with timestamp queries where the device offers them (benchmarks only). */
  readonly gpuTiming: boolean;
}

/**
 * Where the backend draws (ADR 0011): a canvas it manages inside a page container (an existing one, or one it
 * creates), or an OffscreenCanvas it is given, for example in a worker. An OffscreenCanvas cannot be replaced, so a
 * device or context loss there ends in the renderer's `failed` event instead of a rebuild.
 */
export type DrawingSurface =
  | { readonly kind: 'element'; readonly container: HTMLElement; readonly canvas: HTMLCanvasElement | undefined }
  | { readonly kind: 'offscreen'; readonly canvas: OffscreenCanvas };

/**
 * The renderer behind the engine's RendererBackend interface, on three.js WebGPURenderer (ADR 0010). It keeps CPU
 * copies of every mesh and the base imagery, so after a device or context loss it rebuilds the renderer and its canvas
 * and restores everything without a page reload.
 */
export class ThreeBackend implements RendererBackend {
  capabilities!: RendererCapabilities;
  private renderer!: WebGPURenderer;
  private readonly canvases: CanvasSlot;
  private readonly scene = new Scene();
  private readonly camera = new EngineCamera();
  /** Surface tiles by key (no Map: it boxes keys beyond 31 bits on every per-frame lookup, ADR 0018). */
  private readonly tiles = new IntegerKeyMap<TileEntry>(1024);
  private debugEntries: DebugEntry[] = [];
  private textureUploads = 0;
  private matrixUpdates = 0;
  private pipelineCompiles = 0;
  /** Why WebGPU failed its start-up self-test, after which this backend uses WebGL2 (ADR 0010 §2). */
  private webgpuFailure: string | undefined;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  /** GPU time of the last frame measured, with the `gpuTiming` option and timestamp queries; null otherwise. */
  private gpuFrameMs: number | null = null;
  private beginFrame: () => void = () => undefined;
  /** Meshes shown by the last frame, reused across frames. */
  private readonly shown: (Mesh | undefined)[] = [];
  private shownCount = 0;
  private material: MeshBasicNodeMaterial | undefined;
  private imageryTexture: Texture | undefined;
  private imagery: HTMLImageElement | ImageBitmap | undefined;
  private size = { widthPx: 1, heightPx: 1, pixelRatio: 1 };
  private destroyed = false;
  private recovering = false;
  /** Set when recovery gave up: nothing is drawn any more. */
  private failed = false;
  private readonly recoveries = new RecoveryLimiter();
  /** The static message shown after recovery gave up. */
  private failureMessage: HTMLElement | undefined;
  /** Whether the current device or context is still held. */
  private contextHeld: () => boolean = () => false;
  /** The active depth path (ADR 0005 §4). */
  private depthPath: DepthPath = 'reversed-z';

  private constructor(
    private readonly surface: DrawingSurface,
    readonly host: RenderHost,
    private readonly events: RendererEvents,
    private readonly settings: BackendSettings,
  ) {
    this.canvases = new CanvasSlot(surface);
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** Creates and initializes a backend; rejects with GlobeError 'unsupported-device' when nothing can render. */
  static async create(
    surface: DrawingSurface,
    host: RenderHost,
    events: RendererEvents,
    settings: BackendSettings,
  ): Promise<ThreeBackend> {
    const backend = new ThreeBackend(surface, host, events, settings);
    await backend.initRenderer();
    backend.canvases.attach();
    return backend;
  }

  /** The canvas, which receives input; none for an OffscreenCanvas (its host forwards input). */
  get inputElement(): HTMLCanvasElement | undefined {
    return this.canvases.inputElement;
  }

  /** The global scope the canvas lives in: the page's window, or the worker's global scope. */
  private scope(): typeof globalThis {
    return this.surface.kind === 'element'
      ? ((this.surface.container.ownerDocument.defaultView ?? globalThis) as typeof globalThis)
      : globalThis;
  }

  private async initRenderer(): Promise<void> {
    const scope = this.scope();
    const webgpu = this.settings.choice !== 'webgl2' && this.webgpuFailure === undefined && (await webgpuUsable(scope));
    // A forced backend never falls back (ADR 0010 §2).
    if (this.settings.choice === 'webgpu' && !webgpu) {
      throw new GlobeError('unsupported-device', 'WebGPU was requested, but this browser offers no WebGPU adapter.');
    }
    if (!webgpu && !webgl2Usable(this.surface)) {
      throw new GlobeError(
        'unsupported-device',
        'This device supports neither WebGPU nor WebGL2, so the globe cannot render.',
      );
    }
    const forceWebGL = !webgpu;
    if (webgpu) patchIdentitySwizzle(scope);
    const canvas = this.canvases.next();
    const renderer = new WebGPURenderer({
      canvas: canvas as HTMLCanvasElement,
      antialias: true,
      // three.js turns this off on WebGL2 without EXT_clip_control; the engine then writes depth itself.
      reversedDepthBuffer: webgpu || this.settings.depth === 'auto',
      forceWebGL,
      trackTimestamp: this.settings.gpuTiming,
    });
    await renderer.init();
    this.depthPath = depthPathOf(renderer);
    // Every path stores near / d, cleared to 0, nearest kept by greater-equal (ADR 0005 §1). With reversed depth three.js
    // inverts the clear value and the compare itself.
    if (this.depthPath === 'fragment') renderer.setClearDepth(0);
    useFloatMultisampledDepth(renderer.backend);
    const sceneDepth = useFloatSceneDepth(renderer);
    this.beginFrame = stopInternalLoop(renderer);
    const failure = await webgpuSelfTest(renderer, this.depthPath);
    if (failure !== undefined) {
      await this.fallBackFromSelfTest(renderer, canvas, failure);
      return;
    }
    // Opaque tiles need no depth sorting; sorting would also compute bounds and distances for every object each frame.
    renderer.sortObjects = false;
    // Every material is unlit. With lighting enabled three.js still rebuilds the lights node's cache key on every render
    // call, about 5 KB of garbage per frame (F064, ADR 0018).
    renderer.lighting.enabled = false;
    this.watchLoss(renderer);
    releaseVertexArraysWithBuffers(renderer.backend);
    // three.js falls back to WebGL2 silently when WebGPU fails to initialize: reported for 'auto', an error for 'webgpu'.
    const fellBack = !forceWebGL && (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true;
    if (fellBack && this.settings.choice === 'webgpu') {
      renderer.dispose();
      throw new GlobeError('unsupported-device', 'WebGPU was requested, but it failed to initialize.');
    }
    if (fellBack) this.events.backendFallback('WebGPU initialization failed; using WebGL2');
    countCalls(renderer.backend, 'updateTexture', () => this.textureUploads++);
    countCalls(renderer.backend, 'createRenderPipeline', () => this.pipelineCompiles++);
    this.renderer = renderer;
    this.capabilities = readCapabilities(renderer, sceneDepth);
    renderer.setPixelRatio(this.size.pixelRatio);
    renderer.setSize(this.size.widthPx, this.size.heightPx, false);
  }

  /**
   * Replaces a WebGPU renderer that failed its start-up self-test with WebGL2, on a new canvas (the old one holds a
   * WebGPU context); a forced WebGPU backend fails instead (ADR 0010 §2).
   */
  private async fallBackFromSelfTest(
    renderer: WebGPURenderer,
    canvas: HTMLCanvasElement | OffscreenCanvas,
    reason: string,
  ): Promise<void> {
    releaseRenderer(renderer);
    if (this.settings.choice === 'webgpu') {
      throw new GlobeError(
        'unsupported-device',
        `WebGPU was requested, but it failed its start-up self-test: ${reason}`,
      );
    }
    this.webgpuFailure = reason;
    this.canvases.replaceFailed(canvas);
    await this.initRenderer();
    this.events.backendFallback(`WebGPU failed its start-up self-test (${reason}); using WebGL2`);
  }

  /** Creates the GPU mesh of a surface tile and keeps its CPU copy for loss recovery. */
  addMesh(data: TileMeshData): void {
    if (!this.tiles.has(data.key)) this.tiles.set(data.key, this.entryFor(data));
  }

  private entryFor(data: TileMeshData): TileEntry {
    const mesh = createTileMesh(data, this.material);
    countMatrixUpdates(mesh, () => this.matrixUpdates++);
    this.scene.add(mesh);
    return { data, mesh };
  }

  /** Recovers from this renderer's device or context loss, and tracks whether its device or context is held. */
  private watchLoss(renderer: WebGPURenderer): void {
    renderer.onDeviceLost = (info: { message?: string }) => this.handleLoss(renderer, info.message ?? 'device lost');
    // three.js ignores losses with the reason 'destroyed', assuming it destroyed the device itself; any loss of a
    // device this backend did not dispose must still recover.
    const device = (renderer.backend as { device?: GPUDevice }).device;
    const gl = (renderer.backend as { gl?: WebGL2RenderingContext }).gl;
    let deviceLost = false;
    void device?.lost.then((info) => {
      deviceLost = true;
      this.handleLoss(renderer, info.message || info.reason);
    });
    this.contextHeld = () => (device ? !deviceLost : gl ? !gl.isContextLost() : false);
  }

  /** Replaces the debug quads drawn with the surface's precision path. */
  setDebugMeshes(meshes: readonly DebugMeshData[]): void {
    for (const entry of this.debugEntries) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      (entry.mesh.material as MeshBasicNodeMaterial).dispose();
    }
    this.debugEntries = meshes.map((data) => createDebugEntry(data, this.depthPath));
    for (const entry of this.debugEntries) this.scene.add(entry.mesh);
  }

  /**
   * Reads back the GPU time of the frames rendered so far (timestamp queries resolve a few frames late); allocates
   * promises, so only with the `gpuTiming` option. Unsupported devices leave it null.
   */
  private resolveGpuTime(renderer: WebGPURenderer): void {
    void renderer.resolveTimestampsAsync('render').then((ms) => {
      if (typeof ms === 'number' && ms > 0) this.gpuFrameMs = ms;
    });
  }

  /** Cumulative counters (F052). */
  stats(): RendererStats {
    return {
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      textureUploads: this.textureUploads,
      matrixUpdates: this.matrixUpdates,
      pipelineCompiles: this.pipelineCompiles,
      gpuFrameMs: this.gpuFrameMs,
    };
  }

  /** Releases a surface tile mesh. */
  removeMesh(key: number): void {
    const entry = this.tiles.get(key);
    if (!entry) return;
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    this.tiles.delete(key);
    const shownIndex = this.shown.indexOf(entry.mesh);
    if (shownIndex !== -1 && shownIndex < this.shownCount) this.shown[shownIndex] = undefined;
  }

  /** Loads the equirectangular base imagery; resolves when it is decoded and bound to the surface material. */
  async setBaseImagery(url: string): Promise<void> {
    let image: HTMLImageElement | ImageBitmap;
    try {
      image = this.surface.kind === 'element' ? await decodeImage(url) : await decodeBitmap(url);
    } catch (error) {
      throw new GlobeError('resource-failed', `The base imagery could not be loaded from ${url}`, { cause: error });
    }
    if (this.destroyed) return;
    this.imagery = image;
    this.createImageryResources();
    await this.warmUpPipelines();
  }

  /**
   * Compiles every material variant before the frames that draw it (ADR 0010 §4), so no frame waits for a pipeline;
   * `pipelineCompiles` counts from here. Drawing an empty scene once also compiles three.js's output pass, which copies
   * the scene into the canvas; the canvas shows a cleared frame until the first frame.
   */
  private async warmUpPipelines(): Promise<void> {
    if (!this.material) return;
    const warmUp = createWarmUpScene([this.material]);
    try {
      await this.renderer.compileAsync(warmUp.scene, warmUp.camera);
      this.renderer.render(new Scene(), warmUp.camera);
    } finally {
      warmUp.dispose();
    }
    this.pipelineCompiles = 0;
  }

  private createImageryResources(): void {
    if (!this.imagery) return;
    const texture = new Texture(this.imagery);
    // A bitmap is flipped when it is decoded: WebGL2 ignores the flip flag for bitmaps.
    if (this.surface.kind === 'offscreen') texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.anisotropy = this.capabilities.maxAnisotropy;
    texture.needsUpdate = true;
    this.imageryTexture?.dispose();
    this.imageryTexture = texture;
    this.material?.dispose();
    this.material = createSurfaceMaterial(texture, this.depthPath);
    const material = this.material;
    this.tiles.forEach((entry) => (entry.mesh.material = material));
  }

  /** Draws the listed tiles with eye-relative offsets for this frame (ADR 0004, ADR 0005). */
  render(view: FrameView, keys: readonly number[], count: number): void {
    // Nothing is drawn with a lost renderer: while recovering, or after recovery gave up.
    if (this.destroyed || this.recovering || this.failed || !this.material) return;
    // Hide only what the previous frame showed: the work and the memory stay proportional to the drawn tiles.
    for (let i = 0; i < this.shownCount; i++) {
      const mesh = this.shown[i];
      if (mesh) mesh.visible = false;
    }
    this.shownCount = 0;
    for (let i = 0; i < count; i++) {
      const entry = this.tiles.getAt(keys, i);
      if (!entry) continue;
      entry.mesh.visible = true;
      this.shown[this.shownCount++] = entry.mesh;
      placeEyeRelative(entry.mesh, entry.data.originEcef, view.eyeEcef);
    }
    for (let i = 0; i < this.debugEntries.length; i++) {
      const entry = this.debugEntries[i];
      if (entry) placeEyeRelative(entry.mesh, entry.data.originEcef, view.eyeEcef);
    }
    this.camera.apply(view, this.depthPath);
    this.beginFrame();
    this.renderer.render(this.scene, this.camera);
    if (this.settings.gpuTiming) this.resolveGpuTime(this.renderer);
    const info = this.renderer.info.render as { drawCalls?: number; calls?: number; triangles: number };
    this.lastDrawCalls = info.drawCalls ?? info.calls ?? 0;
    this.lastTriangles = info.triangles;
  }

  /** Sets the drawing-buffer size: CSS size times pixel ratio. */
  resize(widthPx: number, heightPx: number, pixelRatio: number): void {
    this.size = { widthPx, heightPx, pixelRatio };
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(widthPx, heightPx, false);
  }

  /** GPU resource counters, counted from what is actually held (after destroy too, so a leak shows). */
  resourceCounts(): ResourceCounts {
    let gpuBytes = 0;
    this.tiles.forEach((entry) => (gpuBytes += entry.data.byteLength + entry.data.indices.byteLength));
    for (const entry of this.debugEntries) gpuBytes += entry.data.positions.byteLength;
    const image = this.imagery;
    const textureBytes = image && this.imageryTexture ? Math.round((image.width * image.height * 4 * 4) / 3) : 0;
    return {
      meshes: this.tiles.size + this.debugEntries.length,
      textures: this.imageryTexture ? 1 : 0,
      gpuBytes: gpuBytes + textureBytes,
      vertexArrays: countVertexArrays(this.renderer.backend),
      contexts: this.contextHeld() ? 1 : 0,
    };
  }

  /** Test hook: destroys the WebGPU device or loses the WebGL2 context. */
  simulateDeviceLoss(): void {
    releaseDevice(this.renderer.backend);
  }

  private handleLoss(lost: WebGPURenderer, reason: string): void {
    // Only the current renderer's loss counts: one replaced or disposed by this backend is expected to go away.
    if (this.destroyed || this.failed || lost !== this.renderer || this.recovering) return;
    this.recovering = true;
    this.events.deviceLost(reason);
    const pauseMs = this.recoveries.next(this.host.now());
    if (pauseMs === undefined) {
      const losses = this.recoveries.recentLosses;
      this.fail(new GlobeError('renderer-failed', `The GPU was lost ${losses} times within a minute; giving up`));
      return;
    }
    void this.recover(pauseMs);
  }

  private async recover(delayMs: number): Promise<void> {
    try {
      this.renderer.dispose();
      this.tiles.forEach((entry) => entry.mesh.geometry.dispose());
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (this.destroyed) return;
      await this.initRenderer();
      // Destroyed while the new renderer started or warmed up: release it, show nothing (KB-035).
      if (this.destroyed) {
        releaseRenderer(this.renderer);
        return;
      }
      this.createImageryResources();
      await this.warmUpPipelines();
      if (this.destroyed) {
        releaseRenderer(this.renderer);
        return;
      }
      this.setDebugMeshes(this.debugEntries.map((entry) => entry.data));
      this.canvases.attach();
      this.recovering = false;
      this.events.deviceRestored();
    } catch (error) {
      if (this.destroyed) return;
      this.fail(
        new GlobeError('renderer-failed', 'The renderer could not recover from a device loss', { cause: error }),
      );
    }
  }

  /**
   * Gives up (ADR 0010 §8): nothing is drawn any more, the error is reported, and in a page a static message replaces
   * the canvas so the map area does not stay frozen or blank without explanation.
   */
  private fail(error: GlobeError): void {
    if (this.destroyed) return;
    this.failed = true;
    this.recovering = false;
    if (this.surface.kind === 'element' && !this.failureMessage) {
      const message = createFailureMessage(this.surface.container.ownerDocument);
      this.canvases.replaceWith(message);
      this.failureMessage = message;
    }
    this.events.failed(error);
  }

  /** Frees every GPU resource and removes the canvas. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const keys: number[] = [];
    this.tiles.forEach((_, key) => keys.push(key));
    for (const key of keys) this.removeMesh(key);
    this.setDebugMeshes([]);
    this.material?.dispose();
    this.material = undefined;
    this.imageryTexture?.dispose();
    this.imageryTexture = undefined;
    releaseRenderer(this.renderer);
    this.canvases.remove();
    this.failureMessage?.remove();
  }
}
