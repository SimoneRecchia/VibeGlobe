import { describe, expect, it } from 'vitest';
import type { RendererBackend } from '../globe/types.js';
import type { TileMeshData } from './surface-mesh.js';
import { SurfaceCache } from './surface-cache.js';
import { MERCATOR_ROOT, quadtreeTileBounds, type QuadtreeTile } from './surface-quadtree.hot.js';
import { TILE_SEGMENTS } from './surface-mesh.js';

/** The deepest and the farthest out a mesh's skirt vertices go from their edge vertices, meters. */
function skirtExtent(mesh: TileMeshData): { downMeters: number; outMeters: number } {
  const grid = TILE_SEGMENTS + 1;
  let downMeters = 0;
  let outMeters = 0;
  for (let i = grid * grid; i < mesh.positions.length / 3; i++) {
    const edge =
      Math.round((mesh.uvs[i * 3 + 1] ?? 0) * TILE_SEGMENTS) * grid +
      Math.round((mesh.uvs[i * 3] ?? 0) * TILE_SEGMENTS);
    const d = [0, 1, 2].map((c) => (mesh.positions[i * 3 + c] ?? 0) - (mesh.positions[edge * 3 + c] ?? 0));
    const up = [0, 1, 2].map((c) => mesh.normals[edge * 3 + c] ?? 0);
    const down = -((d[0] ?? 0) * (up[0] ?? 0) + (d[1] ?? 0) * (up[1] ?? 0) + (d[2] ?? 0) * (up[2] ?? 0));
    downMeters = Math.max(downMeters, down);
    outMeters = Math.max(outMeters, Math.sqrt(Math.max(0, Math.hypot(...d) ** 2 - down ** 2)));
  }
  return { downMeters, outMeters };
}

describe('SurfaceCache skirts', () => {
  it('keeps the flat globe’s skirts with terrain: a few meters deep, reaching out four times as far, so they stay under steep slopes and behind draped maps (KB-178, KB-302)', () => {
    const meshes: TileMeshData[] = [];
    const renderer = { addMesh: (mesh: TileMeshData) => meshes.push(mesh) } as unknown as RendererBackend;
    const tile = quadtreeTileBounds(MERCATOR_ROOT, 12, 2125, 1460, 1, {} as QuadtreeTile);
    new SurfaceCache(renderer).prepare([tile], 1, new Float64Array(1));
    const [skirt] = meshes.map(skirtExtent);
    // Twice the terrain error deep (200 m here before), they stood in front of the vector maps draped along the edges.
    expect(skirt?.downMeters).toBeGreaterThan(0.5);
    expect(skirt?.downMeters).toBeLessThan(10);
    // Four times as far out along an edge, √2 times that at a corner.
    expect(skirt?.outMeters).toBeCloseTo(4 * Math.SQRT2 * (skirt?.downMeters ?? NaN), 1);
  });
});
