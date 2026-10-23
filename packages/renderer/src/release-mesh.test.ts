import { BufferGeometry, Mesh, MeshBasicNodeMaterial, Scene } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { releaseMesh } from './release-mesh.js';

describe('releaseMesh (KB-116)', () => {
  it('removes the mesh, frees its geometry and announces its disposal while its shared material lives on', () => {
    const scene = new Scene();
    const material = new MeshBasicNodeMaterial();
    const mesh = new Mesh(new BufferGeometry(), material);
    scene.add(mesh);
    const events: string[] = [];
    mesh.geometry.addEventListener('dispose', () => events.push('geometry'));
    (mesh as unknown as { addEventListener(type: 'dispose', listener: () => void): void }).addEventListener(
      'dispose',
      () => events.push('mesh'),
    );
    material.addEventListener('dispose', () => events.push('material'));
    releaseMesh(scene, mesh);
    expect(scene.children).not.toContain(mesh);
    expect(events).toEqual(['geometry', 'mesh']);
  });
});
