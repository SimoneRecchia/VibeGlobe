// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GltfDocument, GltfNode } from './document.js';

/** Column-major 4×4 identity. */
function identity(out = new Float64Array(16)): Float64Array {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** `out = a · b` for column-major 4×4 matrices; `out` may alias neither input. */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): Float64Array {
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  return out;
}

/**
 * A node's local transform: its `matrix`, or T · R · S from translation, rotation (a quaternion, normalized here so a
 * slightly denormalized file still gives a rigid rotation) and scale.
 */
export function nodeMatrix(node: GltfNode, out = new Float64Array(16)): Float64Array {
  if (node.matrix) {
    out.set(node.matrix);
    return out;
  }
  const [tx, ty, tz] = node.translation;
  const [sx, sy, sz] = node.scale;
  let [x, y, z, w] = node.rotation;
  const length = Math.hypot(x, y, z, w) || 1;
  x /= length;
  y /= length;
  z /= length;
  w /= length;
  out[0] = (1 - 2 * (y * y + z * z)) * sx;
  out[1] = 2 * (x * y + z * w) * sx;
  out[2] = 2 * (x * z - y * w) * sx;
  out[3] = 0;
  out[4] = 2 * (x * y - z * w) * sy;
  out[5] = (1 - 2 * (x * x + z * z)) * sy;
  out[6] = 2 * (y * z + x * w) * sy;
  out[7] = 0;
  out[8] = 2 * (x * z + y * w) * sz;
  out[9] = 2 * (y * z - x * w) * sz;
  out[10] = (1 - 2 * (x * x + y * y)) * sz;
  out[11] = 0;
  out[12] = tx;
  out[13] = ty;
  out[14] = tz;
  out[15] = 1;
  return out;
}

/** Transforms a point by a column-major 4×4 matrix (affine), writing into `out`. */
export function transformPoint(m: Float64Array, x: number, y: number, z: number, out: number[]): number[] {
  out[0] = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
  out[1] = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
  out[2] = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
  return out;
}

/** A node that shows a mesh, with its model-space matrix. */
export interface MeshNode {
  readonly node: number;
  readonly mesh: number;
  readonly matrix: Float64Array;
}

/**
 * Walks the shown scene (`scene`, else the first, else every root node) and returns each node with a mesh and its
 * model-space matrix: the product of the local transforms from the root down. The hierarchy is a validated forest.
 */
export function meshNodes(doc: GltfDocument): MeshNode[] {
  let roots: readonly number[];
  const scene = doc.scenes[doc.scene ?? 0];
  if (scene) roots = scene.nodes;
  else {
    const children = new Set<number>();
    for (const node of doc.nodes) for (const child of node.children) children.add(child);
    roots = doc.nodes.map((_, i) => i).filter((i) => !children.has(i));
  }
  const result: MeshNode[] = [];
  const visit = (index: number, parent: Float64Array): void => {
    const node = doc.nodes[index] as GltfNode;
    const world = multiply(parent, nodeMatrix(node), new Float64Array(16));
    if (node.mesh !== undefined) result.push({ node: index, mesh: node.mesh, matrix: world });
    for (const child of node.children) visit(child, world);
  };
  const root = identity();
  for (const index of roots) visit(index, root);
  return result;
}
