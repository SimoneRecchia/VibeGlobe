// Scenario benchmarks with the method of ADR 0012: per scenario one discarded warm-up run, then 5 runs in fresh pages,
// each discarding its first 2 s; budgets in quality/budgets.json are checked against the median of the per-run p95.
// Results go to benchmarks/results/<device>/ (device from VIBEGLOBE_DEVICE, default "local").
// Options: --budgets <path> uses another budget file; --report-only records without failing (CI on SwiftShader, where
// timings are not meaningful and only deterministic counters are gated).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { preview } from 'vite';
import { ROOT_DIR } from '../scripts/workspace.ts';
import {
  findBudgetViolations,
  summarizeRun,
  summarizeScenario,
  type Budgets,
  type RunResult,
  type ScenarioSummary,
} from './budgets.ts';

/** Playground URL query per scenario name. */
const SCENARIOS: Record<string, string> = { 'frame-loop': '?scenario=frame-loop', 'debug-overlay': '?debug=1' };
const RUNS = 5;
const DISCARD_MS = 2000;
const SAMPLE_MS = 3000;

interface PlaygroundHooks {
  cpuFrameTimesMs(): number[];
  resetCpuSamples(): void;
}

async function measureRun(browser: Browser, url: string): Promise<RunResult> {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    await page.waitForFunction(() => 'vibeglobePlayground' in window);
    await page.waitForTimeout(DISCARD_MS);
    const sample = await page.evaluate(async (durationMs) => {
      const hooks = (window as unknown as { vibeglobePlayground: PlaygroundHooks }).vibeglobePlayground;
      hooks.resetCpuSamples();
      const timestamps: number[] = [];
      await new Promise<void>((done) => {
        const start = performance.now();
        const tick = (time: number): void => {
          timestamps.push(time);
          if (time - start < durationMs) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      const frameTimesMs = timestamps.slice(1).map((time, index) => time - (timestamps[index] as number));
      return { frameTimesMs, cpuFrameMs: hooks.cpuFrameTimesMs() };
    }, SAMPLE_MS);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
    return summarizeRun(sample.frameTimesMs, sample.cpuFrameMs, usedSize);
  } finally {
    await page.close();
  }
}

async function describeDevice(browser: Browser, url: string): Promise<Record<string, unknown>> {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const display = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        gpu: gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : 'unavailable',
        pixelRatio: devicePixelRatio,
        resolution: { width: innerWidth, height: innerHeight },
      };
    });
    return {
      name: process.env['VIBEGLOBE_DEVICE'] ?? 'local',
      os: `${process.platform} ${release()}`,
      browser: `chromium ${browser.version()}`,
      ...display,
    };
  } finally {
    await page.close();
  }
}

const budgetsIndex = process.argv.indexOf('--budgets');
const budgetsPath =
  budgetsIndex === -1 ? join(ROOT_DIR, 'quality/budgets.json') : (process.argv[budgetsIndex + 1] as string);
const reportOnly = process.argv.includes('--report-only');
const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8')) as Budgets;
const scenarios = new Set([
  ...Object.values(budgets.features).map((feature) => feature.scenario),
  ...Object.values(budgets.packages).flatMap((pkg) => (pkg.memoryScenario ? [pkg.memoryScenario] : [])),
]);

const server = await preview({ root: join(ROOT_DIR, 'apps/playground'), logLevel: 'silent', preview: { port: 4173 } });
const baseUrl = server.resolvedUrls?.local[0] ?? 'http://localhost:4173/';
const executablePath = process.env['VIBEGLOBE_CHROMIUM_PATH'];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const summaries: Record<string, ScenarioSummary> = {};
let device: Record<string, unknown> | undefined;
try {
  device = await describeDevice(browser, baseUrl);
  for (const scenario of scenarios) {
    const query = SCENARIOS[scenario];
    if (query === undefined) throw new Error(`Unknown benchmark scenario "${scenario}"`);
    const url = new URL(query, baseUrl).href;
    await measureRun(browser, url);
    const runs: RunResult[] = [];
    for (let run = 0; run < RUNS; run++) runs.push(await measureRun(browser, url));
    summaries[scenario] = summarizeScenario(runs);
  }
} finally {
  await browser.close();
  await server.close();
}

const violations = findBudgetViolations(budgets, summaries);
const date = new Date().toISOString();
const report = {
  schemaVersion: 1,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
  date,
  device: device ?? {},
  method: {
    warmUpRuns: 1,
    runs: RUNS,
    discardMs: DISCARD_MS,
    sampleMs: SAMPLE_MS,
    budgetStatistic: 'median of per-run p95',
  },
  scenarios: summaries,
  violations,
};
const outDir = join(ROOT_DIR, 'benchmarks/results', String(device?.['name'] ?? 'local'));
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${date.replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

for (const [scenario, summary] of Object.entries(summaries)) {
  console.log(
    `${scenario.padEnd(16)} frame p95 (median of ${RUNS}) ${summary.frameTimeP95Ms.toFixed(2)} ms · cpu p95 ${summary.cpuFrameP95Ms.toFixed(3)} ms · heap ${summary.jsHeapMB.toFixed(1)} MB · gpu n/a`,
  );
}
for (const violation of violations) console.error(`BUDGET  ${violation}`);
console.log(`Results: ${outFile}`);
if (violations.length > 0 && !reportOnly) process.exit(1);
