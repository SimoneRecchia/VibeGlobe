import { describe, expect, it } from 'vitest';
import { buildTileMesh, tileIndices, TILE_SEGMENTS } from './surface-mesh.js';

const DEG = Math.PI / 180;

describe('buildTileMesh', () => {
  it('stores small float32 offsets from a float64 origin, with skirts and shared indices', () => {
    const mesh = buildTileMesh(7, 0, 40 * DEG, 0.001, 40 * DEG + 0.001, 1);
    const vertices = (TILE_SEGMENTS + 1) ** 2 + 4 * (TILE_SEGMENTS + 1);
    expect(mesh.positions.length).toBe(vertices * 3);
    expect(Math.max(...mesh.positions.map(Math.abs))).toBeLessThan(10000);
    expect(mesh.indices).toBe(tileIndices());
    expect(Math.max(...mesh.indices)).toBe(vertices - 1);
    expect(mesh.uvs.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});
