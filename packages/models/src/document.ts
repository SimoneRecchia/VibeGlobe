/**
 * The parts of a glTF 2.0 document this package reads, as {@link validateGltf} returns them: every index checked
 * against its array, every number checked for its range. Fields the package ignores (animations, skins, cameras)
 * are not kept. Names follow the specification.
 */

/** Accessor component types (WebGL enums): BYTE, UNSIGNED_BYTE, SHORT, UNSIGNED_SHORT, UNSIGNED_INT, FLOAT. */
export type ComponentType = 5120 | 5121 | 5122 | 5123 | 5125 | 5126;

/** Accessor element types and their component counts. */
export const ELEMENT_SIZES = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 });
/** A validated glTF element type. */
export type ElementType = keyof typeof ELEMENT_SIZES;

/** Bytes per component of each component type. */
export const COMPONENT_BYTES: Readonly<Record<ComponentType, number>> = Object.freeze({
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
});

/** A validated glTF buffer. */
export interface GltfBuffer {
  readonly uri: string | undefined;
  readonly byteLength: number;
  /** `EXT_meshopt_compression`/`KHR_meshopt_compression` fallback buffer: its bytes are produced by decoding. */
  readonly meshoptFallback: boolean;
}

/** The meshopt compression of a buffer view (`EXT_meshopt_compression`/`KHR_meshopt_compression`). */
export interface MeshoptCompression {
  readonly buffer: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly byteStride: number;
  readonly count: number;
  readonly mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
  readonly filter: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL' | 'COLOR';
}

/** A validated glTF buffer view. */
export interface GltfBufferView {
  readonly buffer: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly byteStride: number | undefined;
  readonly meshopt: MeshoptCompression | undefined;
}

/** A validated glTF sparse. */
export interface GltfSparse {
  readonly count: number;
  readonly indices: {
    readonly bufferView: number;
    readonly byteOffset: number;
    readonly componentType: 5121 | 5123 | 5125;
  };
  readonly values: { readonly bufferView: number; readonly byteOffset: number };
}

/** A validated glTF accessor. */
export interface GltfAccessor {
  readonly bufferView: number | undefined;
  readonly byteOffset: number;
  readonly componentType: ComponentType;
  readonly normalized: boolean;
  readonly count: number;
  readonly type: ElementType;
  readonly min: readonly number[] | undefined;
  readonly max: readonly number[] | undefined;
  readonly sparse: GltfSparse | undefined;
}

/** `KHR_draco_mesh_compression` on a primitive. */
export interface DracoCompression {
  readonly bufferView: number;
  /** glTF attribute name to Draco attribute unique id. */
  readonly attributes: Readonly<Record<string, number>>;
}

/** A validated glTF primitive. */
export interface GltfPrimitive {
  readonly attributes: Readonly<Record<string, number>>;
  readonly indices: number | undefined;
  readonly material: number | undefined;
  /** 0 points, 1 lines, 2 line loop, 3 line strip, 4 triangles, 5 triangle strip, 6 triangle fan. */
  readonly mode: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  readonly draco: DracoCompression | undefined;
}

/** A validated glTF mesh. */
export interface GltfMesh {
  readonly name: string | undefined;
  readonly primitives: readonly GltfPrimitive[];
}

/** A validated glTF node. */
export interface GltfNode {
  readonly name: string | undefined;
  readonly children: readonly number[];
  readonly mesh: number | undefined;
  /** Column-major 4×4, when the node gives `matrix`. */
  readonly matrix: readonly number[] | undefined;
  readonly translation: readonly [number, number, number];
  /** Unit quaternion x, y, z, w. */
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

/** A validated glTF texture transform. */
interface GltfTextureTransform {
  readonly offset: readonly [number, number];
  readonly rotationRad: number;
  readonly scale: readonly [number, number];
  readonly texCoord: number | undefined;
}

/** A validated glTF texture info. */
export interface GltfTextureInfo {
  readonly index: number;
  readonly texCoord: number;
  readonly transform: GltfTextureTransform | undefined;
  /** `normalTexture.scale` or `occlusionTexture.strength`. */
  readonly factor: number;
}

/** A validated glTF material. */
export interface GltfMaterial {
  readonly name: string | undefined;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly baseColorTexture: GltfTextureInfo | undefined;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly metallicRoughnessTexture: GltfTextureInfo | undefined;
  readonly normalTexture: GltfTextureInfo | undefined;
  readonly occlusionTexture: GltfTextureInfo | undefined;
  readonly emissiveTexture: GltfTextureInfo | undefined;
  readonly emissiveFactor: readonly [number, number, number];
  readonly alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
  /** `KHR_materials_unlit`. */
  readonly unlit: boolean;
}

/** A validated glTF texture. */
export interface GltfTexture {
  /** The image to show: the `KHR_texture_basisu` or `EXT_texture_webp` source when given, else `source`. */
  readonly source: number | undefined;
  /** The plain `source` when an extension chose another image (for devices that cannot use it). */
  readonly fallbackSource: number | undefined;
  readonly sampler: number | undefined;
}

/** A validated glTF image. */
export interface GltfImage {
  readonly uri: string | undefined;
  readonly bufferView: number | undefined;
  readonly mimeType: string | undefined;
  readonly name: string | undefined;
}

/** A validated glTF sampler. */
export interface GltfSampler {
  readonly magFilter: number | undefined;
  readonly minFilter: number | undefined;
  readonly wrapS: number;
  readonly wrapT: number;
}

/** A validated glTF scene. */
export interface GltfScene {
  readonly nodes: readonly number[];
}

/** A validated glTF 2.0 document. */
export interface GltfDocument {
  readonly version: string;
  readonly extensionsUsed: readonly string[];
  readonly extensionsRequired: readonly string[];
  readonly buffers: readonly GltfBuffer[];
  readonly bufferViews: readonly GltfBufferView[];
  readonly accessors: readonly GltfAccessor[];
  readonly meshes: readonly GltfMesh[];
  readonly nodes: readonly GltfNode[];
  readonly scenes: readonly GltfScene[];
  readonly scene: number | undefined;
  readonly materials: readonly GltfMaterial[];
  readonly textures: readonly GltfTexture[];
  readonly images: readonly GltfImage[];
  readonly samplers: readonly GltfSampler[];
}
