// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  COMPONENT_BYTES,
  ELEMENT_SIZES,
  type ComponentType,
  type DracoCompression,
  type ElementType,
  type GltfAccessor,
  type GltfBuffer,
  type GltfBufferView,
  type GltfDocument,
  type GltfMesh,
  type GltfNode,
  type GltfPrimitive,
  type GltfScene,
  type GltfSparse,
  type MeshoptCompression,
} from './document.js';
import { ModelError } from './errors.js';
import {
  array,
  extension,
  integer,
  invalid,
  numbers,
  object,
  optionalRef,
  optionalString,
  ref,
  type Json,
} from './json-read.js';
import { validateImages, validateMaterials, validateSamplers, validateTextures } from './validate-materials.js';

/** Extensions this package reads; a document requiring any other is rejected ('unsupported'). */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.freeze([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'EXT_texture_webp',
  'KHR_texture_transform',
  'KHR_materials_unlit',
  'KHR_materials_emissive_strength',
]);

function meshoptOf(view: Json, path: string, buffers: number): MeshoptCompression | undefined {
  const ext = extension(view, 'KHR_meshopt_compression') ?? extension(view, 'EXT_meshopt_compression');
  if (!ext) return undefined;
  const mode = ext['mode'];
  if (mode !== 'ATTRIBUTES' && mode !== 'TRIANGLES' && mode !== 'INDICES')
    throw invalid(`${path}.mode`, 'unknown mode');
  const filter = ext['filter'] ?? 'NONE';
  if (
    filter !== 'NONE' &&
    filter !== 'OCTAHEDRAL' &&
    filter !== 'QUATERNION' &&
    filter !== 'EXPONENTIAL' &&
    filter !== 'COLOR'
  )
    throw invalid(`${path}.filter`, 'unknown filter');
  return {
    buffer: ref(ext['buffer'], `${path}.buffer`, buffers, 'buffer'),
    byteOffset: integer(ext['byteOffset'], `${path}.byteOffset`, 0),
    byteLength: integer(ext['byteLength'], `${path}.byteLength`, undefined, 1),
    byteStride: integer(ext['byteStride'], `${path}.byteStride`, undefined, 1),
    count: integer(ext['count'], `${path}.count`, undefined, 1),
    mode,
    filter,
  };
}

function validateBuffers(gltf: Json): GltfBuffer[] {
  return array(gltf['buffers'], 'buffers').map((value, i) => {
    const buffer = object(value, `buffers[${i}]`);
    const fallback = extension(buffer, 'KHR_meshopt_compression') ?? extension(buffer, 'EXT_meshopt_compression');
    return {
      uri: optionalString(buffer['uri'], `buffers[${i}].uri`),
      byteLength: integer(buffer['byteLength'], `buffers[${i}].byteLength`, undefined, 1),
      meshoptFallback: fallback?.['fallback'] === true,
    };
  });
}

function validateBufferViews(gltf: Json, buffers: readonly GltfBuffer[]): GltfBufferView[] {
  return array(gltf['bufferViews'], 'bufferViews').map((value, i) => {
    const path = `bufferViews[${i}]`;
    const view = object(value, path);
    const buffer = ref(view['buffer'], `${path}.buffer`, buffers.length, 'buffer');
    const byteOffset = integer(view['byteOffset'], `${path}.byteOffset`, 0);
    const byteLength = integer(view['byteLength'], `${path}.byteLength`, undefined, 1);
    const stride = view['byteStride'];
    const byteStride = stride === undefined ? undefined : integer(stride, `${path}.byteStride`, undefined, 4);
    if (byteStride !== undefined && (byteStride > 252 || byteStride % 4 !== 0))
      throw invalid(`${path}.byteStride`, 'must be a multiple of 4 from 4 to 252');
    if (byteOffset + byteLength > (buffers[buffer]?.byteLength ?? 0))
      throw invalid(path, `runs past the end of buffer ${buffer}`);
    const meshopt = meshoptOf(view, `${path}.extensions.meshopt`, buffers.length);
    if (meshopt && meshopt.byteOffset + meshopt.byteLength > (buffers[meshopt.buffer]?.byteLength ?? 0))
      throw invalid(path, 'compressed data runs past the end of its buffer');
    if (meshopt && meshopt.count * meshopt.byteStride > byteLength)
      throw invalid(path, 'meshopt count × byteStride exceeds byteLength');
    return { buffer, byteOffset, byteLength, byteStride, meshopt };
  });
}

function componentType(value: unknown, path: string): ComponentType {
  if (value === 5120 || value === 5121 || value === 5122 || value === 5123 || value === 5125 || value === 5126)
    return value;
  throw invalid(path, 'unknown component type');
}

function elementType(value: unknown, path: string): ElementType {
  if (typeof value === 'string' && value in ELEMENT_SIZES) return value as ElementType;
  throw invalid(path, 'unknown accessor type');
}

