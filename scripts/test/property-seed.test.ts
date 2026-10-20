import { describe, expect, it } from 'vitest';
import { propertyConfig, seedFromCommit } from './property-seed.ts';

describe('property test configuration', () => {
  it('derives a stable non-negative seed from a commit hash', () => {
    const seed = seedFromCommit('b389f7e0123456789abcdef0123456789abcdef0');
    expect(seed).toBe(seedFromCommit('b389f7e0123456789abcdef0123456789abcdef0'));
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).not.toBe(seedFromCommit('c389f7e0123456789abcdef0123456789abcdef0'));
  });

  it('prefers an explicit seed, then the CI commit, and reads the run count', () => {
    expect(propertyConfig({ VIBEGLOBE_FC_SEED: '42', GITHUB_SHA: 'abc' })).toEqual({ seed: 42, numRuns: 200 });
    expect(propertyConfig({ GITHUB_SHA: 'abc', VIBEGLOBE_FC_RUNS: '5000' })).toEqual({
      seed: seedFromCommit('abc'),
      numRuns: 5000,
    });
  });
});
