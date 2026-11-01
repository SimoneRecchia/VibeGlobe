// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { rebuildLater, sameValues, touchBatch } from './layer-pick-grid.js';
import {
  ATTRIBUTE_COMPONENTS,
  type BatchAttribute,
  type BatchDescriptor,
  type BatchHandle,
  type BatchStringChannel,
  type DepthPath,
  type FeatureGeometry,
  type FrameView,
  type LayerGround,
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
import { releaseMesh } from './release-mesh.js';
import { LAYER_RENDER_ORDER, orderLayerMeshes } from './layer-order.js';
import { pickAt } from './layer-picking.js';
import { geometryBytes, LayerModels } from './layer-models.js';
import { LayerAtlas, type AtlasImage } from './layer-atlas.js';
import { FieldWaits, LabelSdf } from './label-sdf.js';
import { FeatureChanges, stableRanges } from './layer-changes.hot.js';
import { buildLayerArrays, rewriteQuads, rises, type BatchContents, type LayerArrays } from './layer-geometry.js';
import type { QuadImages } from './layer-geometry.js';
import { createLayerMaterial, setLayerViewport, type LayerShape } from './layer-material.js';
import { setSurfaceMorph } from './surface-material.js';

interface Batch extends BatchContents {
  readonly descriptor: BatchDescriptor;
  /** Features changed since the last frame, rewritten in place when the layout allows. */
  readonly changes: FeatureChanges;
  /** Update ranges handed to three.js, one pool per quad attribute, reused every frame (F378). */
  readonly rangePools: UpdateRange[][];
  capacity: number;
  order: number;
  /** A polygon batch with heights, drawn as solid volumes; set when its mesh is built (KB-285). */
  solid?: boolean;
  visible: boolean;
  dirty: boolean;
  mesh: Mesh | undefined;
  arrays: LayerArrays | undefined;
}

/** Whether a batch's features stand on the terrain ('clamp-to-ground', 'drape') rather than at absolute altitudes. */
function onGround(batch: Batch): boolean {
  return typeof batch.descriptor.placement === 'string';
}

/** The vertex attributes of a quad batch and their components (`rebuild`). */
const QUAD_ATTRIBUTES = [
  ['position', 3],
  ['tileNormal', 3],
  ['tilePlane', 4],
  ['layerHeight', 1],
  ['layerColor', 4],
  ['layerCorner', 4],
  ['layerUv', 4],
] as const;

function shapeOf(batch: Batch): LayerShape {
  const kind = batch.kind;
  if (kind === 'polygon' && batch.solid === true) return 'solid';
  return kind === 'polyline' ? 'line' : kind === 'polygon' || kind === 'circle' ? 'flat' : 'quad';
}

/**
 * The renderer's side of data layers (ADR 0037): batches kept on the CPU as the layers package writes them, rebuilt
 * into meshes on the next frame after a change, and placed eye-relative between the globe and the flat map each
 * frame like surface tiles. Hidden and empty batches draw nothing.
 */
export class LayerBatches implements LayerRenderTarget {
  private readonly batches = new Map<number, Batch>();
  /** The batches and materials again, as arrays: each frame walks them by index, which allocates nothing (F064). */
  private readonly batchList: Batch[] = [];
  private readonly materials = new Map<LayerShape | 'label', MeshBasicNodeMaterial>();
  private readonly materialList: MeshBasicNodeMaterial[] = [];
  /** glTF models (F361), placed with the batches. */
  readonly models: LayerModels;
  private nextId = 1;
  private rebuilds = 0;
  private rangeUploads = 0;
  private uploadedVertices = 0;
  /** Marker images (ADR 0037). */
  private readonly atlas = new LayerAtlas();
  private atlasGeneration = 0;
  /** Label distance fields (F358), created with the first label. */
  private labels: LabelSdf | undefined;
  private readonly waits = new FieldWaits<Batch>();
  /** Asks the engine for another frame: label fields arrived, or work spread over frames goes on (KB-315). */
  contentReady: (() => void) | undefined;
  /** Images and label fields as the geometry builders read them. */
  private readonly images: QuadImages = {
    text: (text, sizePx, font, feature) => this.labelSdf().quad(text, sizePx, font) ?? this.waits.note(feature),
    image: (name) => this.atlas.image(name),
  };
  /** The terrain clamped and draped features stand on, and the version their heights were taken at. */
  private ground: LayerGround | undefined;
  private groundVersion = -1;
  /** The last frame's view, for picking. */
  private lastView: FrameView | undefined;

  constructor(
    private readonly scene: Scene,
    private depthPath: DepthPath,
  ) {
    this.models = new LayerModels(scene);
  }

  /** See {@link LayerRenderTarget}. */
  createBatch(descriptor: BatchDescriptor): BatchHandle {
    const id = this.nextId++;
    const batch: Batch = {
      descriptor,
      kind: descriptor.kind,
      capacity: descriptor.capacity,
      count: 0,
      order: 0,
      visible: true,
      dirty: true,
      changes: new FeatureChanges(),
      rangePools: QUAD_ATTRIBUTES.map(() => []),
      attributes: new Map(),
      uniforms: new Map(),
      strings: new Map(),
      geometry: new Map(),
      mesh: undefined,
      arrays: undefined,
    };
    this.batches.set(id, batch);
    this.batchList.push(batch);
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
    this.changed(batch, first, first + count);
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
    this.changed(batch, first, first + count);
  }

  /** See {@link LayerRenderTarget}. */
  writeGeometry(handle: BatchHandle, feature: number, geometry: FeatureGeometry): void {
    const batch = this.get(handle);
    batch.geometry.set(feature, geometry);
    rebuildLater(batch);
  }

  /** See {@link LayerRenderTarget}. */
  setUniform(handle: BatchHandle, attribute: BatchAttribute, value: Float64Array | undefined): void {
    const batch = this.get(handle);
    const current = batch.uniforms.get(attribute);
    // The layers send layer-wide values again as the zoom changes: an unchanged one rebuilds nothing (F378).
    if (value ? current !== undefined && sameValues(current, value) : current === undefined) return;
    if (value) batch.uniforms.set(attribute, Float64Array.from(value));
    else batch.uniforms.delete(attribute);
    rebuildLater(batch);
  }

  /** See {@link LayerRenderTarget}. */
  setCount(handle: BatchHandle, count: number): void {
    const batch = this.get(handle);
    if (count === batch.count) return;
    const previous = batch.count;
    batch.count = count;
    // Features appended within the room a quad batch reserved are written in place (F372); fewer features rebuild it.
    if (count > previous) this.changed(batch, previous, count);
    else rebuildLater(batch);
  }

  /** See {@link LayerRenderTarget}. */
  stats(): { rebuilds: number; rangeUploads: number; uploadedVertices: number; labelFields: object } {
    // `labelFields`: label distance fields generated in the worker and on the calling thread (F358).
    const { rebuilds, rangeUploads, uploadedVertices } = this;
    return { rebuilds, rangeUploads, uploadedVertices, labelFields: { ...this.labels?.generated } };
  }

  /**
   * Records a change to features [first, end): a quad batch whose buffers hold them rewrites only those (F376, F377);
   * anything else is rebuilt on the next frame.
   */
  private changed(batch: Batch, first: number, end: number): void {
    touchBatch(batch);
    const inPlace = !batch.dirty && shapeOf(batch) === 'quad' && batch.arrays && end * 4 <= batch.arrays.vertices;
    if (inPlace) batch.changes.mark(first, end);
    else batch.dirty = true;
  }

  /** See {@link LayerRenderTarget}. */
  setOrder(handle: BatchHandle, order: number): void {
    const batch = this.get(handle);
    batch.order = order;
    if (batch.mesh) batch.mesh.renderOrder = LAYER_RENDER_ORDER + order;
    orderLayerMeshes(this.scene.children, this.batchList);
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
    this.batchList.splice(this.batchList.indexOf(batch), 1);
  }

  /** Sets the terrain clamped and draped features take their heights from (ADR 0037). */
  setGround(ground: LayerGround): void {
    this.ground = ground;
    this.groundVersion = -1;
  }

  /** Registers or replaces a marker image by name (the `icon` channel names it); markers using it redraw. */
  addImage(name: string, image: unknown): void {
    this.atlas.addImage(name, image as AtlasImage);
    for (const batch of this.batches.values()) if (batch.kind === 'marker') batch.dirty = true;
  }

  /** See {@link LayerRenderTarget}: measured as the label fields are drawn. */
  measureText(text: string, sizePx: number): { widthPx: number; heightPx: number } {
    return this.labelSdf().measure(text, sizePx, '');
  }

  /** See {@link LayerRenderTarget}: label fields generated in the worker are ready. */
  onContentReady(listener: () => void): void {
    this.contentReady = listener;
  }

  /** See {@link LayerRenderTarget}: picked on the CPU against the last drawn frame, features before models. */
  pick(point: { readonly xPx: number; readonly yPx: number }): Promise<number> {
    const view = this.lastView;
    if (!view) return Promise.resolve(0);
    // Features draw over models: a model is picked only where no feature is.
    const id = pickAt(this.batches.values(), view, point.xPx, point.yPx, (batch) => this.groundOf(batch));
    return Promise.resolve(id !== 0 ? id : this.models.pickAt(view, point.xPx, point.yPx));
  }

  /** Meshes held (batches and models), for the resource counters. */
  get meshCount(): number {
    let count = this.models.held().meshes;
    for (const batch of this.batches.values()) if (batch.mesh) count++;
    return count;
  }

  /** Geometry bytes held by the batches and models, for the resource counters (F385: they return after a removal). */
  get gpuBytes(): number {
    let bytes = this.models.held().bytes;
    for (const batch of this.batches.values()) if (batch.mesh) bytes += geometryBytes(batch.mesh.geometry);
    return bytes;
  }

  /** Brings every batch up to date and places it for this frame (call before drawing the scene). */
  place(view: FrameView): void {
    this.lastView = view;
    this.models.place(view);
    const version = this.ground?.version() ?? 0;
    if (version !== this.groundVersion) {
      // Finer terrain arrived: features on the ground are placed on it again.
      this.groundVersion = version;
      for (const batch of this.batchList)
        if (batch.descriptor.placement !== undefined && onGround(batch)) batch.dirty = true;
    }
    if (this.atlas.generation !== this.atlasGeneration) {
      // The atlas started over: every label and marker is drawn into it again.
      this.atlasGeneration = this.atlas.generation;
      for (const batch of this.batchList) if (batch.kind === 'marker') batch.dirty = true;
    }
    // Label fields arrived: the labels waiting for them are rewritten; the atlas started over: labels are rebuilt.
    if (this.labels) this.waits.settle(this.labels, this.rewriteWaiting, this.rebuildLabels);
    const batches = this.batchList;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (!batch) continue;
      if (batch.dirty) this.rebuild(batch);
      else if (!batch.changes.empty) this.rewrite(batch);
      const mesh = batch.mesh;
      if (!mesh || !batch.arrays) continue;
      mesh.visible = batch.visible;
      if (batch.visible) placeTile(mesh, batch.arrays.origin, view);
    }
    // Labels still waiting for their fields, those the rebuilds above asked for included, are content to come: the
    // engine does not go idle before it is drawn (KB-203).
    if (this.labels?.generating) this.contentReady?.();
    // After the rebuilds, which may have created materials.
    for (let i = 0; i < this.materialList.length; i++) {
      const material = this.materialList[i];
      if (!material) continue;
      setSurfaceMorph(material, view.morph);
      setLayerViewport(material, view);
    }
  }

  /**
   * After a device loss: new materials for the new renderer, every mesh rebuilt from the CPU copies, and the atlases in
   * new textures, the old ones carrying the lost renderer's listeners (KB-222).
   */
  restore(depthPath: DepthPath): void {
    this.depthPath = depthPath;
    for (const batch of this.batches.values()) {
      this.disposeMesh(batch);
      batch.dirty = true;
    }
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.materialList.length = 0;
    for (const atlas of [this.atlas, this.labels?.atlas]) atlas?.renew();
  }

  /** Releases every batch and material. */
  dispose(): void {
    this.models.dispose();
    this.atlas.dispose();
    this.labels?.dispose();
    for (const batch of this.batches.values()) this.disposeMesh(batch);
    this.batches.clear();
    this.batchList.length = 0;
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.materialList.length = 0;
  }

  /** The terrain a batch stands on: none off the ground, and none before the first heights (finer pieces for nothing). */
  private groundOf(batch: Batch): LayerGround | undefined {
    return onGround(batch) && this.groundVersion > 0 ? this.ground : undefined;
  }

  private get(handle: BatchHandle): Batch {
    const batch = this.batches.get(handle.id);
    if (!batch) throw new Error(`Unknown layer batch ${String(handle.id)}`);
    return batch;
  }

  private labelSdf(): LabelSdf {
    if (!this.labels) {
      this.labels = new LabelSdf();
      this.labels.onReady(() => this.contentReady?.());
    }
    return this.labels;
  }

  /** The material of a batch: labels have their own, over the label fields. */
  private material(batch: Batch): MeshBasicNodeMaterial {
    const key = batch.kind === 'label' ? 'label' : shapeOf(batch);
    let material = this.materials.get(key);
    if (!material) {
      material =
        key === 'label'
          ? createLayerMaterial('quad', this.depthPath, undefined, this.labelSdf().atlas.texture)
          : createLayerMaterial(key, this.depthPath, this.atlas.texture);
      this.materials.set(key, material);
      this.materialList.push(material);
    }
    return material;
  }

  /**
   * Rewrites the changed features of a quad batch and uploads only their vertices, one upload per run of consecutive
   * features (F376–F378); rebuilds the batch when its arrays do not hold them.
   */
  private rewrite(batch: Batch): void {
    this.rewriting = this.waits.current = batch;
    const ok = batch.changes.drain(this.rewriteRun);
    this.rewriting = this.waits.current = undefined;
    if (!ok) this.rebuild(batch);
  }

  /** For {@link FieldWaits.settle}, created once: a closure made each frame would allocate (F064). */
  private readonly rewriteWaiting = (batch: Batch, feature: number): void => this.changed(batch, feature, feature + 1);
  private readonly rebuildLabels = (): void => {
    for (const batch of this.batchList) if (batch.kind === 'label') batch.dirty = true;
  };

  /** The batch {@link LayerBatches.rewrite} drains, for {@link LayerBatches.rewriteRun}. */
  private rewriting: Batch | undefined;

  /** Rewrites and uploads one run [first, end) of the batch being rewritten; false when the batch must be rebuilt. */
  private readonly rewriteRun = (first: number, end: number): boolean => {
    const batch = this.rewriting;
    const arrays = batch?.arrays;
    const mesh = batch?.mesh;
    if (!batch || !arrays || !mesh || !rewriteQuads(batch, arrays, first, end, this.images, this.groundOf(batch)))
      return false;
    for (let i = 0; i < QUAD_ATTRIBUTES.length; i++) {
      const [name, size] = QUAD_ATTRIBUTES[i] ?? ['', 0];
      const attribute = mesh.geometry.getAttribute(name) as BufferAttribute;
      // As `addUpdateRange`, with range objects of a pool, into a list three.js empties without dropping its storage.
      const ranges = stableRanges(attribute);
      const pool = batch.rangePools[i] ?? [];
      const range = pool[ranges.length] ?? { start: 0, count: 0 };
      if (pool[ranges.length] === undefined) pool.push(range);
      range.start = first * 4 * size;
      range.count = (end - first) * 4 * size;
      ranges[ranges.length++] = range;
      attribute.needsUpdate = true;
    }
    this.rangeUploads++;
    this.uploadedVertices += (end - first) * 4;
    return true;
  };

  private rebuild(batch: Batch): void {
    batch.dirty = false;
    batch.changes.clear();
    this.rebuilds++;
    this.disposeMesh(batch);
    batch.solid = batch.kind === 'polygon' && rises(batch);
    this.waits.current = batch;
    const arrays = buildLayerArrays(batch, this.images, this.groundOf(batch));
    this.waits.current = undefined;
    batch.arrays = arrays;
    if (!arrays) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('tileNormal', new BufferAttribute(arrays.normals, 3));
    geometry.setAttribute('tilePlane', new BufferAttribute(arrays.planes, 4));
    geometry.setAttribute('layerHeight', new BufferAttribute(arrays.heights, 1));
    geometry.setAttribute('layerColor', new BufferAttribute(arrays.colors, 4));
    geometry.setAttribute('layerCorner', new BufferAttribute(arrays.corners, 4));
    if (shapeOf(batch) === 'quad') geometry.setAttribute('layerUv', new BufferAttribute(arrays.uvs, 4));
    if (arrays.other) setOtherEndpoint(geometry, arrays.other, arrays.vertices);
    geometry.setIndex(new BufferAttribute(arrays.indices, 1));
    const mesh = new Mesh(geometry, this.material(batch));
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = LAYER_RENDER_ORDER + batch.order;
    batch.mesh = mesh;
    this.scene.add(mesh);
    orderLayerMeshes(this.scene.children, this.batchList);
  }

  private disposeMesh(batch: Batch): void {
    if (!batch.mesh) return;
    releaseMesh(this.scene, batch.mesh);
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

/** A range of a buffer attribute's components to upload, as three.js keeps them. */
interface UpdateRange {
  start: number;
  count: number;
}
