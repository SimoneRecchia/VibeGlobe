/**
 * The renderer-neutral description of a glTF model (F361, ADR 0121): flat typed arrays, materials as plain numbers,
 * images as encoded bytes, and one instance per node that shows a mesh. Coordinates are the model's own: glTF's
 * right-handed, +Y up, meters; the renderer turns them onto the local east, north and up axes of the model's pose.
 * Every array owns its buffer, so the whole description can be transferred from a worker without copies.
 */

/** Typed arrays an attribute or an index list can use. */
export type AttributeArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array;

/** One vertex attribute, tightly packed (no interleaving), in the component type the model stores. */
export interface ModelAttribute {
  readonly array: AttributeArray;
  /** Components per vertex: 1 to 4. */
  readonly itemSize: number;
  /** Integer components map to [0, 1] (unsigned) or [-1, 1] (signed), as glTF's `normalized` (and quantized meshes). */
  readonly normalized: boolean;
}

/** How a primitive's vertices form shapes; the same numbers as glTF's `mode` and WebGL's draw modes. */
export type PrimitiveMode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** One draw: a primitive of a glTF mesh, decoded. */
export interface ModelPrimitive {
  readonly mode: PrimitiveMode;
  /** Attributes by their glTF semantic: POSITION always, NORMAL, TANGENT, TEXCOORD_n, COLOR_n when the model has them. */
  readonly attributes: Readonly<Record<string, ModelAttribute>>;
  readonly indices: Uint8Array | Uint16Array | Uint32Array | undefined;
  /** Index into {@link ModelDescription.materials}, or -1 for glTF's default material. */
  readonly material: number;
  readonly vertexCount: number;
  /** Axis-aligned bounds of the positions, in the primitive's own space (before node transforms). */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** A glTF mesh: the primitives drawn together. */
export interface ModelMesh {
  readonly name: string | undefined;
  readonly primitives: readonly ModelPrimitive[];
}

/** A mesh placed in the model by a node. */
export interface ModelInstance {
  readonly mesh: number;
  readonly node: number;
  /** Model-space transform of the node (the product of its ancestors' transforms), column-major 4×4. */
  readonly matrix: Float64Array;
}

/** A texture reference of a material. */
export interface ModelTexture {
  /** Index into {@link ModelDescription.images}. */
  readonly image: number;
  /** The plain image when `image` is KTX2 or WebP (KHR_texture_basisu, EXT_texture_webp) and a device cannot use it. */
  readonly fallbackImage: number | undefined;
  /** Which TEXCOORD_n set it reads (after a `KHR_texture_transform` override). */
  readonly texCoord: number;
  readonly sampler: ModelSampler;
  /** `KHR_texture_transform`: uv' = offset + R(rotation) · (scale · uv). */
  readonly transform:
    | {
        readonly offset: readonly [number, number];
        readonly rotationRad: number;
        readonly scale: readonly [number, number];
      }
    | undefined;
}

/** Texture sampling, as glTF's sampler numbers (WebGL enums); filters undefined mean the renderer's choice. */
export interface ModelSampler {
  readonly magFilter: number | undefined;
  readonly minFilter: number | undefined;
  readonly wrapS: number;
  readonly wrapT: number;
}

/** A metallic-roughness PBR material (glTF 2.0 core with the read extensions). */
export interface ModelMaterial {
  readonly name: string | undefined;
  /** Linear RGBA. */
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly baseColorTexture: ModelTexture | undefined;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly metallicRoughnessTexture: ModelTexture | undefined;
  readonly normalTexture: ModelTexture | undefined;
  readonly normalScale: number;
  readonly occlusionTexture: ModelTexture | undefined;
  readonly occlusionStrength: number;
  readonly emissiveTexture: ModelTexture | undefined;
  /** Linear RGB, already multiplied by `KHR_materials_emissive_strength`. */
  readonly emissiveFactor: readonly [number, number, number];
  readonly alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
  /** `KHR_materials_unlit`: show the base color without lighting. */
  readonly unlit: boolean;
}

/** Image formats a model's textures use. */
export type ModelImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/ktx2';

/** An encoded texture image; the renderer decodes it (KTX2 through the engine's transcoder task). */
export interface ModelImage {
  readonly name: string | undefined;
  readonly mimeType: ModelImageType;
  readonly bytes: Uint8Array;
}

/** A decoded glTF model, ready for any renderer. */
export interface ModelDescription {
  readonly meshes: readonly ModelMesh[];
  readonly instances: readonly ModelInstance[];
  readonly materials: readonly ModelMaterial[];
  readonly images: readonly ModelImage[];
  /** Bounds of every instance in model space; all zero for a model without instances. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Extensions the file uses. */
  readonly extensionsUsed: readonly string[];
  /** Counters: vertices and triangles over every instance, and the bytes of the arrays and images. */
  readonly stats: { readonly vertices: number; readonly triangles: number; readonly bytes: number };
}
