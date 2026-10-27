// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { enuFrame, morphPointInto, type FrameView, type ModelPose, type ModelSetOptions } from '@vibeglobe/core';
import { projectLayerPoint } from '@vibeglobe/core/layers';
import { instancedBufferAttribute } from 'three/tsl';
import {
  Box3,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  OctahedronGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Mesh,
  type Node,
  type Object3D,
} from 'three/webgpu';

const RAD = Math.PI / 180;

/** Makes an unlit material from a glTF one, blended toward a per-instance highlight (see `layer-models.ts`). */
export type UnlitMaker = (material: Material, highlight: Node<'vec4'>) => Material;

/** One mesh of the set's model, drawn instanced: its transform within the model. */
interface Part {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly local: Matrix4;
  mesh: InstancedMesh | undefined;
  /** The unlit material the instanced mesh draws with. */
  drawn: Material | undefined;
}

/**
 * Many copies of one glTF model (F627): each mesh of the model is one instanced draw for all copies near the eye, and
 * the copies beyond `visibleBelowMeters` are one instanced draw of a small placeholder of constant size on screen.
 * Copies outside the view, or behind the globe, are not drawn at all. Placed every frame relative to the eye.
 */
export class ModelSet {
  readonly group = new Group();
  poses: readonly ModelPose[] = [];
  pickIds: readonly number[] = [];
  visible = true;
  /** Highlights by copy, `[r, g, b, amount]` each (selection and hover, F381). */
  highlights = new Float32Array(0);
  /** The copies drawn as the model and as the placeholder in the last frame, by index. */
  modelDrawn = new Int32Array(0);
  placeholderDrawn = new Int32Array(0);
  modelCount = 0;
  placeholderCount = 0;
  private readonly parts: Part[] = [];
  private readonly placeholder: { readonly geometry: BufferGeometry; readonly material: Material };
  private placeholderMesh: InstancedMesh | undefined;
  private placeholderMaterial: Material | undefined;
  private capacity = 0;
  private modelHighlight = new InstancedBufferAttribute(new Float32Array(0), 4);
  private placeholderHighlight = new InstancedBufferAttribute(new Float32Array(0), 4);
  /** Bounding sphere in model units: the center's height above the anchor, and the radius. */
  readonly centerUp: number;
  readonly radius: number;

  constructor(
    root: Object3D,
    readonly options: ModelSetOptions,
    private readonly unlit: UnlitMaker,
  ) {
    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(root);
    this.centerUp = bounds.getCenter(new Vector3()).y;
    this.radius = bounds.getSize(new Vector3()).length() / 2;
    root.traverse((object) => {
      const mesh = object as Partial<Mesh>;
      if (!mesh.isMesh || !mesh.geometry || !mesh.material) return;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (material)
        this.parts.push({
          geometry: mesh.geometry,
          material,
          local: object.matrixWorld.clone(),
          mesh: undefined,
          drawn: undefined,
        });
    });
    const [r, g, b] = options.placeholderColor;
    const material = new MeshBasicNodeMaterial();
    material.color.setRGB(r, g, b);
    this.placeholder = { geometry: new OctahedronGeometry(1, 0), material };
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;
  }

  /** Sets the copies: their poses and pick ids; meshes grow to hold them. */
  setInstances(poses: readonly ModelPose[], pickIds: readonly number[]): void {
    this.poses = poses;
    this.pickIds = pickIds;
    if (poses.length > this.capacity) this.grow(poses.length);
    if (this.highlights.length < poses.length * 4) {
      const next = new Float32Array(poses.length * 4);
      next.set(this.highlights.subarray(0, Math.min(this.highlights.length, next.length)));
      this.highlights = next;
    }
  }

  /** Blends one copy toward a color, `[r, g, b, amount]`; `undefined` clears it. */
  setHighlight(index: number, rgba: readonly [number, number, number, number] | undefined): void {
    if (index < 0 || index * 4 >= this.highlights.length) return;
    this.highlights.set(rgba ?? [0, 0, 0, 0], index * 4);
  }

  /** Places the copies in view for this frame: the model near the eye, the placeholder beyond. */
  place(view: FrameView): void {
    this.modelCount = 0;
    this.placeholderCount = 0;
    if (this.visible)
      for (let i = 0; i < this.poses.length; i++) {
        const pose = this.poses[i];
        if (pose) this.placeOne(pose, i, view);
      }
    for (const part of this.parts) if (part.mesh) commit(part.mesh, this.modelCount);
    if (this.placeholderMesh) commit(this.placeholderMesh, this.placeholderCount);
    this.copyHighlights(this.modelHighlight, this.modelDrawn, this.modelCount);
    this.copyHighlights(this.placeholderHighlight, this.placeholderDrawn, this.placeholderCount);
    this.group.visible = this.modelCount + this.placeholderCount > 0;
  }

