import type { Globe } from '@vibeglobe/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createQuality,
  QUALITY_PRESETS,
  type AppliedQualitySettings,
  type QualityChange,
  type QualityTarget,
} from './index.js';

// A real globe is a quality target: the controller needs nothing beyond the public API (and the optional hook).
const asTarget = (globe: Globe): QualityTarget => globe;
void asTarget;

/** A globe stand-in: frames are emitted by `frame(ms)`, which also advances the clock. */
function fakeGlobe(capabilities: QualityTarget['capabilities'], withHook = true) {
  const handlers = new Set<() => void>();
  const state = { clockMs: 0, scales: [] as number[], settings: [] as AppliedQualitySettings[], renders: 0 };
  const target: QualityTarget = {
    capabilities,
    on: (event, handler) => {
      // Frames only: the stand-in never idles.
      if (event !== 'frame') return () => undefined;
      const h = (): void => handler({ frameNumber: 0 });
      handlers.add(h);
      return () => handlers.delete(h);
    },
    setResolutionScale: (scale) => state.scales.push(scale),
    requestRender: () => state.renders++,
    ...(withHook ? { setQualitySettings: (s: AppliedQualitySettings) => state.settings.push(s) } : {}),
  };
  const frame = (ms: number, count = 1): void => {
    for (let i = 0; i < count; i++) {
      state.clockMs += ms;
      for (const h of handlers) h();
    }
  };
  return { target, state, frame, now: () => state.clockMs, listeners: () => handlers.size };
}

const DESKTOP = {
  backend: 'webgpu',
  maxTextureSize: 16384,
  maxAnisotropy: 16,
  deviceMemoryGiB: 8,
  adapter: 'GPU',
} as const;
const PHONE = {
  backend: 'webgl2',
  maxTextureSize: 4096,
  maxAnisotropy: 4,
  deviceMemoryGiB: 2,
  adapter: 'GPU',
} as const;

