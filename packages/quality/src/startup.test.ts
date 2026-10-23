import { describe, expect, it } from 'vitest';
import { choosePreset, type CapabilityProfile } from './index.js';

/** Capability profiles the playground emulates, and the reference devices (docs/guides or ADR 0122). */
const PROFILES: Readonly<Record<string, CapabilityProfile>> = {
  lowEnd: { backend: 'webgl2', maxTextureSize: 4096, maxAnisotropy: 1, deviceMemoryGiB: 2, adapter: 'Mali-G52' },
  software: {
    backend: 'webgpu',
    maxTextureSize: 8192,
    maxAnisotropy: 16,
    deviceMemoryGiB: 8,
    adapter: 'Google SwiftShader',
  },
  highEnd: {
    backend: 'webgpu',
    maxTextureSize: 16384,
    maxAnisotropy: 16,
    deviceMemoryGiB: 8,
    adapter: 'NVIDIA GeForce RTX 3070',
  },
  referenceDesktop: {
    backend: 'webgpu',
    maxTextureSize: 16384,
    maxAnisotropy: 16,
    deviceMemoryGiB: 8,
    adapter: 'Apple M2',
  },
  referenceTablet: {
    backend: 'webgpu',
    maxTextureSize: 16384,
    maxAnisotropy: 16,
    deviceMemoryGiB: 8,
    adapter: 'Apple M1',
  },
};

describe('choosePreset', () => {
  it.each([
    ['lowEnd', {}, 'low'],
    ['software', {}, 'low'],
    ['highEnd', { hardwareConcurrency: 16 }, 'high'],
    ['referenceDesktop', { hardwareConcurrency: 8, coarsePointer: false }, 'high'],
    ['referenceTablet', { hardwareConcurrency: 8, coarsePointer: true }, 'medium'],
  ] as const)('chooses for the %s profile', (profile, hints, preset) => {
    expect(choosePreset(PROFILES[profile] as CapabilityProfile, hints).preset).toBe(preset);
  });

  it.each([
    [{ maxTextureSize: 2048 }, {}, 'low'],
    [{}, { hardwareConcurrency: 2 }, 'low'],
    [{ backend: 'webgl2' as const }, {}, 'medium'],
    [{ deviceMemoryGiB: 4 }, {}, 'medium'],
    [{}, { hardwareConcurrency: 4 }, 'medium'],
    [{ deviceMemoryGiB: undefined }, {}, 'high'],
  ])('applies each rule: %o %o → %s', (capabilities, hints, preset) => {
    const choice = choosePreset({ ...(PROFILES['highEnd'] as CapabilityProfile), ...capabilities }, hints);
    expect(choice.preset).toBe(preset);
    expect(choice.reason).not.toBe('');
  });
});
