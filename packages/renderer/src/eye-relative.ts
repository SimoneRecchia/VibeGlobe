import type { DepthPath } from '@vibeglobe/core';
import {
  cameraNear,
  cameraProjectionMatrix,
  cameraViewMatrix,
  modelWorldMatrix,
  positionGeometry,
  transpose,
  varying,
  vec4,
} from 'three/tsl';
import { GreaterEqualDepth, type Node, type NodeMaterial, type Object3D } from 'three/webgpu';
import { splitEyeOffset } from './eye-offset.js';

const high = new Float32Array(3);
const low = new Float32Array(3);

/**
 * Writes this frame's split offset T = origin − eye (ADR 0004 §3) into a mesh's world matrix, which three.js uploads
 * per object and the engine's vertex node reads: T_hi in the translation (elements 12–14) and T_lo in the bottom row
 * (elements 3, 7 and 11), which an affine matrix leaves unused. Both are float32 values, so the upload keeps them
 * exactly. The rest of the matrix stays the identity; three.js never recomputes it. Array stores keep the doubles
 * unboxed, unlike object fields or call arguments (ADR 0018).
 */
export function placeEyeRelative(mesh: Object3D, origin: Float64Array, eye: Float64Array): void {
  splitEyeOffset(origin, eye, high, low);
  const elements = mesh.matrixWorld.elements;
  elements[12] = high[0] ?? 0;
  elements[13] = high[1] ?? 0;
  elements[14] = high[2] ?? 0;
  elements[3] = low[0] ?? 0;
  elements[7] = low[1] ?? 0;
  elements[11] = low[2] ?? 0;
}

/**
 * Makes a material place its vertices (`offset` from the mesh's origin, the geometry's positions by default)
 * eye-relative: (offset + T_hi) + T_lo, then the rotation-only view and the
 * projection, all in float32 on the GPU. The first sum is exact where the vertex is near the eye, so a vertex keeps
 * float32 precision relative to its own distance from the eye (0.01 px at 4K, `eye-offset.test.ts`).
 *
 * On the 'fragment' depth path (WebGL2 without `EXT_clip_control`, ADR 0005 §4) the material also writes depth
 * near / d, with d the view-space distance interpolated perspective-correctly, and keeps the nearest fragment with a
 * greater-equal test: the same stored value as the hardware reversed-Z path.
 */
export function makeEyeRelative(
  material: NodeMaterial,
  depthPath: DepthPath,
  offset: Node<'vec3'> = positionGeometry,
): void {
  const viewPosition = eyeRelativeViewPosition(offset);
  material.vertexNode = cameraProjectionMatrix.mul(viewPosition);
  if (depthPath === 'fragment') {
    material.depthNode = cameraNear.div(varying(viewPosition.z.negate()));
    material.depthFunc = GreaterEqualDepth;
  }
}

/** A vertex offset from the mesh's origin, relative to the eye: (offset + T_hi) + T_lo, each sum in float32. */
export function eyeRelativePosition(offset: Node<'vec3'>): Node<'vec3'> {
  // The translation column, and the bottom row (the translation column of the transpose).
  const eyeHigh = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
  const eyeLow = transpose(modelWorldMatrix).mul(vec4(0, 0, 0, 1)).xyz;
  return offset.add(eyeHigh).add(eyeLow);
}

/** The view-space position of a vertex offset from the mesh's origin: the rotation-only view of the eye-relative one. */
export function eyeRelativeViewPosition(offset: Node<'vec3'>): Node<'vec4'> {
  return cameraViewMatrix.mul(vec4(eyeRelativePosition(offset), 1));
}
