// Storage chaos (F511): during frame-stepped random navigation, writes to the persistent tile cache fail with
// QuotaExceededError, and then the browser evicts the origin's IndexedDB (cache and installed packages) while the path
// runs. The offline engine reports both through its events and logs, the view keeps drawing from memory, packages and
// the network, no frame is blank and nothing throws uncaught.
import { expect, test, type Page } from '@playwright/test';
import { recordPath, ROME, sessionId } from '../network/support/network.ts';
import { BLACK_BELOW, HEALTH, romeDetail, STEP_MS, worldBase } from '../network/support/scenarios.ts';
import { openHarness, servedTiers, startHarness, tileHeaders } from '../support/offline.ts';
import { randomPath } from './support/chaos.ts';
import { collectErrors, runSeed, scaled, seeded, unexpected } from './support/probes.ts';

test.use({ viewport: { width: 320, height: 240 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const PLACES = [ROME, { longitudeDeg: 2.35, latitudeDeg: 48.85 }, { longitudeDeg: 13.4, latitudeDeg: 52.5 }];

/**
 * While `window.robustnessQuotaFull` is set, every write transaction on the tile store fails as a full disk does: at
 * commit, with QuotaExceededError (as in F274's test).
 */
function quotaInjector(): void {
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    const tx = original.apply(this, args);
    const names = Array.isArray(args[0]) ? args[0] : [args[0]];
    const full = (window as unknown as { robustnessQuotaFull?: boolean }).robustnessQuotaFull;
    if (full && args[1] === 'readwrite' && names.includes('tiles')) {
      Object.defineProperty(tx, 'error', {
        value: new DOMException('injected: the disk is full', 'QuotaExceededError'),
      });
      queueMicrotask(() => tx.abort());
    }
    return tx;
  };
}

/** The offline engine's events of `type`, as recorded by the harness. */
async function events(page: Page, type: string): Promise<unknown[]> {
  return page.evaluate(
    (t) => window.offlineHarness?.events.filter((e) => e.type === t).map((e) => e.payload) ?? [],
    type,
  );
}

for (const backend of BACKENDS) {
  test(`quota errors on cache writes and eviction of stored data during navigation are reported, and the view keeps drawing from memory, packages and network on ${backend} (F511)`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const seed = runSeed();
    console.log(`[robustness] F511 ${backend} seed ${seed}`);
    const random = seeded(seed);
    const errors = await collectErrors(page);
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning' && message.text().includes('[vibeglobe/offline]')) warnings.push(message.text());
    });
    await page.addInitScript(quotaInjector);
    const session = sessionId(`storage-${backend}`);
    const sources = [{ id: 'world', pattern: 'world', session }];
    await openHarness(page);
    // Cacheable tiles, so the engine writes them to the persistent cache.
    await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
    const config = { sources, view: ROME, backend, store: 'main-thread' } as const;
    await startHarness(page, config);
    // Installed in storage: the world base and Rome's detail.
    for (const spec of [worldBase(session), romeDetail(session)])
      await page.evaluate((s) => window.offlineHarness?.installFixture(s), spec);
    await startHarness(page, { ...config, healthChecks: HEALTH, clockStepMs: STEP_MS });

    // The disk fills up: writes fail during the first half of the path.
    await page.evaluate(() => ((window as unknown as { robustnessQuotaFull: boolean }).robustnessQuotaFull = true));
    const first = await recordPath(page, randomPath(random, PLACES, scaled(15)), BLACK_BELOW);
    // A `warning` event names the full disk (its code is 'quota', or 'storage-unavailable' when making room failed too).
    expect(JSON.stringify(await events(page, 'warning'))).toMatch(/QuotaExceededError|full/);
    await page.evaluate(() => ((window as unknown as { robustnessQuotaFull: boolean }).robustnessQuotaFull = false));

    // The browser evicts the origin's IndexedDB while the second half of the path runs.
    const cdp = await page.context().newCDPSession(page);
    const second = recordPath(page, randomPath(random, PLACES, scaled(15)), BLACK_BELOW);
    await page.waitForTimeout(1000);
    await cdp.send('Storage.clearDataForOrigin', { origin: new URL(page.url()).origin, storageTypes: 'indexeddb' });
    const after = await second;
    console.log(`[robustness] F511 ${backend}: ${JSON.stringify({ first, after, warnings })}`);

    for (const report of [first, after])
      expect([report.holes, report.dark], JSON.stringify(report.first)).toEqual([0, 0]);
    // Reported through the events: the full disk, and the evicted cache and package.
    await expect
      .poll(() => events(page, 'storage-lost'))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ cache: true }),
          expect.objectContaining({ packages: expect.arrayContaining(['rome']) as unknown }),
        ]),
      );
    // And through the logs: one warning for the full disk.
    expect(warnings.some((text) => /full/.test(text))).toBe(true);
    // Rendering continued from memory and the network.
    const tiers = await servedTiers(page);
    expect((tiers['network'] ?? 0) + (tiers['memory'] ?? 0)).toBeGreaterThan(0);
    expect(unexpected(errors)).toEqual([]);
  });
}
