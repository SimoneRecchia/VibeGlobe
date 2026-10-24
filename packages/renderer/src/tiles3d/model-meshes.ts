// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { DepthPath } from '@vibeglobe/core';
import type { ModelAttribute, ModelDescription, ModelImage, ModelMaterial, ModelPrimitive } from '@vibeglobe/models';
import {
  cameraNear,
  cameraProjectionMatrix,
  max,
  modelViewMatrix,
  normalView,
  positionLocal,
  texture,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  FrontSide,
  GreaterEqualDepth,
  Group,
  Line,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MirroredRepeatWrapping,
  Points,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  type Node,
  type Object3D,
  type Wrapping,
} from 'three/webgpu';

/** Decoded RGBA8 pixels, rows from the top (KTX2 transcoded in a worker). */
export interface RawImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** How {@link buildModelMeshes} turns encoded images into pixels; the browser's decoder by default. */
export type ImageDecoder = (image: ModelImage) => Promise<ImageBitmap | RawImage | undefined>;

/** Options of {@link buildModelMeshes}. */
export interface ModelMeshOptions {
  /** The depth path of the renderer (`ThreeExtensionContext.depthPath()`, ADR 0005). */
  readonly depthPath: DepthPath;
  /** Decodes a texture image; undefined leaves the material untextured. Default {@link decodeBrowserImage}. */
  readonly decodeImage?: ImageDecoder;
  /** Shades lit materials by a fixed light from above the eye so volumes read (ADR 0037); default true. */
  readonly shade?: boolean;
}

/** Meshes built from a model: one three.js root to place, and what it holds. */
export interface ModelMeshes {
  /** The model's root: its matrix is the model-to-world transform the caller writes (camera-relative, ADR 0004). */
  readonly root: Group;
  /** Bytes of the vertex, index and texture data (GPU and RAM, ADR 0007's byte accounting). */
  readonly bytes: number;
  /** Frees the geometries, materials and textures. */
  dispose(): void;
}

/** The three.js attribute name of each glTF semantic three.js reads; other semantics keep their glTF name. */
const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  POSITION: 'position',
  NORMAL: 'normal',
  TANGENT: 'tangent',
  TEXCOORD_0: 'uv',
  TEXCOORD_1: 'uv1',
  COLOR_0: 'color',
};

const WRAPPING: Readonly<Record<number, Wrapping>> = {
  33071: ClampToEdgeWrapping,
  33648: MirroredRepeatWrapping,
  10497: RepeatWrapping,
};

/**
 * The share of its distance by which every vertex is drawn nearer the eye, along its own line of sight: the picture
 * stays where it is, only its depth moves. Where content lies on the engine's terrain (photogrammetry, a tileset's
 * ground), it then wins the depth test everywhere instead of fighting the surface (F467): 0.1%, 16 cm at 160 m.
 */
const DEPTH_PULL = 1e-3;

/** The light direction in view space: from above and a little behind the eye (as the data layers' models, ADR 0037). */
const LIGHT = vec3(0.3, 0.8, 0.5).normalize();

/** Decodes PNG, JPEG and WebP images with the browser's decoder; KTX2 is left to the caller (undefined). */
export const decodeBrowserImage: ImageDecoder = async (image) => {
  if (image.mimeType === 'image/ktx2' || typeof createImageBitmap !== 'function') return undefined;
  const blob = new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mimeType });
  return createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
};

function geometryOf(primitive: ModelPrimitive): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [semantic, attribute] of Object.entries(primitive.attributes))
    geometry.setAttribute(ATTRIBUTE_NAMES[semantic] ?? semantic, bufferAttribute(attribute));
  const indices = triangleIndices(primitive);
  if (indices) geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.boundingBox = null;
  geometry.computeBoundingSphere();
  return geometry;
}

function bufferAttribute(attribute: ModelAttribute): BufferAttribute {
  return new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized);
}

/**
 * The index list three.js draws: 8-bit indices widened to 16 bits (WebGPU has no 8-bit index format), and triangle
 * strips and fans turned into plain triangles.
 */
function triangleIndices(primitive: ModelPrimitive): Uint16Array | Uint32Array | undefined {
  const source = primitive.indices;
  if (primitive.mode !== 5 && primitive.mode !== 6) {
    if (source === undefined || !(source instanceof Uint8Array)) return source;
    return Uint16Array.from(source);
  }
  const count = source?.length ?? primitive.vertexCount;
  const at = (i: number): number => (source === undefined ? i : (source[i] ?? 0));
  const out = primitive.vertexCount > 65535 ? new Uint32Array(3 * (count - 2)) : new Uint16Array(3 * (count - 2));
  for (let i = 0; i < count - 2; i++) {
    const [a, b, c] =
      primitive.mode === 6
        ? [at(0), at(i + 1), at(i + 2)]
        : i % 2 === 0
          ? [at(i), at(i + 1), at(i + 2)]
          : [at(i + 1), at(i), at(i + 2)];
    out.set([a, b, c], 3 * i);
  }
  return out;
}

