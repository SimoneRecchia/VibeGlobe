// F375: 500,000 clustered points load in a worker without blocking the main thread, and the engine stays responsive and
// within its memory budgets through 60 seconds of panning and zooming. On the container's software GPU every frame is
// itself a long task, so the 50 ms bound on long tasks applies on a reference device (`VIBEGLOBE_REFERENCE_DEVICE=1`,
// docs/internal/open-questions.md); elsewhere the longest task is logged.
import { expect, test } from '@playwright/test';
import { openGlobe } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const REFERENCE = process.env['VIBEGLOBE_REFERENCE_DEVICE'] === '1';

test('500,000 clustered points load off the main thread and stay interactive within the memory budgets for 60 s (F375)', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.addInitScript(() => {
    const tasks: number[] = [];
    (window as unknown as { longTasks: number[] }).longTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  });
  await openGlobe(page, 'scenario=data-cluster&points=500000&imagery=world&lon=12.5&lat=41.9&zoom=4');
  await page.waitForFunction(() => window.vibeglobeCluster !== undefined);
  // The loading: from the layer's creation until its first zoom shows (the points are built into the index in a
  // worker, the main thread only receives the clusters of the view).
  const before = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks.length);
  await page.evaluate(() => window.vibeglobeCluster?.layer.loaded);
  await expect.poll(() => page.evaluate(() => window.vibeglobeCluster?.layer.shownZoom)).toBeDefined();
  const loading = await page.evaluate(
    (from) => (window as unknown as { longTasks: number[] }).longTasks.slice(from),
    before,
  );
  const longestLoadingMs = Math.max(0, ...loading);
  console.log(`[F375] loading: ${loading.length} long tasks, longest ${longestLoadingMs.toFixed(0)} ms`);
  if (REFERENCE) expect(longestLoadingMs).toBeLessThanOrEqual(50);
  const heapAfterLoad = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  );
  // 60 seconds of panning and zooming across Europe, a step every 100 ms, answered every time.
  const started = Date.now();
  let steps = 0;
  while (Date.now() - started < 60_000) {
    const t = steps / 40;
    const frame = await page.evaluate(
      async (view) => {
        const globe = window.vibeglobePlayground?.globe;
        globe?.jumpTo(view);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return globe?.frameNumber ?? -1;
      },
      {
        longitudeDeg: 12.5 + 8 * Math.sin(t),
        latitudeDeg: 45 + 5 * Math.cos(t * 0.7),
        zoom: 5 + 4 * Math.abs(Math.sin(t * 0.5)),
      },
    );
    expect(frame).toBeGreaterThan(0);
    steps++;
    await page.waitForTimeout(100);
  }
  const state = await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      resources: globe?.resourceCounts(),
      imagery: globe?.imageryStats(),
      heap: memory?.usedJSHeapSize ?? 0,
      shown: window.vibeglobeCluster?.layer.shownPointCount(),
    };
  });
  console.log(
    `[F375] ${steps} steps; heap ${(heapAfterLoad / 1e6).toFixed(0)} → ${(state.heap / 1e6).toFixed(0)} MB; GPU ${((state.resources?.gpuBytes ?? 0) / 1e6).toFixed(0)} MB; imagery GPU ${((state.imagery?.gpuBytes ?? 0) / 1e6).toFixed(0)} of ${((state.imagery?.gpuBudgetBytes ?? 0) / 1e6).toFixed(0)} MB, RAM ${((state.imagery?.ramBytes ?? 0) / 1e6).toFixed(0)} of ${((state.imagery?.ramBudgetBytes ?? 0) / 1e6).toFixed(0)} MB`,
  );
  // Still running, every point accounted for, the imagery within its GPU budget and the heap not growing with time.
  expect(state.resources?.contexts).toBe(1);
  expect(state.shown).toBe(500_000);
  expect(state.imagery?.gpuBudgetBytes ?? 0).toBeGreaterThan(0);
  expect(state.imagery?.gpuBytes ?? 0).toBeLessThanOrEqual(state.imagery?.gpuBudgetBytes ?? 0);
  expect(state.imagery?.ramBytes ?? 0).toBeLessThanOrEqual(state.imagery?.ramBudgetBytes ?? 0);
  expect(state.heap).toBeLessThan(heapAfterLoad * 1.5);
});
