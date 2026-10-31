import { BufferGeometry, Group, Mesh, MeshBasicNodeMaterial, Scene } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { ThreeExtensionContext } from '../extensions.js';
import { ThreeVectorTarget, type VectorMeshData } from './vector-target.js';

const f32 = (n: number): Float32Array => new Float32Array(n);

describe('ThreeVectorTarget', () => {
  it("draws under the application's data layers already in the scene, since the engine draws in scene order (KB-284)", () => {
    const scene = new Scene();
    const surface = new Mesh(new BufferGeometry(), new MeshBasicNodeMaterial());
    const dataLayer = new Mesh(new BufferGeometry(), new MeshBasicNodeMaterial());
    dataLayer.renderOrder = 1000;
    scene.add(surface, dataLayer);
    new ThreeVectorTarget({ scene, depthPath: () => 'reversed-z' } as unknown as ThreeExtensionContext);
    expect(scene.children[0]).toBe(surface);
    expect(scene.children[1]).toBeInstanceOf(Group);
    expect(scene.children[2]).toBe(dataLayer);
  });

  it("announces each released draw object's disposal, so meshes sharing a material are freed (KB-116)", () => {
    const context = { scene: new Scene(), depthPath: () => 'reversed-z' } as unknown as ThreeExtensionContext;
    const target = new ThreeVectorTarget(context);
    const data: VectorMeshData = {
      kind: 'fill',
      originEcef: new Float64Array(3),
      planeCenter: new Float64Array(3),
      positions: f32(9),
      normals: f32(9),
      planes: f32(12),
      tile: f32(6),
      indices: Uint32Array.of(0, 1, 2),
      colorA: f32(12),
      colorB: f32(12),
      paramsA: f32(12),
      paramsB: f32(12),
      ground: f32(3),
    };
    const mesh = target.createMesh(data);
    // A draw object as `draw` makes them: the mesh's geometry with the layer kind's shared material.
    const object = new Mesh(new BufferGeometry(), new MeshBasicNodeMaterial());
    (mesh as unknown as { objects: Mesh[] }).objects.push(object);
    const disposed: string[] = [];
    (object as unknown as { addEventListener(type: 'dispose', listener: () => void): void }).addEventListener(
      'dispose',
      () => disposed.push('object'),
    );
    mesh.dispose();
    expect(disposed).toEqual(['object']);
    target.dispose();
  });
});
