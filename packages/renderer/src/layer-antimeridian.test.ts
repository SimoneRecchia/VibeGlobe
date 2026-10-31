import { describe, expect, it } from 'vitest';
import { unwrapRing } from './layer-antimeridian.js';

describe('layer geometry at the antimeridian and the poles (F368)', () => {
  it('unwraps a ring across the antimeridian and closes a ring around a pole through it', () => {
    expect(
      unwrapRing([
        [170, 0, 0],
        [-170, 0, 0],
        [-170, 10, 0],
        [170, 10, 0],
      ]).map((v) => v[0]),
    ).toEqual([170, 190, 190, 170]);
    const polar = unwrapRing([0, 90, 180, 270].map((lon) => [lon > 180 ? lon - 360 : lon, 80, 0]));
    expect(polar.map((v) => v[1]).slice(-2)).toEqual([90, 90]);
    expect(polar).toHaveLength(7);
  });
});
