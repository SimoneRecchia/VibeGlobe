import {
  GlobeError,
  IntegerKeyMap,
  type DebugMeshData,
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
  Camera,
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
import { createDebugEntry, type DebugEntry } from './debug-meshes.js';
import { createTileMesh } from './tile-mesh.js';
import { patchIdentitySwizzle } from './webgpu-compat.js';
import { createSurfaceMaterial, placeEyeRelative } from './surface-material.js';

/** A camera whose matrices the engine writes every frame; three.js must not recompute them. */
class EngineCamera extends Camera {
  /** Intentionally empty: the engine supplies the reversed-Z infinite projection (ADR 0005). */
  updateProjectionMatrix(): void {}
}

interface TileEntry {
  readonly data: TileMeshData;
  readonly mesh: Mesh;
}

/** Which backend to use: automatic (WebGPU, falling back to WebGL2) or forced. */
export type BackendChoice = 'auto' | 'webgpu' | 'webgl2';

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
  private canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
  private readonly scene = new Scene();
  private readonly camera = new EngineCamera();
  /** Surface tiles by key (no Map: it boxes keys beyond 31 bits on every per-frame lookup, ADR 0018). */
  private readonly tiles = new IntegerKeyMap<TileEntry>(1024);
  private debugEntries: DebugEntry[] = [];
  private textureUploads = 0;
  private matrixUpdates = 0;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
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

  private constructor(
    private readonly surface: DrawingSurface,
    readonly host: RenderHost,
    private readonly choice: BackendChoice,
    private readonly events: RendererEvents,
  ) {
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** Creates and initializes a backend; rejects with GlobeError 'unsupported-device' when nothing can render. */
  static async create(
    surface: DrawingSurface,
    host: RenderHost,
    choice: BackendChoice,
    events: RendererEvents,
  ): Promise<ThreeBackend> {
    const backend = new ThreeBackend(surface, host, choice, events);
    await backend.initRenderer();
    return backend;
  }

  /** The canvas, which receives input; none for an OffscreenCanvas (its host forwards input). */
  get inputElement(): HTMLCanvasElement | undefined {
    return this.surface.kind === 'element' ? (this.canvas as HTMLCanvasElement | undefined) : undefined;
  }

  /** The global scope the canvas lives in: the page's window, or the worker's global scope. */
  private scope(): typeof globalThis {
    return this.surface.kind === 'element'
      ? ((this.surface.container.ownerDocument.defaultView ?? globalThis) as typeof globalThis)
      : globalThis;
  }

  private async initRenderer(): Promise<void> {
    const scope = this.scope();
    const webgpu = this.choice !== 'webgl2' && (await webgpuUsable(scope));
    // A forced backend never falls back (ADR 0010 §2).
    if (this.choice === 'webgpu' && !webgpu) {
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
    const canvas = this.nextCanvas();
    const renderer = new WebGPURenderer({
      canvas: canvas as HTMLCanvasElement,
      antialias: true,
      reversedDepthBuffer: true,
      forceWebGL,
    });
    await renderer.init();
    this.stopInternalLoop(renderer);
    // Opaque tiles need no depth sorting; sorting would also compute bounds and distances for every object each frame.
    renderer.sortObjects = false;
    // Every material is unlit. With lighting enabled three.js still rebuilds the lights node's cache key on every render
    // call, about 5 KB of garbage per frame (F064, ADR 0018).
    renderer.lighting.enabled = false;
    renderer.onDeviceLost = (info: { message?: string }) => this.handleLoss(renderer, info.message ?? 'device lost');
    // three.js ignores losses with the reason 'destroyed', assuming it destroyed the device itself; any loss of a
    // device this backend did not dispose must still recover.
    const device = (renderer.backend as { device?: GPUDevice }).device;
    void device?.lost.then((info) => this.handleLoss(renderer, info.message || info.reason));
    // three.js falls back to WebGL2 silently when WebGPU fails to initialize: reported for 'auto', an error for 'webgpu'.
    const fellBack = !forceWebGL && (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true;
    if (fellBack && this.choice === 'webgpu') {
      renderer.dispose();
      throw new GlobeError('unsupported-device', 'WebGPU was requested, but it failed to initialize.');
    }
    if (fellBack) this.events.backendFallback('WebGPU initialization failed; using WebGL2');
    const backend = renderer.backend as { updateTexture?: (...args: unknown[]) => unknown };
    const updateTexture = backend.updateTexture?.bind(backend);
    if (updateTexture) {
      backend.updateTexture = (...args: unknown[]) => {
        this.textureUploads++;
        return updateTexture(...args);
      };
    }
    if (this.surface.kind === 'element') {
      const element = canvas as HTMLCanvasElement;
      const previous = this.canvas as HTMLCanvasElement | undefined;
      if (previous !== undefined && previous !== element) previous.replaceWith(element);
      else if (!element.isConnected) this.surface.container.appendChild(element);
    }
    this.canvas = canvas;
    this.renderer = renderer;
    this.capabilities = readCapabilities(renderer);
    renderer.setPixelRatio(this.size.pixelRatio);
    renderer.setSize(this.size.widthPx, this.size.heightPx, false);
  }

  /**
   * The canvas for a new renderer: the given one first; after a loss, a fresh element in a page container (an
   * OffscreenCanvas cannot be replaced, so recovery fails there).
   */
  private nextCanvas(): HTMLCanvasElement | OffscreenCanvas {
    if (this.canvas === undefined) return this.surface.canvas ?? this.newCanvas();
    if (this.surface.kind === 'offscreen') {
      throw new GlobeError('renderer-failed', 'An OffscreenCanvas cannot be replaced after a device or context loss');
    }
    return this.newCanvas();
  }

  /** A fresh canvas, carrying over the identity and accessibility attributes of the one it replaces. */
  private newCanvas(): HTMLCanvasElement {
    if (this.surface.kind !== 'element') throw new Error('newCanvas needs a page container');
    const canvas = this.surface.container.ownerDocument.createElement('canvas');
    const previous = this.canvas as HTMLCanvasElement | undefined;
    for (const name of ['id', 'class', 'aria-label', 'role']) {
      const value = previous?.getAttribute(name);
      if (value) canvas.setAttribute(name, value);
    }
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    canvas.tabIndex = 0;
    return canvas;
  }

  /**
   * three.js 0.186 starts its own requestAnimationFrame loop in init() and keeps it running forever, which defeats
   * render on demand and allocates every display frame. The engine owns the frame loop, so the internal loop is
   * stopped and its bookkeeping (counter reset, node-frame clock) runs at the start of each engine render instead.
   * These are private members of the pinned version (ADR 0010).
   */
  private stopInternalLoop(renderer: WebGPURenderer): void {
    const internals = renderer as unknown as {
      _animation?: { stop(): void };
      _nodes?: { nodeFrame: { update(): void } };
    };
    internals._animation?.stop();
    this.beginFrame = () => {
      if (renderer.info.autoReset) renderer.info.reset();
      internals._nodes?.nodeFrame.update();
    };
  }

  /** Creates the GPU mesh of a surface tile and keeps its CPU copy for loss recovery. */
  addMesh(data: TileMeshData): void {
    if (!this.tiles.has(data.key)) this.tiles.set(data.key, this.entryFor(data));
  }

  private entryFor(data: TileMeshData): TileEntry {
    const mesh = createTileMesh(data, this.material);
    this.countMatrixUpdates(mesh);
    this.scene.add(mesh);
    return { data, mesh };
  }

  /** Counts any automatic matrix update three.js performs on a tile mesh; the engine expects none (F052). */
  private countMatrixUpdates(mesh: Mesh): void {
    const updateMatrix = mesh.updateMatrix.bind(mesh);
    const updateMatrixWorld = mesh.updateMatrixWorld.bind(mesh);
    mesh.updateMatrix = () => {
      this.matrixUpdates++;
      updateMatrix();
    };
    mesh.updateMatrixWorld = (force?: boolean) => {
      this.matrixUpdates++;
      updateMatrixWorld(force);
    };
  }

  /** Replaces the debug quads drawn with the surface's precision path. */
  setDebugMeshes(meshes: readonly DebugMeshData[]): void {
    for (const entry of this.debugEntries) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      (entry.mesh.material as MeshBasicNodeMaterial).dispose();
    }
    this.debugEntries = meshes.map((data) => createDebugEntry(data));
    for (const entry of this.debugEntries) this.scene.add(entry.mesh);
  }

  /** Cumulative counters (F052). */
  stats(): RendererStats {
    return {
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      textureUploads: this.textureUploads,
      matrixUpdates: this.matrixUpdates,
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
    this.material = createSurfaceMaterial(texture);
    const material = this.material;
    this.tiles.forEach((entry) => (entry.mesh.material = material));
  }

  /** Draws the listed tiles with eye-relative offsets for this frame (ADR 0004). */
  render(view: FrameView, keys: readonly number[], count: number): void {
    if (this.destroyed || !this.material) return;
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
    this.camera.matrixWorldInverse.fromArray(view.view);
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert();
    this.camera.projectionMatrix.fromArray(view.projection);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.beginFrame();
    this.renderer.render(this.scene, this.camera);
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

  /** GPU resource counters; all zero after destroy. */
  resourceCounts(): ResourceCounts {
    if (this.destroyed) return { meshes: 0, textures: 0, gpuBytes: 0 };
    let gpuBytes = 0;
    this.tiles.forEach((entry) => (gpuBytes += entry.data.byteLength + entry.data.indices.byteLength));
    const image = this.imagery;
    const textureBytes = image && this.imageryTexture ? Math.round((image.width * image.height * 4 * 4) / 3) : 0;
    return { meshes: this.tiles.size, textures: this.imageryTexture ? 1 : 0, gpuBytes: gpuBytes + textureBytes };
  }

  /** Test hook: destroys the WebGPU device or loses the WebGL2 context. */
  simulateDeviceLoss(): void {
    const backend = this.renderer.backend as { device?: GPUDevice; gl?: WebGL2RenderingContext };
    if (backend.device) backend.device.destroy();
    else backend.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private handleLoss(lost: WebGPURenderer, reason: string): void {
    // Only the current renderer's loss counts: one replaced or disposed by this backend is expected to go away.
    if (this.destroyed || lost !== this.renderer || this.recovering) return;
    this.recovering = true;
    this.events.deviceLost(reason);
    void this.recover();
  }

  private async recover(): Promise<void> {
    try {
      this.renderer.dispose();
      this.tiles.forEach((entry) => entry.mesh.geometry.dispose());
      await this.initRenderer();
      this.createImageryResources();
      this.setDebugMeshes(this.debugEntries.map((entry) => entry.data));
      this.recovering = false;
      this.events.deviceRestored();
    } catch (error) {
      this.events.failed(
        new GlobeError('renderer-failed', 'The renderer could not recover from a device loss', { cause: error }),
      );
    }
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
    this.imageryTexture?.dispose();
    this.renderer.dispose();
    if (this.surface.kind === 'element') (this.canvas as HTMLCanvasElement | undefined)?.remove();
  }
}

/** True when the browser offers a WebGPU adapter. */
async function webgpuUsable(scope: typeof globalThis): Promise<boolean> {
  const gpu = (scope.navigator as Navigator | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/** True when a WebGL2 context can be created. */
function webgl2Usable(surface: DrawingSurface): boolean {
  const probe =
    surface.kind === 'element' ? surface.container.ownerDocument.createElement('canvas') : new OffscreenCanvas(1, 1);
  const context = probe.getContext('webgl2');
  context?.getExtension('WEBGL_lose_context')?.loseContext();
  return context !== null;
}

/** Decodes an image in the page. */
async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url;
  await image.decode();
  return image;
}

/** Fetches and decodes an image where there is no DOM (ADR 0011), flipped at decode time like the page's images. */
async function decodeBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return createImageBitmap(await response.blob(), { imageOrientation: 'flipY' });
}
