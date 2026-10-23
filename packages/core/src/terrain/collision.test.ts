import { describe, expect, it } from 'vitest';
import { liftMeters } from './collision.js';

describe('liftMeters', () => {
  it('keeps the clearance above the shown surface at once, and lowers the eye back over the ellipsoid (F146)', () => {
    // An eye 5 m above the ellipsoid over a shown surface at 1,000 m: lifted to 1,010 m in one frame.
    expect(liftMeters(0, 5, 1000, 1000, 10)).toBe(1005);
    // Nothing in the way: no lift.
    expect(liftMeters(1005, 5, -20, -20, 10)).toBe(0);
  });

  it('catches up with finer resident terrain above the shown surface over several frames, without a jump (KB-082)', () => {
    // Shown surface 1,000 m, the finest resident terrain under the eye 1,100 m, clearance 10 m; the eye starts 10 m
    // above the shown surface. The lift approaches 1,110 m in steps of a quarter of the gap, none above a third of it.
    let lift = 1005;
    const steps: number[] = [];
    for (let frame = 0; frame < 60; frame++) {
      const next = liftMeters(lift, 5, 1000, 1100, 10);
      steps.push(next - lift);
      lift = next;
    }
    expect(lift).toBe(1105);
    expect(steps.filter((step) => step > 0).length).toBeGreaterThan(4);
    expect(Math.max(...steps)).toBeLessThanOrEqual(100 / 3);
    // Once there, it holds; finer terrain that is also shown needs no catching up.
    expect(liftMeters(lift, 5, 1100, 1100, 10)).toBe(1105);
  });
});
