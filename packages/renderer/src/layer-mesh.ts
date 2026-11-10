// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute } from 'three/webgpu';
import { stableRanges } from './layer-changes.hot.js';
import type { LayerArrays } from './layer-geometry.js';

/** The vertex attributes of a quad batch, their components and the arrays they are built over. */
export const QUAD_ATTRIBUTES = [
  ['position', 3, 'positions'],
  ['tileNormal', 3, 'normals'],
  ['tilePlane', 4, 'planes'],
  ['layerHeight', 1, 'heights'],
  ['layerColor', 4, 'colors'],
  ['layerCorner', 4, 'corners'],
  ['layerUv', 4, 'uvs'],
] as const;
/** The index of the heights in {@link QUAD_ATTRIBUTES}. */
export const HEIGHT = 3;
/** The index of the colors in {@link QUAD_ATTRIBUTES}. */
export const COLOR = 4;

/** The geometry of a layer mesh over its vertex arrays; only `quad` batches have atlas coordinates, the last. */
export function layerGeometry(arrays: LayerArrays, quad: boolean): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, size, values] of QUAD_ATTRIBUTES.slice(0, quad ? 7 : 6))
    geometry.setAttribute(name, new BufferAttribute(arrays[values], size));
  if (arrays.other) setOtherEndpoint(geometry, arrays.other);
  geometry.setIndex(new BufferAttribute(arrays.indices, 1));
  return geometry;
}

/**
 * Uploads vertices [first, end) of one of a geometry's {@link QUAD_ATTRIBUTES}: as `addUpdateRange`, with range objects
 * of the batch's `pools`, into a list three.js empties without dropping its storage (F378).
 */
export function uploadRange(
  pools: UpdateRange[][],
  geometry: BufferGeometry,
  index: number,
  first: number,
  end: number,
): void {
  const [name, size] = QUAD_ATTRIBUTES[index] ?? ['', 0];
  const attribute = geometry.getAttribute(name) as BufferAttribute;
  const ranges = stableRanges(attribute);
  const pool = pools[index] ?? [];
  const range = pool[ranges.length] ?? { start: 0, count: 0 };
  if (pool[ranges.length] === undefined) pool.push(range);
  range.start = first * size;
  range.count = (end - first) * size;
  ranges[ranges.length++] = range;
  attribute.needsUpdate = true;
}

/** Values a vertex of a line's other endpoint: position, normal, plane and, last, height. */
const OTHER_STRIDE = 11;

/**
 * Uploads the heights of a line's other endpoints again, after its own were taken from newer terrain (KB-349): the
 * other end of vertex `v` is vertex `v ^ 2` of the same piece.
 */
export function uploadOtherHeights(geometry: BufferGeometry, { other, heights }: LayerArrays): void {
  if (!other) return;
  for (let v = 0; v < heights.length; v++) other[v * OTHER_STRIDE + 10] = heights[v ^ 2] ?? 0;
  (geometry.getAttribute('otherHeight') as InterleavedBufferAttribute).data.needsUpdate = true;
}

/**
 * The other endpoint of each line vertex's segment, interleaved in one vertex buffer: WebGPU allows 8 per pipeline, and
 * a line vertex has 10 attributes.
 */
function setOtherEndpoint(geometry: BufferGeometry, other: Float32Array): void {
  const buffer = new InterleavedBuffer(other, OTHER_STRIDE);
  geometry.setAttribute('otherPosition', new InterleavedBufferAttribute(buffer, 3, 0));
  geometry.setAttribute('otherNormal', new InterleavedBufferAttribute(buffer, 3, 3));
  geometry.setAttribute('otherPlane', new InterleavedBufferAttribute(buffer, 4, 6));
  geometry.setAttribute('otherHeight', new InterleavedBufferAttribute(buffer, 1, 10));
}

/** A range of a buffer attribute's components to upload, as three.js keeps them. */
export interface UpdateRange {
  start: number;
  count: number;
}
