import { describe, expect, it } from 'vitest';
import { isBlank } from './decode-image.js';

describe('decode-image blank tiles (F618)', () => {
  it('counts a tile as blank only when every pixel is opaque and within the tolerance of the color', () => {
    const tile = (pixel: number[], count = 4): Uint8ClampedArray =>
      new Uint8ClampedArray(Array.from({ length: count }, () => pixel).flat());
    const white = { rgb: [255, 255, 255], tolerance: 2 };
    expect(isBlank(tile([254, 255, 253, 255]), white)).toBe(true);
    expect(isBlank(new Uint8ClampedArray([...tile([255, 255, 255, 255], 3), 200, 255, 255, 255]), white)).toBe(false);
    expect(isBlank(tile([255, 255, 255, 0]), white)).toBe(false);
  });
});