/** The bytes one element of an accessor spans in its buffer view (columns of matrices padded to 4 bytes). */
function elementBytes(type: ElementType, component: ComponentType): number {
  const bytes = COMPONENT_BYTES[component];
  if (type === 'MAT2' && bytes === 1) return 8;
  if (type === 'MAT3' && bytes === 1) return 12;
  if (type === 'MAT3' && bytes === 2) return 24;
  return ELEMENT_SIZES[type] * bytes;
}

function validateSparse(value: unknown, path: string, views: readonly GltfBufferView[], count: number): GltfSparse {
  const sparse = object(value, path);
  const sparseCount = integer(sparse['count'], `${path}.count`, undefined, 1);
  if (sparseCount > count) throw invalid(`${path}.count`, 'exceeds the accessor count');
  const indices = object(sparse['indices'], `${path}.indices`);
  const values = object(sparse['values'], `${path}.values`);
  const type = indices['componentType'];
  if (type !== 5121 && type !== 5123 && type !== 5125)
    throw invalid(`${path}.indices.componentType`, 'must be unsigned');
  return {
    count: sparseCount,
    indices: {
      bufferView: ref(indices['bufferView'], `${path}.indices.bufferView`, views.length, 'buffer view'),
      byteOffset: integer(indices['byteOffset'], `${path}.indices.byteOffset`, 0),
      componentType: type,
    },
    values: {
      bufferView: ref(values['bufferView'], `${path}.values.bufferView`, views.length, 'buffer view'),
      byteOffset: integer(values['byteOffset'], `${path}.values.byteOffset`, 0),
    },
  };
}

function validateAccessors(gltf: Json, views: readonly GltfBufferView[]): GltfAccessor[] {
  return array(gltf['accessors'], 'accessors').map((value, i) => {
    const path = `accessors[${i}]`;
    const accessor = object(value, path);
    const component = componentType(accessor['componentType'], `${path}.componentType`);
    const type = elementType(accessor['type'], `${path}.type`);
    const count = integer(accessor['count'], `${path}.count`, undefined, 1);
    const bufferView = optionalRef(accessor['bufferView'], `${path}.bufferView`, views.length, 'buffer view');
    const byteOffset = integer(accessor['byteOffset'], `${path}.byteOffset`, 0);
    if (byteOffset % COMPONENT_BYTES[component] !== 0) throw invalid(`${path}.byteOffset`, 'is misaligned');
    if (bufferView !== undefined) {
      const view = views[bufferView] as GltfBufferView;
      const size = elementBytes(type, component);
      const stride = view.byteStride ?? size;
      if (byteOffset + stride * (count - 1) + size > view.byteLength)
        throw invalid(path, `count ${count} runs past the end of buffer view ${bufferView}`);
    }
    const size = ELEMENT_SIZES[type];
    const bound = (key: 'min' | 'max'): number[] | undefined =>
      accessor[key] === undefined ? undefined : numbers(accessor[key], `${path}.${key}`, size, []);
    return {
      bufferView,
      byteOffset,
      componentType: component,
      normalized: accessor['normalized'] === true,
      count,
      type,
      min: bound('min'),
      max: bound('max'),
      sparse:
        accessor['sparse'] === undefined
          ? undefined
          : validateSparse(accessor['sparse'], `${path}.sparse`, views, count),
    };
  });
}

function attributeMap(value: unknown, path: string, accessors: number): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [name, index] of Object.entries(object(value, path)))
    map[name] = ref(index, `${path}.${name}`, accessors, 'accessor');
  return map;
}

function validatePrimitive(
  value: unknown,
  path: string,
  doc: Pick<GltfDocument, 'accessors' | 'bufferViews'>,
  materials: number,
): GltfPrimitive {
  const primitive = object(value, path);
  const mode = integer(primitive['mode'], `${path}.mode`, 4);
  if (mode > 6) throw invalid(`${path}.mode`, 'must be from 0 to 6');
  const ext = extension(primitive, 'KHR_draco_mesh_compression');
  let draco: DracoCompression | undefined;
  if (ext) {
    const ids: Record<string, number> = {};
    for (const [name, id] of Object.entries(object(ext['attributes'], `${path}.draco.attributes`)))
      ids[name] = integer(id, `${path}.draco.attributes.${name}`);
    draco = {
      bufferView: ref(ext['bufferView'], `${path}.draco.bufferView`, doc.bufferViews.length, 'buffer view'),
      attributes: ids,
    };
  }
  const attributes = attributeMap(primitive['attributes'], `${path}.attributes`, doc.accessors.length);
  if (attributes['POSITION'] === undefined) throw invalid(`${path}.attributes`, 'has no POSITION');
  const indices = optionalRef(primitive['indices'], `${path}.indices`, doc.accessors.length, 'accessor');
  if (indices !== undefined) {
    const accessor = doc.accessors[indices] as GltfAccessor;
    if (
      accessor.type !== 'SCALAR' ||
      (accessor.componentType !== 5121 && accessor.componentType !== 5123 && accessor.componentType !== 5125)
    )
      throw invalid(`${path}.indices`, 'must be an unsigned SCALAR accessor');
  }
  return {
    attributes,
    indices,
    material: optionalRef(primitive['material'], `${path}.material`, materials, 'material'),
    mode: mode as GltfPrimitive['mode'],
    draco,
  };
}

