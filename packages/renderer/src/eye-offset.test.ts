import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { splitEyeOffset } from './eye-offset.js';

/** One pixel at 2160 px over a 37° vertical field of view (4K), in radians. */
const PIXEL_RAD = 0.6435 / 2160;

const unit = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter(([x, y, z]) => Math.hypot(x, y, z) > 0.1)
  .map(([x, y, z]) => {
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length] as const;
  });

/**
 * The angle, seen from the eye, between where the shader puts a vertex and where it is: the shader evaluates
 * (offset + T_hi) + T_lo with each sum rounded to float32. With `dropLow`, a compiler that lost T_lo.
 */
function shaderErrorRad(origin: Float64Array, offset: Float32Array, eye: Float64Array, dropLow = false): number {
  const high = new Float32Array(3);
  const low = new Float32Array(3);
  splitEyeOffset(origin, eye, high, low);
  let errorSquared = 0;
  let distanceSquared = 0;
  for (let i = 0; i < 3; i++) {
    const sum = Math.fround((offset[i] ?? 0) + (high[i] ?? 0));
    const shader = dropLow ? sum : Math.fround(sum + (low[i] ?? 0));
    const exact = (origin[i] ?? 0) + (offset[i] ?? 0) - (eye[i] ?? 0);
    errorSquared += (shader - exact) ** 2;
    distanceSquared += exact ** 2;
  }
  return Math.sqrt(errorSquared / distanceSquared);
}

describe('eye-relative offsets (ADR 0004 §3)', () => {
  test.prop([
    // A tile origin on the Earth, a vertex within the tile radius, and an eye at distance d from it with R ≤ 1000·d.
    unit,
    fc.double({ min: 0, max: 6, noNaN: true }).map((exponent) => 10 ** exponent),
    unit,
    // The worst case is a vertex at the tile's edge seen from the closest allowed distance: both are sampled often.
    fc.oneof(fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true })),
    unit,
    fc.oneof(fc.constant(0), fc.double({ min: 0, max: 1, noNaN: true })),
  ])(
    '(offset + T_hi) + T_lo in float32 stays within 0.01 px at 4K, and within 0.4 px if T_lo is lost',
    (originDir, radius, offsetDir, offsetScale, viewDir, distanceScale) => {
      const origin = Float64Array.from(originDir, (c) => c * 6.371e6);
      // The vertex offset is stored as float32, like the mesh attribute.
      const offset = Float32Array.from(offsetDir, (c) => c * radius * offsetScale);
      const minimum = Math.max(radius / 1000, 0.5);
      // Log-uniform from the closest allowed distance (R/1000, at least 0.5 m) to 1000 times that.
      const distance = minimum * 1000 ** distanceScale;
      const eye = Float64Array.from(origin, (c, i) => c + (offset[i] ?? 0) - (viewDir[i] ?? 0) * distance);
      expect(shaderErrorRad(origin, offset, eye)).toBeLessThan(0.01 * PIXEL_RAD);
      expect(shaderErrorRad(origin, offset, eye, true)).toBeLessThan(0.4 * PIXEL_RAD);
    },
  );

  it('keeps the low part where a single float32 offset would be off by more than 0.1 px (KB-025)', () => {
    // A vertex 786432·√3 m from its origin seen from 1363 m (R ≈ 999·d): every component of T lies 0.03 m from the
    // nearest float32, so a single float32 offset (T_lo dropped) moves the vertex by 0.052 m, 0.13 px at 4K.
    const side = 786_432;
    const step = 787.03;
    const origin = Float64Array.of(4e6, 3e6, 3.9e6);
    const offset = Float32Array.of(side, side, side);
    const eye = Float64Array.from(origin, (c) => c + side - step);
    expect(shaderErrorRad(origin, offset, eye)).toBeLessThan(0.01 * PIXEL_RAD);
    expect(shaderErrorRad(origin, offset, eye, true)).toBeGreaterThan(0.1 * PIXEL_RAD);
  });
});
