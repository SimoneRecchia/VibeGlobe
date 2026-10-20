import {
  GlobeError,
  type FrameView,
  type RendererBackend,
  type RendererCapabilities,
  type RendererEvents,
  type RenderHost,
  type ResourceCounts,
  type TileMeshData,
} from '@vibeglobe/core';
import {
  BufferAttribute,
  BufferGeometry,
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
import { patchIdentitySwizzle } from './webgpu-compat.js';
import { attachEyeOffset, createSurfaceMaterial, setEyeOffset, type EyeOffset } from './surface-material.js';

/** A camera whose matrices the engine writes every frame; three.js must not recompute them. */
class EngineCamera extends Camera {
  /** Intentionally empty: the engine supplies the reversed-Z infinite projection (ADR 0005). */
  updateProjectionMatrix(): void {}
}

interface TileEntry {
  readonly data: TileMeshData;
  readonly mesh: Mesh;
  readonly offset: EyeOffset;
}

/** Which backend to use: automatic (WebGPU, falling back to WebGL2) or forced. */
export type BackendChoice = 'auto' | 'webgpu' | 'webgl2';

/**
 * The renderer behind the engine's RendererBackend interface, on three.js WebGPURenderer (ADR 0010). It keeps CPU
 * copies of every mesh and the base imagery, so after a device or context loss it rebuilds the renderer and its canvas
 * and restores everything without a page reload.
 */
export class ThreeBackend implements RendererBackend {
  capabilities!: RendererCapabilities;
  private renderer!: WebGPURenderer;
  private canvas: HTMLCanvasElement | undefined;
  private readonly scene = new Scene();
  private readonly camera = new EngineCamera();
  private readonly tiles = new Map<number, TileEntry>();
  private material: MeshBasicNodeMaterial | undefined;
  private imageryTexture: Texture | undefined;
  private imagery: HTMLImageElement | undefined;
  private size = { widthPx: 1, heightPx: 1, pixelRatio: 1 };
  private destroyed = false;

  private constructor(
    private readonly container: HTMLElement,
    readonly host: RenderHost,
    private readonly choice: BackendChoice,
    private readonly events: RendererEvents,
    private initialCanvas: HTMLCanvasElement | undefined,
  ) {
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** Creates and initializes a backend; rejects with GlobeError 'unsupported-device' when nothing can render. */
  static async create(
    container: HTMLElement,
    host: RenderHost,
    choice: BackendChoice,
    events: RendererEvents,
    canvas?: HTMLCanvasElement,
  ): Promise<ThreeBackend> {
    const backend = new ThreeBackend(container, host, choice, events, canvas);
    await backend.initRenderer();
    return backend;
  }

  /** The canvas, which receives input. */
  get inputElement(): HTMLCanvasElement | undefined {
    return this.canvas;
  }

  private async initRenderer(): Promise<void> {
    const forceWebGL = this.choice === 'webgl2' || !(await webgpuUsable(this.container));
    const view = this.container.ownerDocument.defaultView;
    if (!forceWebGL && view) patchIdentitySwizzle(view);
    if (!forceWebGL && this.choice === 'auto') {
      // WebGPU is usable: three.js would still fall back silently if init failed, which we detect below.
    } else if (!webgl2Usable(this.container)) {
      throw new GlobeError(
        'unsupported-device',
        'This device supports neither WebGPU nor WebGL2, so the globe cannot render.',
      );
    }
    const canvas = this.initialCanvas ?? this.newCanvas();
    this.initialCanvas = undefined;
    const renderer = new WebGPURenderer({ canvas, antialias: true, reversedDepthBuffer: true, forceWebGL });
    await renderer.init();
    renderer.onDeviceLost = (info: { message?: string }) => this.handleLoss(info.message ?? 'device lost');
    if (
      this.choice === 'auto' &&
      !forceWebGL &&
      (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true
    ) {
      this.events.backendFallback('WebGPU initialization failed; using WebGL2');
    }
    if (this.canvas !== undefined && this.canvas !== canvas) this.canvas.replaceWith(canvas);
    else if (!canvas.isConnected) this.container.appendChild(canvas);
    this.canvas = canvas;
    this.renderer = renderer;
    this.capabilities = readCapabilities(renderer);
    renderer.setPixelRatio(this.size.pixelRatio);
    renderer.setSize(this.size.widthPx, this.size.heightPx, false);
  }

  /** A fresh canvas, carrying over the identity and accessibility attributes of the one it replaces. */
  private newCanvas(): HTMLCanvasElement {
    const canvas = this.container.ownerDocument.createElement('canvas');
    for (const name of ['id', 'class', 'aria-label', 'role']) {
      const value = this.canvas?.getAttribute(name);
      if (value) canvas.setAttribute(name, value);
    }
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    canvas.tabIndex = 0;
    return canvas;
  }

  /** Creates the GPU mesh of a surface tile and keeps its CPU copy for loss recovery. */
  addMesh(data: TileMeshData): void {
    if (!this.tiles.has(data.key)) this.tiles.set(data.key, this.entryFor(data));
  }

  private entryFor(data: TileMeshData): TileEntry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2));
    geometry.setIndex(new BufferAttribute(data.indices, 1));
    const mesh = new Mesh(geometry, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    return { data, mesh, offset: attachEyeOffset(mesh) };
  }

  /** Releases a surface tile mesh. */
  removeMesh(key: number): void {
    const entry = this.tiles.get(key);
    if (!entry) return;
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    this.tiles.delete(key);
  }

  /** Loads the equirectangular base imagery; resolves when it is decoded and bound to the surface material. */
  async setBaseImagery(url: string): Promise<void> {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = url;
    try {
      await image.decode();
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
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.anisotropy = this.capabilities.maxAnisotropy;
    texture.needsUpdate = true;
    this.imageryTexture?.dispose();
    this.imageryTexture = texture;
    this.material?.dispose();
    this.material = createSurfaceMaterial(texture);
    for (const entry of this.tiles.values()) entry.mesh.material = this.material;
  }

  /** Draws the listed tiles with eye-relative offsets for this frame (ADR 0004). */
  render(view: FrameView, keys: readonly number[], count: number): void {
    if (this.destroyed || !this.material) return;
    for (const entry of this.tiles.values()) entry.mesh.visible = false;
    for (let i = 0; i < count; i++) {
      const entry = this.tiles.get(keys[i] ?? -1);
      if (!entry) continue;
      entry.mesh.visible = true;
      setEyeOffset(entry.offset, entry.data.originEcef, view.eyeEcef);
    }
    this.camera.matrixWorldInverse.fromArray(view.view);
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert();
    this.camera.projectionMatrix.fromArray(view.projection);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.render(this.scene, this.camera);
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
    for (const entry of this.tiles.values()) gpuBytes += entry.data.byteLength + entry.data.indices.byteLength;
    const image = this.imagery;
    const textureBytes =
      image && this.imageryTexture ? Math.round((image.naturalWidth * image.naturalHeight * 4 * 4) / 3) : 0;
    return { meshes: this.tiles.size, textures: this.imageryTexture ? 1 : 0, gpuBytes: gpuBytes + textureBytes };
  }

  /** Test hook: destroys the WebGPU device or loses the WebGL2 context. */
  simulateDeviceLoss(): void {
    const backend = this.renderer.backend as { device?: GPUDevice; gl?: WebGL2RenderingContext };
    if (backend.device) backend.device.destroy();
    else backend.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private handleLoss(reason: string): void {
    if (this.destroyed) return;
    this.events.deviceLost(reason);
    void this.recover();
  }

  private async recover(): Promise<void> {
    try {
      this.renderer.dispose();
      for (const entry of this.tiles.values()) entry.mesh.geometry.dispose();
      await this.initRenderer();
      this.createImageryResources();
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
    for (const key of [...this.tiles.keys()]) this.removeMesh(key);
    this.material?.dispose();
    this.imageryTexture?.dispose();
    this.renderer.dispose();
    this.canvas?.remove();
  }
}

/** True when the browser offers a WebGPU adapter. */
async function webgpuUsable(container: HTMLElement): Promise<boolean> {
  const gpu = (container.ownerDocument.defaultView?.navigator as Navigator | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/** True when a WebGL2 context can be created. */
function webgl2Usable(container: HTMLElement): boolean {
  const probe = container.ownerDocument.createElement('canvas');
  const context = probe.getContext('webgl2');
  context?.getExtension('WEBGL_lose_context')?.loseContext();
  return context !== null;
}
