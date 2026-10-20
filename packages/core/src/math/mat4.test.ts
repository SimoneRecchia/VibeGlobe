import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { perspectiveReversedInfinite, transformPoint4, viewRotation } from './mat4.js';

const out = new Float64Array(4);

describe('perspectiveReversedInfinite', () => {
  test.prop([
    fc.double({ min: 0.1, max: 2.5, noNaN: true }),
    fc.double({ min: 0.2, max: 5, noNaN: true }),
    fc.double({ min: 0.001, max: 1, noNaN: true }),
    fc.double({ min: 0, max: 1e7, noNaN: true }),
  ])('maps depth d to near / d in (0, 1], decreasing with distance', (fov, aspect, near, extra) => {
    const m = perspectiveReversedInfinite(new Float64Array(16), fov, aspect, near);
    const depth = near + extra;
    transformPoint4(out, m, 0, 0, -depth);
    const z = (out[2] ?? NaN) / (out[3] ?? NaN);
    expect(Math.abs(z - near / depth)).toBeLessThanOrEqual(1e-15 + 1e-12 * z);
    transformPoint4(out, m, 0, 0, -(depth * 2));
    expect((out[2] ?? NaN) / (out[3] ?? NaN)).toBeLessThan(z);
  });
});

describe('viewRotation', () => {
  const unit = fc
    .tuple(
      fc.double({ min: -1, max: 1, noNaN: true }),
      fc.double({ min: -1, max: 1, noNaN: true }),
      fc.double({ min: -1, max: 1, noNaN: true }),
    )
    .filter(([x, y, z]) => Math.hypot(x, y, z) > 0.1);

  test.prop([unit, unit])('is a rotation: it preserves lengths and maps forward to -Z', (a, b) => {
    // Build an orthonormal basis from two random directions (Gram–Schmidt).
    const forward = normalize(a);
    const along = dot(b, forward);
    const upRaw: [number, number, number] = [
      b[0] - along * forward[0],
      b[1] - along * forward[1],
      b[2] - along * forward[2],
    ];
    fc.pre(Math.hypot(...upRaw) > 1e-3);
    const up = normalize(upRaw);
    const right = cross(forward, up);
    const m = viewRotation(
      new Float64Array(16),
      new Float64Array(right),
      new Float64Array(up),
      new Float64Array(forward),
    );
    transformPoint4(out, m, ...forward);
    expect(out[2]).toBeCloseTo(-1, 12);
    transformPoint4(out, m, ...b);
    expect(Math.hypot(out[0] ?? NaN, out[1] ?? NaN, out[2] ?? NaN)).toBeCloseTo(Math.hypot(...b), 12);
  });
});

function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

function normalize(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
