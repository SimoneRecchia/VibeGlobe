import {
  ATTRIBUTE_COMPONENTS,
  type BatchAttribute,
  type BatchDescriptor,
  type BatchHandle,
  type BatchStringChannel,
  type DepthPath,
  type FeatureGeometry,
  type FrameView,
  type LayerRenderTarget,
} from '@vibeglobe/core';
import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  type MeshBasicNodeMaterial,
  type Scene,
} from 'three/webgpu';
import { placeTile } from './eye-relative.js';
import { pickAt } from './layer-picking.js';
import { LayerAtlas, type AtlasImage } from './layer-atlas.js';
import { buildLayerArrays, type BatchContents, type LayerArrays } from './layer-geometry.js';
import { createLayerMaterial, setLayerViewport, type LayerShape } from './layer-material.js';
import { setSurfaceMorph } from './surface-material.js';

/** Draw order of layers: after every surface tile (three.js sorts transparent objects by this, then by order). */
const LAYER_RENDER_ORDER = 1000;

interface Batch extends BatchContents {
  readonly descriptor: BatchDescriptor;
  capacity: number;
  order: number;
  visible: boolean;
  dirty: boolean;
  mesh: Mesh | undefined;
  arrays: LayerArrays | undefined;
}

function shapeOf(kind: BatchDescriptor['kind']): LayerShape {
  return kind === 'polyline' ? 'line' : kind === 'polygon' || kind === 'circle' ? 'flat' : 'quad';
}

/**
 * The renderer's side of data layers (ADR 0037): batches kept on the CPU as the layers package writes them, rebuilt
 * into meshes on the next frame after a change, and placed eye-relative between the globe and the flat map each
 * frame like surface tiles. Hidden and empty batches draw nothing.
 */
export class LayerBatches implements LayerRenderTarget {
  private readonly batches = new Map<number, Batch>();
  private readonly materials = new Map<LayerShape, MeshBasicNodeMaterial>();
  private nextId = 1;
  /** Labels and marker images (ADR 0037). */
  private readonly atlas = new LayerAtlas();
  private atlasGeneration = 0;
  /** The last frame's view, for picking. */
  private lastView: FrameView | undefined;

  constructor(
    private readonly scene: Scene,
    private depthPath: DepthPath,
  ) {}

  /** See {@link LayerRenderTarget}. */
  createBatch(descriptor: BatchDescriptor): BatchHandle {
    const id = this.nextId++;
    this.batches.set(id, {
      descriptor,
      kind: descriptor.kind,
      capacity: descriptor.capacity,
      count: 0,
      order: 0,
      visible: true,
      dirty: true,
      attributes: new Map(),
      uniforms: new Map(),
      strings: new Map(),
      geometry: new Map(),
      mesh: undefined,
      arrays: undefined,
    });
    return { id };
  }

  /** See {@link LayerRenderTarget}. */
  growBatch(handle: BatchHandle, capacity: number): void {
    const batch = this.get(handle);
    batch.capacity = Math.max(batch.capacity, capacity);
  }

  /** See {@link LayerRenderTarget}. */
  writeRange(
    handle: BatchHandle,
    attribute: BatchAttribute,
    first: number,
    count: number,
    data: Float64Array | Float32Array | Uint32Array,
  ): void {
    const batch = this.get(handle);
    const components = ATTRIBUTE_COMPONENTS[attribute];
    let values = batch.attributes.get(attribute);
    const needed = Math.max(batch.capacity, first + count) * components;
    if (!values || values.length < needed) {
      const grown = new Float64Array(needed);
      if (values) grown.set(values);
      values = grown;
      batch.attributes.set(attribute, values);
    }
    for (let i = first * components; i < (first + count) * components; i++) values[i] = data[i] ?? 0;
    batch.dirty = true;
  }

  /** See {@link LayerRenderTarget}. */
  writeStrings(
    handle: BatchHandle,
    channel: BatchStringChannel,
    first: number,
    count: number,
    values: readonly string[],
  ): void {
    const batch = this.get(handle);
    const strings = batch.strings.get(channel) ?? [];
    for (let i = first; i < first + count; i++) strings[i] = values[i] ?? '';
    batch.strings.set(channel, strings);
    batch.dirty = true;
  }

  /** See {@link LayerRenderTarget}. */
  writeGeometry(handle: BatchHandle, feature: number, geometry: FeatureGeometry): void {
    const batch = this.get(handle);
    batch.geometry.set(feature, geometry);
    batch.dirty = true;
  }

  /** See {@link LayerRenderTarget}. */
  setUniform(handle: BatchHandle, attribute: BatchAttribute, value: Float64Array | undefined): void {
    const batch = this.get(handle);
    if (value) batch.uniforms.set(attribute, Float64Array.from(value));
    else batch.uniforms.delete(attribute);
    batch.dirty = true;
  }

  /** See {@link LayerRenderTarget}. */
  setCount(handle: BatchHandle, count: number): void {
    const batch = this.get(handle);
    batch.count = count;
    batch.dirty = true;
  }

  /** See {@link LayerRenderTarget}. */
  setOrder(handle: BatchHandle, order: number): void {
    const batch = this.get(handle);
    batch.order = order;
    if (batch.mesh) batch.mesh.renderOrder = LAYER_RENDER_ORDER + order;
  }

  /** See {@link LayerRenderTarget}. */
  setVisible(handle: BatchHandle, visible: boolean): void {
    this.get(handle).visible = visible;
  }

  /** See {@link LayerRenderTarget}. */
  release(handle: BatchHandle): void {
    const batch = this.batches.get(handle.id);
    if (!batch) return;
    this.disposeMesh(batch);
    this.batches.delete(handle.id);
  }

