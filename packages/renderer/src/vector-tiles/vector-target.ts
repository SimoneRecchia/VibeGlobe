// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The three.js side of vector tiles (ADR 0131): meshes built from laid-out buckets, drawn each frame in style-layer
 * order with one draw per target square (a stand-in ancestor is drawn once per square it covers, clipped to it), and
 * the label quads of the frame. It implements the renderer-neutral `VectorTileTarget` of
 * `@vibeglobe/layers/vector-tiles`, which decides what to draw; it decides nothing itself.
 */
import type { DepthPath, FrameView } from '@vibeglobe/core';
import { BufferAttribute, BufferGeometry, Group, Mesh, type MeshBasicNodeMaterial, type Texture } from 'three/webgpu';
import { placeTile } from '../eye-relative.js';
import type { ThreeExtensionContext } from '../extensions.js';
import { rasterizeSdfGlyphs } from './local-glyphs.js';
import { SdfAtlas } from './sdf-atlas.js';
import { updateVectorGeometry, vectorGeometry } from './vector-geometry.js';
import { createRasterMaterial, rasterTexture } from './raster-material.js';
import { createTextMaterial, setTextViewport } from './text-material.js';
import {
  createVectorMaterial,
  setVectorFrame,
  setVectorLayer,
  createDrawUniforms,
  type VectorDrawUniforms,
  type VectorMeshKind,
} from './vector-material.js';

/** One tile's mesh of one style layer. Attribute arrays have the lengths given in the names' comments. */
export interface VectorMeshData {
  readonly kind: VectorMeshKind;
  readonly originEcef: Float64Array;
  readonly planeCenter: Float64Array;
  /** Offsets from the origin (3), normals (3), Mercator plane offsets (4) per vertex. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly planes: Float32Array;
  /** Tile units (2) per vertex. */
  readonly tile: Float32Array;
  readonly indices: Uint32Array;
  /** Paint at the two zooms around the camera's (4 each per vertex): colors and parameters. */
  readonly colorA: Float32Array;
  readonly colorB: Float32Array;
  readonly paramsA: Float32Array;
  readonly paramsB: Float32Array;
  /** Terrain height under each vertex (1), for draping. */
  readonly ground: Float32Array;
  /** Lines: the side point's globe attributes and (ex, ey, distance, 0) per vertex. */
  readonly side?: { readonly positions: Float32Array; readonly normals: Float32Array; readonly planes: Float32Array };
  readonly line?: Float32Array;
  /** Extrusions: height above the ground (1), the building top (1) and the shading normal (3) per vertex. */
  readonly height?: Float32Array;
  readonly top?: Float32Array;
  readonly shadeNormals?: Float32Array;
  /** Circles: corner (2) and stroke color (4) per vertex. */
  readonly corners?: Float32Array;
  readonly stroke?: Float32Array;
  /** Rasters: the tile's image (straight sRGB RGBA, top row first). */
  readonly image?: { readonly width: number; readonly height: number; readonly data: Uint8Array | Uint8ClampedArray };
}

/** Attributes a mesh may replace in place (same lengths): paint and draping. */
export type VectorMeshUpdate = Partial<
  Pick<VectorMeshData, 'colorA' | 'colorB' | 'paramsA' | 'paramsB' | 'ground' | 'stroke'>
>;

/** A created mesh. */
export interface VectorMesh {
  update(attributes: VectorMeshUpdate): void;
  dispose(): void;
}

/** One draw of a mesh: the target square it is clipped to (tile units) and CSS pixels per tile unit. */
export interface VectorDraw {
  readonly mesh: VectorMesh;
  readonly clip: readonly [number, number, number, number];
  readonly pxPerUnit: number;
}

/** One style layer's draws this frame. */
export interface VectorLayerDraws {
  readonly layerId: string;
  readonly kind: VectorMeshKind;
  /** Opacity factor of the layer (its fade included). */
  readonly opacity: number;
  /** The factor between the paint at zoom A and B. */
  readonly zoomT: number;
  /** `line-dasharray` in line widths. */
  readonly dash?: readonly number[];
  /** Extrusions drawn opaque, writing depth. */
  readonly solid?: boolean;
  /** Extrusions: the share of their height drawn (they grow as their layer fades in, F457). */
  readonly heightScale?: number;
  readonly draws: readonly VectorDraw[];
}

/** The label quads of a frame: four vertices per quad, attributes as the text material reads them. */
export interface LabelQuads {
  readonly quads: number;
  readonly screen: Float32Array;
  readonly uv: Float32Array;
  readonly fill: Float32Array;
  readonly halo: Float32Array;
  readonly params: Float32Array;
}

class ThreeVectorMesh implements VectorMesh {
  readonly geometry: BufferGeometry;
  /** One three.js mesh per draw this frame, kept for the next frames (pipelines are cached per object). */
  readonly objects: Mesh[] = [];
  used = 0;
  disposed = false;

