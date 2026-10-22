import { readFileSync } from 'node:fs';
import type { FrameCapture, Globe } from '@vibeglobe/core';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { checkFrame, countPops, emptyReport } from './scenario-harness.js';

/** Two frames captured once from the playground (`?fadeMs=0`), before and after finer imagery arrived. */
function frame(name: string): FrameCapture {
  const png = PNG.sync.read(readFileSync(new URL(`./__fixtures__/${name}.png`, import.meta.url)));
  return { widthPx: png.width, heightPx: png.height, rgba: new Uint8ClampedArray(png.data) } as FrameCapture;
}

/** The globe fills these frames: every pixel hits it, on flat ground at the ellipsoid. */
const filling = {
  screenToGeo: () => ({ longitudeDeg: 0, latitudeDeg: 0, heightMeters: 0 }),
  elevationAt: () => ({ heightMeters: 0 }),
} as unknown as Globe;

describe('scenario checks on saved frames (F562, F563)', () => {
  it('the frame-difference check fires on two frames that differ by a pop, and not on a frame and itself', () => {
    const before = frame('pop-before');
    expect(countPops(before, frame('pop-after'))).toBeGreaterThan(100);
    expect(countPops(before, before)).toBe(0);
  });

  it('the hole check fires on a frame with a missing tile and reports where', () => {
    const capture = frame('pop-after');
    const clean = emptyReport();
    checkFrame(filling, capture, { widthPx: capture.widthPx, heightPx: capture.heightPx }, clean, 0);
    expect(clean.holes).toBe(0);
    // A tile not drawn leaves the cleared canvas: transparent pixels.
    for (let y = 40; y < 60; y++) for (let x = 60; x < 90; x++) capture.rgba[(y * capture.widthPx + x) * 4 + 3] = 0;
    const missing = emptyReport();
    checkFrame(filling, capture, { widthPx: capture.widthPx, heightPx: capture.heightPx }, missing, 7);
    expect(missing.holes).toBeGreaterThan(0);
    expect(missing.firstHoleFrame).toBe(7);
  });
});
