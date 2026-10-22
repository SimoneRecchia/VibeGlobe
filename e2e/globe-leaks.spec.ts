import { expect, test, type Page } from '@playwright/test';
import { openGlobe } from './support/globe.ts';
import { heapObjects, HEAP_NOISE_BYTES, snapshot, trackGpuObjects, type Snapshot } from './support/leaks.ts';
import { slowRecoverySteps } from './support/recovery.ts';

// ADR 0010's leak suite: 100 mount/unmount cycles, as a single-page app does on navigation, must leave the JS heap, the
// DOM, the event listeners and the live GPU objects where they were. Chromium only (CDP heap and DOM counters).

const CYCLES = 100;
const WARM_UP_CYCLES = 10;

async function cycle(page: Page, count: number): Promise<void> {
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

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`${CYCLES} mount/unmount cycles leave heap, DOM, listeners and GPU objects flat on ${backend} (ADR 0010 leak suite)`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await page.addInitScript(trackGpuObjects);
    await openGlobe(page, `backend=${backend}&zoom=3`);
    const cdp = await page.context().newCDPSession(page);
    // Warm-up: compiled code, shader caches and lazily created singletons are not leaks.
    await cycle(page, WARM_UP_CYCLES);
    // Only the playground's own globe holds a device or context. A destroyed device reports its loss asynchronously,
    // so a snapshot taken at once may still count one being released (KB-065): both wait for the count to settle (a
    // held one never would).
    const settled = (): Promise<void> =>
      expect
        .poll(() => page.evaluate(() => (window as unknown as { liveContexts: () => number }).liveContexts()), {
          timeout: 10_000,
        })
        .toBe(1);
    await settled();
    const before = await snapshot(page, cdp);
    await cycle(page, CYCLES);
    await settled();
    const after = await snapshot(page, cdp);
    // Constructors with more instances than before: a leak of one object per cycle shows as a growth of CYCLES.
    const grown = [...after.instances]
      .map(([name, count]) => [name, count - (before.instances.get(name) ?? 0)] as const)
      .filter(([, growth]) => growth > 0)
      .sort((a, b) => b[1] - a[1]);
    const show = (snap: Snapshot): string => JSON.stringify({ ...snap, instances: undefined });
    console.log(
      `leak suite ${backend}: before ${show(before)} after ${show(after)} grown ${JSON.stringify(grown.slice(0, 5))}`,
    );
    expect(grown.filter(([, growth]) => growth >= CYCLES / 2)).toEqual([]);
    expect(after.contexts).toBe(1);
    expect(after.gpuObjects).toBe(before.gpuObjects);
    expect(after.nodes).toBeLessThanOrEqual(before.nodes);
    expect(after.listeners).toBeLessThanOrEqual(before.listeners);
    expect(after.heapBytes - before.heapBytes).toBeLessThan(HEAP_NOISE_BYTES);
  });
}

test('a destroyed globe that the host still references holds no renderer (KB-045)', async ({ page }) => {
  await openGlobe(page, 'backend=webgl2&zoom=3');
  const cdp = await page.context().newCDPSession(page);
  const renderers = async (): Promise<number> => {
    await page.waitForTimeout(500);
    await cdp.send('HeapProfiler.collectGarbage');
    return (await heapObjects(cdp)).instances.get('WebGPURenderer') ?? 0;
  };
  const before = await renderers();
  // Frameworks keep component references after unmount: the destroyed globes stay reachable from the page.
  await page.evaluate(async () => {
    const hooks = window.vibeglobePlayground;
    if (!hooks) throw new Error('no playground');
    const kept: unknown[] = [];
    (window as unknown as { kept: unknown[] }).kept = kept;
    for (let i = 0; i < 5; i++) {
      const mounted = hooks.mount();
      await mounted.globe.ready;
      mounted.unmount();
      kept.push(mounted.globe);
    }
  });
  // At most one more: three.js's module-level output node keeps a reference to the last renderer it served.
  expect(await renderers()).toBeLessThanOrEqual(before + 1);
});

test('a globe destroyed while its recovery starts a renderer holds no renderer (KB-053)', async ({ page }) => {
  await page.addInitScript(slowRecoverySteps);
  await openGlobe(page, 'backend=webgpu&zoom=3');
  const cdp = await page.context().newCDPSession(page);
  const renderers = async (): Promise<number> => {
    await page.waitForTimeout(500);
    await cdp.send('HeapProfiler.collectGarbage');
    return (await heapObjects(cdp)).instances.get('WebGPURenderer') ?? 0;
  };
  const before = await renderers();
  await page.evaluate(() => {
    (window as unknown as { slowRecovery?: boolean }).slowRecovery = true;
    window.vibeglobePlayground?.globe.simulateDeviceLoss();
  });
  await page.waitForFunction(() => (window as unknown as { recoveryStep?: string }).recoveryStep === 'device request');
  // The playground keeps its reference to the destroyed globe, as a host would.
  await page.evaluate(() => window.vibeglobePlayground?.globe.destroy());
  // The recovery's device request resumes after a second and its renderer starts.
  await page.waitForTimeout(3000);
  // Not more than before: three.js's module-level output node may keep the destroyed globe's last renderer (KB-045).
  expect(await renderers()).toBeLessThanOrEqual(before);
});
