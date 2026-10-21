// Benchmark statistics and budget comparison (ADR 0012), kept free of browser and file access for unit tests.

export interface Budgets {
  /** `gpuFrameP95Ms` is checked only where the GPU time was measured (timestamp queries; not on SwiftShader). */
  features: Record<string, { scenario: string; frameTimeP95Ms: number; cpuFrameP95Ms: number; gpuFrameP95Ms?: number }>;
  packages: Record<string, { memoryScenario?: string; jsHeapMB?: number }>;
  /**
   * Time from navigation to the first complete frame, served from a local server (F546): the median over the
   * scenario's runs, and the p90 over the cold runs (fresh context, cache disabled; ADR 0012).
   */
  startup?: { scenario: string; firstFrameMedianMs: number; firstFrameP90Ms?: number };
  /** Streaming (F564): the deterministic counter gated; timings, tiles, requests and memory are recorded. */
  streaming?: { scenario: string; maxFailedTiles: number };
}

/** Imagery counters of a streaming run, read at its end (F564). */
export interface StreamingCounters {
  tiles: number;
  requests: number;
  failed: number;
  gpuMB: number;
  ramMB: number;
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
  /** Draw calls of the last frame sampled, which the `drag-*` scenarios are named after; null when not read. */
  drawCalls: number | null;
  /** Imagery counters at the end of the run; null without tiled imagery. */
  streaming?: StreamingCounters | null;
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
  /** Median time to the first complete frame, or null when a run did not record it. */
  startupMs: number | null;
  /** Median of the runs' draw calls, or null when a run did not record them. */
  drawCalls: number | null;
  /** Median of the per-run GPU frame p95, or null when a run measured no GPU time. */
  gpuFrameP95Ms: number | null;
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
  startupMs: number | null = null,
  drawCalls: number | null = null,
  gpuFrameMs: readonly number[] = [],
  streaming: StreamingCounters | null = null,
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
    gpuFrameMs: gpuFrameMs.length > 0 ? distribution(gpuFrameMs) : null,
    gpuMemoryMB: null,
    startupMs,
    steadyStateAllocations: null,
    drawCalls,
    streaming,
  };
}

export function summarizeScenario(runs: RunResult[]): ScenarioSummary {
  return {
    runs,
    frameTimeP95Ms: median(runs.map((run) => run.frameTimeMs.p95)),
    cpuFrameP95Ms: median(runs.map((run) => run.cpuFrameMs.p95)),
    jsHeapMB: median(runs.map((run) => run.jsHeapMB)),
    startupMs: runs.every((run) => run.startupMs !== null) ? median(runs.map((run) => run.startupMs ?? 0)) : null,
    drawCalls: runs.every((run) => run.drawCalls !== null) ? median(runs.map((run) => run.drawCalls ?? 0)) : null,
    gpuFrameP95Ms: runs.every((run) => run.gpuFrameMs !== null)
      ? median(runs.map((run) => run.gpuFrameMs?.p95 ?? 0))
      : null,
  };
}

/**
 * Lists every broken budget. `coldStartsMs` holds the times to the first complete frame of the cold runs, checked
 * against `startup.firstFrameP90Ms` when that budget is set.
 */
export function findBudgetViolations(
  budgets: Budgets,
  summaries: Record<string, ScenarioSummary>,
  coldStartsMs: readonly number[] = [],
): string[] {
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
      const gpu = summary.gpuFrameP95Ms;
      if (budget.gpuFrameP95Ms !== undefined && gpu !== null && gpu > budget.gpuFrameP95Ms)
        violations.push(`${feature}: median gpu p95 ${gpu.toFixed(3)} ms > ${budget.gpuFrameP95Ms} ms`);
    }
  }
  for (const [pkg, budget] of Object.entries(budgets.packages)) {
    if (budget.memoryScenario === undefined || budget.jsHeapMB === undefined) continue;
    const summary = summaries[budget.memoryScenario];
    if (!summary) violations.push(`${pkg}: scenario "${budget.memoryScenario}" did not run`);
    else if (summary.jsHeapMB > budget.jsHeapMB)
      violations.push(`${pkg}: median JS heap ${summary.jsHeapMB.toFixed(1)} MB > ${budget.jsHeapMB} MB`);
  }
  if (budgets.startup) {
    const { scenario, firstFrameMedianMs } = budgets.startup;
    const startupMs = summaries[scenario]?.startupMs;
    if (startupMs === undefined) violations.push(`startup: scenario "${scenario}" did not run`);
    else if (startupMs === null) violations.push(`startup: scenario "${scenario}" recorded no time to the first frame`);
    else if (startupMs > firstFrameMedianMs)
      violations.push(
        `startup: median time to the first complete frame ${startupMs.toFixed(0)} ms > ${firstFrameMedianMs} ms`,
      );
    const { firstFrameP90Ms } = budgets.startup;
    if (firstFrameP90Ms !== undefined) {
      const p90 = percentile(coldStartsMs, 0.9);
      if (coldStartsMs.length === 0) violations.push('startup: no cold run recorded a time to the first frame');
      else if (p90 > firstFrameP90Ms)
        violations.push(
          `startup: p90 time to the first complete frame over ${coldStartsMs.length} cold runs ${p90.toFixed(0)} ms > ${firstFrameP90Ms} ms`,
        );
    }
  }
  if (budgets.streaming) {
    const { scenario, maxFailedTiles } = budgets.streaming;
    const runs = summaries[scenario]?.runs;
    if (!runs) violations.push(`streaming: scenario "${scenario}" did not run`);
    else {
      const failed = Math.max(...runs.map((run) => run.streaming?.failed ?? Infinity));
      if (failed > maxFailedTiles) violations.push(`streaming: ${failed} failed tiles > ${maxFailedTiles}`);
    }
  }
  return violations;
}

/**
 * True for a violation of a deterministic counter (the streaming scenario's failed tiles, F564): it does not depend on
 * the machine's speed, so it fails the run even with `--report-only`, which only waives the timing budgets.
 */
export function isDeterministicViolation(violation: string): boolean {
  return violation.startsWith('streaming:');
}
