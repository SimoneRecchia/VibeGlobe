import { describe, expect, it } from 'vitest';
import { geoidModel, toEllipsoidal, undulationMeters } from './vertical-datum.js';

const DEG = Math.PI / 180;

/** A 5° grid whose undulation is a known function: N = 10·sin(lat) + lon° / 36. */
function syntheticGeoid(): ReturnType<typeof geoidModel> {
  const rows = 37;
  const columns = 72;
  const values = new Float32Array(rows * columns);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      const lat = 90 - r * 5;
      const lon = -180 + c * 5;
      values[r * columns + c] = 10 * Math.sin(lat * DEG) + lon / 36;
    }
  return geoidModel(rows, columns, values);
}

describe('vertical datum', () => {
  it('interpolates the undulation between grid nodes and wraps across the antimeridian (F133)', () => {
    const geoid = syntheticGeoid();
    expect(undulationMeters(geoid, 0, 0)).toBeCloseTo(0, 5);
    expect(undulationMeters(geoid, 90 * DEG, 30 * DEG)).toBeCloseTo(5 + 2.5, 5);
    // Halfway between 175° E (4.86) and 180° W (−5): the wrap interpolates between the last and first column.
    expect(undulationMeters(geoid, 177.5 * DEG, 0)).toBeCloseTo((175 / 36 - 5) / 2, 4);
  });

  it('converts geoid heights to WGS84 ellipsoidal heights, h = H + N, and leaves ellipsoidal sources alone (F133)', () => {
    const geoid = syntheticGeoid();
    const grid = { cells: 1, heightsMeters: new Float32Array([100, 100, 100, 100]), minMeters: 100, maxMeters: 100 };
    const unchanged = toEllipsoidal(grid, { kind: 'ellipsoid' }, 0, 0, 1, 1);
    expect(unchanged).toBe(grid);
    // The tile 0°–90° E, 0°–30° N: corners NW (0, 30), NE (90, 30), SW (0, 0), SE (90, 0).
    const converted = toEllipsoidal(grid, { kind: 'geoid', model: geoid }, 0, 0, 90 * DEG, 30 * DEG);
    expect([...converted.heightsMeters].map((h) => Math.round(h * 100) / 100)).toEqual([105, 107.5, 100, 102.5]);
    expect(converted.minMeters).toBeCloseTo(100, 4);
    expect(converted.maxMeters).toBeCloseTo(107.5, 4);
  });

  it('rejects grids that are too small, of the wrong size, or not finite', () => {
    expect(() => geoidModel(1, 4, new Float32Array(4))).toThrow(RangeError);
    expect(() => geoidModel(2, 2, new Float32Array(3))).toThrow(RangeError);
    expect(() => geoidModel(2, 2, new Float32Array([0, 0, Number.NaN, 0]))).toThrow(RangeError);
  });
});
