import { enuFrame, morphPointInto, type FrameView, type ModelPose, type ModelRenderer } from '@vibeglobe/core';
import { max, normalView, texture, uv, vec3, vec4 } from 'three/tsl';
import {
  Euler,
  Matrix4,
  MeshBasicNodeMaterial,
  Vector3,
  type Material,
  type Mesh,
  type Node,
  type MeshStandardMaterial,
  type Object3D,
  type Scene,
} from 'three/webgpu';

const RAD = Math.PI / 180;

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
}

const geodetic = new Float64Array(3);
const position = new Float64Array(3);
const enu = new Float64Array(9);
const axesToModel = new Matrix4();
const attitude = new Matrix4();
const euler = new Euler(0, 0, 0, 'YXZ');
const scaled = new Vector3();

/**
 * Writes a model's transform for a frame: its anchor where the frame draws that position (ADR 0008: the morph, with the
 * relief scale), relative to the eye in float64 before the float32 matrix, oriented on the local east, north and up
 * axes (on the flat map, the anchor's) with heading, pitch, roll and scale. glTF's +Y is up and −Z is forward.
 */
function place(model: Model, pose: ModelPose, view: FrameView): void {
  geodetic[0] = pose.position.longitudeDeg * RAD;
  geodetic[1] = pose.position.latitudeDeg * RAD;
  geodetic[2] = pose.position.heightMeters ?? 0;
  morphPointInto(view.morph, geodetic, position);
  const axes = (view.morph.factors[0] ?? 0) >= 0.5 ? view.morph.axes : enuFrame(geodetic[0], geodetic[1], enu);
  const a = (i: number): number => axes[i] ?? 0;
  // Model +X east, +Y up, +Z south (so −Z, glTF's forward, points north at heading 0).
  axesToModel.set(a(0), a(6), -a(3), 0, a(1), a(7), -a(4), 0, a(2), a(8), -a(5), 0, 0, 0, 0, 1);
  // Heading turns clockwise seen from above (about −Y), pitch raises the nose (about +X), roll lowers the right side.
  euler.set((pose.pitchDeg ?? 0) * RAD, -(pose.headingDeg ?? 0) * RAD, -(pose.rollDeg ?? 0) * RAD);
  attitude.makeRotationFromEuler(euler);
  const scale = pose.scale ?? 1;
  const m = model.root.matrix;
  m.multiplyMatrices(axesToModel, attitude).scale(scaled.set(scale, scale, scale));
  const eye = view.eyeEcef;
  m.elements[12] = (position[0] ?? 0) - (eye[0] ?? 0);
  m.elements[13] = (position[1] ?? 0) - (eye[1] ?? 0);
  m.elements[14] = (position[2] ?? 0) - (eye[2] ?? 0);
  model.root.updateMatrixWorld(true);
}

/**
 * glTF 2.0 models (F361, ADR 0037): loaded with three.js's glTF loader, their materials drawn unlit with a fixed shade
 * (see {@link unlit}), and placed every frame relative to the eye like the surface (ADR 0004).
 */
export class LayerModels implements ModelRenderer {
  private readonly models = new Map<number, Model>();
  /** The models again, walked by index each frame, which allocates nothing (F064). */
  private readonly modelList: Model[] = [];
  /** The glTF loader, created on the first model; none unless the application gave `createRenderer` one. */
  private loader: GltfLoader | undefined;
  /** Set from `createRenderer({ gltf })`. */
  loaderFactory: GltfLoaderFactory | undefined;
  private nextId = 1;

  constructor(private readonly scene: Scene) {}

  /** See {@link ModelRenderer}. */
  async load(source: { readonly url?: string; readonly data?: ArrayBuffer }): Promise<number> {
    if (!this.loaderFactory)
      throw new Error(
        "Models need the glTF loader: createRenderer({ gltf: gltfLoader }) from '@vibeglobe/renderer/gltf'",
      );
    const loader = (this.loader ??= await this.loaderFactory());
    const gltf = source.data ? await loader.parseAsync(source.data, '') : await loader.loadAsync(source.url ?? '');
    const root = gltf.scene;
    root.matrixAutoUpdate = false;
    root.frustumCulled = false;
    root.traverse((object) => (object.frustumCulled = false));
    root.visible = false;
    const id = this.nextId++;
    const model: Model = { root, pose: undefined };
    this.models.set(id, model);
    this.modelList.push(model);
    root.traverse((object) => {
      const mesh = object as Partial<Mesh>;
      if (mesh.isMesh && mesh.material) mesh.material = unlit(mesh.material as Material);
    });
    this.scene.add(root);
    return id;
  }

  /** See {@link ModelRenderer}. */
  setPose(id: number, pose: ModelPose): void {
    const model = this.models.get(id);
    if (model) model.pose = pose;
  }

  /** See {@link ModelRenderer}. */
  remove(id: number): void {
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
      model.root.visible = model.pose !== undefined;
      if (model.pose) place(model, model.pose, view);
    }
  }

  /** Removes every model. */
  dispose(): void {
    for (const id of [...this.models.keys()]) this.remove(id);
  }
}

/** The light direction in view space: from above and a little behind the eye. */
const LIGHT = vec3(0.3, 0.8, 0.5).normalize();

/**
 * An unlit copy of a glTF material (the renderer draws without three.js's lighting, F064): its base color, texture and
 * opacity, shaded by a fixed light from above the eye so volumes read (ADR 0037). Lit, image-based PBR is M11's.
 */
function unlit(material: Material): MeshBasicNodeMaterial {
  const standard = material as Partial<MeshStandardMaterial>;
  const unlitMaterial = new MeshBasicNodeMaterial();
  const tint = standard.color ?? { r: 1, g: 1, b: 1 };
  const factor = vec4(tint.r, tint.g, tint.b, standard.opacity ?? 1);
  const base: Node<'vec4'> = standard.map ? factor.mul(texture(standard.map, uv())) : factor;
  const shade = max(normalView.dot(LIGHT), 0).mul(0.6).add(0.4);
  unlitMaterial.colorNode = vec4(base.xyz.mul(shade), base.w);
  unlitMaterial.transparent = material.transparent;
  unlitMaterial.side = material.side;
  material.dispose();
  return unlitMaterial;
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
