import { describe, expect, it } from 'vitest';
import { chooseGrid, gridErrorMeters } from './grid-size.js';

function heights(sizePx: number, f: (u: number, v: number) => number): Float32Array {
  const out = new Float32Array(sizePx * sizePx);
  for (let y = 0; y < sizePx; y++)
    for (let x = 0; x < sizePx; x++) out[y * sizePx + x] = f((x + 0.5) / sizePx, (y + 0.5) / sizePx);
  return out;
}

describe('chooseGrid (F134)', () => {
  it('keeps the coarsest grid for a plane, which every grid represents exactly', () => {
    const plane = heights(64, (u, v) => 100 + 50 * u - 30 * v);
    const { grid, maxErrorMeters } = chooseGrid(plane, 64, 0.5);
    expect(grid.cells).toBe(8);
    expect(maxErrorMeters).toBeLessThan(0.5);
  });

  it('refines until the measured error at every sample is within the bound', () => {
    const hills = heights(256, (u, v) => 400 * Math.sin(6 * u) * Math.cos(5 * v));
    for (const bound of [20, 5, 1]) {
      const { grid, maxErrorMeters } = chooseGrid(hills, 256, bound);
      expect(maxErrorMeters).toBeLessThanOrEqual(bound);
      expect(gridErrorMeters(grid, hills, 256)).toBe(maxErrorMeters);
    }
    expect(chooseGrid(hills, 256, 20).grid.cells).toBeLessThan(chooseGrid(hills, 256, 1).grid.cells);
  });

  it('falls back to the finest grid with its measured error when no grid meets the bound', () => {
    const noise = heights(256, (u, v) => ((Math.floor(u * 256) + Math.floor(v * 256)) % 2 === 0 ? 0 : 100));
    const { grid, maxErrorMeters } = chooseGrid(noise, 256, 1);
    expect(grid.cells).toBe(256);
    expect(maxErrorMeters).toBeGreaterThan(1);
  });

  it('meets the bound on rough relief with a grid finer than 64 cells, never finer than the pixels (F134)', () => {
    // Ridges 16 pixels apart, 200 m high: 64 cells (4 pixels each) miss them by about 22 m, 256 cells by under 4 m.
    const ridges = heights(256, (u) => 200 * Math.sin(u * 16 * Math.PI) ** 2);
    const { grid, maxErrorMeters } = chooseGrid(ridges, 256, 5);
    expect(grid.cells).toBeGreaterThan(64);
    expect(maxErrorMeters).toBeLessThanOrEqual(5);
    expect(
      chooseGrid(
        heights(64, (u) => 200 * Math.sin(u * 16 * Math.PI) ** 2),
        64,
        0.001,
      ).grid.cells,
    ).toBe(64);
  });
});
