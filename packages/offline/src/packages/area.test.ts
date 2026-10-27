import { xyzImagery } from '@vibeglobe/sources';
import { describe, expect, it } from 'vitest';
import { tilesOfArea } from './area.js';

describe('package areas', () => {
  it('a box reaching the antimeridian covers every column, not only the first (KB-198)', () => {
    const { tiling } = xyzImagery({ id: 'a', url: 'https://a.test/{z}/{x}/{y}.png' });
    const world = { westDeg: -180, southDeg: -85, eastDeg: 180, northDeg: 85 };
    expect([...tilesOfArea(tiling, world, 0, 2)]).toHaveLength(1 + 4 + 16);
    const east = { westDeg: 90, southDeg: 0, eastDeg: 180, northDeg: 10 };
    expect([...tilesOfArea(tiling, east, 2, 2)].map((c) => c.x)).toEqual([3]);
  });
});
