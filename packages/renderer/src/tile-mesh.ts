import type { TileMeshData } from '@vibeglobe/core';
import { BufferAttribute, BufferGeometry, Mesh, type Material } from 'three/webgpu';

/**
 * Creates the three.js mesh of a surface tile. The engine owns placement and culling (ADR 0004, ADR 0010): the mesh
 * is placed eye-relative by its material and keeps an identity matrix that three.js never recomputes, is never frustum-culled by three.js, and starts hidden until
 * a frame selects it.
 */
export function createTileMesh(data: TileMeshData, material: Material | undefined): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('tileUv', new BufferAttribute(data.uvs, 3));
  geometry.setAttribute('tileNormal', new BufferAttribute(data.normals, 3));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  const mesh = new Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}
