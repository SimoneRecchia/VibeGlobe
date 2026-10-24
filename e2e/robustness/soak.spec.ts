// The soak test (F509): randomized navigation (flights, eases, pans and zooms, view-mode changes, imagery and data
// layer toggles) for `VIBEGLOBE_SOAK_MINUTES` on both backends: 6 minutes with small cache budgets in the default run,
// 4 hours on the reference desktop for the entry (docs/hardening-backlog.md). The JS heap after a forced collection,
// the engine's GPU bytes and the frame times are sampled every 15 s: no crash or console error, no upward heap trend
// after the warm-up (every view visited once), GPU memory within its budget, and the late p95 frame time no worse than the early one.
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

/** The views movements go to: 6 places at 3 zooms, so the tile caches can be filled by visiting each once. */
const VIEWS = 6 * 3;

/**
 * One random action on the page's globe, awaited until its movement settles: flights, eases and jumps between a
 * fixed set of places and zooms, view-mode changes, imagery and data layer toggles. Returns the action and, for a
 * movement to a place, the index of its view.
 */
async function act(page: Page, roll: number[]): Promise<{ action: string; view?: number }> {
  return page.evaluate(async ([kind = 0, a = 0, b = 0, c = 0]) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const places = [
      [12.5, 41.9],
      [2.35, 48.85],
      [-74, 40.7],
      [139.7, 35.7],
      [-43.2, -22.9],
      [151.2, -33.9],
    ] as const;
    const placeIndex = Math.min(places.length - 1, Math.floor(a * places.length));
    const zoomIndex = Math.min(2, Math.floor(c * 3));
    const [longitudeDeg, latitudeDeg] = places[placeIndex] ?? places[0];
    const place = { longitudeDeg, latitudeDeg, zoom: [3, 5, 7][zoomIndex] ?? 3 };
    const view = placeIndex * 3 + zoomIndex;
    if (kind < 0.25) return { action: await globe.flyTo(place, { durationMs: 1000 + b * 2000 }), view };
    if (kind < 0.45) {
      const heading = { headingDeg: Math.floor(b * 4) * 90, tiltDeg: Math.floor(b * 3) * 20 };
      return { action: await globe.easeTo(heading, { durationMs: 600 }) };
    }
    if (kind < 0.6) return { action: await globe.jumpTo(place), view };
    if (kind < 0.7) {
      globe.setViewMode((['2d', '3d', 'auto'] as const)[Math.floor(a * 3)] ?? 'auto');
      return { action: 'view-mode' };
    }
    if (kind < 0.85) {
      const layer = globe.imageryLayers.list()[0];
      if (layer) globe.imageryLayers.set(layer.id, { visible: !layer.visible });
      return { action: 'imagery-toggle' };
    }
    const layers = Object.values(window.vibeglobeLayers?.layers ?? {});
    const layer = layers[Math.floor(a * layers.length)];
    layer?.setVisible(b < 0.5);
    return { action: 'data-toggle' };
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
    // The run extends to at most three times its length until the steady state has enough samples.
    test.setTimeout(MINUTES * 60_000 * 3 + 180_000);
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
    // The warm-up ends once every view was visited: the caches then hold what the navigation needs, and a heap trend
    // afterwards is a leak. Its length depends on the machine's frame rate, so it is counted in views, not minutes.
    const visited = new Set<number>();
    let warm: number | undefined;
    const steady = (): number => (warm === undefined ? 0 : samples.length - warm);
    const elapsedMs = (): number => Date.now() - started;
    while (elapsedMs() < MINUTES * 60_000 || (steady() < 6 && elapsedMs() < MINUTES * 3 * 60_000)) {
      const { action, view } = await act(page, [random(), random(), random(), random()]);
      actions[action] = (actions[action] ?? 0) + 1;
      if (view !== undefined) visited.add(view);
      if (Date.now() >= nextSample) {
        samples.push(await sample(page, elapsedMs() / 60_000));
        nextSample += SAMPLE_MS;
        if (warm === undefined && visited.size === VIEWS) warm = samples.length;
      }
    }
    console.log(`[robustness] F509 ${backend}: ${JSON.stringify({ actions, warmSample: warm, samples })}`);
    expect(crashed).toBe(false);
    // No upward heap trend in the steady state, after the warm-up.
    expect(steady(), 'samples after every view was visited').toBeGreaterThanOrEqual(6);
    const settled = samples.slice(warm);
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
