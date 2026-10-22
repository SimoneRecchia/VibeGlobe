import { expect, test, type Page } from '@playwright/test';
import { consoleProblems, openExample } from './support/adapters.ts';
import { HEAP_NOISE_BYTES, snapshot, trackGpuObjects, type Snapshot } from './support/leaks.ts';

// ADR 0010's leak suite through the framework adapters: 100 mount and unmount cycles of the Vue component (v-if,
// F478) and 100 insertions and removals of the `<vibe-globe>` element (F484) leave the JS heap, the DOM, the event
// listeners, the workers and the live GPU objects where they were. Runs alone (playwright.config.ts, measurements).

const CYCLES = 100;
const WARM_UP_CYCLES = 10;

/** Hides and shows the page's globe `count` times, each time waiting until the new engine drew a frame. */
async function cycle(page: Page, count: number): Promise<void> {
  await page.evaluate(async (cycles) => {
    const hooks = window.adapterExample;
    if (!hooks) throw new Error('no example');
    for (let i = 0; i < cycles; i++) {
      await hooks.show(false);
      await hooks.show(true);
      await hooks.globes()[0]?.ready;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      // The page's own log of events would grow with the cycles: it is the test's record, not the adapter's.
      hooks.events.length = 0;
    }
  }, count);
}

/** Module workers alive in the page, as Chromium's target list reports them. */
async function workers(page: Page): Promise<number> {
  return page.workers().length;
}

for (const [adapter, path] of [
  ['Vue component (v-if, F478)', ''],
  ['Web Component (F484)', 'plain.html'],
] as const) {
  for (const backend of ['webgl2', 'webgpu'] as const) {
    test(`${CYCLES} mount and unmount cycles of the ${adapter} leave no growth on ${backend}`, async ({ page }) => {
      test.setTimeout(600_000);
      const problems = consoleProblems(page);
      await page.addInitScript(trackGpuObjects);
      await openExample(page, `${path}?backend=${backend}`);
      const cdp = await page.context().newCDPSession(page);
      await cycle(page, WARM_UP_CYCLES);
      const settled = (): Promise<void> =>
        expect
          .poll(() => page.evaluate(() => (window as unknown as { liveContexts: () => number }).liveContexts()), {
            timeout: 10_000,
          })
          .toBe(1);
      await settled();
      const before = await snapshot(page, cdp);
      const workersBefore = await workers(page);
      await cycle(page, CYCLES);
      await settled();
      const after = await snapshot(page, cdp);
      const grown = [...after.instances]
        .map(([name, count]) => [name, count - (before.instances.get(name) ?? 0)] as const)
        .filter(([, growth]) => growth > 0)
        .sort((a, b) => b[1] - a[1]);
      const show = (snap: Snapshot): string => JSON.stringify({ ...snap, instances: undefined });
      console.log(
        `${adapter} ${backend}: before ${show(before)} after ${show(after)} grown ${JSON.stringify(grown.slice(0, 5))}`,
      );
      expect(grown.filter(([, growth]) => growth >= CYCLES / 2)).toEqual([]);
      expect(after.contexts).toBe(1);
      expect(after.gpuObjects).toBe(before.gpuObjects);
      expect(after.nodes).toBeLessThanOrEqual(before.nodes);
      expect(after.listeners).toBeLessThanOrEqual(before.listeners);
      expect(after.heapBytes - before.heapBytes).toBeLessThan(HEAP_NOISE_BYTES);
      expect(await workers(page)).toBeLessThanOrEqual(workersBefore);
      expect(problems).toEqual([]);
    });
  }
}
