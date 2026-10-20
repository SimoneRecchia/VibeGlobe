// Benchmark statistics and budget comparison, kept free of browser and file access so they can be unit tested.

export interface Budgets {
  features: Record<string, { scenario: string; frameTimeP95Ms: number; cpuFrameP95Ms: number }>;
  packages: Record<string, { memoryScenario?: string; jsHeapMB?: number }>;
}

export interface ScenarioResult {
  frames: number;
  frameTimeP95Ms: number;
  cpuFrameP95Ms: number;
  /** GPU frame time, `null` until the active backend exposes timestamp queries. */
  gpuFrameP95Ms: number | null;
  jsHeapMB: number;
  /** GPU memory, `null` until the renderer reports it. */
  gpuMemoryMB: number | null;
}

/** The value below which `fraction` of the samples fall (nearest-rank method); 0 for no samples. */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] as number;
}

export function summarize(
  frameTimesMs: readonly number[],
  cpuFrameMs: readonly number[],
  jsHeapBytes: number,
): ScenarioResult {
  return {
    frames: frameTimesMs.length,
    frameTimeP95Ms: percentile(frameTimesMs, 0.95),
    cpuFrameP95Ms: percentile(cpuFrameMs, 0.95),
    gpuFrameP95Ms: null,
    jsHeapMB: jsHeapBytes / (1024 * 1024),
    gpuMemoryMB: null,
  };
}

export function findBudgetViolations(budgets: Budgets, results: Record<string, ScenarioResult>): string[] {
  const violations: string[] = [];
  for (const [feature, budget] of Object.entries(budgets.features)) {
    const result = results[budget.scenario];
    if (!result) violations.push(`${feature}: scenario "${budget.scenario}" did not run`);
    else {
      if (result.frameTimeP95Ms > budget.frameTimeP95Ms)
        violations.push(`${feature}: frame p95 ${result.frameTimeP95Ms.toFixed(2)} ms > ${budget.frameTimeP95Ms} ms`);
      if (result.cpuFrameP95Ms > budget.cpuFrameP95Ms)
        violations.push(`${feature}: cpu p95 ${result.cpuFrameP95Ms.toFixed(3)} ms > ${budget.cpuFrameP95Ms} ms`);
    }
  }
  for (const [pkg, budget] of Object.entries(budgets.packages)) {
    if (budget.memoryScenario === undefined || budget.jsHeapMB === undefined) continue;
    const result = results[budget.memoryScenario];
    if (!result) violations.push(`${pkg}: scenario "${budget.memoryScenario}" did not run`);
    else if (result.jsHeapMB > budget.jsHeapMB)
      violations.push(`${pkg}: JS heap ${result.jsHeapMB.toFixed(1)} MB > ${budget.jsHeapMB} MB`);
  }
  return violations;
}
