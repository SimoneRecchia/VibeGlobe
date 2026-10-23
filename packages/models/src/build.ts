import { positionBounds, readAccessor } from './accessors.js';
import type {
  ModelDescription,
  ModelImage,
  ModelInstance,
  ModelMaterial,
  ModelMesh,
  ModelPrimitive,
  ModelSampler,
  ModelTexture,
} from './description.js';
import type { GltfDocument, GltfMaterial, GltfPrimitive, GltfTextureInfo } from './document.js';
import { decodeDracoPrimitive, type DracoDecoderModule } from './draco.js';
import { ModelError } from './errors.js';
import { meshNodes, transformPoint } from './transforms.js';

const DEFAULT_SAMPLER: ModelSampler = Object.freeze({
  magFilter: undefined,
  minFilter: undefined,
  wrapS: 10497,
  wrapT: 10497,
});

function texture(doc: GltfDocument, info: GltfTextureInfo | undefined, where: string): ModelTexture | undefined {
  if (!info) return undefined;
  const source = doc.textures[info.index];
  if (source?.source === undefined)
    throw new ModelError('invalid-gltf', `${where}: texture ${info.index} has no image`);
  return {
    image: source.source,
    fallbackImage: source.fallbackSource,
    texCoord: info.transform?.texCoord ?? info.texCoord,
    sampler: source.sampler === undefined ? DEFAULT_SAMPLER : (doc.samplers[source.sampler] ?? DEFAULT_SAMPLER),
    transform: info.transform && {
      offset: info.transform.offset,
      rotationRad: info.transform.rotationRad,
      scale: info.transform.scale,
    },
  };
}

function material(doc: GltfDocument, m: GltfMaterial, i: number): ModelMaterial {
  const where = `materials[${i}]`;
  return {
    name: m.name,
    baseColorFactor: m.baseColorFactor,
    baseColorTexture: texture(doc, m.baseColorTexture, where),
    metallicFactor: m.metallicFactor,
    roughnessFactor: m.roughnessFactor,
    metallicRoughnessTexture: texture(doc, m.metallicRoughnessTexture, where),
    normalTexture: texture(doc, m.normalTexture, where),
    normalScale: m.normalTexture?.factor ?? 1,
    occlusionTexture: texture(doc, m.occlusionTexture, where),
    occlusionStrength: m.occlusionTexture?.factor ?? 1,
    emissiveTexture: texture(doc, m.emissiveTexture, where),
    emissiveFactor: m.emissiveFactor,
    alphaMode: m.alphaMode,
    alphaCutoff: m.alphaCutoff,
    doubleSided: m.doubleSided,
    unlit: m.unlit,
  };
}

/** What building a primitive needs besides the document. */
export interface BuildContext {
  readonly doc: GltfDocument;
  readonly views: readonly Uint8Array[];
  readonly draco: DracoDecoderModule | undefined;
}

function indicesOf(array: ModelPrimitive['attributes'][string]['array']): ModelPrimitive['indices'] {
  if (array instanceof Uint8Array || array instanceof Uint16Array || array instanceof Uint32Array) return array;
  throw new ModelError('invalid-gltf', 'indices must be unsigned integers');
}

