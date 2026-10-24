import type { TileDrawList } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { ToneMatcher } from './tone-matching.js';

/** A frame's draws: texture handles with their tone keys (-1: not matched). */
function draws(rows: readonly [texture: number, key: number, from?: number][]): TileDrawList {
  return {
    count: rows.length,
    textures: Int32Array.from(rows.map((r) => r[0])),
    fromTextures: Int32Array.from(rows.map((r) => r[2] ?? r[0])),
    toneSources: Int16Array.from(rows.map((r) => r[1])),
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
});
