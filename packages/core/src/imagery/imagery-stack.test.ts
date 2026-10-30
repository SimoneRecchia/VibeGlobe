import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { rangeForGroundZoom } from '../camera/zoom.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import type { ImagerySource } from './imagery-source.js';
import {
  applyChanges,
  fadeByZoom,
  isOpaque,
  pinnedLevels,
  shownOpacity,
  sourceProblem,
  stackEntries,
  validStack,
} from './imagery-stack.js';

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

describe('layer changes', () => {
  it('refuses a blend mode that is only an inherited property name', () => {
    const [entry] = stackEntries([valid]);
    if (!entry) throw new Error('no entry');
    for (const blend of ['toString', 'constructor', '__proto__'])
      expect(() => applyChanges(entry, { blend: blend as 'normal' })).toThrow(/Unknown blend mode/);
    applyChanges(entry, { blend: 'multiply' });
    expect(entry.blend).toBe('multiply');
  });
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

  it('pins a chain without a level-0 source from its first level, within its coverage, and none that starts too deep (F634)', () => {
    const europe = [{ westRad: -0.5, southRad: 0.6, eastRad: 0.7, northRad: 1.2 }];
    const pkg = { ...valid, id: 'package', minLevel: 5, coverage: europe };
    expect(pinnedLevels(stackEntries([{ sources: [pkg] }]), 512 * 1024 * 1024)[0]).toBeGreaterThanOrEqual(5);
    const fine = { ...valid, id: 'fine', minLevel: 12, coverage: europe };
    expect(pinnedLevels(stackEntries([{ sources: [fine] }]), 512 * 1024 * 1024)[0]).toBe(-1);
  });
});

describe('fading a layer in with the zoom (F635)', () => {
  it('hides the layer up to its first zoom, shows it partly, as an overlay, up to the second, then fully', () => {
    const entries = stackEntries([{ id: 'marble', sources: [valid], fadeIn: { fromZoom: 4, toZoom: 4.5 } }]);
    const [entry] = entries;
    if (!entry) throw new Error('no layer');
    const camera = new Camera();
    camera.heightPx = 600;
    const at = (zoom: number): [number, boolean] => {
      camera.pose.targetLatitudeRad = 0;
      camera.pose.rangeMeters = rangeForGroundZoom(zoom, camera.heightPx, camera.fovYRad);
      fadeByZoom([{ entry }], camera);
      return [shownOpacity(entry), isOpaque(entry)];
    };
    expect(at(3)).toEqual([0, false]);
    expect(at(4.25)).toEqual([0.5, false]);
    expect(at(6)).toEqual([1, true]);
    expect(() => stackEntries([{ sources: [valid], fadeIn: { fromZoom: 5, toZoom: 5 } }])).toThrow(RangeError);
  });
});

describe('matching tones only at the lowest levels (F638)', () => {
  it('matches fully up to the first zoom, partly up to the second, then not at all', () => {
    const [entry] = stackEntries([
      { id: 'cover', sources: [valid], harmonize: 'below', harmonizeFade: { fromZoom: 5, toZoom: 8 } },
    ]);
    if (!entry) throw new Error('no layer');
    const camera = new Camera();
    camera.heightPx = 600;
    const at = (zoom: number): number | undefined => {
      camera.pose.targetLatitudeRad = 0;
      camera.pose.rangeMeters = rangeForGroundZoom(zoom, camera.heightPx, camera.fovYRad);
      fadeByZoom([{ entry }], camera);
      return entry.toneStrength;
    };
    expect(at(4)).toBe(1);
    expect(at(6.5)).toBeCloseTo(0.5, 6);
    expect(at(12)).toBe(0);
    expect(() => stackEntries([{ sources: [valid], harmonizeFade: { fromZoom: 8, toZoom: 5 } }])).toThrow(RangeError);
  });
});
