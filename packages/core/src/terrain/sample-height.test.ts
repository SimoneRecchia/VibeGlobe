import { describe, expect, it } from 'vitest';
import type { HeightGrid } from './heightmap.js';
import { gridRangeInto, MAX_RANGE_SCAN_CELLS, sampleHeight } from './sample-height.js';

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

describe('gridRangeInto', () => {
  it('bounds the surface over part of a grid exactly, and takes the whole range for wide parts (KB-080)', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const cells = 16;
    const g = grid(
      cells,
      Array.from({ length: (cells + 1) ** 2 }, () => Math.round(next() * 4000)),
    );
    const at = new Float64Array(6);
    for (let trial = 0; trial < 200; trial++) {
      const width = (next() * MAX_RANGE_SCAN_CELLS) / cells;
      const height = (next() * MAX_RANGE_SCAN_CELLS) / cells;
      const u0 = next() * (1 - width);
      const v0 = next() * (1 - height);
      at.set([u0, u0 + width, v0, v0 + height]);
      gridRangeInto(g, at);
      // Dense sampling of the part: never outside the range, and reaching both ends of it.
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i <= 200; i++)
        for (let j = 0; j <= 200; j++) {
          const h = sampleHeight(g, u0 + (width * i) / 200, v0 + (height * j) / 200);
          low = Math.min(low, h);
          high = Math.max(high, h);
        }
      expect(low).toBeGreaterThanOrEqual((at[4] ?? 0) - 1e-3);
      expect(high).toBeLessThanOrEqual((at[5] ?? 0) + 1e-3);
      // Tight: within what the sampling can miss, the steepest slope (8,000 m per cell) over one sample step.
      const missMeters = (8000 * Math.max(width, height) * cells) / 200;
      expect(low - (at[4] ?? 0)).toBeLessThanOrEqual(missMeters);
      expect((at[5] ?? 0) - high).toBeLessThanOrEqual(missMeters);
    }
    at.set([0, 1, 0, 1]);
    gridRangeInto(g, at);
    expect([at[4], at[5]]).toEqual([g.minMeters, g.maxMeters]);
  });
});
