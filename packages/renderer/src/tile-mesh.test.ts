import { buildTileMesh } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { createTileMesh } from './tile-mesh.js';

describe('createTileMesh (F052)', () => {
  it('disables automatic matrix updates and frustum culling, and starts hidden', () => {
    const data = buildTileMesh(3, 0, 0, 0.01, 0.01, 1);
    const mesh = createTileMesh(data, undefined);
    expect(mesh.matrixAutoUpdate).toBe(false);
    expect(mesh.matrixWorldAutoUpdate).toBe(false);
    expect(mesh.frustumCulled).toBe(false);
    expect(mesh.visible).toBe(false);
    expect(mesh.matrixWorld.equals(mesh.matrixWorld.clone().identity())).toBe(true);
    expect(mesh.geometry.getAttribute('position').array).toBe(data.positions);
    expect(mesh.geometry.getIndex()?.array).toBe(data.indices);
  });
});
