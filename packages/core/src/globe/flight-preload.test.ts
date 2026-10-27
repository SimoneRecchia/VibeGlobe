// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { FlightPreload } from './flight-preload.js';

const DEG = Math.PI / 180;

describe('FlightPreload', () => {
  it('selects the view ahead no finer than the motion-aware detail of the moment allows (F287)', () => {
    const current = new Camera();
    current.widthPx = 800;
    current.heightPx = 600;
    current.update();
    // The view half a second ahead of a descent onto Tokyo, 20 km above it.
    const ahead = Float64Array.of(139.7 * DEG, 35.7 * DEG, 20_000, 0, 0);
    const deepest = (texelErrorPx: number): number => {
      const preload = new FlightPreload();
      preload.select(current, ahead, {
        maxScreenErrorPx: 1,
        maxLevel: 22,
        imageryTexelsPerTile: 256,
        imageryMaxLevel: 19,
        maxTexelErrorPx: texelErrorPx,
      });
      return Math.max(...preload.tiles.slice(0, preload.count).map((tile) => tile.level));
    };
    // Still: texels up to 1.5 px; at full speed the motion factor allows four times that. Tiles near the eye still
    // refine for their size against the distance, which motion does not change, so the deepest level drops by one here.
    const still = deepest(1.5);
    const fast = deepest(1.5 * 4);
    expect(still).toBeGreaterThan(8);
    expect(fast).toBeLessThan(still);
    for (const factor of [1, 2, 4]) expect(deepest(1.5 * factor)).toBeLessThanOrEqual(still);
  });
});
