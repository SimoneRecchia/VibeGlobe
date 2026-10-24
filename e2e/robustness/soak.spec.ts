// The soak test (F509): randomized navigation (flights, eases, pans and zooms, view-mode changes, imagery and data
// layer toggles) for `VIBEGLOBE_SOAK_MINUTES` on both backends: 6 minutes with small cache budgets in the default run,
// 4 hours on the reference desktop for the entry (docs/hardening-backlog.md). The JS heap after a forced collection,
// the engine's GPU bytes and the frame times are sampled every 15 s: no crash or console error, no upward heap trend
// after the warm-up half, GPU memory within its budget, and the late p95 frame time no worse than the early one.
import { expect, test, type Page } from '@playwright/test';
import { openGlobe } from '../support/globe.ts';
import { collectErrors, runSeed, seeded, unexpected } from './support/probes.ts';

test.use({ viewport: { width: 320, height: 240 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const MINUTES = Number(process.env['VIBEGLOBE_SOAK_MINUTES'] ?? 6);
/**
 * Small cache budgets (F098's `?gpuBudgetMB=&ramBudgetMB=`): the caches fill within the warm-up, so a heap trend
 * afterwards is a leak and not a cache filling up, even in a short run.
 */
const BUDGETS = 'gpuBudgetMB=48&ramBudgetMB=16';
const SAMPLE_MS = 15_000;
/** Heap growth per minute of navigation, after the warm-up quarter, that counts as a trend (a leak). */
const HEAP_TREND_BYTES_PER_MIN = 1024 * 1024;
/**
 * GPU memory beyond the loaded view's (the base image, the first meshes): the imagery budget set above plus slack for
 * the surface meshes and data layers.
 */
const GPU_GROWTH_BYTES = (48 + 32) * 1024 * 1024;
/** How much worse the late p95 frame time may be than the early one (a busy shared machine varies this much). */
const P95_DRIFT = 1.5;

interface Sample {
  minute: number;
  heapBytes: number;
  gpuBytes: number;
  p95Ms: number;
}

/** One random action on the page's globe, awaited until its movement settles. */
async function act(page: Page, roll: number[]): Promise<string> {
  return page.evaluate(async ([kind = 0, a = 0, b = 0, c = 0]) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const place = { longitudeDeg: -180 + a * 360, latitudeDeg: -60 + b * 120, zoom: 2 + c * 10 };
    if (kind < 0.25) return globe.flyTo(place, { durationMs: 1000 + a * 2000 });
    if (kind < 0.45)
      return globe.easeTo({ zoom: 2 + c * 12, headingDeg: a * 360, tiltDeg: b * 50 }, { durationMs: 600 });
    if (kind < 0.6) return globe.jumpTo(place);
    if (kind < 0.7) {
      globe.setViewMode((['2d', '3d', 'auto'] as const)[Math.floor(a * 3)] ?? 'auto');
      return 'view-mode';
    }
    if (kind < 0.85) {
      const layer = globe.imageryLayers.list()[0];
      if (layer) globe.imageryLayers.set(layer.id, { visible: !layer.visible });
      return 'imagery-toggle';
    }
    const layers = Object.values(window.vibeglobeLayers?.layers ?? {});
    const layer = layers[Math.floor(a * layers.length)];
    layer?.setVisible(b < 0.5);
    return 'data-toggle';
  }, roll);
}

/** The heap after a forced collection, the engine's GPU bytes and the p95 of the frame times since the last sample. */
async function sample(page: Page, minute: number): Promise<Sample> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
  await cdp.detach();
  const { gpuBytes, p95Ms } = await page.evaluate(() => {
    const w = window as unknown as { frameIntervalsMs: number[] };
    const times = w.frameIntervalsMs.sort((x, y) => x - y);
    w.frameIntervalsMs = [];
    return {
      gpuBytes: window.vibeglobePlayground?.globe.resourceCounts().gpuBytes ?? 0,
      p95Ms: times[Math.floor(times.length * 0.95)] ?? 0,
    };
  });
  return { minute, heapBytes: usedSize, gpuBytes, p95Ms };
}

/** The least-squares slope of `y` over `x`. */
function slope(points: readonly [number, number][]): number {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const num = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const den = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;

for (const backend of BACKENDS) {
  test(`${MINUTES} min of randomized navigation on ${backend}: no crash or error, no heap trend, GPU memory in budget, stable p95 frame time (F509)`, async ({
    page,
  }) => {
    test.setTimeout(MINUTES * 60_000 * 2 + 120_000);
    const seed = runSeed();
    console.log(`[robustness] F509 ${backend} seed ${seed}, ${MINUTES} min`);
    const random = seeded(seed);
    const errors = await collectErrors(page);
    let crashed = false;
    page.on('crash', () => (crashed = true));
    await openGlobe(page, `backend=${backend}&imagery=world&layers=demo&${BUDGETS}&lon=12.5&lat=41.9&zoom=6`);
    // Frame times: the intervals between drawn frames while frames follow each other (idle gaps left out).
    await page.evaluate(() => {
      const w = window as unknown as { frameIntervalsMs: number[] };
      w.frameIntervalsMs = [];
      let last = 0;
      window.vibeglobePlayground?.globe.on('frame', () => {
        const now = performance.now();
        if (last > 0 && now - last < 1000) w.frameIntervalsMs.push(now - last);
        last = now;
      });
    });
    const loadedGpuBytes = await page.evaluate(() => window.vibeglobePlayground?.globe.resourceCounts().gpuBytes ?? 0);
    const started = Date.now();
    const samples: Sample[] = [];
    const actions: Record<string, number> = {};
    let nextSample = started + SAMPLE_MS;
    while (Date.now() - started < MINUTES * 60_000) {
      const outcome = await act(page, [random(), random(), random(), random()]);
      actions[outcome] = (actions[outcome] ?? 0) + 1;
      if (Date.now() >= nextSample) {
        samples.push(await sample(page, (Date.now() - started) / 60_000));
        nextSample += SAMPLE_MS;
      }
    }
    console.log(`[robustness] F509 ${backend}: ${JSON.stringify({ actions, samples })}`);
    expect(crashed).toBe(false);
    expect(samples.length).toBeGreaterThanOrEqual(4);
    // No upward heap trend once the caches have filled (the first half is the warm-up).
    const settled = samples.slice(Math.floor(samples.length / 2));
    expect(slope(settled.map((s) => [s.minute, s.heapBytes]))).toBeLessThan(HEAP_TREND_BYTES_PER_MIN);
    for (const s of samples) expect(s.gpuBytes).toBeLessThanOrEqual(loadedGpuBytes + GPU_GROWTH_BYTES);
    // Frame time stable: the last third's median p95 no worse than the first third's by more than the drift.
    const third = Math.max(1, Math.floor(samples.length / 3));
    const early = median(samples.slice(0, third).map((s) => s.p95Ms));
    const late = median(samples.slice(-third).map((s) => s.p95Ms));
    expect(late).toBeLessThanOrEqual(early * P95_DRIFT);
    expect(unexpected(errors)).toEqual([]);
  });
}
