import { describe, expect, it } from 'vitest';
import { LandMask } from './land.js';
import { rangeCount, tileRange } from './mercator.js';

// An island 0°–10° E, 0°–10° N in a region 0°–20° E, 0°–20° N.
const ISLAND: [number, number][][] = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
];
const REGION = { west: 0, south: 0, east: 20, north: 20 };

describe('land masks (F614)', () => {
  it('keeps every tile up to the sea level and only land tiles beyond, its counts matching its tiles', () => {
    const mask = new LandMask(ISLAND, REGION, 8);
    for (let z = 0; z <= 8; z++) {
      const all = rangeCount(tileRange(REGION, z));
      expect(mask.landCount(z) + mask.seaCount(z)).toBe(all);
      expect([...mask.tiles(z, 5)].length).toBe(z <= 5 ? all : mask.landCount(z));
    }
    // About a quarter of the region is land, a little more at the coarse zooms where tiles straddle the coast.
    expect(mask.landCount(8) / rangeCount(tileRange(REGION, 8))).toBeGreaterThan(0.2);
    expect(mask.landCount(8) / rangeCount(tileRange(REGION, 8))).toBeLessThan(0.3);
    expect(mask.isLand({ z: 8, x: 131, y: 124 })).toBe(true);
    expect(mask.isLand({ z: 8, x: 140, y: 118 })).toBe(false);
    // A parent touches land exactly when one of its children does.
    for (const tile of mask.tiles(7, 0)) {
      const children = [0, 1, 2, 3].map((q) => ({ z: 8, x: tile.x * 2 + (q % 2), y: tile.y * 2 + (q >> 1) }));
      expect(children.some((c) => mask.isLand(c))).toBe(true);
    }
  });
});
