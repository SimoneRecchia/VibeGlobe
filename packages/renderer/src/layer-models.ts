// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { FrameView, ModelPose, ModelRenderer, ModelSetOptions } from '@vibeglobe/core';
import { ModelSet, placePose, sphereRatio } from './model-sets.js';
import { max, mix, normalView, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import {
  Box3,
  type BufferGeometry,
  MeshBasicNodeMaterial,
  Vector3,
  Vector4,
  type Material,
  type Mesh,
  type Node,
  type MeshStandardMaterial,
  type Object3D,
  type Scene,
} from 'three/webgpu';

/** What a glTF loader does for models: three.js's `GLTFLoader` (`@vibeglobe/renderer/gltf`). */
export interface GltfLoader {
  parseAsync(data: ArrayBuffer, path: string): Promise<{ scene: Object3D }>;
  loadAsync(url: string): Promise<{ scene: Object3D }>;
}

/** Creates a glTF loader, on the first model added. */
export type GltfLoaderFactory = () => Promise<GltfLoader>;

interface Model {
  readonly root: Object3D;
  pose: ModelPose | undefined;
  /** Blend toward a color (rgb, amount), shared by the model's materials. */
  readonly highlight: { value: Vector4 };
  pickId: number;
  visible: boolean;
  /** Bounding sphere in model units: the center's height above the anchor, and the radius. */
  readonly centerUp: number;
  readonly radius: number;
}

/**
 * glTF 2.0 models (F361, ADR 0037): loaded with three.js's glTF loader, their materials drawn unlit with a fixed shade
 * (see {@link unlit}), and placed every frame relative to the eye like the surface (ADR 0004).
 */
export class LayerModels implements ModelRenderer {
  private readonly models = new Map<number, Model>();
  /** The models again, walked by index each frame, which allocates nothing (F064). */
  private readonly modelList: Model[] = [];
  /** Sets of copies of one model, instanced (F627), by id; ids are shared with the models. */
  private readonly sets = new Map<number, ModelSet>();
  private readonly setList: ModelSet[] = [];
  /** The glTF loader, created on the first model; none unless the application gave `createRenderer` one. */
  private loader: GltfLoader | undefined;
  /** Set from `createRenderer({ gltf })`. */
  loaderFactory: GltfLoaderFactory | undefined;
  private nextId = 1;
  private disposed = false;

  constructor(private readonly scene: Scene) {}

  /** See {@link ModelRenderer}. */
  async load(source: { readonly url?: string; readonly data?: ArrayBuffer }): Promise<number> {
    const root = await this.loadScene(source);
    root.matrixAutoUpdate = false;
    root.frustumCulled = false;
    root.traverse((object) => (object.frustumCulled = false));
    root.visible = false;
    const id = this.nextId++;
    const bounds = new Box3().setFromObject(root);
    const center = bounds.getCenter(new Vector3());
    const highlight = uniform(new Vector4(0, 0, 0, 0));
    const model: Model = {
      root,
      pose: undefined,
      highlight,
      pickId: 0,
      visible: true,
      centerUp: center.y,
      radius: bounds.getSize(new Vector3()).length() / 2,
    };
    this.models.set(id, model);
    this.modelList.push(model);
    root.traverse((object) => {
      const mesh = object as Partial<Mesh>;
      if (mesh.isMesh && mesh.material)
        mesh.material = unlit(mesh.material as Material, highlight as unknown as Node<'vec4'>);
    });
    this.scene.add(root);
    return id;
  }

  /** Loads a glTF file's scene with the application's loader. */
  private async loadScene(source: { readonly url?: string; readonly data?: ArrayBuffer }): Promise<Object3D> {
    if (!this.loaderFactory)
      throw new Error(
        "Models need the glTF loader: createRenderer({ gltf: gltfLoader }) from '@vibeglobe/renderer/gltf'",
      );
    const loader = (this.loader ??= await this.loaderFactory());
    const gltf = source.data ? await loader.parseAsync(source.data, '') : await loader.loadAsync(source.url ?? '');
    // A model arriving after the renderer was destroyed is freed, never added to its scene.
    if (this.disposed) {
      disposeTree(gltf.scene);
      throw new Error('The renderer was destroyed while the model loaded');
    }
    return gltf.scene;
  }

  /** See {@link ModelRenderer}: one model for many copies, each of its meshes one instanced draw (F627). */
  async loadSet(
    source: { readonly url?: string; readonly data?: ArrayBuffer },
    options: ModelSetOptions,
  ): Promise<number> {
    const set = new ModelSet(await this.loadScene(source), options, unlit);
    const id = this.nextId++;
    this.sets.set(id, set);
    this.setList.push(set);
    this.scene.add(set.group);
    return id;
  }

  /** See {@link ModelRenderer}. */
  setInstances(id: number, poses: readonly ModelPose[], pickIds: readonly number[]): void {
    this.sets.get(id)?.setInstances(poses, pickIds);
  }

  /** See {@link ModelRenderer}. */
  setInstanceHighlight(id: number, index: number, rgba: readonly [number, number, number, number] | undefined): void {
    this.sets.get(id)?.setHighlight(index, rgba);
  }

  /** See {@link ModelRenderer}. */
  setInstanceAngles(id: number, joint: number, anglesRad: Float32Array): void {
    const set = this.sets.get(id);
    if (set) set.angles[joint] = anglesRad;
  }

  /** See {@link ModelRenderer}. */
  drawnInstances(id: number): number {
    return this.sets.get(id)?.modelCount ?? 0;
  }

  /** See {@link ModelRenderer}. */
  setPose(id: number, pose: ModelPose): void {
    const model = this.models.get(id);
    if (model) model.pose = pose;
  }

  /** See {@link ModelRenderer}. */
  setPickId(id: number, pickId: number): void {
    const model = this.models.get(id);
    if (model) model.pickId = pickId;
  }

  /** See {@link ModelRenderer}. */
  setHighlight(id: number, rgba: readonly [number, number, number, number] | undefined): void {
    this.models.get(id)?.highlight.value.set(rgba?.[0] ?? 0, rgba?.[1] ?? 0, rgba?.[2] ?? 0, rgba?.[3] ?? 0);
  }

  /** See {@link ModelRenderer}. */
  setVisible(id: number, visible: boolean): void {
    const model = this.models.get(id);
    if (model) model.visible = visible;
    const set = this.sets.get(id);
    if (set) set.visible = visible;
  }

  /**
   * The pick id of the model drawn at a screen point, 0 for none: among those whose bounding sphere, projected where
   * the frame draws it, covers the point, the one whose center is nearest relative to its size.
   */
  pickAt(view: FrameView, xPx: number, yPx: number): number {
    let best = 0;
    let bestRatio = Infinity;
    for (const model of this.modelList) {
      const pose = model.pose;
      if (!pose || !model.visible || model.pickId === 0) continue;
      const ratio = sphereRatio(view, pose, xPx, yPx, model.centerUp, model.radius);
      if (ratio <= 1 && ratio < bestRatio) {
        best = model.pickId;
        bestRatio = ratio;
      }
    }
    // Then the copies of the sets: the nearest pick of each set, the first set's that hits.
    for (const set of this.setList) {
      if (best !== 0 || !set.visible) continue;
      const index = set.indexAt(view, xPx, yPx);
      best = index < 0 ? 0 : (set.pickIds[index] ?? 0);
    }
    return best;
  }

  /** See {@link ModelRenderer}. */
  remove(id: number): void {
    const set = this.sets.get(id);
    if (set) {
      this.scene.remove(set.group);
      set.dispose();
      this.sets.delete(id);
      this.setList.splice(this.setList.indexOf(set), 1);
    }
    const model = this.models.get(id);
    if (!model) return;
    this.scene.remove(model.root);
    disposeTree(model.root);
    this.models.delete(id);
    this.modelList.splice(this.modelList.indexOf(model), 1);
  }

  /** Places every model for this frame. */
  place(view: FrameView): void {
    for (let i = 0; i < this.modelList.length; i++) {
      const model = this.modelList[i];
      if (!model) continue;
      model.root.visible = model.visible && model.pose !== undefined;
      if (model.pose) {
        placePose(model.root.matrix, view, model.pose);
        model.root.updateMatrixWorld(true);
      }
    }
    for (let i = 0; i < this.setList.length; i++) this.setList[i]?.place(view);
  }

  /** Meshes and geometry bytes held by the models, for the resource counters (F385). */
  held(): { meshes: number; bytes: number } {
    const held = { meshes: 0, bytes: 0 };
    for (const model of this.modelList)
      model.root.traverse((object) => {
        const geometry = (object as Partial<Mesh>).geometry;
        if (!geometry) return;
        held.meshes += 1;
        held.bytes += geometryBytes(geometry);
      });
    for (const set of this.setList) {
      const parts = set.held();
      held.meshes += parts.meshes;
      for (const geometry of parts.geometries) held.bytes += geometryBytes(geometry);
    }
    return held;
  }

  /** Removes every model. */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.models.keys(), ...this.sets.keys()]) this.remove(id);
  }
}