  /**
   * The copy drawn at a screen point, as its index, or -1: among those whose bounding sphere (the placeholder's, beyond
   * `visibleBelowMeters`), projected where the frame drew it, covers the point, the one nearest relative to its size.
   */
  indexAt(view: FrameView, xPx: number, yPx: number): number {
    let best = -1;
    let bestRatio = Infinity;
    const consider = (index: number, radiusPx: number | undefined): void => {
      const pose = this.poses[index];
      if (!pose) return;
      const scale = pose.scale ?? 1;
      const { longitudeDeg, latitudeDeg } = pose.position;
      const near = radiusPx === undefined;
      const height = (pose.position.heightMeters ?? 0) + (near ? this.centerUp * scale : 0);
      if (!projectLayerPoint(view, longitudeDeg, latitudeDeg, height, center)) return;
      let r = radiusPx ?? 0;
      if (near) {
        const east = (this.radius * scale) / (111_320 * Math.max(Math.cos(latitudeDeg * RAD), 1e-6));
        if (!projectLayerPoint(view, longitudeDeg + east, latitudeDeg, height, edge)) return;
        r = Math.hypot((edge[0] ?? 0) - (center[0] ?? 0), (edge[1] ?? 0) - (center[1] ?? 0));
      }
      const ratio = Math.hypot(xPx - (center[0] ?? 0), yPx - (center[1] ?? 0)) / Math.max(r, 1);
      if (ratio <= 1 && ratio < bestRatio) {
        best = index;
        bestRatio = ratio;
      }
    };
    for (let i = 0; i < this.modelCount; i++) consider(this.modelDrawn[i] ?? -1, undefined);
    const placeholderPx = this.options.placeholderSizePx;
    for (let i = 0; i < this.placeholderCount; i++) consider(this.placeholderDrawn[i] ?? -1, placeholderPx);
    return best;
  }

  /** Meshes and geometry bytes the set holds (its model's meshes once, however many copies). */
  held(): { meshes: number; bytes: number; geometries: BufferGeometry[] } {
    return { meshes: this.parts.length + 1, bytes: 0, geometries: this.parts.map((part) => part.geometry) };
  }

  /** Frees the meshes, geometries and materials. */
  dispose(): void {
    for (const part of this.parts) {
      part.mesh?.dispose();
      part.drawn?.dispose();
      part.geometry.dispose();
      part.material.dispose();
    }
    this.placeholderMesh?.dispose();
    this.placeholderMaterial?.dispose();
    this.placeholder.geometry.dispose();
    this.placeholder.material.dispose();
    this.group.clear();
  }

  private placeOne(pose: ModelPose, index: number, view: FrameView): void {
    geodetic[0] = pose.position.longitudeDeg * RAD;
    geodetic[1] = pose.position.latitudeDeg * RAD;
    geodetic[2] = pose.position.heightMeters ?? 0;
    morphPointInto(view.morph, geodetic, position);
    const eye = view.eyeEcef;
    rel[0] = (position[0] ?? 0) - (eye[0] ?? 0);
    rel[1] = (position[1] ?? 0) - (eye[1] ?? 0);
    rel[2] = (position[2] ?? 0) - (eye[2] ?? 0);
    const distance = Math.hypot(rel[0], rel[1], rel[2]);
    const scale = pose.scale ?? 1;
    const near = distance < this.options.visibleBelowMeters;
    // Ground meters per pixel at that distance: the placeholder keeps its size on screen.
    const metersPerPx = (2 * distance) / ((view.projection[5] ?? 1) * view.heightPx);
    const placeholderRadius = (this.options.placeholderSizePx / 2) * metersPerPx;
    const radius = near ? (this.radius + Math.abs(this.centerUp)) * scale : placeholderRadius;
    if (!inView(view, radius) || behindGlobe(view)) return;
    const axes = (view.morph.factors[0] ?? 0) >= 0.5 ? view.morph.axes : enuFrame(geodetic[0], geodetic[1], enu);
    if (near) {
      instanceMatrix(axes, pose, scale);
      for (const part of this.parts)
        if (part.mesh) part.mesh.setMatrixAt(this.modelCount, matrix.multiplyMatrices(base, part.local));
      this.modelDrawn[this.modelCount++] = index;
    } else if (this.placeholderMesh) {
      // Above the anchor by its radius, standing on the ground.
      base.makeScale(placeholderRadius, placeholderRadius, placeholderRadius);
      base.elements[12] = rel[0] + (axes[6] ?? 0) * placeholderRadius;
      base.elements[13] = rel[1] + (axes[7] ?? 0) * placeholderRadius;
      base.elements[14] = rel[2] + (axes[8] ?? 0) * placeholderRadius;
      this.placeholderMesh.setMatrixAt(this.placeholderCount, base);
      this.placeholderDrawn[this.placeholderCount++] = index;
    }
  }

