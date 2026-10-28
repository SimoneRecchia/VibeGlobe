import { TONE_BELOW, type TileDrawList, type TileDrawOverlay } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { ToneMatcher } from './tone-matching.js';

/** A frame's draws: texture handles with their tone keys (-1: not matched). */
function draws(rows: readonly [texture: number, key: number, from?: number][]): TileDrawList {
  return {
    count: rows.length,
    textures: Int32Array.from(rows.map((r) => r[0])),
    fromTextures: Int32Array.from(rows.map((r) => r[2] ?? r[0])),
    toneSources: Int16Array.from(rows.map((r) => r[1])),
    overlays: [],
  } as unknown as TileDrawList;
}

describe('tone matching (F249)', () => {
  it("scales a later source toward the first source's mean, in linear light, clamped, and leaves unmatched draws", () => {
    const tones = new ToneMatcher();
    tones.measure(1, undefined, Float32Array.of(0.6, 0.6, 0.6));
    tones.measure(2, undefined, Float32Array.of(0.3, 0.6, 0.1));
    const frame = draws([
      [1, 8],
      [2, 9],
      [3, -1, 2],
    ]);
    tones.frame(frame);
    const out = new Float32Array(16);
    tones.apply(frame, 1, out);
    expect(Array.from(out.slice(0, 3))).toEqual([2 ** 2.2, 1, 2 ** 2.2].map(Math.fround));
    // The imagery a draw fades from keeps the gain of the source it was drawn as.
    tones.apply(frame, 2, out);
    expect(Array.from(out.slice(0, 3))).toEqual([1, 1, 1]);
    expect(out[4]).toBeCloseTo(2 ** 2.2, 5);
    // Out of view, the last gains stay.
    tones.frame(draws([[2, 9]]));
    tones.apply(frame, 1, out);
    expect(out[0]).toBeCloseTo(2 ** 2.2, 5);
  });

  it('matches an opaque layer to the base image under it and an overlay to the layer below where it covers it, weighted by its alpha (F633)', () => {
    const tones = new ToneMatcher();
    const whole = Float32Array.of(1, 1, 0, 0);
    // The base image: 0.6 grey everywhere; the lowest layer's tile 0.4 grey: its gain is 1.5.
    tones.measureBase(undefined, new Float32Array(256 * 128 * 4).fill(0.6));
    tones.measure(1, undefined, Float32Array.of(0.4, 0.4, 0.4));
    // The overlay's tile: its left half covered in 0.3 grey, its right half transparent water; under its left half the
    // lower tile is 0.4, so 0.6 as shown: the overlay's gain is 2, whatever lies under its transparent half.
    const overlayGrid = new Float32Array(64);
    for (let cell = 0; cell < 16; cell++)
      overlayGrid.set(cell % 4 < 2 ? [0.3, 0.3, 0.3, 1] : [0.2, 0.3, 0.4, 0], cell * 4);
    tones.measure(2, undefined, overlayGrid);
    const overlay = {
      textures: Int32Array.of(2),
      uvTransforms: whole,
      opacities: Float32Array.of(1),
      toneSources: Int16Array.of(TONE_BELOW + 8),
    } as unknown as TileDrawOverlay;
    const frame = {
      count: 1,
      textures: Int32Array.of(1),
      fromTextures: Int32Array.of(1),
      toneSources: Int16Array.of(TONE_BELOW),
      uvTransforms: whole,
      below: {
        textures: Int32Array.of(-1),
        uvTransforms: Float32Array.of(0.01, 0.01, 0.5, 0.25),
        toneSources: Int16Array.of(-1),
      },
      overlays: [overlay],
    } as unknown as TileDrawList;
    tones.frame(frame);
    const out = new Float32Array(16);
    tones.apply(frame, 0, out);
    expect(out[0]).toBeCloseTo(1.5 ** 2.2, 4);
    const gains = new Float32Array(3);
    tones.applyOverlay(overlay, 0, gains, 0);
    expect(gains[0]).toBeCloseTo(2 ** 2.2, 4);
  });
});
