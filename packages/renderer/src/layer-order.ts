// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Object3D } from 'three/webgpu';

/**
 * Puts the layer meshes among `children` in their draw order (`renderOrder`, ties as they are), each in a slot a layer
 * mesh held, so other objects keep their places: the engine draws without sorting, in scene order, so a layer's
 * order is its place among the scene's children.
 */
export function orderLayerMeshes(
  children: Object3D[],
  layers: Iterable<{ readonly mesh?: Object3D | undefined }>,
): void {
  const layerMeshes = new Set<Object3D | undefined>();
  for (const layer of layers) layerMeshes.add(layer.mesh);
  const slots: number[] = [];
  const meshes: Object3D[] = [];
  children.forEach((child, slot) => {
    if (!layerMeshes.has(child)) return;
    slots.push(slot);
    meshes.push(child);
  });
  meshes.sort((a, b) => a.renderOrder - b.renderOrder);
  slots.forEach((slot, i) => (children[slot] = meshes[i] as Object3D));
}
