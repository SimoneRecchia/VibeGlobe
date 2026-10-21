import type { DebugMeshData } from '@vibeglobe/core';
import { positionLocal, sin, vec3 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';

/** A drawn debug quad. */
export interface DebugEntry {
  readonly data: DebugMeshData;
  readonly mesh: Mesh;
}

/**
 * Builds a debug quad on the same precision path as the surface (ADR 0004): float32 offsets from a float64 origin,
 * placed eye-relative each frame. A smooth checker-like pattern, when requested, is computed from the interpolated local
 * position, so it is fixed to the ground and moves only if the geometry does. A sum of sines (period twice the cell
 * size) keeps sub-pixel motion measurable, which hard checker edges inside a triangle (never anti-aliased) are not.
 */
export function createDebugEntry(data: DebugMeshData): DebugEntry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const material = new MeshBasicNodeMaterial();
  const color = vec3(...data.colorRgb);
  if (data.checkerMeters > 0) {
    const phase = positionLocal.mul(Math.PI / data.checkerMeters);
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
  return { data, mesh };
}
