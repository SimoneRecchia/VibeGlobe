import type { AttributeArray, ModelAttribute } from './description.js';
import {
  COMPONENT_BYTES,
  ELEMENT_SIZES,
  type ComponentType,
  type GltfAccessor,
  type GltfDocument,
  type GltfSparse,
} from './document.js';
import { ModelError } from './errors.js';

type ArrayConstructor = new (length: number) => AttributeArray;

const ARRAYS: Readonly<Record<ComponentType, ArrayConstructor>> = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

/** A new typed array of a component type. */
export function newArray(type: ComponentType, length: number): AttributeArray {
  return new ARRAYS[type](length);
}

function readComponent(view: DataView, offset: number, type: ComponentType): number {
  switch (type) {
    case 5120:
      return view.getInt8(offset);
    case 5121:
      return view.getUint8(offset);
    case 5122:
      return view.getInt16(offset, true);
    case 5123:
      return view.getUint16(offset, true);
    case 5125:
      return view.getUint32(offset, true);
    case 5126:
      return view.getFloat32(offset, true);
  }
}

/** Copies `count` elements of `size` components from (possibly interleaved) bytes into a packed array. */
function copyElements(
  bytes: Uint8Array,
  byteOffset: number,
  stride: number,
  type: ComponentType,
  size: number,
  count: number,
  target: AttributeArray,
  targetStart = 0,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const componentBytes = COMPONENT_BYTES[type];
  for (let i = 0; i < count; i++)
    for (let c = 0; c < size; c++)
      target[(targetStart + i) * size + c] = readComponent(view, byteOffset + i * stride + c * componentBytes, type);
}

/** Applies an accessor's sparse substitution to its packed array. */
function applySparse(
  accessor: GltfAccessor,
  index: number,
  array: AttributeArray,
  viewBytes: (view: number) => Uint8Array,
): void {
  const sparse = accessor.sparse as GltfSparse;
  const size = ELEMENT_SIZES[accessor.type];
  const elementBytes = size * COMPONENT_BYTES[accessor.componentType];
  const indexType = sparse.indices.componentType;
  const indexBytes = viewBytes(sparse.indices.bufferView);
  const valueBytes = viewBytes(sparse.values.bufferView);
  if (sparse.indices.byteOffset + sparse.count * COMPONENT_BYTES[indexType] > indexBytes.byteLength)
    throw new ModelError('invalid-gltf', `accessors[${index}].sparse.indices run past their buffer view`);
  if (sparse.values.byteOffset + sparse.count * elementBytes > valueBytes.byteLength)
    throw new ModelError('invalid-gltf', `accessors[${index}].sparse.values run past their buffer view`);
  const indices = newArray(indexType, sparse.count);
  copyElements(indexBytes, sparse.indices.byteOffset, COMPONENT_BYTES[indexType], indexType, 1, sparse.count, indices);
  const values = newArray(accessor.componentType, sparse.count * size);
  copyElements(valueBytes, sparse.values.byteOffset, elementBytes, accessor.componentType, size, sparse.count, values);
  for (let i = 0; i < sparse.count; i++) {
    const target = indices[i] ?? 0;
    if (target >= accessor.count)
      throw new ModelError('invalid-gltf', `accessors[${index}].sparse index ${target} out of range`);
    for (let c = 0; c < size; c++) array[target * size + c] = values[i * size + c] ?? 0;
  }
}

/**
 * Reads an accessor into a tightly packed typed array that owns its buffer: de-interleaves strided views, starts
 * from zeros when there is no buffer view, then applies sparse substitution. `viewBytes(i)` returns buffer view i's
 * bytes (already meshopt-decoded). Only SCALAR and VEC2–VEC4 are read (vertex attributes and indices).
 */
export function readAccessor(
  doc: GltfDocument,
  index: number,
  viewBytes: (view: number) => Uint8Array,
): ModelAttribute {
  const accessor = doc.accessors[index] as GltfAccessor;
  const size = ELEMENT_SIZES[accessor.type];
  if (size > 4)
    throw new ModelError('unsupported', `accessor ${index}: ${accessor.type} is not a vertex attribute type`);
  const array = newArray(accessor.componentType, accessor.count * size);
  const elementBytes = size * COMPONENT_BYTES[accessor.componentType];
  if (accessor.bufferView !== undefined) {
    const stride = doc.bufferViews[accessor.bufferView]?.byteStride ?? elementBytes;
    copyElements(
      viewBytes(accessor.bufferView),
      accessor.byteOffset,
      stride,
      accessor.componentType,
      size,
      accessor.count,
      array,
    );
  }
  if (accessor.sparse) applySparse(accessor, index, array, viewBytes);
  return { array, itemSize: size, normalized: accessor.normalized };
}

/** The value an integer component stands for when normalized (glTF 2.0 §3.11), else the value itself. */
export function componentValue(value: number, array: AttributeArray, normalized: boolean): number {
  if (!normalized || array instanceof Float32Array) return value;
  if (array instanceof Int8Array) return Math.max(value / 127, -1);
  if (array instanceof Uint8Array) return value / 255;
  if (array instanceof Int16Array) return Math.max(value / 32767, -1);
  if (array instanceof Uint16Array) return value / 65535;
  return value / 4294967295;
}

/** Axis-aligned bounds of a POSITION attribute (normalized components mapped to their values). */
export function positionBounds(position: ModelAttribute): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const { array, itemSize, normalized } = position;
  for (let i = 0; i + itemSize <= array.length; i += itemSize)
    for (let c = 0; c < 3; c++) {
      const v = componentValue(array[i + c] ?? 0, array, normalized);
      if (v < (min[c] ?? 0)) min[c] = v;
      if (v > (max[c] ?? 0)) max[c] = v;
    }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}