function textureOf(image: ImageBitmap | RawImage, material: ModelMaterial): Texture {
  const tex = 'data' in image ? new DataTexture(image.data, image.width, image.height, RGBAFormat) : new Texture(image);
  if ('data' in image) tex.generateMipmaps = true;
  const sampler = material.baseColorTexture?.sampler;
  tex.flipY = false;
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = WRAPPING[sampler?.wrapS ?? 10497] ?? RepeatWrapping;
  tex.wrapT = WRAPPING[sampler?.wrapT ?? 10497] ?? RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * An unlit node material for a glTF material: its base color factor and texture, vertex colors, alpha mode and sides,
 * shaded by a fixed light from above the eye unless the material is unlit or the primitive has no normals.
 */
function materialOf(
  material: ModelMaterial | undefined,
  map: Texture | undefined,
  primitive: ModelPrimitive,
  options: ModelMeshOptions,
): MeshBasicNodeMaterial {
  const out = new MeshBasicNodeMaterial();
  const [r, g, b, a] = material?.baseColorFactor ?? [1, 1, 1, 1];
  let color: Node<'vec4'> = vec4(r, g, b, a);
  if (map) color = color.mul(texture(map, uv()));
  if (primitive.attributes['COLOR_0']) out.vertexColors = true;
  const lit = options.shade !== false && material?.unlit !== true && primitive.attributes['NORMAL'] !== undefined;
  const shade = lit ? max(normalView.dot(LIGHT).abs(), 0).mul(0.6).add(0.4) : 1;
  out.colorNode = vec4(color.xyz.mul(shade), color.w);
  const alphaMode = material?.alphaMode ?? 'OPAQUE';
  out.transparent = alphaMode === 'BLEND';
  if (alphaMode === 'MASK') out.alphaTest = material?.alphaCutoff ?? 0.5;
  out.side = material?.doubleSided ? DoubleSide : FrontSide;
  const pulled = modelViewMatrix.mul(vec4(positionLocal, 1)).xyz.mul(1 - DEPTH_PULL);
  out.vertexNode = cameraProjectionMatrix.mul(vec4(pulled, 1));
  if (options.depthPath === 'fragment') {
    out.depthNode = cameraNear.div(varying(pulled.z.negate()));
    out.depthFunc = GreaterEqualDepth;
  }
  return out;
}

function drawable(primitive: ModelPrimitive, geometry: BufferGeometry, material: MeshBasicNodeMaterial): Object3D {
  switch (primitive.mode) {
    case 0:
      return new Points(geometry, material);
    case 1:
      return new LineSegments(geometry, material);
    case 2:
      return new LineLoop(geometry, material);
    case 3:
      return new Line(geometry, material);
    default:
      return new Mesh(geometry, material);
  }
}

function geometryBytes(geometry: BufferGeometry): number {
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength;
  return bytes;
}

/**
 * Builds three.js meshes from a {@link ModelDescription} of `@vibeglobe/models` (F361, F461; ADR 0141): one geometry
 * per primitive with its packed attributes (normalized integers as given), indices, unlit materials with the base
 * color texture, and one mesh per instance placed by its model-space matrix under a root group. Geometries and
 * materials are shared between instances. 3D Tiles content and the data layers' glTF models use it.
 */
export async function buildModelMeshes(model: ModelDescription, options: ModelMeshOptions): Promise<ModelMeshes> {
  const decode = options.decodeImage ?? decodeBrowserImage;
  const bitmaps = await Promise.all(
    model.materials.map(async (material) => {
      const ref = material.baseColorTexture;
      if (!ref) return undefined;
      const primary = model.images[ref.image];
      const fallback = ref.fallbackImage === undefined ? undefined : model.images[ref.fallbackImage];
      const bitmap = primary ? await decode(primary).catch(() => undefined) : undefined;
      return bitmap ?? (fallback ? await decode(fallback).catch(() => undefined) : undefined);
    }),
  );
  const textures = model.materials.map((material, i) => {
    const bitmap = bitmaps[i];
    return bitmap ? textureOf(bitmap, material) : undefined;
  });
  let bytes = 0;
  for (const bitmap of bitmaps) if (bitmap) bytes += Math.round(bitmap.width * bitmap.height * 4 * (4 / 3));
  const materials = new Set<MeshBasicNodeMaterial>();
  const geometries = new Set<BufferGeometry>();
  const meshes = model.meshes.map((mesh) =>
    mesh.primitives.map((primitive) => {
      const geometry = geometryOf(primitive);
      const material = materialOf(
        model.materials[primitive.material],
        textures[primitive.material],
        primitive,
        options,
      );
      geometries.add(geometry);
      materials.add(material);
      bytes += geometryBytes(geometry);
      return { primitive, geometry, material };
    }),
  );
  const root = new Group();
  root.matrixAutoUpdate = false;
  for (const instance of model.instances) {
    for (const { primitive, geometry, material } of meshes[instance.mesh] ?? []) {
      const object = drawable(primitive, geometry, material);
      object.matrixAutoUpdate = false;
      object.matrix.copy(new Matrix4().fromArray(instance.matrix));
      object.frustumCulled = false;
      object.userData['node'] = instance.node;
      root.add(object);
    }
  }
  return {
    root,
    bytes,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const tex of textures) tex?.dispose();
      for (const bitmap of bitmaps) if (bitmap && 'close' in bitmap) bitmap.close();
      root.clear();
    },
  };
}
