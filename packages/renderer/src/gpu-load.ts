// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { RenderExtension, RenderExtensionContext } from '@vibeglobe/core';
import type { BufferGeometry, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import type { ThreeExtensionContext } from './extensions.js';

/** The shared triangle and material of the load passes. */
interface LoadParts {
  readonly geometry: BufferGeometry;
  readonly material: MeshBasicNodeMaterial;
  readonly mesh: () => Mesh;
}

/** Builds the parts, importing three.js only now: nothing may touch the browser at import time (SSR test). */
async function loadParts(): Promise<LoadParts> {
  const [three, tsl] = await Promise.all([import('three/webgpu'), import('three/tsl')]);
  const geometry = new three.BufferGeometry();
  geometry.setAttribute('position', new three.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const material = new three.MeshBasicNodeMaterial();
  // The triangle's vertices are already in normalized device coordinates.
  material.vertexNode = tsl.vec4(tsl.positionGeometry.xy, 0, 1);
  material.colorNode = tsl.vec4(0, 0, 0, 1 / 255);
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  return { geometry, material, mesh: () => new three.Mesh(geometry, material) };
}

/**
 * A debug render extension that loads the GPU (F401: "inject an artificial GPU load"): `passes()` full-screen
 * triangles drawn over the frame, each blended at an opacity of 1/255 in black, so the picture barely changes while
 * the fill cost grows with the number of passes and the drawing buffer's pixels (which the resolution scale relieves).
 * For tests and the playground's `?gpuLoad=`; `passes()` is read every frame, so the load changes at runtime. The
 * passes start once three.js is loaded, a frame or two after the extension is added.
 */
export function gpuLoad(passes: () => number): (context: RenderExtensionContext) => RenderExtension {
  return (context) => {
    const { scene } = context.renderer as ThreeExtensionContext;
    const meshes: Mesh[] = [];
    let parts: LoadParts | undefined;
    let disposed = false;
    void loadParts().then((loaded) => {
      if (disposed) {
        loaded.geometry.dispose();
        loaded.material.dispose();
      } else parts = loaded;
    });
    return {
      frame() {
        if (!parts) return;
        const count = Math.max(0, Math.floor(passes()));
        while (meshes.length < count) {
          const mesh = parts.mesh();
          mesh.frustumCulled = false;
          mesh.renderOrder = 1_000_000;
          meshes.push(mesh);
          scene.add(mesh);
        }
        meshes.forEach((mesh, i) => (mesh.visible = i < count));
      },
      dispose() {
        disposed = true;
        for (const mesh of meshes) scene.remove(mesh);
        parts?.geometry.dispose();
        parts?.material.dispose();
      },
    };
  };
}
