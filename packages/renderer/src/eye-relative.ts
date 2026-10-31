// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { DepthPath, FrameView, TileMeshData } from '@vibeglobe/core';
import {
  cameraNear,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  modelWorldMatrix,
  positionGeometry,
  transpose,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { GreaterEqualDepth, type Node, type NodeMaterial, type Object3D } from 'three/webgpu';
import { splitEyeOffset } from './eye-offset.js';

/**
 * 1, as a uniform: the first sum of each split offset is multiplied by it before the second is added. Its value is
 * unknown when the shader compiles, so a compiler that reassociates float additions (Apple's Metal compiler does,
 * KB-175) cannot regroup (a + T_hi) + T_lo into a + (T_hi + T_lo), which rounds T_lo away (ADR 0004 §3).
 */
const ORDER = uniform(1);

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
 * The diagonal of the rotation part of a surface mesh's world matrix. three.js picks a mesh's front-face winding from
 * the sign of its world matrix's determinant, and on WebGPU the winding is part of the pipeline: a large diagonal keeps
 * the determinant positive whatever the offsets stored beside it (one pipeline for every tile, ADR 0010 §4).
 */
const DIAGONAL = 1e30;

/**
 * Writes this frame's split offset of a tile's plane center from the eye (ADR 0008) into the mesh's world matrix,
 * beside {@link placeEyeRelative}'s: the high part in elements 1, 2 and 4, the low part in elements 6, 8 and 9 (the
 * rotation part, which the engine's vertex node does not use as a rotation), with {@link DIAGONAL} on its diagonal.
 */
function placePlaneEyeRelative(mesh: Object3D, planeCenter: Float64Array, eye: Float64Array): void {
  splitEyeOffset(planeCenter, eye, high, low);
  const elements = mesh.matrixWorld.elements;
  elements[0] = DIAGONAL;
  elements[5] = DIAGONAL;
  elements[10] = DIAGONAL;
  elements[1] = high[0] ?? 0;
  elements[2] = high[1] ?? 0;
  elements[4] = high[2] ?? 0;
  elements[6] = low[0] ?? 0;
  elements[8] = low[1] ?? 0;
  elements[9] = low[2] ?? 0;
}

/** A tile's plane center this frame, ECEF meters (ADR 0008). */
const planeCenter = new Float64Array(3);

/** Places a surface tile for a frame: its globe origin and its plane center, both relative to the eye. */
export function placeTile(
  mesh: Object3D,
  data: Pick<TileMeshData, 'originEcef' | 'planeCenter'>,
  view: FrameView,
): void {
  placeEyeRelative(mesh, data.originEcef, view.eyeEcef);
  view.morph.tilePlaneCenterInto(data.planeCenter, planeCenter);
  placePlaneEyeRelative(mesh, planeCenter, view.eyeEcef);
}

/**
 * On the 'fragment' depth path (WebGL2 without `EXT_clip_control`, ADR 0005 §4), makes a material write depth near / d,
 * with d the view-space distance interpolated perspective-correctly, and keep the nearest fragment with a
 * greater-equal test: the same stored value as the hardware reversed-Z path. Nothing on the reversed-Z path.
 */
export function writeFragmentDepth(material: NodeMaterial, depthPath: DepthPath, viewPosition: Node<'vec4'>): void {
  if (depthPath !== 'fragment') return;
  material.depthNode = cameraNear.div(varying(viewPosition.z.negate()));
  material.depthFunc = GreaterEqualDepth;
}

/**
 * Makes a material place its vertices between the globe and the flat map (ADR 0008): each endpoint eye-relative as
 * in {@link makeEyeRelative}, the globe one from the mesh's origin and the plane one from its plane center, mixed as
 * (1 − m)·globe + m·plane, written out (never `mix`).
 */
export function makeMorphedEyeRelative(
  material: NodeMaterial,
  depthPath: DepthPath,
  globeOffset: Node<'vec3'>,
  planeOffset: Node<'vec3'>,
  morph: Node<'float'>,
): Node<'vec3'> {
  const eyeRelative = morphedEyeRelative(globeOffset, planeOffset, morph);
  const viewPosition = cameraViewMatrix.mul(vec4(eyeRelative, 1));
  material.vertexNode = cameraProjectionMatrix.mul(viewPosition);
  writeFragmentDepth(material, depthPath, viewPosition);
  return eyeRelative;
}

/**
 * A vertex's position relative to the eye between the globe and the flat map (ADR 0008): the globe endpoint from the
 * mesh's origin and the plane endpoint from its plane center (both placed by {@link placeTile}), mixed as
 * (1 − m)·globe + m·plane, written out (never `mix`).
 */
export function morphedEyeRelative(
  globeOffset: Node<'vec3'>,
  planeOffset: Node<'vec3'>,
  morph: Node<'float'>,
): Node<'vec3'> {
  const column0 = modelWorldMatrix.mul(vec4(1, 0, 0, 0));
  const column1 = modelWorldMatrix.mul(vec4(0, 1, 0, 0));
  const column2 = modelWorldMatrix.mul(vec4(0, 0, 1, 0));
  const planeHigh = vec3(column0.y, column0.z, column1.x);
  const planeLow = vec3(column1.z, column2.x, column2.y);
  const globe = eyeRelativePosition(globeOffset);
  const plane = planeOffset.add(planeHigh).mul(ORDER).add(planeLow);
  return globe.mul(float(1).sub(morph)).add(plane.mul(morph));
}

/**
 * Makes a material place its vertices (`offset` from the mesh's origin, the geometry's positions by default)
 * eye-relative: (offset + T_hi) + T_lo, then the rotation-only view and the
 * projection, all in float32 on the GPU. The first sum is exact where the vertex is near the eye, so a vertex keeps
 * float32 precision relative to its own distance from the eye (0.01 px at 4K, `eye-offset.test.ts`).
 * On the 'fragment' depth path the material also writes its depth ({@link writeFragmentDepth}).
 */
export function makeEyeRelative(
  material: NodeMaterial,
  depthPath: DepthPath,
  offset: Node<'vec3'> = positionGeometry,
): void {
  const viewPosition = eyeRelativeViewPosition(offset);
  material.vertexNode = cameraProjectionMatrix.mul(viewPosition);
  writeFragmentDepth(material, depthPath, viewPosition);
}

/**
 * A vertex offset from the mesh's origin, relative to the eye: (offset + T_hi) + T_lo, each sum in float32, the first
 * held apart from the second by {@link ORDER}.
 */
export function eyeRelativePosition(offset: Node<'vec3'>): Node<'vec3'> {
  // The translation column, and the bottom row (the translation column of the transpose).
  const eyeHigh = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
  const eyeLow = transpose(modelWorldMatrix).mul(vec4(0, 0, 0, 1)).xyz;
  return offset.add(eyeHigh).mul(ORDER).add(eyeLow);
}

/** The view-space position of a vertex offset from the mesh's origin: the rotation-only view of the eye-relative one. */
export function eyeRelativeViewPosition(offset: Node<'vec3'>): Node<'vec4'> {
  return cameraViewMatrix.mul(vec4(eyeRelativePosition(offset), 1));
}
