import { describe, expect, it } from 'vitest';
import {
  distribution,
  findBudgetViolations,
  median,
  percentile,
  summarizeRun,
  summarizeScenario,
  type Budgets,
} from './budgets.ts';

describe('statistics', () => {
  it('uses the nearest-rank method', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(samples, 0.95)).toBe(95);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([], 0.95)).toBe(0);
    expect(median([4, 1, 9, 7, 3])).toBe(4);
  });

  it('summarizes a run with p50, p95, p99, max and the frames over 16.7 and 33.3 ms', () => {
    const frames = [...Array.from({ length: 97 }, () => 16.6), 17, 20, 40];
    const run = summarizeRun(frames, [0.5, 1, 2], 3 * 1024 * 1024);
    expect(run.frameTimeMs).toEqual({ ...distribution(frames), over16_7: 2, over33_3: 1 });
    expect(run.frameTimeMs.p99).toBe(20);
    expect(run.frameTimeMs.max).toBe(40);
    expect(run.cpuFrameMs.max).toBe(2);
    expect(run.jsHeapMB).toBe(3);
  });

  it('counts late frames with a tolerance for vsync timer jitter', () => {
    const onTime = [16.6, 16.7, 16.8, 16.8, 17.1];
    const dropped = [33.2999, 33.4, 50];
    const run = summarizeRun([...onTime, ...dropped], [], 0);
    expect(run.frameTimeMs.over16_7).toBe(3);
    expect(run.frameTimeMs.over33_3).toBe(1);
  });

  it('reports what the engine cannot measure yet as null', () => {
    const run = summarizeRun([16.7], [0.1], 0);
    expect(run).toMatchObject({ gpuFrameMs: null, gpuMemoryMB: null, startupMs: null, steadyStateAllocations: null });
  });

  it('checks budgets against the median of the per-run p95 values', () => {
    const runs = [16.7, 16.8, 30, 16.6, 16.7].map((p95) => summarizeRun([p95], [1], 1024 * 1024));
    expect(summarizeScenario(runs).frameTimeP95Ms).toBe(16.7);
  });
});

describe('findBudgetViolations', () => {
  const budgets: Budgets = {
    features: { loop: { scenario: 's', frameTimeP95Ms: 18, cpuFrameP95Ms: 2 } },
    packages: { core: { memoryScenario: 's', jsHeapMB: 10 }, ui: {} },
  };

  it('accepts results within budget', () => {
    const summary = summarizeScenario([summarizeRun([16, 17, 16.5], [0.5, 1], 5 * 1024 * 1024)]);
    expect(findBudgetViolations(budgets, { s: summary })).toEqual([]);
  });

  it('reports every broken budget and missing scenarios', () => {
    const summary = summarizeScenario([summarizeRun([16, 40], [3], 20 * 1024 * 1024)]);
    expect(findBudgetViolations(budgets, { s: summary })).toEqual([
      'loop: median frame p95 40.00 ms > 18 ms',
      'loop: median cpu p95 3.000 ms > 2 ms',
      'core: median JS heap 20.0 MB > 10 MB',
    ]);
    expect(findBudgetViolations(budgets, {})).toEqual([
      'loop: scenario "s" did not run',
      'core: scenario "s" did not run',
    ]);
  });
});