  /** Rasters: the mesh's own material over its image (F445). */
  readonly rasterMaterial: MeshBasicNodeMaterial | undefined;
  private readonly texture: Texture | undefined;

  constructor(
    readonly data: VectorMeshData,
    private readonly owner: ThreeVectorTarget,
    depthPath: DepthPath,
  ) {
    this.geometry = vectorGeometry(data);
    if (data.image !== undefined) {
      this.texture = rasterTexture(data.image);
      this.rasterMaterial = createRasterMaterial(this.texture, depthPath);
    }
  }

  /** Frees the raster material and texture. */
  disposeRaster(): void {
    this.rasterMaterial?.dispose();
    this.texture?.dispose();
  }

  update(attributes: VectorMeshUpdate): void {
    updateVectorGeometry(this.geometry, attributes);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.release(this);
  }
}

/** The three.js implementation of `VectorTileTarget`. */
export class ThreeVectorTarget {
  /** Glyphs and icons of the labels. */
  readonly atlas = new SdfAtlas();
  /** Draws glyphs locally for characters the style's glyph server lacks (F448). */
  readonly rasterizeGlyphs = rasterizeSdfGlyphs;
  private readonly meshes = new Set<ThreeVectorMesh>();
  private readonly materials = new Map<string, MeshBasicNodeMaterial>();
  private readonly textMaterial: MeshBasicNodeMaterial;
  private labelMesh: Mesh | undefined;
  private pendingLabels: LabelQuads | undefined;

  /** Every vector object, in drawing order: the layer groups, then the labels. */
  private readonly root = new Group();
  private readonly groups = new Map<string, Group>();

  constructor(private readonly context: ThreeExtensionContext) {
    this.textMaterial = createTextMaterial(this.atlas.texture, this.atlas.size);
    this.root.matrixAutoUpdate = false;
    this.root.matrixWorldAutoUpdate = false;
    context.scene.add(this.root);
  }

  /** Uploads one tile's mesh of one style layer; it is drawn when a frame's draws list it. */
  createMesh(data: VectorMeshData): VectorMesh {
    const mesh = new ThreeVectorMesh(data, this, this.context.depthPath());
    this.meshes.add(mesh);
    return mesh;
  }

  /** Draws the frame: every layer's draws in order (meshes not drawn are hidden), then the labels. */
  draw(layers: readonly VectorLayerDraws[], view: FrameView): void {
    for (const mesh of this.meshes) mesh.used = 0;
    // The engine renders without sorting (scene order): one group per style layer, in style order, labels last.
    for (const group of this.groups.values()) group.visible = false;
    this.root.children.length = 0;
    for (const layer of layers) {
      const group = this.group(layer.layerId);
      group.visible = true;
      this.root.children.push(group);
    }
    if (this.labelMesh !== undefined) this.root.children.push(this.labelMesh);
    for (const layer of layers) if (layer.kind !== 'raster') this.material(layer);
    for (const material of this.materials.values()) setVectorFrame(material, view.morph, view.widthPx, view.heightPx);
    for (const layer of layers) {
      const shared = layer.kind === 'raster' ? undefined : this.material(layer);
      for (const draw of layer.draws) {
        const mesh = draw.mesh as ThreeVectorMesh;
        const material = shared ?? mesh.rasterMaterial;
        if (mesh.disposed || material === undefined) continue;
        if (shared === undefined) setVectorFrame(material, view.morph, view.widthPx, view.heightPx);
        const object = this.object(mesh, material, this.group(layer.layerId));
        const uniforms = object.userData['vectorDraw'] as VectorDrawUniforms;
        setVectorLayer(uniforms, layer.opacity, layer.zoomT, layer.dash, layer.heightScale);
        uniforms.clip.set(draw.clip[0], draw.clip[1], draw.clip[2], draw.clip[3]);
        uniforms.tile.set(draw.pxPerUnit, 0, 0, 0);
        placeTile(object, mesh.data, view);
      }
    }
    for (const mesh of this.meshes) {
      for (let i = 0; i < mesh.objects.length; i++) {
        const object = mesh.objects[i];
        if (object !== undefined) object.visible = i < mesh.used;
      }
    }
    this.drawLabels(view);
  }

  /** The label quads to draw from the next frame on; undefined draws none. */
  setLabels(labels: LabelQuads | undefined): void {
    this.pendingLabels = labels;
  }

  /** Frees a layer's group (the layer was removed from the style); its meshes go with their tiles. */
  removeLayer(layerId: string): void {
    this.groups.get(layerId)?.removeFromParent();
    this.groups.delete(layerId);
  }

  /** Frees every mesh, material and texture. */
  dispose(): void {
    for (const mesh of [...this.meshes]) mesh.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.disposeLabels();
    this.root.removeFromParent();
    this.textMaterial.dispose();
    this.atlas.dispose();
  }

