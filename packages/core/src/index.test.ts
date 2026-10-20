import { describe, expect, it } from 'vitest';

describe('@vibeglobe/core entry point', () => {
  it('imports without browser globals (SSR-safe)', async () => {
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);
    const core = await import('./index.js');
    expect(core.WGS84.semiMajorAxisMeters).toBe(6378137);
  });
});
