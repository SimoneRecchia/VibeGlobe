import { describe, expect, it } from 'vitest';
import type { HeightGrid } from './heightmap.js';
import { sampleHeight } from './sample-height.js';

const grid = (cells: number, heights: number[]): HeightGrid => ({
  cells,
  heightsMeters: Float32Array.from(heights),
  minMeters: Math.min(...heights),
  maxMeters: Math.max(...heights),
});

describe('sampleHeight', () => {
  it('returns the vertex heights at the vertices and is linear inside each triangle', () => {
    // One cell: NW 0, NE 10, SW 20, SE 40.
    const g = grid(1, [0, 10, 20, 40]);
    expect([sampleHeight(g, 0, 0), sampleHeight(g, 1, 0), sampleHeight(g, 0, 1), sampleHeight(g, 1, 1)]).toEqual([
      0, 10, 20, 40,
    ]);
    // On the diagonal both triangles agree: halfway from NW (0) to SE (40).
    expect(sampleHeight(g, 0.5, 0.5)).toBe(20);
    // North-east triangle (NW, NE, SE): at u 0.75, v 0.25.
    expect(sampleHeight(g, 0.75, 0.25)).toBeCloseTo(0 + 10 * 0.75 + 30 * 0.25, 9);
    // South-west triangle (NW, SW, SE): at u 0.25, v 0.75.
    expect(sampleHeight(g, 0.25, 0.75)).toBeCloseTo(0 + 20 * 0.25 + 20 * 0.75, 9);
    // Clamped outside the tile.
    expect(sampleHeight(g, 2, -1)).toBe(10);
  });

  it('reproduces a coarse grid exactly on a nested finer grid built from it (ADR 0006 §4)', () => {
    const coarse = grid(1, [0, 10, 20, 40]);
    const fine: number[] = [];
    for (let r = 0; r <= 4; r++) for (let c = 0; c <= 4; c++) fine.push(sampleHeight(coarse, c / 4, r / 4));
    const nested = grid(4, fine);
    for (const [u, v] of [
      [0.1, 0.2],
      [0.37, 0.81],
      [0.9, 0.05],
      [0.5, 0.5],
    ] as const)
      expect(sampleHeight(nested, u, v)).toBeCloseTo(sampleHeight(coarse, u, v), 4);
  });
});