function validateMeshes(
  gltf: Json,
  doc: Pick<GltfDocument, 'accessors' | 'bufferViews'>,
  materials: number,
): GltfMesh[] {
  return array(gltf['meshes'], 'meshes').map((value, i) => {
    const mesh = object(value, `meshes[${i}]`);
    const primitives = array(mesh['primitives'], `meshes[${i}].primitives`);
    if (primitives.length === 0) throw invalid(`meshes[${i}].primitives`, 'must not be empty');
    return {
      name: optionalString(mesh['name'], `meshes[${i}].name`),
      primitives: primitives.map((p, j) => validatePrimitive(p, `meshes[${i}].primitives[${j}]`, doc, materials)),
    };
  });
}

function validateNodes(gltf: Json, meshes: number): GltfNode[] {
  const list = array(gltf['nodes'], 'nodes');
  const nodes = list.map((value, i): GltfNode => {
    const path = `nodes[${i}]`;
    const node = object(value, path);
    const matrix = node['matrix'] === undefined ? undefined : numbers(node['matrix'], `${path}.matrix`, 16, []);
    return {
      name: optionalString(node['name'], `${path}.name`),
      children: array(node['children'], `${path}.children`).map((c, j) =>
        ref(c, `${path}.children[${j}]`, list.length, 'node'),
      ),
      mesh: optionalRef(node['mesh'], `${path}.mesh`, meshes, 'mesh'),
      matrix,
      translation: numbers(node['translation'], `${path}.translation`, 3, [0, 0, 0]) as [number, number, number],
      rotation: numbers(node['rotation'], `${path}.rotation`, 4, [0, 0, 0, 1]) as [number, number, number, number],
      scale: numbers(node['scale'], `${path}.scale`, 3, [1, 1, 1]) as [number, number, number],
    };
  });
  // Every node has at most one parent, and the hierarchy has no cycles: the graph is a forest.
  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((node, i) => {
    for (const child of node.children) {
      if (parent[child] !== -1 || child === i)
        throw invalid(`nodes[${i}].children`, `node ${child} has two parents or is its own child`);
      parent[child] = i;
    }
  });
  nodes.forEach((_, i) => {
    let steps = 0;
    for (let at = parent[i] ?? -1; at !== -1; at = parent[at] ?? -1)
      if (++steps > nodes.length) throw invalid(`nodes[${i}]`, 'is part of a cycle');
  });
  return nodes;
}

function validateScenes(gltf: Json, nodes: readonly GltfNode[]): { scenes: GltfScene[]; scene: number | undefined } {
  const roots = new Set<number>();
  nodes.forEach((node) => node.children.forEach((c) => roots.add(c)));
  const scenes = array(gltf['scenes'], 'scenes').map((value, i) => {
    const scene = object(value, `scenes[${i}]`);
    const list = array(scene['nodes'], `scenes[${i}].nodes`).map((n, j) =>
      ref(n, `scenes[${i}].nodes[${j}]`, nodes.length, 'node'),
    );
    for (const n of list) if (roots.has(n)) throw invalid(`scenes[${i}].nodes`, `node ${n} is not a root`);
    return { nodes: list };
  });
  return { scenes, scene: optionalRef(gltf['scene'], 'scene', scenes.length, 'scene') };
}

/**
 *
 */
export function validateGltf(json: unknown): GltfDocument {
  const gltf = object(json, 'glTF');
  const asset = object(gltf['asset'], 'asset');
  const version = asset['version'];
  if (typeof version !== 'string') throw invalid('asset.version', 'must be a string');
  if (!/^2\.\d+$/.test(version)) throw new ModelError('unsupported', `glTF version ${version} (only 2.x is read)`);
  const extensionsUsed = array(gltf['extensionsUsed'], 'extensionsUsed').map(
    (e, i) => optionalString(e, `extensionsUsed[${i}]`) ?? '',
  );
  const extensionsRequired = array(gltf['extensionsRequired'], 'extensionsRequired').map(
    (e, i) => optionalString(e, `extensionsRequired[${i}]`) ?? '',
  );
  for (const name of extensionsRequired)
    if (!SUPPORTED_EXTENSIONS.includes(name))
      throw new ModelError('unsupported', `required extension ${name} is not supported`);
  const buffers = validateBuffers(gltf);
  const bufferViews = validateBufferViews(gltf, buffers);
  const accessors = validateAccessors(gltf, bufferViews);
  const samplers = validateSamplers(gltf);
  const images = validateImages(gltf, bufferViews.length);
  const textures = validateTextures(gltf, images.length, samplers.length);
  const materials = validateMaterials(gltf, textures.length);
  const meshes = validateMeshes(gltf, { accessors, bufferViews }, materials.length);
  const nodes = validateNodes(gltf, meshes.length);
  const { scenes, scene } = validateScenes(gltf, nodes);
  return {
    version,
    extensionsUsed,
    extensionsRequired,
    buffers,
    bufferViews,
    accessors,
    meshes,
    nodes,
    scenes,
    scene,
    materials,
    textures,
    images,
    samplers,
  };
}
