import { Mesh, Scene } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { orderLayerMeshes } from './layer-order.js';

describe('orderLayerMeshes', () => {
  it('draws layers in their order whatever order their meshes were built in, other objects keeping their places', () => {
    const scene = new Scene();
    const tile = new Mesh();
    const [a, b, c] = [new Mesh(), new Mesh(), new Mesh()];
    a.renderOrder = 1002;
    b.renderOrder = 1000;
    c.renderOrder = 1001;
    scene.add(a, tile, b, c);
    orderLayerMeshes(scene.children, [{ mesh: a }, { mesh: b }, { mesh: c }, {}]);
    expect(scene.children).toEqual([b, tile, c, a]);
  });
});
