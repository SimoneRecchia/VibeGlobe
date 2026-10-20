// Runs the benchmark scenarios in a real browser against the production build of the playground, compares the
// results with quality/budgets.json and writes them to benchmark-results/. `--budgets <path>` uses another budget file.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { preview } from 'vite';
import { ROOT_DIR } from '../scripts/workspace.ts';
import { summarize, findBudgetViolations, type Budgets, type ScenarioResult } from './budgets.ts';

/** Playground URL query per scenario name. */
const SCENARIOS: Record<string, string> = { 'frame-loop': '?scenario=frame-loop', 'debug-overlay': '?debug=1' };
const WARM_UP_MS = 500;
const SAMPLE_MS = 3000;

async function runScenario(page: Page, url: string): Promise<ScenarioResult> {
  await page.goto(url);
  await page.waitForTimeout(WARM_UP_MS);
  const sample = await page.evaluate(async (durationMs) => {
    performance.clearMeasures('vge:frame');
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
    const cpuFrameMs = performance.getEntriesByName('vge:frame', 'measure').map((entry) => entry.duration);
    return { frameTimesMs, cpuFrameMs };
  }, SAMPLE_MS);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
  return summarize(sample.frameTimesMs, sample.cpuFrameMs, usedSize);
}

const budgetsIndex = process.argv.indexOf('--budgets');
const budgetsPath =
  budgetsIndex === -1 ? join(ROOT_DIR, 'quality/budgets.json') : (process.argv[budgetsIndex + 1] as string);
const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8')) as Budgets;

const server = await preview({ root: join(ROOT_DIR, 'apps/playground'), logLevel: 'silent', preview: { port: 4173 } });
const baseUrl = server.resolvedUrls?.local[0] ?? 'http://localhost:4173/';
const executablePath = process.env['VGE_CHROMIUM_PATH'];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const results: Record<string, ScenarioResult> = {};
try {
  const page = await browser.newPage();
  const scenarios = new Set([
    ...Object.values(budgets.features).map((feature) => feature.scenario),
    ...Object.values(budgets.packages).flatMap((pkg) => (pkg.memoryScenario ? [pkg.memoryScenario] : [])),
  ]);
  for (const scenario of scenarios) {
    const query = SCENARIOS[scenario];
    if (query === undefined) throw new Error(`Unknown benchmark scenario "${scenario}"`);
    results[scenario] = await runScenario(page, new URL(query, baseUrl).href);
  }
} finally {
  await browser.close();
  await server.close();
}

const violations = findBudgetViolations(budgets, results);
const report = {
  date: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
  device: { platform: process.platform, arch: process.arch, browser: browser.version() },
  scenarios: results,
  violations,
};
const outDir = join(ROOT_DIR, 'benchmark-results');
mkdirSync(outDir, { recursive: true });
const json = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(join(outDir, `${report.date.replace(/[:.]/g, '-')}.json`), json);
writeFileSync(join(outDir, 'latest.json'), json);

for (const [scenario, result] of Object.entries(results)) {
  const gpu = result.gpuFrameP95Ms === null ? 'n/a' : `${result.gpuFrameP95Ms.toFixed(2)} ms`;
  console.log(
    `${scenario.padEnd(16)} frame p95 ${result.frameTimeP95Ms.toFixed(2)} ms · cpu p95 ${result.cpuFrameP95Ms.toFixed(3)} ms · gpu p95 ${gpu} · heap ${result.jsHeapMB.toFixed(1)} MB`,
  );
}
for (const violation of violations) console.error(`BUDGET  ${violation}`);
if (violations.length > 0) process.exit(1);
console.log('All benchmark budgets met; results in benchmark-results/latest.json');
