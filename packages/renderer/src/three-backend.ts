// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  GlobeError,
  IntegerKeyMap,
  type DebugMeshData,
  type DepthPath,
  type FrameView,
  type RendererBackend,
  type FrameCapture,
  type RendererCapabilities,
  type RendererQuality,
  type AtmosphereSettings,
  type RendererEvents,
  type RendererStats,
  type RenderHost,
  type ResourceCounts,
  type DecodedTile,
  type TileDrawList,
  type TileMeshData,
} from '@vibeglobe/core';
import { RenderExtensions } from './extensions.js';
import { Mesh, Scene, Texture, WebGPURenderer, type MeshBasicNodeMaterial } from 'three/webgpu';
import { readCapabilities } from './capabilities.js';
import { CanvasSlot, captureCanvas } from './canvas-slot.js';
import { createDebugEntry, disposeDebugEntries, placeDebugEntries, type DebugEntry } from './debug-meshes.js';
import { meshBytes } from './debug-meshes.js';
import { LayerBatches } from './layer-batches.js';
import { createTileMesh } from './tile-mesh.js';
import { countVertexArrays, releaseVertexArraysWithBuffers, useFloatMultisampledDepth } from './webgl-compat.js';
import { patchIdentitySwizzle } from './webgpu-compat.js';
import { chooseWebGPU, decodeBitmap, surfaceScope } from './environment.js';
import * as surface from './surface-material.js';
import { createBaseTexture, TileTextures } from './tile-textures.js';
import { depthPathOf, useFloatSceneDepth } from './depth.js';
import { placeTile } from './eye-relative.js';
import { EngineCamera } from './engine-camera.js';
import { stopInternalLoop } from './three-hooks.js';
import { BackendCounters } from './backend-counters.js';
import { warmUpPipelines, webgpuSelfTest } from './warm-up.js';
import { releaseMesh } from './release-mesh.js';
import { SceneAtmosphere } from './atmosphere/scene-atmosphere.js';
import { Antialiasing } from './antialiasing.js';
import type { BackendSettings } from './backend-settings.js';

export type { BackendSettings } from './backend-settings.js';
import {
  RecoveryLimiter,
  createFailureMessage,
  releaseDevice,
  recordContext,
  releaseRenderer,
  watchLoss,
  type LossWatch,
} from './recovery.js';

interface TileEntry {
  readonly data: TileMeshData;
  readonly mesh: Mesh;
  readonly draw: surface.SurfaceDraw;
}

/** Which backend to use: automatic (WebGPU, falling back to WebGL2) or forced. */
export type BackendChoice = 'auto' | 'webgpu' | 'webgl2';

/**
 * Which depth path to use on WebGL2 (ADR 0005 §4): 'auto' uses hardware reversed-Z where `EXT_clip_control` exists
 * and the fragment-written path elsewhere; 'fragment' forces the latter, for tests and diagnostics. WebGPU always
 * uses hardware reversed-Z.
 */
