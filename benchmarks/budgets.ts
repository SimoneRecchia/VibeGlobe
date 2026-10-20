// Benchmark statistics and budget comparison (ADR 0012), kept free of browser and file access for unit tests.

export interface Budgets {
  features: Record<string, { scenario: string; frameTimeP95Ms: number; cpuFrameP95Ms: number }>;
  packages: Record<string, { memoryScenario?: string; jsHeapMB?: number }>;
}

export interface Distribution {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface RunResult {
  frames: number;
  /** `over16_7`: frames that missed at least one 60 Hz refresh; `over33_3`: at least two (ADR 0014). */
  frameTimeMs: Distribution & { over16_7: number; over33_3: number };
  cpuFrameMs: Distribution;
  jsHeapMB: number;
  /** Not measurable before the engine exists; recorded as `null` until M2–M3 (ADR 0013). */
  gpuFrameMs: Distribution | null;
  gpuMemoryMB: number | null;
  startupMs: number | null;
  steadyStateAllocations: number | null;
}

// rAF intervals carry vsync and timestamp-coarsening jitter, so a frame counts as late only beyond it (ADR 0014): an
// on-time 16.8 ms interval is not late, a 33.3 ms one missed one refresh, a 50 ms one missed two.
const TIMER_JITTER_MS = 0.5;

export interface ScenarioSummary {
  runs: RunResult[];
  /** Medians over the runs of each run's p95 (and of the heap), which the budgets are checked against. */
  frameTimeP95Ms: number;
  cpuFrameP95Ms: number;
  jsHeapMB: number;
}

/** The value below which `fraction` of the samples fall (nearest-rank method); 0 for no samples. */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] as number;
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

export function distribution(samples: readonly number[]): Distribution {
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: samples.length === 0 ? 0 : Math.max(...samples),
  };
}

export function summarizeRun(
  frameTimesMs: readonly number[],
  cpuFrameMs: readonly number[],
  jsHeapBytes: number,
): RunResult {
  return {
    frames: frameTimesMs.length,
    frameTimeMs: {
      ...distribution(frameTimesMs),
      over16_7: frameTimesMs.filter((time) => time > 16.7 + TIMER_JITTER_MS).length,
      over33_3: frameTimesMs.filter((time) => time > 33.3 + TIMER_JITTER_MS).length,
    },
    cpuFrameMs: distribution(cpuFrameMs),
    jsHeapMB: jsHeapBytes / (1024 * 1024),
    gpuFrameMs: null,
    gpuMemoryMB: null,
    startupMs: null,
    steadyStateAllocations: null,
  };
}

export function summarizeScenario(runs: RunResult[]): ScenarioSummary {
  return {
    runs,
    frameTimeP95Ms: median(runs.map((run) => run.frameTimeMs.p95)),
    cpuFrameP95Ms: median(runs.map((run) => run.cpuFrameMs.p95)),
    jsHeapMB: median(runs.map((run) => run.jsHeapMB)),
  };
}

export function findBudgetViolations(budgets: Budgets, summaries: Record<string, ScenarioSummary>): string[] {
  const violations: string[] = [];
  for (const [feature, budget] of Object.entries(budgets.features)) {
    const summary = summaries[budget.scenario];
    if (!summary) violations.push(`${feature}: scenario "${budget.scenario}" did not run`);
    else {
      if (summary.frameTimeP95Ms > budget.frameTimeP95Ms)
        violations.push(
          `${feature}: median frame p95 ${summary.frameTimeP95Ms.toFixed(2)} ms > ${budget.frameTimeP95Ms} ms`,
        );
      if (summary.cpuFrameP95Ms > budget.cpuFrameP95Ms)
        violations.push(
          `${feature}: median cpu p95 ${summary.cpuFrameP95Ms.toFixed(3)} ms > ${budget.cpuFrameP95Ms} ms`,
        );
    }
  }
  for (const [pkg, budget] of Object.entries(budgets.packages)) {
    if (budget.memoryScenario === undefined || budget.jsHeapMB === undefined) continue;
    const summary = summaries[budget.memoryScenario];
    if (!summary) violations.push(`${pkg}: scenario "${budget.memoryScenario}" did not run`);
    else if (summary.jsHeapMB > budget.jsHeapMB)
      violations.push(`${pkg}: median JS heap ${summary.jsHeapMB.toFixed(1)} MB > ${budget.jsHeapMB} MB`);
  }
  return violations;
}
