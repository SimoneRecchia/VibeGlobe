import { describe, expect, it } from 'vitest';
import { adaptiveLadder, PRESET_NAMES, QUALITY_PRESETS } from './index.js';

const ANTIALIAS = ['none', 'fxaa', 'msaa4'];
const ATMOSPHERE = ['off', 'low', 'medium', 'high', 'ultra'];
const anisotropy = (value: number | 'max'): number => (value === 'max' ? 16 : value);

describe('quality presets', () => {
  it('every step up costs at least as much in pixels, detail and effects', () => {
    for (let i = 1; i < PRESET_NAMES.length; i++) {
      const lower = QUALITY_PRESETS[PRESET_NAMES[i - 1] ?? 'low'];
      const higher = QUALITY_PRESETS[PRESET_NAMES[i] ?? 'low'];
      expect(higher.resolutionScale).toBeGreaterThanOrEqual(lower.resolutionScale);
      expect(higher.maxScreenErrorPx).toBeLessThanOrEqual(lower.maxScreenErrorPx);
      expect(anisotropy(higher.anisotropy)).toBeGreaterThanOrEqual(anisotropy(lower.anisotropy));
      expect(ANTIALIAS.indexOf(higher.antialias)).toBeGreaterThanOrEqual(ANTIALIAS.indexOf(lower.antialias));
      expect(ATMOSPHERE.indexOf(higher.atmosphere)).toBeGreaterThan(ATMOSPHERE.indexOf(lower.atmosphere));
    }
    expect(QUALITY_PRESETS.low).toMatchObject({ resolutionScale: 0.5, maxScreenErrorPx: 4 });
    expect(QUALITY_PRESETS.ultra).toMatchObject({ resolutionScale: 1.25, maxScreenErrorPx: 0.75 });
  });

  it.each(PRESET_NAMES)('the adaptive ladder of %s lowers one setting a little per step, to the floor', (name) => {
    const ladder = adaptiveLadder(QUALITY_PRESETS[name]);
    expect(ladder[0]).toBe(QUALITY_PRESETS[name]);
    for (let i = 1; i < ladder.length; i++) {
      const [a, b] = [ladder[i - 1], ladder[i]];
      if (!a || !b) throw new Error('ladder gap');
      const resolutionRatio = b.resolutionScale / a.resolutionScale;
      const errorRatio = b.maxScreenErrorPx / a.maxScreenErrorPx;
      // Exactly one of the two changes, by at most 15 % in resolution or 40 % in screen error; effects stay.
      expect(resolutionRatio < 1 !== errorRatio > 1).toBe(true);
      expect(resolutionRatio).toBeGreaterThanOrEqual(0.8);
      expect(errorRatio).toBeLessThanOrEqual(1.401); // steps are rounded to 0.001
      expect([b.antialias, b.atmosphere, b.anisotropy]).toEqual([a.antialias, a.atmosphere, a.anisotropy]);
    }
    const last = ladder[ladder.length - 1];
    expect(last?.resolutionScale).toBe(0.4);
    expect(last?.maxScreenErrorPx).toBe(8);
  });
});
