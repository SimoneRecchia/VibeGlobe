import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import type { ImagerySource } from './imagery-source.js';
import { sourceProblem, validStack } from './imagery-stack.js';

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
