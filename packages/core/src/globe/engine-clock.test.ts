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
  });

  it('clamps a stall to 100 ms and never runs backward', () => {
    const clock = new EngineClock();
    at(clock, 0);
    at(clock, 5000);
    expect(clock.timeMs).toBe(100);
    at(clock, 4000);
    expect(clock.timeMs).toBe(100);
  });

  it('advances a fixed step per frame in manual mode, whatever the timestamps', () => {
    const clock = new EngineClock(1000 / 60);
    for (const ms of [0, 0, 500, 501]) at(clock, ms);
    expect(clock.timeMs).toBeCloseTo((4 * 1000) / 60, 9);
  });
});