  /** Registers or replaces a marker image by name (the `icon` channel names it); markers using it redraw. */
  addImage(name: string, image: unknown): void {
    this.atlas.addImage(name, image as AtlasImage);
    for (const batch of this.batches.values()) if (batch.kind === 'marker') batch.dirty = true;
  }

  /** See {@link LayerRenderTarget}: picked on the CPU against the last drawn frame. */
  pick(point: { readonly xPx: number; readonly yPx: number }): Promise<number> {
    const view = this.lastView;
    return Promise.resolve(view ? pickAt(this.batches.values(), view, point.xPx, point.yPx) : 0);
  }

  /** Meshes held, for the resource counters. */
  get meshCount(): number {
    let count = 0;
    for (const batch of this.batches.values()) if (batch.mesh) count++;
    return count;
  }

  /** Brings every batch up to date and places it for this frame (call before drawing the scene). */
  place(view: FrameView): void {
    this.lastView = view;
    this.atlas.setPixelRatio(view.pixelRatio);
    if (this.atlas.generation !== this.atlasGeneration) {
      // The atlas started over: every label and marker is drawn into it again.
      this.atlasGeneration = this.atlas.generation;
      for (const batch of this.batches.values())
        if (batch.kind === 'label' || batch.kind === 'marker') batch.dirty = true;
    }
    for (const batch of this.batches.values()) {
      if (batch.dirty) this.rebuild(batch);
      const mesh = batch.mesh;
      if (!mesh || !batch.arrays) continue;
      mesh.visible = batch.visible;
      if (batch.visible) placeTile(mesh, batch.arrays.origin, view);
    }
    // After the rebuilds, which may have created materials.
    for (const material of this.materials.values()) {
      setSurfaceMorph(material, view.morph);
      setLayerViewport(material, view.widthPx, view.heightPx);
    }
  }

  /** After a device loss: new materials for the new renderer, and every mesh rebuilt from the CPU copies. */
  restore(depthPath: DepthPath): void {
    this.depthPath = depthPath;
    for (const batch of this.batches.values()) {
      this.disposeMesh(batch);
      batch.dirty = true;
    }
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }

  /** Releases every batch and material. */
  dispose(): void {
    this.atlas.dispose();
    for (const batch of this.batches.values()) this.disposeMesh(batch);
    this.batches.clear();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }

  private get(handle: BatchHandle): Batch {
    const batch = this.batches.get(handle.id);
    if (!batch) throw new Error(`Unknown layer batch ${String(handle.id)}`);
    return batch;
  }

  private material(shape: LayerShape): MeshBasicNodeMaterial {
    let material = this.materials.get(shape);
    if (!material) {
      material = createLayerMaterial(shape, this.depthPath, this.atlas.texture);
      this.materials.set(shape, material);
    }
    return material;
  }

  private rebuild(batch: Batch): void {
    batch.dirty = false;
    this.disposeMesh(batch);
    const arrays = buildLayerArrays(batch, this.atlas);
    batch.arrays = arrays;
    if (!arrays) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('tileNormal', new BufferAttribute(arrays.normals, 3));
    geometry.setAttribute('tilePlane', new BufferAttribute(arrays.planes, 4));
    geometry.setAttribute('layerHeight', new BufferAttribute(arrays.heights, 1));
    geometry.setAttribute('layerColor', new BufferAttribute(arrays.colors, 4));
    geometry.setAttribute('layerCorner', new BufferAttribute(arrays.corners, 4));
    if (shapeOf(batch.kind) === 'quad') geometry.setAttribute('layerUv', new BufferAttribute(arrays.uvs, 2));
    if (arrays.other) setOtherEndpoint(geometry, arrays.other, arrays.vertices);
    geometry.setIndex(new BufferAttribute(arrays.indices, 1));
    const mesh = new Mesh(geometry, this.material(shapeOf(batch.kind)));
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = LAYER_RENDER_ORDER + batch.order;
    batch.mesh = mesh;
    this.scene.add(mesh);
  }

  private disposeMesh(batch: Batch): void {
    if (!batch.mesh) return;
    this.scene.remove(batch.mesh);
    batch.mesh.geometry.dispose();
    batch.mesh = undefined;
  }
}

/**
 * The other endpoint of each line vertex's segment, interleaved in one vertex buffer: WebGPU allows 8 per pipeline, and
 * a line vertex has 10 attributes.
 */
function setOtherEndpoint(geometry: BufferGeometry, other: NonNullable<LayerArrays['other']>, vertices: number): void {
  const stride = 11;
  const data = new Float32Array(vertices * stride);
  for (let v = 0; v < vertices; v++) {
    const at = v * stride;
    for (let i = 0; i < 3; i++) data[at + i] = other.positions[v * 3 + i] ?? 0;
    for (let i = 0; i < 3; i++) data[at + 3 + i] = other.normals[v * 3 + i] ?? 0;
    for (let i = 0; i < 4; i++) data[at + 6 + i] = other.planes[v * 4 + i] ?? 0;
    data[at + 10] = other.heights[v] ?? 0;
  }
  const buffer = new InterleavedBuffer(data, stride);
  geometry.setAttribute('otherPosition', new InterleavedBufferAttribute(buffer, 3, 0));
  geometry.setAttribute('otherNormal', new InterleavedBufferAttribute(buffer, 3, 3));
  geometry.setAttribute('otherPlane', new InterleavedBufferAttribute(buffer, 4, 6));
  geometry.setAttribute('otherHeight', new InterleavedBufferAttribute(buffer, 1, 10));
}
