// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Mesh, Scene } from 'three/webgpu';

/**
 * Removes a mesh from the scene and frees it: its geometry, and the renderer's per-object state (render object,
 * bindings, pipeline entry), which three.js keeps until the mesh or its material is disposed. A mesh sharing a
 * long-lived material must therefore announce its own disposal, or every removed mesh stays reachable (KB-116).
 */
export function releaseMesh(scene: Scene, mesh: Mesh): void {
  scene.remove(mesh);
  mesh.geometry.dispose();
  (mesh as unknown as { dispatchEvent(event: { type: 'dispose' }): void }).dispatchEvent({ type: 'dispose' });
}
