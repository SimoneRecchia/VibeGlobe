// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import { TileGrounds } from './drape.js';

describe('draping on the terrain (F452)', () => {
  it('samples no terrain while the relief is flat, and drapes again once it rises (KB-282)', () => {
    let samples = 0;
    const camera = { reliefFactor: 0 };
    const grounds = new TileGrounds({
      camera,
      elevationAt: (_position, out) => {
        samples++;
        return Object.assign(out ?? { level: 0, noData: false }, { heightMeters: 120 });
      },
      terrainStats: () => ({ uploads: 3 }),
    });
    const tile = { z: 8, x: 134, y: 92 };
    const xy = Float32Array.of(0, 0, 4096, 4096);

    grounds.frame();
    expect(grounds.active).toBe(false);
    expect(Array.from(grounds.heights(tile, xy, new Float32Array(2)))).toEqual([0, 0]);
    expect(samples).toBe(0);
    const flatVersion = grounds.version;

    camera.reliefFactor = 0.4;
    grounds.frame();
    expect(grounds.active).toBe(true);
    expect(grounds.version).not.toBe(flatVersion);
    expect(Array.from(grounds.heights(tile, xy, new Float32Array(2)))).toEqual([120, 120]);
    expect(samples).toBe(2);
  });
});
