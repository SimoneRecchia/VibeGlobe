import type { DebugMeshData } from '@vibeglobe/core';
import { attribute, positionLocal, sin, uniform, vec3 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import { attachEyeOffset, type EyeOffset } from './surface-material.js';

/** A drawn debug quad and its eye-relative offset record. */
export interface DebugEntry {
  readonly data: DebugMeshData;
  readonly mesh: Mesh;
  readonly offset: EyeOffset;
}

/** Uniforms reading each object's eye-relative offset, shared by every debug quad. */
export function eyeOffsetUniforms(read: (part: 'high' | 'low', object: unknown) => Vector3) {
  return {
    high: uniform(new Vector3()).onObjectUpdate(({ object }) => read('high', object)),
    low: uniform(new Vector3()).onObjectUpdate(({ object }) => read('low', object)),
  };
}

/** The offset uniforms' type. */
export type EyeOffsetUniforms = ReturnType<typeof eyeOffsetUniforms>;

/**
 * Builds a debug quad on the same precision path as the surface (ADR 0004): float32 offsets plus per-object
 * eye-relative offsets. A smooth checker-like pattern, when requested, is computed from the interpolated local position,
 * so it is fixed to the ground and moves only if the geometry does.
 */
export function createDebugEntry(data: DebugMeshData, uniforms: EyeOffsetUniforms): DebugEntry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const material = new MeshBasicNodeMaterial();
  material.positionNode = positionLocal.add(uniforms.low).add(uniforms.high);
  const color = vec3(...data.colorRgb);
  if (data.checkerMeters > 0) {
    // The raw vertex attribute, not positionLocal: once positionNode is set, positionLocal is the eye-relative
    // position and a pattern computed from it would move with the camera. A smooth sum of sines (period twice the cell
    // size) keeps sub-pixel motion measurable, which hard checker edges inside a triangle (never anti-aliased) are not.
    const phase = attribute<'vec3'>('position', 'vec3').mul(Math.PI / data.checkerMeters);
    const wave = sin(phase.x).add(sin(phase.y)).add(sin(phase.z));
    material.colorNode = color.mul(wave.mul(0.15).add(0.55));
  } else {
    material.colorNode = color;
  }
  material.side = DoubleSide;
  const mesh = new Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.frustumCulled = false;
  return { data, mesh, offset: attachEyeOffset(mesh) };
}
