// Sleep and resume (F516), as Playwright can simulate it: the page lifecycle's freeze and resume (hidden, `freeze`,
// `resume`, visible: `support/page-clock.ts`, since headless Chromium ignores CDP's lifecycle states) with tile
// requests in flight, the network down during the sleep (the browser's `offline` and `online` events) and its
// connections dropped, the clock 5 minutes later on resume, and the GPU device or context lost on wake. On resume the
// engine recovers its GPU state, re-checks connectivity, requests the view's tiles again and renders it at full detail,
// without a reload. The real devices' sleep is a manual step (docs/internal/hardening-backlog.md).
import { expect, test, type Page, type Route } from '@playwright/test';
import { ROME, sessionId } from '../network/support/network.ts';
import { HEALTH } from '../network/support/scenarios.ts';
import { openHarness, startHarness } from '../support/offline.ts';
import { lifecycleControls } from './support/page-clock.ts';
import { collectErrors, unexpected } from './support/probes.ts';

test.use({ viewport: { width: 320, height: 240 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const SLEEP_MS = 5 * 60_000;
const PARIS = { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 8 };

/** Imagery state of the harness's globe, after asking for a frame. */
async function detail(page: Page) {
  return page.evaluate(() => {
    const globe = window.offlineHarness?.globe;
    globe?.requestRender();
    const imagery = globe?.imageryStats();
    return {
      pending: imagery ? imagery.queued + imagery.loading + imagery.decoding + imagery.uploadsPending : -1,
      fromAncestor: globe?.surfaceStats().fromAncestor ?? -1,
    };
  });
}

for (const backend of BACKENDS) {
  test(`freeze with requests in flight, the network dropped, 5 minutes later resume with the GPU lost: GPU recovered, connectivity re-checked, requests retried, full detail without a reload on ${backend} (F516)`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const errors = await collectErrors(page);
    await page.addInitScript(lifecycleControls);
    const session = sessionId(`sleep-${backend}`);
    await openHarness(page);
    await startHarness(page, {
      sources: [{ id: 'world', pattern: 'world', session }],
      view: ROME,
      backend,
      healthChecks: HEALTH,
    });
    await expect.poll(() => detail(page), { timeout: 60_000 }).toEqual({ pending: 0, fromAncestor: 0 });
    const navigations = await page.evaluate(() => performance.getEntriesByType('navigation').length);

    // Tile requests of a new view are held in flight when the machine goes to sleep.
    const held: Route[] = [];
    let holding = true;
    const requested: string[] = [];
    await page.route(`**/fixture-tiles/${session}/**`, (route) => {
      requested.push(new URL(route.request().url()).pathname);
      if (holding) held.push(route);
      else return route.continue();
    });
    await page.evaluate((view) => window.offlineHarness?.globe?.jumpTo(view), PARIS);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.evaluate(() => (window as unknown as { freeze: () => void }).freeze());
    // Asleep: the network goes down (the browser fires `offline`), the open connections drop, the clock runs on.
    await page.context().setOffline(true);
    holding = false;
    const died = held.map((route) => new URL(route.request().url()).pathname);
    await Promise.all(held.map((route) => route.abort('internetdisconnected').catch(() => undefined)));
    const beforeWake = requested.length;
    // Awake: the network comes back first (the browser fires `online`).
    await page.context().setOffline(false);
    await page.evaluate((ms) => {
      // The GPU process lost its device or context during the sleep: the loss is reported as the page wakes.
      const globe = window.offlineHarness?.globe;
      const w = window as unknown as { restored: number; framesSinceWake: number };
      w.restored = 0;
      w.framesSinceWake = 0;
      globe?.on('device-restored', () => w.restored++);
      globe?.on('frame', () => w.framesSinceWake++);
      (window as unknown as { resume: (slept: number) => void }).resume(ms);
      globe?.simulateDeviceLoss();
    }, SLEEP_MS);

    expect(await page.evaluate(() => (window as unknown as { lifecycle: string[] }).lifecycle)).toEqual([
      'visibilitychange',
      'freeze',
      'resume',
      'visibilitychange',
    ]);
    // The GPU state recovered, and frames are drawn again.
    await expect.poll(() => page.evaluate(() => (window as unknown as { restored: number }).restored)).toBe(1);
    // Connectivity re-checked: health checks run again after the wake, and the engine is online.
    await expect
      .poll(() => requested.slice(beforeWake).some((path) => path.endsWith('/0/0/0.png')), { timeout: 30_000 })
      .toBe(true);
    expect(await page.evaluate(() => window.offlineHarness?.offline?.connectivity)).toBe('online');
    // Requests resume after the wake, the view's tiles among them, and the view reaches full detail. (Tiles of the
    // requests that died which the settled view no longer shows stay marked failed: their retry on reselection is
    // TG-05's.)
    await expect
      .poll(() => requested.slice(beforeWake).filter((path) => !path.endsWith('/0/0/0.png')).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await expect.poll(() => detail(page), { timeout: 60_000 }).toEqual({ pending: 0, fromAncestor: 0 });
    const retried = died.filter((path) => requested.slice(beforeWake).includes(path)).length;
    console.log(`[robustness] F516 ${backend}: ${retried} of ${died.length} requests that died were made again`);
    expect(
      await page.evaluate(() => (window as unknown as { framesSinceWake: number }).framesSinceWake),
    ).toBeGreaterThan(0);
    // No reload.
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(navigations);
    // The browser's own messages for the connections that dropped are expected; nothing else is.
    expect(unexpected(errors, [/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/])).toEqual([]);
  });
}
