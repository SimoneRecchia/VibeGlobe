import { describe, expect, it } from 'vitest';
import { decodeHeightmap, heightGrid, heightmapBorderPx } from './heightmap.js';

/** RGBA bytes of a square tile whose every pixel has the given red, green and blue. */
function uniform(sizePx: number, r: number, g: number, b: number): Uint8Array {
  const rgba = new Uint8Array(sizePx * sizePx * 4);
  for (let p = 0; p < rgba.length; p += 4) rgba.set([r, g, b, 255], p);
  return rgba;
}

describe('heightmap encodings', () => {
  it('decodes Terrarium as (R × 256 + G + B / 256) − 32768 m at 256 and 512 px (F129)', () => {
    for (const size of [256, 512]) {
      // 128·256 + 0 + 0 − 32768 = 0 m; 129·256 + 4 + 128/256 − 32768 = 260.5 m.
      expect(decodeHeightmap(uniform(size, 128, 0, 0), size, 'terrarium')[0]).toBe(0);
      const heights = decodeHeightmap(uniform(size, 129, 4, 128), size, 'terrarium');
      expect(heights.length).toBe(size * size);
      expect(heights[size * size - 1]).toBe(260.5);
    }
  });

  it('decodes Terrain-RGB as −10000 + (R × 65536 + G × 256 + B) × 0.1 m at 256 and 512 px (F130)', () => {
    for (const size of [256, 512]) {
      // (1·65536 + 134·256 + 160) × 0.1 − 10000 = 0 m; Everest-like 8848 m: value 188480 = (2, 224, 64).
      expect(decodeHeightmap(uniform(size, 1, 134, 160), size, 'terrain-rgb')[0]).toBeCloseTo(0, 3);
      expect(decodeHeightmap(uniform(size, 2, 224, 64), size, 'terrain-rgb')[7]).toBeCloseTo(8848, 3);
    }
  });

  it('decodes the minimum and maximum encodable heights of both encodings (F129, F130)', () => {
    expect(decodeHeightmap(uniform(256, 0, 0, 0), 256, 'terrarium')[0]).toBe(-32768);
    expect(decodeHeightmap(uniform(256, 255, 255, 255), 256, 'terrarium')[0]).toBeCloseTo(32767 + 255 / 256, 3);
    expect(decodeHeightmap(uniform(256, 0, 0, 0), 256, 'terrain-rgb')[0]).toBe(-10000);
    // −10000 + 16,777,215 × 0.1 = 1,667,721.5 m; float32 keeps it to 0.125 m.
    expect(decodeHeightmap(uniform(256, 255, 255, 255), 256, 'terrain-rgb')[0]).toBeCloseTo(1667721.5, 0);
  });

  it('refuses a byte count that does not match the size, so a truncated tile never decodes (F131)', () => {
    expect(() => decodeHeightmap(new Uint8Array(100), 256, 'terrarium')).toThrow(RangeError);
    expect(() => decodeHeightmap(uniform(256, 0, 0, 0).subarray(4), 256, 'terrain-rgb')).toThrow(RangeError);
  });
});

describe('height grid', () => {
  it('gives two neighbors with a one-pixel border the same heights along their shared edge (KB-178)', () => {
    // Rough relief sampled at pixel centers of 16-pixel tiles, each with a ring of its neighbor's pixels: 18 px.
    const relief = (x: number, y: number): number =>
      1000 * Math.sin(x * 1.7) * Math.cos(y * 2.3) + 300 * Math.sin(x * y);
    const tile = (column: number): Float32Array => {
      const pixels = new Float32Array(18 * 18);
      for (let y = 0; y < 18; y++)
        for (let x = 0; x < 18; x++) pixels[y * 18 + x] = relief(column * 16 + x - 1 + 0.5, y - 1 + 0.5);
      return pixels;
    };
    expect([heightmapBorderPx(18), heightmapBorderPx(258), heightmapBorderPx(256), heightmapBorderPx(257)]).toEqual([
      1, 1, 0, 0,
    ]);
    const west = heightGrid(tile(0), 18, 16);
    const east = heightGrid(tile(1), 18, 16);
    for (let row = 0; row <= 16; row++)
      expect(west.heightsMeters[row * 17 + 16]).toBeCloseTo(east.heightsMeters[row * 17] ?? NaN, 3);
    // The interior keeps its own pixels: a vertex between four pixel centers is their mean.
    const pixels = tile(0);
    const mean =
      ((pixels[1 * 18 + 1] ?? 0) + (pixels[1 * 18 + 2] ?? 0) + (pixels[2 * 18 + 1] ?? 0) + (pixels[2 * 18 + 2] ?? 0)) /
      4;
    expect(west.heightsMeters[1 * 17 + 1]).toBeCloseTo(mean, 3);
  });

  it('spans the tile edge to edge, interpolating between pixel centers and extrapolating to the border', () => {
    // A 4-pixel ramp west to east: 0, 10, 20, 30 m at the pixel centers (x = 0.5, 1.5, 2.5, 3.5).
    const pixels = new Float32Array(16);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) pixels[y * 4 + x] = x * 10;
    const grid = heightGrid(pixels, 4, 4);
    expect(grid.heightsMeters.length).toBe(25);
    // Vertices at x = 0, 1, 2, 3, 4: the ramp continued half a pixel past the outer centers, −5 and 35.
    expect([...grid.heightsMeters.subarray(0, 5)]).toEqual([-5, 5, 15, 25, 35]);
    expect(grid.minMeters).toBe(-5);
    expect(grid.maxMeters).toBe(35);
  });
});
