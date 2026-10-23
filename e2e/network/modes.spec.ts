// The network modes with the loading switches all on and all off (F314's matrix, F329's scenario frames), on WebGPU
// and forced WebGL2: the navigation scenario on a 100 ms link with every frame drawn on the manual clock and checked
// for holes, black pixels and pops. The full matrix of switch combinations and its request and storage assertions is
// `e2e/offline-matrix.spec.ts`; this spec records the frames of its extremes in every mode.
import { expect, test } from '@playwright/test';
import { openHarness, servedTiers, startHarness } from '../support/offline.ts';
import { NAVIGATION, recordPath, ROME, sessionId } from './support/network.ts';
import { BACKENDS, BLACK_BELOW, expectClean, HEALTH, romeDetail, STEP_MS, worldBase } from './support/scenarios.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.describe.configure({ timeout: 300_000 });

const MODES = ['online', 'offline', 'hybrid'] as const;
const SWITCHES = {
  'all on': { persistentCache: true, memoryReuse: true, prefetch: true, offlinePackaging: true },
  'all off': { persistentCache: false, memoryReuse: false, prefetch: false, offlinePackaging: false },
};

for (const backend of BACKENDS)
  for (const mode of MODES)
    test(`${mode} mode with the loading switches all on and all off on ${backend}: no hole, black pixel or pop (F314, F329)`, async ({
      page,
    }) => {
      for (const [name, switches] of Object.entries(SWITCHES)) {
        const session = sessionId(`${mode}-${name}-${backend}`);
        await openHarness(page);
        const sources = [{ id: 'world', pattern: 'world', session }];
        await startHarness(page, { sources, view: ROME, backend });
        // Online-only mode reads no package: its base is the engine's bundled base image, then the network.
        if (mode !== 'online')
          for (const spec of [worldBase(session), romeDetail(session)])
            await page.evaluate((s) => window.offlineHarness?.installFixture(s), spec);
        await page.request.post(`/_fixture/${session}/rules`, { data: JSON.stringify([{ latencyMs: 100 }]) });
        await startHarness(page, {
          network: mode,
          switches,
          sources,
          view: ROME,
          backend,
          healthChecks: HEALTH,
          clockStepMs: STEP_MS,
        });
        const report = await recordPath(page, NAVIGATION, BLACK_BELOW);
        console.log(`[network] ${mode} ${name} ${backend}: ${JSON.stringify(report)}`);
        expectClean(report);
        const tiers = await servedTiers(page);
        if (mode === 'offline') expect(tiers['network'] ?? 0).toBe(0);
        else expect(tiers['network'] ?? 0).toBeGreaterThan(0);
        if (mode !== 'online') expect(tiers['package'] ?? 0).toBeGreaterThan(0);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
    });