  private copyHighlights(attribute: InstancedBufferAttribute, drawn: Int32Array, count: number): void {
    const target = attribute.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const from = (drawn[i] ?? 0) * 4;
      for (let k = 0; k < 4; k++) target[i * 4 + k] = this.highlights[from + k] ?? 0;
    }
    attribute.needsUpdate = true;
  }

  /** Recreates the instanced meshes for `capacity` copies; geometries and materials are kept. */
  private grow(capacity: number): void {
    this.capacity = capacity;
    this.modelDrawn = new Int32Array(capacity);
    this.placeholderDrawn = new Int32Array(capacity);
    this.modelHighlight = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.placeholderHighlight = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.group.clear();
    const blend = instancedBufferAttribute(this.modelHighlight) as unknown as Node<'vec4'>;
    for (const part of this.parts) {
      part.mesh?.dispose();
      part.drawn?.dispose();
      part.drawn = this.unlit(part.material, blend);
      part.mesh = instanced(part.geometry, part.drawn, capacity);
      this.group.add(part.mesh);
    }
    this.placeholderMesh?.dispose();
    this.placeholderMaterial?.dispose();
    const highlight = instancedBufferAttribute(this.placeholderHighlight) as unknown as Node<'vec4'>;
    this.placeholderMaterial = this.unlit(this.placeholder.material, highlight);
    this.placeholderMesh = instanced(this.placeholder.geometry, this.placeholderMaterial, capacity);
    if (this.options.placeholderSizePx > 0) this.group.add(this.placeholderMesh);
  }
}

const geodetic = new Float64Array(3);
const position = new Float64Array(3);
const rel = new Float64Array(3);
const enu = new Float64Array(9);
const center = new Float64Array(2);
const edge = new Float64Array(2);
const base = new Matrix4();
const matrix = new Matrix4();
const axesToModel = new Matrix4();
const attitude = new Matrix4();
const euler = new Euler(0, 0, 0, 'YXZ');
const scaled = new Vector3();

/** An instanced mesh drawn as one call, never culled by three.js (the set culls its copies). */
function instanced(geometry: BufferGeometry, material: Material, capacity: number): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.count = 0;
  return mesh;
}

function commit(mesh: InstancedMesh, count: number): void {
  mesh.count = count;
  mesh.visible = count > 0;
  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Whether a sphere of `radius` meters about {@link rel} (eye-relative) is in the view: in front of the eye and within
 * the frustum's sides, with the view's rotation and the projection's half-angle tangents.
 */
function inView(view: FrameView, radius: number): boolean {
  const v = view.view;
  const x = (v[0] ?? 0) * (rel[0] ?? 0) + (v[4] ?? 0) * (rel[1] ?? 0) + (v[8] ?? 0) * (rel[2] ?? 0);
  const y = (v[1] ?? 0) * (rel[0] ?? 0) + (v[5] ?? 0) * (rel[1] ?? 0) + (v[9] ?? 0) * (rel[2] ?? 0);
  const depth = -((v[2] ?? 0) * (rel[0] ?? 0) + (v[6] ?? 0) * (rel[1] ?? 0) + (v[10] ?? 0) * (rel[2] ?? 0));
  if (depth < -radius) return false;
  const tx = 1 / (view.projection[0] ?? 1);
  const ty = 1 / (view.projection[5] ?? 1);
  return (
    Math.abs(x) <= depth * tx + radius * Math.sqrt(1 + tx * tx) &&
    Math.abs(y) <= depth * ty + radius * Math.sqrt(1 + ty * ty)
  );
}

/** Whether {@link position} lies beyond the globe's horizon from the eye (on the globe only, not the flat map). */
function behindGlobe(view: FrameView): boolean {
  if ((view.morph.factors[0] ?? 0) > 0) return false;
  const eye = view.eyeEcef;
  const p0 = position[0] ?? 0;
  const p1 = position[1] ?? 0;
  const p2 = position[2] ?? 0;
  // Seen from the eye, a point on the surface is past the horizon when the eye lies below its tangent plane.
  return (eye[0] ?? 0) * p0 + (eye[1] ?? 0) * p1 + (eye[2] ?? 0) * p2 < 0.999 * (p0 * p0 + p1 * p1 + p2 * p2);
}

/** Writes a copy's transform into `base`: east, north and up axes, then heading, pitch, roll and scale (as one model). */
function instanceMatrix(axes: Float64Array, pose: ModelPose, scale: number): void {
  const a = (i: number): number => axes[i] ?? 0;
  axesToModel.set(a(0), a(6), -a(3), 0, a(1), a(7), -a(4), 0, a(2), a(8), -a(5), 0, 0, 0, 0, 1);
  euler.set((pose.pitchDeg ?? 0) * RAD, -(pose.headingDeg ?? 0) * RAD, -(pose.rollDeg ?? 0) * RAD);
  attitude.makeRotationFromEuler(euler);
  base.multiplyMatrices(axesToModel, attitude).scale(scaled.set(scale, scale, scale));
  base.elements[12] = rel[0] ?? 0;
  base.elements[13] = rel[1] ?? 0;
  base.elements[14] = rel[2] ?? 0;
}
