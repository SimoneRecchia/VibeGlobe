import { describe, expect, it } from 'vitest';
import { EngineClock } from './engine-clock.js';

describe('EngineClock (ADR 0009, ADR 0012)', () => {
  const at = (clock: EngineClock, ms: number): void => clock.advance(Float64Array.of(ms));

  it('advances by the display step, starting at zero', () => {
    const clock = new EngineClock();
    at(clock, 1000);
    expect(clock.timeMs).toBe(0);
    at(clock, 1016.5);
    at(clock, 1033);
    expect(clock.timeMs).toBeCloseTo(33, 9);
    expect(clock.deltaMs).toBeCloseTo(16.5, 9);
    const out = new Float64Array(1);
    clock.timeInto(out);
    expect(out[0]).toBe(clock.timeMs);
  });

  it('clamps a stall to 100 ms and never runs backward', () => {
    const clock = new EngineClock();
    at(clock, 0);
    at(clock, 5000);
    expect(clock.timeMs).toBe(100);
    at(clock, 4000);
    expect(clock.timeMs).toBe(100);
  });

  it('takes back a manual step for a frame that was not drawn, and keeps real time (KB-058)', () => {
    const manual = new EngineClock(10);
    at(manual, 0);
    manual.skipped();
    at(manual, 16);
    expect(manual.timeMs).toBe(10);
    const real = new EngineClock();
    at(real, 0);
    at(real, 16);
    real.skipped();
    expect(real.timeMs).toBe(16);
  });

  it('takes back a skipped frame exactly, also for a step that is not a binary fraction (KB-060)', () => {
    const step = 1000 / 60;
    const skipping = new EngineClock(step);
    const drawing = new EngineClock(step);
    // A frame that was not drawn before every drawn one: each position in the sequence is tried.
    for (let frame = 0; frame < 100; frame++) {
      at(skipping, frame);
      skipping.skipped();
      expect(skipping.timeMs).toBe(drawing.timeMs);
      at(skipping, frame);
      at(drawing, frame);
      expect(skipping.timeMs).toBe(drawing.timeMs);
    }
  });

  it('advances a fixed step per frame in manual mode, whatever the timestamps', () => {
    const clock = new EngineClock(1000 / 60);
    for (const ms of [0, 0, 500, 501]) at(clock, ms);
    expect(clock.timeMs).toBeCloseTo((4 * 1000) / 60, 9);
  });
});
