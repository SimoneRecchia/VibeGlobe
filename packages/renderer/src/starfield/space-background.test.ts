// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import { addSpaceBackground, type SpaceBackgroundGlobe } from './space-background.js';

const globe = {
  addRenderExtension: () => () => undefined,
  atmosphere: { sunLighting: false, timeMs: 0, haze: 1 },
  qualitySettings: { atmosphere: 'medium' },
  requestRender: () => undefined,
} as unknown as SpaceBackgroundGlobe;

describe('the space background halo (F643)', () => {
  it('is off by default, changes at runtime and accepts 0 to 4 only', () => {
    const background = addSpaceBackground(globe);
    expect(background.options.glow).toBe(0);
    background.setOptions({ glow: 1.5 });
    expect(background.options.glow).toBe(1.5);
    expect(() => background.setOptions({ glow: 4.5 })).toThrow(/glow must be 0 to 4/);
    expect(() => addSpaceBackground(globe, { glow: -1 })).toThrow(/glow must be 0 to 4/);
  });
});

describe('the space background sky and halo colors (F693)', () => {
  it('keeps space and the built-in halo by default, takes #rrggbb colors at runtime and refuses others', () => {
    const background = addSpaceBackground(globe);
    expect([background.options.sky, background.options.glowColor]).toEqual(['#000000', '']);
    background.setOptions({ sky: '#f4f4f4', glowColor: '#cfd3d4', stars: false, milkyWay: false });
    expect([background.options.sky, background.options.glowColor]).toEqual(['#f4f4f4', '#cfd3d4']);
    background.setOptions({ glowColor: '' });
    expect(background.options.glowColor).toBe('');
    expect(() => background.setOptions({ sky: 'white' })).toThrow(/sky must be a #rrggbb color/);
    expect(() => addSpaceBackground(globe, { glowColor: '#fff' })).toThrow(/glowColor must be a #rrggbb color/);
  });
});
