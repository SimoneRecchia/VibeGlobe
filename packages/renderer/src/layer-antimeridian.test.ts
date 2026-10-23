import { describe, expect, it } from 'vitest';
import { splitAtAntimeridian, unwrapRing, wrapTriangle } from './layer-antimeridian.js';

describe('layer geometry at the antimeridian and the poles (F368)', () => {
  it('cuts a segment that crosses ±180° at the crossing, each piece on its own side', () => {
    expect(splitAtAntimeridian([170, 10, 0], [-170, 20, 0])).toEqual([
      [
        [170, 10, 0],
        [180, 15, 0],
      ],
      [
        [-180, 15, 0],
        [-170, 20, 0],
      ],
    ]);
    expect(splitAtAntimeridian([-175, 0, 0], [175, 0, 100])).toEqual([
      [
        [-175, 0, 0],
        [-180, 0, 50],
      ],
      [
        [180, 0, 50],
        [175, 0, 100],
      ],
    ]);
    expect(splitAtAntimeridian([10, 0, 0], [20, 0, 0])).toHaveLength(1);
  });

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

  it('cuts a triangle spanning the antimeridian into pieces within ±180° covering the same area', () => {
    const pieces = wrapTriangle([
      [170, 0, 0],
      [190, 0, 0],
      [180, 10, 0],
    ]);
    for (const piece of pieces) for (const v of piece) expect(Math.abs(v[0])).toBeLessThanOrEqual(180);
    const area = (t: readonly (readonly number[])[]): number => {
      const [a, b, c] = t as [number[], number[], number[]];
      return (
        Math.abs(
          ((b[0] ?? 0) - (a[0] ?? 0)) * ((c[1] ?? 0) - (a[1] ?? 0)) -
            ((c[0] ?? 0) - (a[0] ?? 0)) * ((b[1] ?? 0) - (a[1] ?? 0)),
        ) / 2
      );
    };
    expect(pieces.reduce((sum, t) => sum + area(t), 0)).toBeCloseTo(100, 6);
    expect(
      wrapTriangle([
        [10, 0, 0],
        [20, 0, 0],
        [15, 5, 0],
      ]),
    ).toEqual([
      [
        [10, 0, 0],
        [20, 0, 0],
        [15, 5, 0],
      ],
    ]);
    expect(
      wrapTriangle([
        [200, 0, 0],
        [210, 0, 0],
        [205, 5, 0],
      ])[0]?.[0],
    ).toEqual([-160, 0, 0]);
  });
});