describe('createQuality', () => {
  it('chooses the preset from capabilities, and an explicit preset overrides detection', () => {
    const desktop = fakeGlobe(DESKTOP);
    const auto = createQuality(desktop.target, { hints: { hardwareConcurrency: 8 }, now: desktop.now });
    expect([auto.preset, auto.choice?.reason]).toEqual(['high', 'capable WebGPU device']);
    expect(desktop.state.scales).toEqual([1]);
    expect(desktop.state.settings[0]).toMatchObject({ anisotropy: 16, antialias: 'msaa4', atmosphere: 'high' });
    const phone = fakeGlobe(PHONE);
    expect(createQuality(phone.target, { hints: {}, now: phone.now }).preset).toBe('low');
    const forced = createQuality(phone.target, { preset: 'ultra', now: phone.now });
    expect([forced.preset, forced.choice]).toEqual(['ultra', undefined]);
    expect(forced.settings.anisotropy).toBe(4); // 'max' is the device's maximum
    expect(() => createQuality(phone.target, { preset: 'extreme' as 'low' })).toThrow(TypeError);
  });

  it('switches presets at runtime, applying each preset in full', () => {
    const globe = fakeGlobe(DESKTOP);
    const quality = createQuality(globe.target, { preset: 'high', now: globe.now });
    const changes: QualityChange[] = [];
    quality.onChange((c) => changes.push(c));
    for (const name of ['low', 'medium', 'ultra', 'high'] as const) {
      globe.frame(16, 10);
      quality.setPreset(name);
      // Every engine setting of the preset; its pixel-ratio cap stays here (the test has no device pixel ratio).
      const engine = Object.entries(QUALITY_PRESETS[name]).filter(([key]) => key !== 'maxPixelRatio');
      expect(quality.settings).toEqual({
        ...Object.fromEntries(engine),
        anisotropy: QUALITY_PRESETS[name].anisotropy === 'max' ? 16 : QUALITY_PRESETS[name].anisotropy,
      });
    }
    expect(changes.map((c) => [c.reason, c.preset, c.level])).toEqual([
      ['preset', 'low', 0],
      ['preset', 'medium', 0],
      ['preset', 'ultra', 0],
      ['preset', 'high', 0],
    ]);
    expect(globe.state.renders).toBe(5);
  });

  it('draws no more pixels per CSS pixel than the preset allows on a dense screen', () => {
    const scales = (pixelRatio: number): number[] =>
      (['low', 'medium', 'high', 'ultra'] as const).map(
        (preset) =>
          createQuality(fakeGlobe(DESKTOP).target, { preset, hints: { pixelRatio } }).settings.resolutionScale,
      );
    // At 1 the presets' own scales; at 3 (a phone) low, medium and high draw at 1, 1.5 and 2 pixels per CSS pixel.
    expect(scales(1)).toEqual([0.5, 0.75, 1, 1.25]);
    expect(scales(3)).toEqual([0.333, 0.5, 0.667, 1.25]);
  });

  it('lowers on slow frames and raises back once frames are fast, through the resolution scale without the hook', () => {
    const globe = fakeGlobe(DESKTOP, false);
    const quality = createQuality(globe.target, { preset: 'high', now: globe.now });
    globe.frame(16, 60);
    expect(quality.level).toBe(0);
    globe.frame(30, 200);
    expect(quality.level).toBeGreaterThan(0);
    expect(globe.state.scales.at(-1)).toBeLessThan(1);
    globe.frame(8, 3000);
    expect(quality.level).toBe(0);
    expect(globe.state.scales.at(-1)).toBe(1);
  });

  it('holds the preset with adaptive quality off, and stops listening when destroyed', () => {
    const globe = fakeGlobe(DESKTOP);
    const quality = createQuality(globe.target, { preset: 'medium', adaptive: false, now: globe.now });
    globe.frame(40, 300);
    expect([quality.level, quality.adaptive]).toEqual([0, false]);
    quality.setAdaptive(true);
    globe.frame(40, 300);
    expect(quality.level).toBeGreaterThan(0);
    quality.setAdaptive(false);
    expect(quality.level).toBe(0);
    quality.destroy();
    expect(globe.listeners()).toBe(0);
  });

  it('shows the preset in full once the camera rests, and the lowered level again from its next movement (F688)', () => {
    const handlers = new Map<string, Set<() => void>>();
    const state = { clockMs: 0, scales: [] as number[] };
    const target: QualityTarget = {
      capabilities: DESKTOP,
      on: (event, handler) => {
        const set = handlers.get(event) ?? new Set();
        handlers.set(event, set);
        const h = (): void => handler({ frameNumber: 0 });
        set.add(h);
        return () => set.delete(h);
      },
      setResolutionScale: (scale) => state.scales.push(scale),
      requestRender: () => undefined,
    };
    const emit = (event: string): void => handlers.get(event)?.forEach((h) => h());
    // Each frame of a drag carries its own movement, as the controls send it; still frames carry none.
    const frames = (ms: number, count: number, moving: boolean): void => {
      for (let i = 0; i < count; i++) {
        state.clockMs += ms;
        if (moving) emit(i % 2 ? 'moveend' : 'movestart');
        emit('frame');
      }
    };
    const quality = createQuality(target, { preset: 'high', now: () => state.clockMs });
    frames(30, 200, true);
    const level = quality.level;
    expect(level).toBeGreaterThan(0);
    const lowered = state.scales.at(-1);
    expect(lowered).toBeLessThan(1);
    // Very slow frames of a drag keep it: each carries a movement.
    frames(400, 3, true);
    expect(state.scales.at(-1)).toBe(lowered);
    // Still frames (inertia over, an animation drawing) show the preset in full from 150 ms on, keep the level and
    // lower nothing; an idle engine does too.
    frames(30, 4, false);
    expect(state.scales.at(-1)).toBe(lowered);
    frames(30, 100, false);
    expect([state.scales.at(-1), quality.level]).toEqual([1, level]);
    // The next movement brings the level back at once; an engine idling within 150 ms of it rests once they passed.
    emit('movestart');
    expect(state.scales.at(-1)).toBe(lowered);
    vi.useFakeTimers();
    emit('idle');
    expect(state.scales.at(-1)).toBe(lowered);
    state.clockMs += 150;
    vi.advanceTimersByTime(150);
    expect(state.scales.at(-1)).toBe(1);
    vi.useRealTimers();
  });
});