function primitive(ctx: BuildContext, p: GltfPrimitive, where: string): ModelPrimitive {
  const viewBytes = (view: number): Uint8Array => ctx.views[view] as Uint8Array;
  const attributes: Record<string, ModelPrimitive['attributes'][string]> = {};
  let indices: ModelPrimitive['indices'];
  if (p.draco) {
    if (!ctx.draco) throw new ModelError('unsupported', `${where} needs the Draco decoder`);
    if (p.mode !== 4) throw new ModelError('unsupported', `${where}: Draco primitives must be triangles`);
    const decoded = decodeDracoPrimitive(
      ctx.draco,
      ctx.doc,
      p.draco,
      p.attributes,
      p.indices,
      viewBytes(p.draco.bufferView),
    );
    Object.assign(attributes, decoded.attributes);
    indices = decoded.indices;
  } else if (p.indices !== undefined) indices = indicesOf(readAccessor(ctx.doc, p.indices, viewBytes).array);
  // Attributes the Draco stream does not carry are stored uncompressed (the extension allows mixing).
  for (const [semantic, accessor] of Object.entries(p.attributes))
    attributes[semantic] ??= readAccessor(ctx.doc, accessor, viewBytes);
  const position = attributes['POSITION'];
  if (!position || position.itemSize !== 3) throw new ModelError('invalid-gltf', `${where}: POSITION must be VEC3`);
  const vertexCount = position.array.length / 3;
  for (const [semantic, attribute] of Object.entries(attributes))
    if (attribute.array.length / attribute.itemSize !== vertexCount)
      throw new ModelError('invalid-gltf', `${where}: ${semantic} has a different count than POSITION`);
  if (indices)
    for (const index of indices)
      if (index >= vertexCount) throw new ModelError('invalid-gltf', `${where}: index ${index} out of range`);
  const { min, max } = positionBounds(position);
  return { mode: p.mode, attributes, indices, material: p.material ?? -1, vertexCount, min, max };
}

function triangles(p: ModelPrimitive): number {
  const count = p.indices?.length ?? p.vertexCount;
  if (p.mode === 4) return Math.floor(count / 3);
  if (p.mode === 5 || p.mode === 6) return Math.max(count - 2, 0);
  return 0;
}

function boundsOf(
  meshes: readonly ModelMesh[],
  instances: readonly ModelInstance[],
): Pick<ModelDescription, 'min' | 'max'> {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const point: number[] = [0, 0, 0];
  for (const instance of instances)
    for (const p of meshes[instance.mesh]?.primitives ?? [])
      for (let corner = 0; corner < 8; corner++) {
        transformPoint(
          instance.matrix,
          corner & 1 ? p.max[0] : p.min[0],
          corner & 2 ? p.max[1] : p.min[1],
          corner & 4 ? p.max[2] : p.min[2],
          point,
        );
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c] ?? 0, point[c] ?? 0);
          max[c] = Math.max(max[c] ?? 0, point[c] ?? 0);
        }
      }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: min as [number, number, number], max: max as [number, number, number] };
}

/** Builds the renderer-neutral description from a validated document, its buffer views and its images. */
export function buildModel(ctx: BuildContext, images: readonly ModelImage[]): ModelDescription {
  const { doc } = ctx;
  const materials = doc.materials.map((m, i) => material(doc, m, i));
  const meshes = doc.meshes.map((mesh, i) => ({
    name: mesh.name,
    primitives: mesh.primitives.map((p, j) => primitive(ctx, p, `meshes[${i}].primitives[${j}]`)),
  }));
  const instances = meshNodes(doc);
  let vertices = 0;
  let triangleCount = 0;
  for (const instance of instances)
    for (const p of meshes[instance.mesh]?.primitives ?? []) {
      vertices += p.vertexCount;
      triangleCount += triangles(p);
    }
  let bytes = 0;
  for (const mesh of meshes)
    for (const p of mesh.primitives) {
      bytes += p.indices?.byteLength ?? 0;
      for (const attribute of Object.values(p.attributes)) bytes += attribute.array.byteLength;
    }
  for (const image of images) bytes += image.bytes.byteLength;
  return {
    meshes,
    instances,
    materials,
    images,
    ...boundsOf(meshes, instances),
    extensionsUsed: doc.extensionsUsed,
    stats: { vertices, triangles: triangleCount, bytes },
  };
}

/** The buffers a description's arrays and images own: the transfer list of a worker result. */
export function transferables(model: ModelDescription): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const mesh of model.meshes)
    for (const p of mesh.primitives) {
      if (p.indices) buffers.add(p.indices.buffer as ArrayBuffer);
      for (const attribute of Object.values(p.attributes)) buffers.add(attribute.array.buffer as ArrayBuffer);
    }
  for (const image of model.images) buffers.add(image.bytes.buffer as ArrayBuffer);
  for (const instance of model.instances) buffers.add(instance.matrix.buffer as ArrayBuffer);
  return [...buffers];
}
