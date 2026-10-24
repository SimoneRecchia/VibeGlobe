import { describe, expect, it } from 'vitest';
import { EngineQuality } from './engine-quality.js';

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
