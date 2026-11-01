// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import { gridLines } from './grid-lines.js';

/** The value, which the test expects to be there. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

const center = { longitudeDeg: 13, latitudeDeg: 52 };

describe('grid lines (F659)', () => {
  it('draws two families of lines through the center, the spacing apart, as far as the half size', () => {
    const lines = gridLines({ center, halfSizeM: 100, spacingM: 10 });
    expect(lines).toHaveLength(42);
    const [a, b] = must(lines[0]);
    const meters = (lat: number) => (lat - 52) * 111_320;
    expect(meters(a.latitudeDeg)).toBeCloseTo(-100, 6);
    expect(meters(b.latitudeDeg)).toBeCloseTo(100, 6);
  });

  it('keeps to 2000 lines by widening the spacing, and turns with the bearing', () => {
    expect(gridLines({ center, halfSizeM: 10_000, spacingM: 1 }).length).toBeLessThanOrEqual(2002);
    const [a, b] = must(gridLines({ center, halfSizeM: 50, spacingM: 10, bearingDeg: 90 })[0]);
    expect(a.latitudeDeg).toBeCloseTo(b.latitudeDeg, 9);
  });

  it('refuses a spacing that is not a positive number of meters, instead of never returning (KB-324)', () => {
    for (const spacingM of [-5, Number.NaN, 0])
      expect(() => gridLines({ center, halfSizeM: 100, spacingM }), String(spacingM)).toThrow(RangeError);
  });
});
