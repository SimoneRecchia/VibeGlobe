import type { Globe } from '@vibeglobe/core';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { QualityPresetChoice } from './quality.js';

const created: string[] = [];
const switched: string[] = [];
vi.mock('@vibeglobe/quality', () => ({
  createQuality: (_engine: unknown, options: { preset: string }) => {
    created.push(options.preset);
    return { setPreset: (preset: string) => switched.push(preset), destroy: vi.fn() };
  },
}));

const { watchQualityPreset } = await import('./quality.js');

/** Lets the lazy import and the engine's ready promise settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};

describe('the qualityPreset prop (F474)', () => {
  it("switches presets in place, and back to 'auto' chooses from the device again (KB-148)", async () => {
    const preset = ref<QualityPresetChoice | undefined>('low');
    const engine = { ready: Promise.resolve() } as unknown as Globe;
    const stop = watchQualityPreset(engine, () => preset.value);
    await settle();
    expect(created).toEqual(['low']);
    preset.value = 'ultra';
    await settle();
    expect(switched).toEqual(['ultra']);
    preset.value = 'auto';
    await settle();
    expect(created).toEqual(['low', 'auto']);
    stop();
  });
});
