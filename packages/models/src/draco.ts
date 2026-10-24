// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { newArray } from './accessors.js';
import type { ModelAttribute } from './description.js';
import { ELEMENT_SIZES, type ComponentType, type DracoCompression, type GltfDocument } from './document.js';
import { ModelError } from './errors.js';

/** A Draco object allocated in the decoder's WebAssembly heap; freed with {@link DracoDecoderModule.destroy}. */
type DracoObject = object;

/** A decoded Draco attribute. */
interface DracoAttribute extends DracoObject {
  num_components(): number;
}

/** A decoded Draco mesh. */
interface DracoMesh extends DracoObject {
  num_points(): number;
  num_faces(): number;
}

/** A decoding status. */
interface DracoStatus {
  ok(): boolean;
  error_msg(): string;
}

/** The decoder object of the Draco module. */
interface DracoDecoder extends DracoObject {
  DecodeArrayToMesh(data: Int8Array, length: number, mesh: DracoMesh): DracoStatus;
  GetAttributeByUniqueId(mesh: DracoMesh, id: number): DracoAttribute;
  GetTrianglesUInt32Array(mesh: DracoMesh, byteLength: number, pointer: number): boolean;
  GetAttributeDataArrayForAllPoints(
    mesh: DracoMesh,
    attribute: DracoAttribute,
    dataType: number,
    byteLength: number,
    pointer: number,
  ): boolean;
}

/**
 * The part of Draco's Emscripten decoder module (Google's `draco3d`, Apache-2.0, or a build of the same decoder) this
 * package calls: decoding goes through the heap with `_malloc`, as the module's array API requires.
 */
export interface DracoDecoderModule {
  readonly Decoder: new () => DracoDecoder;
  readonly Mesh: new () => DracoMesh;
  readonly HEAPU8: Uint8Array;
  readonly DT_INT8: number;
  readonly DT_UINT8: number;
  readonly DT_INT16: number;
  readonly DT_UINT16: number;
  readonly DT_UINT32: number;
  readonly DT_FLOAT32: number;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  destroy(object: DracoObject): void;
}

/** Loads the Draco decoder module, lazily, on the first model that needs it (in the worker that decodes). */
export type DracoLoader = () => Promise<DracoDecoderModule>;

function dataType(module: DracoDecoderModule, type: ComponentType): number {
  switch (type) {
    case 5120:
      return module.DT_INT8;
    case 5121:
      return module.DT_UINT8;
    case 5122:
      return module.DT_INT16;
    case 5123:
      return module.DT_UINT16;
    case 5125:
      return module.DT_UINT32;
    case 5126:
      return module.DT_FLOAT32;
  }
}

/** Copies `byteLength` bytes out of the Draco heap through a temporary allocation filled by `fill(pointer)`. */
function fromHeap(
  module: DracoDecoderModule,
  byteLength: number,
  fill: (pointer: number) => boolean,
  target: Uint8Array,
): boolean {
  const pointer = module._malloc(byteLength);
  try {
    if (!fill(pointer)) return false;
    target.set(module.HEAPU8.subarray(pointer, pointer + byteLength));
    return true;
  } finally {
    module._free(pointer);
  }
}

/** The index count an indices accessor declares, if any. */
function declaredCount(doc: GltfDocument, accessor: number | undefined): number | undefined {
  return accessor === undefined ? undefined : doc.accessors[accessor]?.count;
}

/** Reads a decoded mesh's triangle list, checking its count and that every index names a point. */
function decodeTriangles(
  module: DracoDecoderModule,
  decoder: DracoDecoder,
  mesh: DracoMesh,
  declared: number | undefined,
  fail: (message: string) => ModelError,
): Uint32Array {
  const count = mesh.num_faces() * 3;
  if (declared !== undefined && declared !== count) throw fail(`${count} indices decoded, ${declared} declared`);
  const indices = new Uint32Array(count);
  const ok = fromHeap(
    module,
    indices.byteLength,
    (pointer) => decoder.GetTrianglesUInt32Array(mesh, indices.byteLength, pointer),
    new Uint8Array(indices.buffer),
  );
  if (!ok) throw fail('the triangles did not decode');
  const points = mesh.num_points();
  for (const index of indices) if (index >= points) throw fail(`index ${index} out of range`);
  return indices;
}

/** A decoded `KHR_draco_mesh_compression` primitive: its attributes (by glTF semantic) and triangle indices. */
export interface DracoPrimitive {
  readonly attributes: Record<string, ModelAttribute>;
  readonly indices: Uint32Array;
}

/**
 * Decodes a Draco-compressed triangle primitive. Each attribute is decoded into its accessor's component type and
 * checked against the accessor's count; the triangle list against the indices accessor's count. Anything the stream
 * does not deliver as declared throws a ModelError ('decode-failed'), and every heap object is freed either way.
 */
export function decodeDracoPrimitive(
  module: DracoDecoderModule,
  doc: GltfDocument,
  draco: DracoCompression,
  semantics: Readonly<Record<string, number>>,
  indicesAccessor: number | undefined,
  bytes: Uint8Array,
): DracoPrimitive {
  const fail = (message: string): ModelError => new ModelError('decode-failed', `Draco: ${message}`);
  const decoder = new module.Decoder();
  const mesh = new module.Mesh();
  try {
    const data = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const status = decoder.DecodeArrayToMesh(data, data.byteLength, mesh);
    if (!status.ok()) throw fail(status.error_msg() || 'the stream does not decode to a mesh');
    const points = mesh.num_points();
    const attributes: Record<string, ModelAttribute> = {};
    for (const [semantic, accessorIndex] of Object.entries(semantics)) {
      const id = draco.attributes[semantic];
      if (id === undefined) continue;
      const accessor = doc.accessors[accessorIndex];
      if (!accessor) throw fail(`${semantic} has no accessor`);
      if (accessor.count !== points) throw fail(`${semantic}: ${points} points decoded, ${accessor.count} declared`);
      const attribute = decoder.GetAttributeByUniqueId(mesh, id);
      const size = ELEMENT_SIZES[accessor.type];
      if (attribute.num_components() !== size) throw fail(`${semantic}: component count differs from the accessor`);
      const array = newArray(accessor.componentType, points * size);
      const ok = fromHeap(
        module,
        array.byteLength,
        (pointer) =>
          decoder.GetAttributeDataArrayForAllPoints(
            mesh,
            attribute,
            dataType(module, accessor.componentType),
            array.byteLength,
            pointer,
          ),
        new Uint8Array(array.buffer),
      );
      if (!ok) throw fail(`${semantic} did not decode`);
      attributes[semantic] = { array, itemSize: size, normalized: accessor.normalized };
    }
    const indices = decodeTriangles(module, decoder, mesh, declaredCount(doc, indicesAccessor), fail);
    return { attributes, indices };
  } finally {
    module.destroy(mesh);
    module.destroy(decoder);
  }
}