  /** Called by a mesh's `dispose`. */
  release(mesh: ThreeVectorMesh): void {
    this.meshes.delete(mesh);
    for (const object of mesh.objects) object.removeFromParent();
    mesh.objects.length = 0;
    mesh.geometry.dispose();
    mesh.disposeRaster();
  }

  private material(layer: VectorLayerDraws): MeshBasicNodeMaterial {
    // One material, so one shader program, per kind: a layer appearing compiles nothing (F443).
    const key = `${layer.kind}\u0000${layer.solid === false ? 't' : 's'}`;
    let material = this.materials.get(key);
    if (material === undefined) {
      // Rasters have a material per mesh (their image); this is never asked for one.
      const kind = layer.kind === 'raster' ? 'fill' : layer.kind;
      material = createVectorMaterial(kind, this.context.depthPath(), {
        solid: layer.solid !== false,
        atlas: this.atlas,
      });
      this.materials.set(key, material);
    }
    return material;
  }

  private group(layerId: string): Group {
    let group = this.groups.get(layerId);
    if (group === undefined) {
      group = new Group();
      group.matrixAutoUpdate = false;
      group.matrixWorldAutoUpdate = false;
      group.parent = this.root;
      this.groups.set(layerId, group);
    }
    return group;
  }

  private object(mesh: ThreeVectorMesh, material: MeshBasicNodeMaterial, group: Group): Mesh {
    let object = mesh.objects[mesh.used];
    if (object === undefined) {
      object = new Mesh(mesh.geometry, material);
      object.matrixAutoUpdate = false;
      object.matrixWorldAutoUpdate = false;
      object.frustumCulled = false;
      object.userData['vectorDraw'] = createDrawUniforms();
      mesh.objects.push(object);
      group.add(object);
    } else if (object.material !== material) {
      object.material = material;
    }
    object.visible = true;
    mesh.used++;
    return object;
  }

  private drawLabels(view: FrameView): void {
    setTextViewport(this.textMaterial, view.widthPx, view.heightPx);
    const labels = this.pendingLabels;
    if (labels === undefined) {
      if (this.labelMesh !== undefined) this.labelMesh.visible = false;
      return;
    }
    const geometry = this.labelGeometry(labels.quads);
    const write = (name: string, array: Float32Array) => {
      const attribute = geometry.getAttribute(name) as BufferAttribute;
      (attribute.array as Float32Array).set(array.subarray(0, Math.min(array.length, attribute.array.length)));
      attribute.needsUpdate = true;
    };
    write('labelScreen', labels.screen);
    write('labelUv', labels.uv);
    write('labelFill', labels.fill);
    write('labelHalo', labels.halo);
    write('labelParams', labels.params);
    geometry.setDrawRange(0, labels.quads * 6);
    if (this.labelMesh !== undefined) this.labelMesh.visible = labels.quads > 0;
  }

  /** The label geometry, grown to hold `quads` quads (capacity doubles, so it is rebuilt rarely). */
  private labelGeometry(quads: number): BufferGeometry {
    const current = this.labelMesh?.geometry;
    const capacity = (current?.userData['capacity'] as number | undefined) ?? 0;
    if (current !== undefined && capacity >= quads) return current;
    this.disposeLabels();
    const size = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, quads))));
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(size * 4 * 3), 3));
    g.setAttribute('labelScreen', new BufferAttribute(new Float32Array(size * 4 * 2), 2));
    g.setAttribute('labelUv', new BufferAttribute(new Float32Array(size * 4 * 2), 2));
    g.setAttribute('labelFill', new BufferAttribute(new Float32Array(size * 4 * 4), 4));
    g.setAttribute('labelHalo', new BufferAttribute(new Float32Array(size * 4 * 4), 4));
    g.setAttribute('labelParams', new BufferAttribute(new Float32Array(size * 4 * 4), 4));
    const indices = new Uint32Array(size * 6);
    for (let q = 0; q < size; q++) indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    g.setIndex(new BufferAttribute(indices, 1));
    g.userData['capacity'] = size;
    const mesh = new Mesh(g, this.textMaterial);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.frustumCulled = false;
    this.labelMesh = mesh;
    mesh.parent = this.root;
    this.root.children.push(mesh);
    return g;
  }

  private disposeLabels(): void {
    if (this.labelMesh === undefined) return;
    this.labelMesh.removeFromParent();
    this.labelMesh.geometry.dispose();
    this.labelMesh = undefined;
  }
}

/** Creates the three.js vector tile target from a render extension's `context.renderer` (ADR 0131). */
export function createVectorTileTarget(renderer: unknown): ThreeVectorTarget {
  return new ThreeVectorTarget(renderer as ThreeExtensionContext);
}
