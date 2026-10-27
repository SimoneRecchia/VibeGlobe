import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import type { ImagerySource } from './imagery-source.js';
import { pinnedLevels, sourceProblem, stackEntries, validStack } from './imagery-stack.js';

const valid: ImagerySource = {
  id: 'valid',
  tiling: WEB_MERCATOR_TILING,
  minLevel: 0,
  maxLevel: 18,
  tileSizePx: 256,
  pixelRatio: 1,
  transport: { start: () => () => undefined },
  decoder: 'image',
  request: () => 'noData',
};

describe('source metadata validation (F220)', () => {
  it('accepts complete metadata and names what is wrong otherwise', () => {
    expect(sourceProblem(valid)).toBeUndefined();
    const cases: [Partial<ImagerySource>, string][] = [
      [{ tiling: { ...WEB_MERCATOR_TILING, crs: 'EPSG:32632' } as never }, 'unknown reference system EPSG:32632'],
      [{ minLevel: 9, maxLevel: 3 }, 'minimum level 9 above its maximum 3'],
      [{ tileSizePx: 0 }, 'tile size of 0 pixels'],
      [{ coverage: [{ westRad: 0, southRad: 0.5, eastRad: 0.2, northRad: 0.1 }] }, 'coverage rectangle'],
      [{ maxRequestsPerSecond: -1 }, 'rate limit of -1'],
    ];
    for (const [change, message] of cases) expect(sourceProblem({ ...valid, ...change })).toContain(message);
  });

  it('refuses a source whose id cannot be turned into text instead of throwing (KB-118)', () => {
    const fuzzed = { ...valid, id: { toString: false } } as unknown as ImagerySource;
    const refused: string[] = [];
    expect(validStack([valid, { id: 'other', sources: [fuzzed] }], (m) => refused.push(m)).map((e) => e.id)).toEqual([
      'valid',
    ]);
    expect(refused).toHaveLength(1);
  });

  test.prop([fc.anything(), fc.anything(), fc.anything(), fc.anything()])(
    'never throws on arbitrary configuration objects, and keeps every valid layer',
    (id, levels, tileSize, coverage) => {
      const fuzzed = { ...valid, id, maxLevel: levels, tileSizePx: tileSize, coverage } as unknown as ImagerySource;
      const refused: string[] = [];
      const entries = validStack([valid, { id: 'other', sources: [fuzzed] }], (message) => refused.push(message));
      expect(entries[0]?.id).toBe('valid');
      expect(entries.length + refused.length).toBeGreaterThanOrEqual(2);
    },
  );
});

describe('the pinned base (F084, KB-218)', () => {
  it("pins the low levels of a chain's first source with level 0, not of one that starts deeper", () => {
    const deeper = { ...valid, id: 'package', minLevel: 5 };
    const world = { ...valid, id: 'world' };
    const levels = pinnedLevels(stackEntries([{ sources: [deeper, world] }]), 512 * 1024 * 1024);
    expect(levels[0]).toBe(-1);
    expect(levels[1]).toBeGreaterThanOrEqual(3);
    // A chain whose first source has level 0 pins that one, as before.
    expect(pinnedLevels(stackEntries([{ sources: [world, deeper] }]), 512 * 1024 * 1024)[1]).toBe(-1);
  });
});
