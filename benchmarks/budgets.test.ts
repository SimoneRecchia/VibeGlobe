import { describe, expect, it } from 'vitest';
import { findBudgetViolations, percentile, summarize, type Budgets } from './budgets.ts';

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(samples, 0.95)).toBe(95);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe('findBudgetViolations', () => {
  const budgets: Budgets = {
    features: { loop: { scenario: 's', frameTimeP95Ms: 18, cpuFrameP95Ms: 2 } },
    packages: { core: { memoryScenario: 's', jsHeapMB: 10 }, ui: {} },
  };

  it('accepts results within budget', () => {
    expect(findBudgetViolations(budgets, { s: summarize([16, 17, 16.5], [0.5, 1], 5 * 1024 * 1024) })).toEqual([]);
  });

  it('reports every broken budget and missing scenarios', () => {
    expect(findBudgetViolations(budgets, { s: summarize([16, 40], [3], 20 * 1024 * 1024) })).toEqual([
      'loop: frame p95 40.00 ms > 18 ms',
      'loop: cpu p95 3.000 ms > 2 ms',
      'core: JS heap 20.0 MB > 10 MB',
    ]);
    expect(findBudgetViolations(budgets, {})).toEqual([
      'loop: scenario "s" did not run',
      'core: scenario "s" did not run',
    ]);
  });
});
