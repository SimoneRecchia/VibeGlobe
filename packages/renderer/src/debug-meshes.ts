// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { DebugMeshData, DepthPath, TileMeshData } from '@vibeglobe/core';
import { positionLocal, sin, vec3 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, type Scene } from 'three/webgpu';
import { makeEyeRelative, placeEyeRelative } from './eye-relative.js';
import { releaseMesh } from './release-mesh.js';

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
export function createDebugEntry(data: DebugMeshData, depthPath: DepthPath): DebugEntry {
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
  makeEyeRelative(material, depthPath);
  material.side = DoubleSide;
  const mesh = new Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.frustumCulled = false;
  return { data, mesh };
}

/** Places the debug meshes eye-relative for a frame (ADR 0004). */
export function placeDebugEntries(entries: readonly DebugEntry[], eye: Float64Array): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) placeEyeRelative(entry.mesh, entry.data.originEcef, eye);
  }
}

/** Removes debug meshes from the scene and releases their geometry and materials. */
export function disposeDebugEntries(scene: Scene, entries: readonly DebugEntry[]): void {
  for (const entry of entries) {
    releaseMesh(scene, entry.mesh);
    (entry.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}

/** Bytes of vertex data held for surface tiles and debug quads, for the resource counters. */
export function meshBytes(
  tiles: { forEach(visit: (entry: { readonly data: TileMeshData }) => void): void },
  debugEntries: readonly DebugEntry[],
): number {
  let bytes = 0;
  tiles.forEach((entry) => (bytes += entry.data.byteLength + entry.data.indices.byteLength));
  for (const entry of debugEntries) bytes += entry.data.positions.byteLength;
  return bytes;
}
