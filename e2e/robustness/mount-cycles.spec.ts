// Mount and unmount cycles (F499) and rapid mount and unmount with destruction during start-up and loading (F517):
// the playground's lifecycle scenario (`vibeglobePlayground.mount`, a single-page app's navigation) on both backends,
// with the JS heap after a forced collection, the live GPU objects and contexts, the browser's workers and the event
// listeners compared before and after. Chromium only (CDP heap, DOM and target counters).
import { expect, test, type Browser, type Page } from '@playwright/test';
import { openGlobe } from '../support/globe.ts';
import { HEAP_NOISE_BYTES, snapshot, trackGpuObjects, type Snapshot } from '../support/leaks.ts';
import { collectErrors, runSeed, scaled, unexpected, workerCount } from './support/probes.ts';

const BACKENDS = ['webgl2', 'webgpu'] as const;
/** Imagery, so every instance starts the worker pool and streams tiles: the destruction while loading is real. */
const QUERY = 'imagery=world&zoom=3';
const WARM_UP_CYCLES = 10;

/**
 * Waits until no device or context is held (a destroyed one reports its loss later, KB-065) and no worker runs (the
 * page-wide pool terminates its workers with the last engine, ADR 0011; a worker's target closes asynchronously).
 */
async function nothingRunning(page: Page, browser: Browser): Promise<void> {
  const contexts = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { liveContexts: () => number }).liveContexts());
  await expect.poll(contexts, { timeout: 20_000 }).toBe(0);
  await expect.poll(() => workerCount(browser), { timeout: 20_000 }).toBe(0);
}

/** Constructors with at least `limit` more instances than before. */
function grown(before: Snapshot, after: Snapshot, limit: number): [string, number][] {
  return [...after.instances]
    .map(([name, count]): [string, number] => [name, count - (before.instances.get(name) ?? 0)])
    .filter(([, growth]) => growth >= limit)
    .sort((a, b) => b[1] - a[1]);
}

/**
 * Opens the playground on `backend`, destroys its own globe so the page holds no engine (the worker pool is page-wide
 * and never shrinks while an engine holds it, so only an empty page has an exact baseline of workers and listeners),
 * warms up, and compares snapshots taken with no engine before and after `play` (ADR 0010's tolerances).
 */
async function expectNoGrowth(
  page: Page,
  browser: Browser,
  backend: string,
  cycles: number,
  play: () => Promise<void>,
) {
  const errors = await collectErrors(page);
  await page.addInitScript(trackGpuObjects);
  await openGlobe(page, `backend=${backend}&${QUERY}`);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => window.vibeglobePlayground?.globe.destroy());
  // Warm-up: compiled code, shader caches, the worker program and lazily created singletons are not leaks.
  await fullCycles(page, WARM_UP_CYCLES);
  await nothingRunning(page, browser);
  const before = await snapshot(page, cdp);
  await play();
  await nothingRunning(page, browser);
  const after = await snapshot(page, cdp);
  const show = (snap: Snapshot): string => JSON.stringify({ ...snap, instances: undefined });
  console.log(`[robustness] before ${show(before)} after ${show(after)}`);
  // Below 100 cycles (development runs) a few objects of noise would pass for a leak: the limit stays at 50.
  expect(grown(before, after, Math.max(cycles / 2, 50))).toEqual([]);
  expect(after.gpuObjects).toBe(before.gpuObjects);
  expect(after.nodes).toBeLessThanOrEqual(before.nodes);
  expect(after.listeners).toBeLessThanOrEqual(before.listeners);
  expect(after.heapBytes - before.heapBytes).toBeLessThan(HEAP_NOISE_BYTES);
  expect(unexpected(errors)).toEqual([]);
}

/** Mounts and unmounts `count` engines: each draws a frame after `ready`, as a mounted page does. */
async function fullCycles(page: Page, count: number): Promise<void> {
  await page.evaluate(async (cycles) => {
    const hooks = window.vibeglobePlayground;
    if (!hooks) throw new Error('no playground');
    for (let i = 0; i < cycles; i++) {
      const mounted = hooks.mount();
      await mounted.globe.ready;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      mounted.unmount();
    }
  }, count);
}

/**
 * Mounts and unmounts `count` engines, each destroyed after a random delay from 0 to `maxDelayMs`: every second one
 * counted from its mount (on the container's software GPU a start takes longer, so it dies while its backend starts),
 * the others from its `ready` (it dies while its first tiles load). Returns how many were destroyed before `ready`.
 */
async function rapidCycles(page: Page, backend: string, count: number, seed: number, maxDelayMs: number) {
  return page.evaluate(
    async ({ backend, count, seed, maxDelayMs }) => {
      const hooks = window.vibeglobePlayground;
      if (!hooks) throw new Error('no playground');
      let state = seed >>> 0;
      const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      let beforeReady = 0;
      for (let i = 0; i < count; i++) {
        const mounted = hooks.mount(undefined, backend as 'webgpu' | 'webgl2');
        let ready = false;
        // A destroyed engine's `ready` may never settle or may reject; neither is an error of the host.
        mounted.globe.ready.then(
          () => (ready = true),
          () => undefined,
        );
        const delayMs = Math.floor(random() * (maxDelayMs + 1));
        if (i % 2 === 1) await mounted.globe.ready;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (!ready) beforeReady++;
        mounted.unmount();
      }
      return beforeReady;
    },
    { backend, count, seed, maxDelayMs },
  );
}

for (const backend of BACKENDS) {
  test(`100 mount and unmount cycles leave heap, GPU objects, workers and listeners flat on ${backend} (F499)`, async ({
    page,
    browser,
  }) => {
    const cycles = scaled(100);
    // Up to about 12 s per full cycle on the container's software GPU (a WebGPU start), with room to spare.
    test.setTimeout(600_000 + cycles * 15_000);
    await expectNoGrowth(page, browser, backend, cycles, async () => {
      // Each engine starts the pool's workers and terminates them on unmount: sampled while the cycles run.
      let running = true;
      const cyclesDone = fullCycles(page, cycles).finally(() => (running = false));
      let mostWorkers = 0;
      while (running) {
        mostWorkers = Math.max(mostWorkers, await workerCount(browser));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await cyclesDone;
      expect(mostWorkers).toBeGreaterThan(0);
    });
  });

  test(`1000 engines destroyed after random delays of 0–500 ms, during start-up and loading, on ${backend}: no error, no leak (F517)`, async ({
    page,
    browser,
  }) => {
    const cycles = scaled(1000);
    const seed = runSeed();
    console.log(`[robustness] F517 ${backend} seed ${seed} cycles ${cycles}`);
    // About 3 s per cycle on the container's software GPU (WebGPU start-ups are the slow ones), with room to spare.
    test.setTimeout(600_000 + cycles * 4000);
    await expectNoGrowth(page, browser, backend, cycles, async () => {
      const beforeReady = await rapidCycles(page, backend, cycles, seed, 500);
      console.log(`[robustness] F517 ${backend}: ${beforeReady} of ${cycles} destroyed before ready`);
      // Destruction during start-up and after it must both have happened, or the run proved nothing about one of them.
      expect(beforeReady).toBeGreaterThan(0);
      expect(beforeReady).toBeLessThan(cycles);
    });
  });
}
