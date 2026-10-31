import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { rangeForGroundZoom } from '../camera/zoom.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import type { ImagerySource } from './imagery-source.js';
import {
  applyChanges,
  fadeByZoom,
  LAYER_FADE_MS,
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

describe('fading a layer with the zoom in time (F670)', () => {
  const camera = new Camera();
  camera.heightPx = 600;
  const zoomTo = (zoom: number): void => {
    camera.pose.targetLatitudeRad = 0;
    camera.pose.rangeMeters = rangeForGroundZoom(zoom, camera.heightPx, camera.fovYRad);
  };

  it('changes opacity no faster than once over the layer fade time, a slow zoom at its own pace', () => {
    const [entry] = stackEntries([{ id: 'fine', sources: [valid], fadeIn: { fromZoom: 11, toZoom: 12 } }]);
    if (!entry) throw new Error('no layer');
    const time = Float64Array.of(0, Number.NaN);
    zoomTo(4);
    expect(fadeByZoom([{ entry }], camera, time)).toBe(false);
    expect(shownOpacity(entry)).toBe(0);
    // A fast zoom from 4 to 13 in one 100 ms frame: the opacity moves a sixth of the way, and the frames go on.
    time[0] = 100;
    zoomTo(13);
    expect(fadeByZoom([{ entry }], camera, time)).toBe(true);
    expect(shownOpacity(entry)).toBeCloseTo(100 / LAYER_FADE_MS, 9);
    for (let ms = 200; ms <= LAYER_FADE_MS + 100; ms += 100) {
      time[0] = ms;
      fadeByZoom([{ entry }], camera, time);
    }
    expect(shownOpacity(entry)).toBe(1);
    expect(fadeByZoom([{ entry }], camera, time)).toBe(false);
    // A slow zoom out, a tenth of a level per 100 ms frame: the opacity follows the zoom.
    for (let step = 1; step <= 5; step++) {
      time[0] += 100;
      zoomTo(12 - step / 10);
      fadeByZoom([{ entry }], camera, time);
      expect(shownOpacity(entry)).toBeCloseTo(1 - step / 10, 9);
    }
  });

  it('starts a layer added on a running globe at its value, and cuts fades short only where layers change role or slot (KB-307)', () => {
    const transparent = { ...valid, id: 'clipped', transparent: true };
    const [entry] = stackEntries([{ sources: [transparent], fadeIn: { fromZoom: 4, toZoom: 5 } }]);
    if (!entry) throw new Error('no layer');
    const time = Float64Array.of(1000, 900);
    zoomTo(3);
    fadeByZoom([{ entry }], camera, time);
    expect(shownOpacity(entry)).toBe(0);
    // Through to full opacity in steps: never opaque, alone in the stack, so no fade is cut short.
    const snaps = [{ snapNext: false }, { snapNext: false }];
    zoomTo(6);
    for (let ms = 1100; ms <= 1000 + LAYER_FADE_MS + 100; ms += 100) {
      time[0] = ms;
      fadeByZoom([{ entry }], camera, time, snaps);
    }
    expect(shownOpacity(entry)).toBe(1);
    expect(snaps.map((fades) => fades.snapNext)).toEqual([false, false]);
    // An opaque layer turning translucent cuts every draw's fades short; one appearing under it, the slots'.
    const [base, under] = stackEntries([
      { id: 'base', sources: [valid], fadeIn: { fromZoom: 4, toZoom: 5 } },
      { id: 'under', sources: [transparent], fadeIn: { fromZoom: 7, toZoom: 8 } },
    ]);
    if (!base || !under) throw new Error('no layers');
    const layers = [{ entry: under }, { entry: base }];
    fadeByZoom(layers, camera);
    zoomTo(7.5);
    fadeByZoom(layers, camera, Float64Array.of(1, 0), snaps);
    expect(snaps.map((fades) => fades.snapNext)).toEqual([false, true]);
    snaps[1] = { snapNext: false };
    zoomTo(4.5);
    fadeByZoom(layers, camera, Float64Array.of(1, 0), snaps);
    expect(snaps.map((fades) => fades.snapNext)).toEqual([true, true]);
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
