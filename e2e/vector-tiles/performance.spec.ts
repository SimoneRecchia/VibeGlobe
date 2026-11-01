// F443: during a fast pan and zoom over the dense fixture city, vector tiles are decoded and tessellated only on worker
// threads, the vector tile work on the main thread stays within its per-frame budget, and no main-thread task runs
// over 50 ms while tiles load.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { hardwareGpu } from '../../scripts/browser/gpu-args.ts';
import { openVector, settle } from './support.ts';

test.use({ viewport: { width: 480, height: 360 } });

/** Vector tile main-thread time per frame while moving, p95 (ADR 0131; within the 6 ms frame of docs/internal/plan/quality.md). */
const VECTOR_CPU_BUDGET_MS = 4;
const LONG_TASK_MS = 50;

interface TraceEvent {
  name: string;
  ph?: string;
  pid: number;
  tid: number;
  dur?: number;
  args?: { name?: string };
}

const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.floor(q * (values.length - 1))] ?? 0;

test('vector tiles lay out in workers and keep the main thread within budget while moving (F443)', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await openVector(page, 'scenario=mvt-city&backend=webgl2&zoom=13&imagery=world');
  const tracePath = testInfo.outputPath('trace.json');
  await browser.startTracing(page, {
    path: tracePath,
    categories: ['devtools.timeline', 'blink.user_timing', '__metadata'],
  });
  // A fast pan and zoom: a new view every display frame for three seconds, over tiles not loaded yet.
  const samples = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const globe = window.vibeglobePlayground?.globe;
        const layer = window.vibeglobeVectorTiles?.layer;
        if (!globe || !layer) throw new Error('no globe');
        const times: number[] = [];
        const off = globe.on('frame', () => times.push(layer.frameTimeMs()));
        const start = performance.now();
        const step = () => {
          const t = (performance.now() - start) / 3000;
          if (t >= 1) {
            off();
            resolve(times);
            return;
          }
          globe.jumpTo({
            longitudeDeg: 9.16 + 0.06 * t,
            latitudeDeg: 45.45 + 0.03 * Math.sin(t * Math.PI),
            zoom: 13 + 3 * t,
            tiltDeg: 45,
          });
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
  await settle(page);
  await browser.stopTracing();
  console.log(
    `vector tiles per frame: ${samples.length} frames, p50 ${quantile(samples, 0.5).toFixed(2)} ms, p95 ${quantile(samples, 0.95).toFixed(2)} ms`,
  );
  expect(samples.length).toBeGreaterThan(10);
  // The time is gated on a real GPU only (ADR 0012), like the terrain's (F134).
  if (hardwareGpu()) expect(quantile(samples, 0.95)).toBeLessThanOrEqual(VECTOR_CPU_BUDGET_MS);

  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as { traceEvents: TraceEvent[] };
  const threads = new Map<string, string>();
  for (const event of trace.traceEvents)
    if (event.name === 'thread_name') threads.set(`${event.pid}:${event.tid}`, event.args?.name ?? '');
  const thread = (event: TraceEvent) => threads.get(`${event.pid}:${event.tid}`) ?? '';
  // Every layout (decoding and tessellation) ran on a worker.
  const layouts = trace.traceEvents.filter((e) => e.name === 'vibeglobe:layout-vector-tile');
  expect(layouts.length).toBeGreaterThan(0);
  expect(layouts.filter((e) => !thread(e).startsWith('DedicatedWorker')).map(thread)).toEqual([]);
  // No long task on the main thread while the tiles loaded.
  const long = trace.traceEvents.filter(
    (e) => e.name === 'RunTask' && thread(e) === 'CrRendererMain' && (e.dur ?? 0) > LONG_TASK_MS * 1000,
  );
  expect(long.map((e) => (e.dur ?? 0) / 1000)).toEqual([]);
});