/** The light direction in view space: from above and a little behind the eye. */
const LIGHT = vec3(0.3, 0.8, 0.5).normalize();

/**
 * An unlit copy of a glTF material (the renderer draws without three.js's lighting, F064): its base color, texture and
 * opacity, shaded by a fixed light from above the eye so volumes read (ADR 0037), and blended toward the model's
 * highlight color (selection, F381). Lit, image-based PBR is M11's.
 */
function unlit(material: Material, highlight: Node<'vec4'>): MeshBasicNodeMaterial {
  const standard = material as Partial<MeshStandardMaterial>;
  const unlitMaterial = new MeshBasicNodeMaterial();
  const tint = standard.color ?? { r: 1, g: 1, b: 1 };
  const factor = vec4(tint.r, tint.g, tint.b, standard.opacity ?? 1);
  const base: Node<'vec4'> = standard.map ? factor.mul(texture(standard.map, uv())) : factor;
  const shade = max(normalView.dot(LIGHT), 0).mul(0.6).add(0.4);
  const blend = highlight;
  unlitMaterial.colorNode = vec4(mix(base.xyz.mul(shade), blend.xyz, blend.w), base.w);
  unlitMaterial.transparent = material.transparent;
  unlitMaterial.side = material.side;
  // The texture now lives in a node, where no walk over the material finds it: it goes with the material.
  const map = standard.map;
  if (map) unlitMaterial.addEventListener('dispose', () => map.dispose());
  material.dispose();
  return unlitMaterial;
}

/** The bytes of a geometry's vertex and index arrays, each shared buffer counted once. */
export function geometryBytes(geometry: BufferGeometry): number {
  const arrays = new Set<ArrayBufferView>();
  for (const attribute of Object.values(geometry.attributes))
    arrays.add('data' in attribute && attribute.data ? attribute.data.array : attribute.array);
  if (geometry.index) arrays.add(geometry.index.array);
  let bytes = 0;
  for (const array of arrays) bytes += array.byteLength;
  return bytes;
}

/** Frees the geometry, materials and textures of a model's scene graph. */
function disposeTree(root: Object3D): void {
  root.traverse((object) => {
    const mesh = object as Partial<{ geometry: { dispose(): void }; material: unknown }>;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials as { dispose(): void; [key: string]: unknown }[]) {
      for (const value of Object.values(material))
        if (value && typeof value === 'object' && 'isTexture' in value)
          (value as unknown as { dispose(): void }).dispose();
      material.dispose();
    }
  });
}
