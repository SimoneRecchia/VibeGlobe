import { describe, expect, it } from 'vitest';
import { FrameTimeGovernor, GOVERNOR_DEFAULTS, type GovernorDecision } from './index.js';

/**
 * Runs frames until `durationMs`: each frame lasts `frameMs(level, t)`, the cost of the level the governor chose.
 * Returns every decision with its time.
 */
function simulate(
  governor: FrameTimeGovernor,
  durationMs: number,
  frameMs: (level: number, timeMs: number) => number,
  startMs = 0,
): (GovernorDecision & { atMs: number })[] {
  const decisions: (GovernorDecision & { atMs: number })[] = [];
  for (let t = startMs; t < startMs + durationMs;) {
    t += frameMs(governor.level, t);
    const decision = governor.frame(t);
    if (decision) decisions.push({ ...decision, atMs: t });
  }
  return decisions;
}

/** A fill-bound load: each level saves 12 % of the frame. */
const load = (baseMs: number) => (level: number) => baseMs * 0.88 ** level;

describe('FrameTimeGovernor', () => {
  it('lowers within the reaction time when frames exceed the target, until frame time is back within it', () => {
    // No raise tried within the run: the lowering alone is under test.
    const governor = new FrameTimeGovernor(10, { probeMs: 60_000 });
    simulate(governor, 2000, () => 10);
    const decisions = simulate(governor, 20_000, load(25), 2000);
    // First reaction: the window fills (30 frames of 25 ms) and the median stays over for reactionMs.
    expect(decisions[0]?.direction).toBe('lower');
    expect((decisions[0]?.atMs ?? Infinity) - 2000).toBeLessThanOrEqual(30 * 25 + GOVERNOR_DEFAULTS.reactionMs + 25);
    expect(decisions.every((d) => d.direction === 'lower')).toBe(true);
    expect(load(25)(governor.level)).toBeLessThanOrEqual(
      GOVERNOR_DEFAULTS.targetFrameMs * GOVERNOR_DEFAULTS.lowerAbove,
    );
  });

  it('ignores isolated slow frames and idle gaps', () => {
    const governor = new FrameTimeGovernor(10);
    // Every tenth frame takes 60 ms: the median stays at 10 ms.
    let n = 0;
    expect(simulate(governor, 30_000, () => (++n % 10 === 0 ? 60 : 10))).toEqual([]);
    // A 5-second idle gap is no slow frame.
    governor.frame(40_000);
    governor.frame(45_000);
    expect(simulate(governor, 2000, () => 10, 45_000)).toEqual([]);
  });

  it('raises back step by step to the preset once frames are stable for the stable interval', () => {
    const governor = new FrameTimeGovernor(10);
    simulate(governor, 20_000, load(25));
    const lowered = governor.level;
    expect(lowered).toBeGreaterThan(1);
    const decisions = simulate(governor, 60_000, () => 8, 20_000);
    expect(decisions.map((d) => d.level)).toEqual([...Array(lowered).keys()].reverse());
    let previous = 20_000;
    for (const d of decisions) {
      expect(d.direction).toBe('raise');
      expect(d.atMs - previous).toBeGreaterThanOrEqual(GOVERNOR_DEFAULTS.stableMs);
      previous = d.atMs;
    }
  });

  it('a load hovering around the threshold for 5 minutes changes quality no more often than the minimum interval', () => {
    const governor = new FrameTimeGovernor(10);
    // The load swings ±25 % around the lowering threshold every 1.3 s, and the level saves 12 % per step.
    const threshold = GOVERNOR_DEFAULTS.targetFrameMs * GOVERNOR_DEFAULTS.lowerAbove;
    const decisions = simulate(
      governor,
      300_000,
      (level, t) => threshold * (1 + 0.25 * Math.sin(t / 207)) * 0.88 ** level,
    );
    for (let i = 1; i < decisions.length; i++)
      expect((decisions[i]?.atMs ?? 0) - (decisions[i - 1]?.atMs ?? 0)).toBeGreaterThanOrEqual(
        GOVERNOR_DEFAULTS.minChangeIntervalMs,
      );
    // It settles: after the first minute, at most a handful of changes, and never a raise-lower ping-pong per minute.
    expect(decisions.filter((d) => d.atMs > 60_000).length).toBeLessThanOrEqual(4);
  });

  it('backs off raising after a raise is undone', () => {
    const governor = new FrameTimeGovernor(10, { stableMs: 1000, minChangeIntervalMs: 500 });
    // Level 0 is too slow (20 ms), level 1 is very fast (8 ms): a raise is always undone.
    const decisions = simulate(governor, 60_000, (level) => (level === 0 ? 20 : 8));
    const raises = decisions.filter((d) => d.direction === 'raise').map((d) => d.atMs);
    const gaps = raises.slice(1).map((t, i) => t - (raises[i] ?? 0));
    expect(gaps.length).toBeGreaterThan(2);
    // The wait doubles on every undone raise, up to 8 × stableMs.
    expect(gaps[0]).toBeLessThan(4000);
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(8000);
    expect(governor.raiseWaitMs).toBe(8000);
  });

  it('raises back on a screen that never draws faster than the target, and backs off when the raise is too much', () => {
    const governor = new FrameTimeGovernor(10);
    // A slow spell (tiles arriving) lowers quality; then every frame waits for the 60 Hz refresh.
    simulate(governor, 10_000, load(25));
    const lowered = governor.level;
    expect(lowered).toBeGreaterThan(0);
    const refresh = 1000 / 60;
    const back = simulate(governor, 10 * GOVERNOR_DEFAULTS.probeMs * 2, () => refresh, 10_000);
    expect(back.every((d) => d.direction === 'raise')).toBe(true);
    expect(governor.level).toBe(0);
    for (let i = 1; i < back.length; i++)
      expect((back[i]?.atMs ?? 0) - (back[i - 1]?.atMs ?? 0)).toBeGreaterThanOrEqual(GOVERNOR_DEFAULTS.probeMs);
    // Where level 0 is too slow, a tried raise is undone and the tries grow rarer.
    const tight = new FrameTimeGovernor(10);
    const decisions = simulate(tight, 600_000, (level) => (level === 0 ? 25 : refresh));
    const raises = decisions.filter((d) => d.direction === 'raise').map((d) => d.atMs);
    const gaps = raises.slice(1).map((t, i) => t - (raises[i] ?? 0));
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(8 * GOVERNOR_DEFAULTS.probeMs);
  });

  it('adapts on a device drawing a few frames a second, and an idle engine is no slow frame', () => {
    const governor = new FrameTimeGovernor(10);
    // 300 ms frames: under the gap that restarts the measurement, so they count.
    const decisions = simulate(governor, 60_000, (level) => 300 * 0.88 ** level);
    expect(decisions[0]?.direction).toBe('lower');
    const idle = new FrameTimeGovernor(10);
    simulate(idle, 2000, () => 10);
    // The engine idles for a second: the frame after it starts a new measurement.
    idle.idle();
    idle.frame(3000);
    expect(simulate(idle, 100, () => 10, 3000)).toEqual([]);
    // Ten frames since: the window starts over instead of holding a one-second frame.
    expect(idle.median()).toBeNaN();
  });

  it('stays within its levels', () => {
    const governor = new FrameTimeGovernor(3);
    simulate(governor, 60_000, () => 100);
    expect(governor.level).toBe(2);
    governor.reset(5);
    expect(governor.level).toBe(2);
    simulate(governor, 60_000, () => 5);
    expect(governor.level).toBe(0);
  });
});