export type DepthChoice = 'auto' | 'fragment';

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
  /** Vertex arrays three.js still held when the backend was destroyed (0 once released: KB-030). */
  private vertexArraysLeft = 0;
  private readonly canvases: CanvasSlot;
  private readonly scene = new Scene();
  private readonly camera = new EngineCamera();
  /** Surface tiles by key (no Map: it boxes keys beyond 31 bits on every per-frame lookup, ADR 0018). */
  private readonly tiles = new IntegerKeyMap<TileEntry>(1024);
  private debugEntries: DebugEntry[] = [];
  readonly layers = new LayerBatches(this.scene, 'reversed-z'); // Data layers (ADR 0037).
  readonly models = this.layers.models;
  /** Subsystems added from outside the core loop (`Globe.addRenderExtension`, M13). */
  readonly extensions = new RenderExtensions({ scene: this.scene, depthPath: () => this.depthPath });
  /** Sky, haze and sun lighting while the quality's atmosphere level is not 'off' (ADR 0040). */
  private readonly atmosphere = new SceneAtmosphere(this.scene);
  /** Anisotropic filtering of imagery tiles (F398), at most the device's. */
  private anisotropy: number | undefined;
  private readonly counters = new BackendCounters();
  /** Why WebGPU failed its start-up self-test, after which this backend uses WebGL2 (ADR 0010 §2). */
  private webgpuFailure: string | undefined;
  private beginFrame: () => void = () => undefined;
  /** Meshes shown by the last frame, reused across frames. */
  private readonly shown: (Mesh | undefined)[] = [];
  private shownCount = 0;
  private material: MeshBasicNodeMaterial | undefined;
  private imageryTexture: Texture | undefined;
  private readonly tileTextures = new TileTextures(() => this.anisotropy ?? this.capabilities.maxAnisotropy);
  private imagery: ImageBitmap | undefined;
  private size = { widthPx: 1, heightPx: 1, pixelRatio: 1 };
  private destroyed = false;
  private recovering = false;
  /** Set when the renderer a recovery just created is lost before the recovery finishes. */
  private lostWhileRecovering = false;
  /** Set when recovery gave up: nothing is drawn any more. */
  private failed = false;
  private readonly recoveries = new RecoveryLimiter();
  /** The static message shown after recovery gave up. */
  private failureMessage: HTMLElement | undefined;
  /** The current device or context: whether it is held, and its loss reporting. */
  private lossWatch: LossWatch = { held: () => false, stop: () => undefined };
  /** The active depth path (ADR 0005 §4). */
  private depthPath: DepthPath = 'reversed-z';
  /** Multisampling or the FXAA pass (KB-140). */
  private readonly antialiasing = new Antialiasing();

  private constructor(
    private readonly surface: DrawingSurface,
    readonly host: RenderHost,
    private readonly events: RendererEvents,
    private readonly settings: BackendSettings,
  ) {
    this.canvases = new CanvasSlot(surface);
    this.camera.matrixAutoUpdate = this.camera.matrixWorldAutoUpdate = this.scene.matrixWorldAutoUpdate = false;
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

  private async initRenderer(): Promise<void> {
    const scope = surfaceScope(this.surface);
    const choice = this.webgpuFailure === undefined ? this.settings.choice : 'webgl2';
    const webgpu = await chooseWebGPU(scope, this.surface, choice);
    const forceWebGL = !webgpu;
    // A recovery may find WebGPU gone (blocked after a GPU-process crash): WebGL2 takes over, reported (KB-049),
    // unless a self-test failure reports it (KB-052).
    const previous = (this.capabilities as RendererCapabilities | undefined)?.backend;
    if (forceWebGL && previous === 'webgpu' && this.webgpuFailure === undefined)
      this.events.backendFallback('WebGPU is no longer available after a device loss; using WebGL2');
    if (webgpu) patchIdentitySwizzle(scope);
    const canvas = this.canvases.next(webgpu);
    const renderer = new WebGPURenderer({
      canvas: canvas as HTMLCanvasElement,
      antialias: this.settings.antialias,
      // three.js turns this off on WebGL2 without EXT_clip_control; the engine then writes depth itself.
      reversedDepthBuffer: webgpu || this.settings.depth === 'auto',
      forceWebGL,
      trackTimestamp: this.settings.gpuTiming,
    });
    await renderer.init();
    this.depthPath = depthPathOf(renderer);
    this.layers.restore(this.depthPath);
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
    this.lossWatch.stop();
    this.lossWatch = watchLoss(renderer, (reason) => this.handleLoss(renderer, reason));
    releaseVertexArraysWithBuffers(renderer.backend);
    // three.js falls back to WebGL2 silently when WebGPU fails to initialize: reported for 'auto', an error for 'webgpu'.
    const fellBack = !forceWebGL && (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true;
    // The canvas holds a WebGL2 context now: recorded, or released with the renderer, so it is not reused for WebGPU.
    if (fellBack) recordContext(canvas, false);
    if (fellBack && this.settings.choice === 'webgpu') {
      releaseRenderer(renderer);
      throw new GlobeError('unsupported-device', 'WebGPU was requested, but it failed to initialize.');
    }
    if (fellBack) this.events.backendFallback('WebGPU initialization failed; using WebGL2');
    this.counters.watch(renderer);
    this.renderer = renderer;
    this.capabilities = readCapabilities(renderer, sceneDepth, this.settings.compressedTextures);
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
    this.counters.meshAdded(mesh);
    this.scene.add(mesh);
    return { data, mesh, draw: surface.attachSurfaceDraw(mesh) };
  }

  /** Replaces the debug quads drawn with the surface's precision path. */
  setDebugMeshes(meshes: readonly DebugMeshData[]): void {
    disposeDebugEntries(this.scene, this.debugEntries);
    this.debugEntries = meshes.map((data) => createDebugEntry(data, this.depthPath));
    for (const entry of this.debugEntries) this.scene.add(entry.mesh);
  }

  /** Cumulative counters (F052). */
  readonly stats = (): RendererStats => this.counters.stats(this.tileTextures.compressedCount);

  /** Releases a surface tile mesh. */
  removeMesh(key: number): void {
    const entry = this.tiles.get(key);
    if (!entry) return;
    releaseMesh(this.scene, entry.mesh);
    this.tiles.delete(key);
    const shownIndex = this.shown.indexOf(entry.mesh);
    if (shownIndex !== -1 && shownIndex < this.shownCount) this.shown[shownIndex] = undefined;
  }

  /** Creates the texture of an imagery tile and uploads it now (M3 plan §3). */
  uploadTexture(handle: number, tile: DecodedTile): void {
    if (!this.destroyed) this.tileTextures.upload(this.renderer, handle, tile);
  }

  /** Releases an imagery tile texture and its image. */
  readonly releaseTexture = (handle: number): void => this.tileTextures.release(handle);

  /** Loads the equirectangular base imagery; resolves when it is decoded and bound to the surface material. */
  async setBaseImagery(url: string): Promise<void> {
    let image: ImageBitmap;
    try {
      image = await decodeBitmap(url);
    } catch (error) {
      throw new GlobeError('resource-failed', `The base imagery could not be loaded from ${url}`, { cause: error });
    }
    if (this.destroyed) return;
    this.imagery = image;
    this.createImageryResources();
    await this.warmUpPipelines();
  }

  /** Compiles the surface pipelines before the first frame (ADR 0010 §4); `pipelineCompiles` counts from here. */
  private async warmUpPipelines(material = this.material): Promise<void> {
    const sky = this.atmosphere.skyMaterial;
    if (material) await warmUpPipelines(this.renderer, sky ? [material, sky] : [material]);
    this.counters.resetCompiles();
  }

  private createImageryResources(): void {
    if (!this.imagery) return;
    const texture = createBaseTexture(this.imagery, this.anisotropy ?? this.capabilities.maxAnisotropy);
    this.imageryTexture?.dispose();
    this.imageryTexture = texture;
    this.material?.dispose();
    // A new renderer may have another depth path: the atmosphere is built again with the material it shades.
    this.atmosphere.rebuild(this.depthPath);
    this.material = surface.createSurfaceMaterial(texture, this.depthPath, this.atmosphere.current);
    const material = this.material;
    this.tiles.forEach((entry) => (entry.mesh.material = material));
  }

  /** Draws the listed tiles with eye-relative offsets for this frame (ADR 0004, ADR 0005). */
  render(view: FrameView, draws: TileDrawList): boolean {
    // Nothing is drawn with a lost renderer: while recovering, or after recovery gave up.
    if (this.destroyed || this.recovering || this.failed || !this.material || !this.imageryTexture) return false;
    // Hide only what the previous frame showed: the work and the memory stay proportional to the drawn tiles.
    for (let i = 0; i < this.shownCount; i++) {
      const mesh = this.shown[i];
      if (mesh) mesh.visible = false;
    }
    this.shownCount = 0;
    this.tileTextures.tones.frame(draws);
    for (let i = 0; i < draws.count; i++) {
      const entry = this.tiles.getAt(draws.meshKeys, i);
      if (!entry) continue;
      surface.applyDraw(entry.draw, draws, i, this.tileTextures, this.imageryTexture);
      entry.mesh.visible = true;
      this.shown[this.shownCount++] = entry.mesh;
      placeTile(entry.mesh, entry.data, view);
    }
    surface.setSurfaceMorph(this.material, view.morph);
    placeDebugEntries(this.debugEntries, view.eyeEcef);
    this.layers.place(view);
    this.extensions.frame(view);
    this.camera.apply(view, this.depthPath);
    this.atmosphere.update(view);
    this.beginFrame();
    this.counters.beforeRender();
    this.antialiasing.render(this.renderer, this.scene, this.camera);
    this.counters.afterRender(this.renderer, this.settings.gpuTiming);
    return true;
  }

  /** Sets the drawing-buffer size: CSS size times pixel ratio. */
  resize(widthPx: number, heightPx: number, pixelRatio: number): void {
    this.size = { widthPx, heightPx, pixelRatio };
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(widthPx, heightPx, false);
  }

  /** GPU resource counters, counted from what is actually held (after destroy too, so a leak shows). */
  resourceCounts(): ResourceCounts {
    const gpuBytes = meshBytes(this.tiles, this.debugEntries);
    const image = this.imageryTexture ? this.imagery : undefined;
    const textureBytes = image ? Math.round((image.width * image.height * 4 * 4) / 3) : 0;
    return {
      meshes: this.tiles.size + this.debugEntries.length + this.layers.meshCount,
      textures: (this.imageryTexture ? 1 : 0) + this.tileTextures.size,
      gpuBytes: gpuBytes + textureBytes + this.tileTextures.gpuBytes + this.layers.gpuBytes,
      vertexArrays: this.destroyed ? this.vertexArraysLeft : countVertexArrays(this.renderer.backend),
      contexts: this.lossWatch.held() ? 1 : 0,
    };
  }

  /** The frame just drawn, read from the canvas in the calling task (ADR 0012, Capture). */
  readonly capture = (): Promise<FrameCapture> => captureCanvas(this.canvases.drawingCanvas);

  /**
   * Applies the effects of the engine's quality settings (F398, F399, KB-140): anisotropy, the atmosphere level and the
   * anti-aliasing.
   */
  setQuality(quality: RendererQuality): Promise<void> | undefined {
    this.anisotropy = quality.anisotropy;
    if (!this.destroyed) this.tileTextures.refilter(this.renderer, this.imageryTexture);
    const atmosphereChanged = this.atmosphere.setQuality(quality, this.depthPath);
    if (this.destroyed || this.failed) return undefined;
    this.antialiasing.set(quality.antialias);
    // A recovering backend loads the pass with its new renderer; the atmosphere appearing or going away rebuilds the
    // surface material that it shades.
    const pass = this.recovering ? undefined : this.antialiasing.prepare(this.renderer, this.scene, this.camera);
    const material = atmosphereChanged && this.imageryTexture ? this.swapMaterial(this.imageryTexture) : undefined;
    return pass || material ? Promise.all([pass, material]).then(() => undefined) : undefined;
  }

  /**
   * Replaces the surface material once the new one is compiled: until then the frames keep the old one, since a
   * material whose pipeline is still compiling is skipped and the globe would vanish for a frame (F399).
   */
  private async swapMaterial(texture: Texture): Promise<void> {
    const material = surface.createSurfaceMaterial(texture, this.depthPath, this.atmosphere.current);
    await this.warmUpPipelines(material);
    if (this.destroyed || this.imageryTexture !== texture) return material.dispose();
    this.material?.dispose();
    this.material = material;
    this.tiles.forEach((entry) => (entry.mesh.material = material));
  }

  /** The atmosphere's sun lighting, time and haze (F394, F396): uniforms only. */
  setAtmosphere(settings: Required<AtmosphereSettings>): void {
    this.atmosphere.setSky(settings);
  }

  /** Test hook: destroys the WebGPU device or loses the WebGL2 context. */
  readonly simulateDeviceLoss = (): void => releaseDevice(this.renderer.backend);

  private handleLoss(lost: WebGPURenderer, reason: string): void {
    // Only the current renderer's loss counts: one replaced or disposed by this backend is expected to go away.
    if (this.destroyed || this.failed || lost !== this.renderer) return;
    // The recovery's new renderer lost too: the recovery notices after its next wait and starts over (KB-044).
    if (this.recovering) {
      this.lostWhileRecovering = true;
      return;
    }
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
      this.antialiasing.release();
      this.renderer.dispose();
      this.tiles.forEach((entry) => entry.mesh.geometry.dispose());
      this.tileTextures.disposeTextures();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (this.destroyed) return;
      await this.initRenderer();
      if (this.abandoned()) return;
      this.createImageryResources();
      this.tileTextures.restore(this.renderer);
      await this.warmUpPipelines();
      if (this.abandoned()) return;
      if (this.lostWhileRecovering || !this.lossWatch.held()) {
        this.lostWhileRecovering = false;
        this.recovering = false;
        this.handleLoss(this.renderer, 'lost again during recovery');
        return;
      }
      this.setDebugMeshes(this.debugEntries.map((entry) => entry.data));
      await this.antialiasing.prepare(this.renderer, this.scene, this.camera);
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

  /** Destroyed while the new renderer started or warmed up: release it, show nothing, keep nothing (KB-035, KB-053). */
  private abandoned(): boolean {
    if (!this.destroyed) return false;
    releaseRenderer(this.renderer);
    this.forgetRenderer();
    return true;
  }

  /**
   * A host may keep its reference to the globe after unmounting: nothing large stays reachable from it (KB-045). No
   * method touches the renderer or the imagery after destroy.
   */
  private forgetRenderer(): void {
    (this as unknown as { renderer: WebGPURenderer | undefined }).renderer = undefined;
    this.beginFrame = () => undefined;
    this.lossWatch.stop();
  }

  /** Frees every GPU resource and removes the canvas. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const keys: number[] = [];
    this.tiles.forEach((_, key) => keys.push(key));
    for (const key of keys) this.removeMesh(key);
    this.setDebugMeshes([]);
    this.layers.dispose();
    this.extensions.dispose();
    this.atmosphere.dispose();
    this.material?.dispose();
    this.material = undefined;
    this.imageryTexture?.dispose();
    this.imageryTexture = undefined;
    this.tileTextures.clear();
    releaseRenderer(this.renderer);
    this.vertexArraysLeft = countVertexArrays(this.renderer.backend);
    this.forgetRenderer();
    this.imagery?.close();
    this.imagery = undefined;
    this.canvases.remove();
    this.failureMessage?.remove();
  }
}
