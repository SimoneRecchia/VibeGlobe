// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import { eyeAltitudeMeters, skyVisibility } from './sky-visibility.js';

const R = 6_378_137;
/** An eye over 0° N 0° E at an altitude. */
const eyeAt = (altitudeM: number): number[] => [R + altitudeM, 0, 0];
const noon = [1, 0, 0];
const midnight = [-1, 0, 0];
const at = (sunElevationDeg: number): number[] => {
  const e = (sunElevationDeg * Math.PI) / 180;
  return [Math.sin(e), Math.cos(e), 0];
};

describe('sky visibility (F606)', () => {
  it('measures the eye altitude over the ellipsoid', () => {
    expect(eyeAltitudeMeters(eyeAt(1000))).toBeCloseTo(1000, 3);
    expect(eyeAltitudeMeters([0, 0, 6_356_752.314245 + 500])).toBeCloseTo(500, 3);
  });

  it('hides the stars under the daytime sky near the ground and shows them at night and from space', () => {
    const ground = { eyeEcef: eyeAt(2000), atmosphere: true, morph: 0 };
    expect(skyVisibility({ ...ground, sunEcef: noon })).toBe(0);
    expect(skyVisibility({ ...ground, sunEcef: midnight })).toBe(1);
    expect(skyVisibility({ ...ground, eyeEcef: eyeAt(20_000_000), sunEcef: noon })).toBe(1);
    // Twilight and the upper atmosphere fade in between.
    const twilight = skyVisibility({ ...ground, sunEcef: at(-5) });
    expect(twilight).toBeGreaterThan(0.1);
    expect(twilight).toBeLessThan(0.9);
    const high = skyVisibility({ ...ground, eyeEcef: eyeAt(70_000), sunEcef: noon });
    expect(high).toBeGreaterThan(0.1);
    expect(high).toBeLessThan(0.9);
  });

  it('treats sun lighting off as day everywhere, shows everything without the atmosphere or the fade', () => {
    expect(skyVisibility({ eyeEcef: eyeAt(2000), sunEcef: undefined, atmosphere: true, morph: 0 })).toBe(0);
    expect(skyVisibility({ eyeEcef: eyeAt(2000), sunEcef: noon, atmosphere: false, morph: 0 })).toBe(1);
    expect(skyVisibility({ eyeEcef: eyeAt(2000), sunEcef: noon, atmosphere: true, morph: 0, fade: false })).toBe(1);
  });

  it('hides the background around a flat map seen from high above, not over the flat map near the ground', () => {
    expect(skyVisibility({ eyeEcef: eyeAt(2e7), sunEcef: midnight, atmosphere: true, morph: 1 })).toBe(0);
    expect(skyVisibility({ eyeEcef: eyeAt(2e7), sunEcef: midnight, atmosphere: false, morph: 0.25 })).toBe(0.75);
    expect(skyVisibility({ eyeEcef: eyeAt(3000), sunEcef: midnight, atmosphere: true, morph: 1 })).toBe(1);
  });
});
