import { describe, expect, it } from 'vitest';
import { liftMeters, shortfallMeters } from './collision.js';

describe('liftMeters', () => {
  it('keeps the clearance above the shown surface at once, and lowers the eye back over the ellipsoid (F146)', () => {
    // An eye 5 m above the ellipsoid over a shown surface at 1,000 m: lifted to 1,010 m in one frame.
    expect(liftMeters(5, 1000, 1000, 10)).toBe(1005);
    // Nothing in the way: no lift.
    expect(liftMeters(5, -20, -20, 10)).toBe(0);
  });

  it('keeps the clearance above the finest resident terrain too, less the shortfall', () => {
    // Shown surface 1,000 m, finest 1,100 m: the eye stands 10 m above the finest.
    expect(liftMeters(5, 1000, 1100, 10)).toBe(1105);
    // With a 4 m shortfall, 6 m above it.
    expect(liftMeters(5, 1000, 1100 - 4, 10)).toBe(1101);
  });
});

describe('shortfallMeters', () => {
  it('closes over several frames when finer terrain arrives under the eye, without a jump (F147, KB-219)', () => {
    // Finer terrain 40 m higher arrives: the eye catches up in steps of a quarter, none above a third.
    let shortfall = shortfallMeters(0, 40);
    expect(shortfall).toBe(40);
    const steps: number[] = [];
    for (let frame = 0; frame < 30; frame++) {
      const next = shortfallMeters(shortfall, 0);
      steps.push(shortfall - next);
      shortfall = next;
    }
    expect(shortfall).toBe(0);
    expect(steps.filter((step) => step > 0).length).toBeGreaterThan(4);
    expect(Math.max(...steps)).toBeLessThanOrEqual(40 / 3);
    // Lower terrain opens none.
    expect(shortfallMeters(0, -50)).toBe(0);
  });
});
