import { describe, expect, it } from 'vitest';
import { EngineQuality } from './engine-quality.js';
import type { RendererQuality } from './quality-types.js';
import type { RendererBackend } from './types.js';

/** Quality settings over fake parts, recording the fog haze the surface selection receives. */
function quality(initial: unknown): { engine: EngineQuality; fog: (number | undefined)[] } {
  const fog: (number | undefined)[] = [];
  const engine = new EngineQuality(
    {
      globe: { setResolutionScale: () => undefined, requestRender: () => undefined },
      renderer: () => undefined,
      surface: () => ({ setScreenError: () => undefined, setFog: (haze) => fog.push(haze) }),
      resolutionScale: () => 1,
    },
    { quality: initial },
  );
  return { engine, fog };
}

describe('fog-aware detail (F395)', () => {
  it('follows the fog drawn, and loads full detail under the fog when switched off', () => {
    const { engine, fog } = quality({ atmosphere: 'low' });
    engine.set({});
    expect(fog.at(-1)).toBe(1);
    engine.set({ fogAwareDetail: false });
    expect(fog.at(-1)).toBeUndefined();
    expect(engine.settings.fogAwareDetail).toBe(false);
    engine.set({ fogAwareDetail: true, fog: false });
    expect(fog.at(-1)).toBeUndefined();
    expect(() => engine.set({ fogAwareDetail: 'yes' as unknown as boolean })).toThrow(/fogAwareDetail/);
  });
});

describe('day and night settings (F647)', () => {
  it('starts with day and night off and the physical airlight, and refuses values outside 0 to 1', () => {
    const { engine } = quality({});
    expect([engine.atmosphere.dayNight, engine.atmosphere.airlight]).toEqual([0, 1]);
    engine.setAtmosphere({ dayNight: 0.5, airlight: 0.4 });
    expect([engine.atmosphere.dayNight, engine.atmosphere.airlight]).toEqual([0.5, 0.4]);
    expect(() => engine.setAtmosphere({ dayNight: 1.01 })).toThrow(/dayNight/);
    expect(() => engine.setAtmosphere({ airlight: -0.1 })).toThrow(/airlight/);
  });
});

describe('motion blur (F694)', () => {
  it('is off by default, reaches the renderer, and refuses values outside 0 to 1', () => {
    const { engine } = quality({});
    expect(engine.settings.motionBlur).toBe(0);
    engine.set({ motionBlur: 0.5 });
    expect(engine.settings.motionBlur).toBe(0.5);
    let applied: RendererQuality | undefined;
    engine.attach({ capabilities: { maxAnisotropy: 16 }, setQuality: (q) => void (applied = q) } as RendererBackend);
    expect(applied?.motionBlur).toBe(0.5);
    expect(() => engine.set({ motionBlur: 1.5 })).toThrow(/motionBlur/);
    expect(() => engine.set({ motionBlur: -0.1 })).toThrow(/motionBlur/);
  });
});
