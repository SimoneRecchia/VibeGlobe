import { describe, expect, it } from 'vitest';

/**
 * The analytic check of ADR 0005: each depth path's arithmetic emulated in float32 must keep surfaces a small fraction
 * of their distance apart in order, from the nearest near plane to beyond the Moon's distance.
 */
const NEAR_METERS = [0.001, 0.1];
const FAR_METERS = 4e7;

/**
 * Both paths store near / d in float32: hardware reversed-Z divides clip z = near by w = d, and the fragment path
 * divides near by the interpolated view-space distance.
 */
function nearOverDistance(near: number, d: number): number {
  return Math.fround(Math.fround(near) / Math.fround(d));
}

/** WebGL2's fixed function on the [−1, 1] projection, without the fragment write: (z/w + 1) / 2 in float32. */
function fixedFunction(near: number, d: number): number {
  const ndc = Math.fround(Math.fround(2 * near - Math.fround(d)) / Math.fround(d));
  return Math.fround(Math.fround(ndc + 1) / 2);
}

/** Whether every pair of surfaces `relativeStep`·d apart over [near, FAR_METERS] stores in the right order. */
function resolves(depth: (near: number, d: number) => number, near: number, relativeStep: number): boolean {
  for (let exponent = Math.log10(near); exponent <= Math.log10(FAR_METERS); exponent += 0.001) {
    const d = 10 ** exponent;
    if (!(depth(near, d) > depth(near, d * (1 + relativeStep)))) return false;
  }
  return true;
}

describe('depth encodings (ADR 0005)', () => {
  it('resolves surfaces 3e-7·d apart with hardware reversed-Z', () => {
    for (const near of NEAR_METERS) expect(resolves(nearOverDistance, near, 3e-7)).toBe(true);
  });

  it('resolves surfaces 5e-7·d apart on the fragment path', () => {
    for (const near of NEAR_METERS) expect(resolves(nearOverDistance, near, 5e-7)).toBe(true);
  });

  it('needs the fragment write: the fixed-function fallback cannot resolve the same steps', () => {
    for (const near of NEAR_METERS) expect(resolves(fixedFunction, near, 5e-7)).toBe(false);
  });
});
