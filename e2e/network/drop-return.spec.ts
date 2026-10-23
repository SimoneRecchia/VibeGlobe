// Connectivity dropping and returning (F298, F329's scenario frames): the navigation scenario with the connection lost
// mid-pan and back after the flight, on WebGPU and forced WebGL2; every frame drawn on the manual clock and checked
// for holes, black pixels and pops. The base package and the network's own detail cover the path while offline.
import { expect, test } from '@playwright/test';
import { openHarness, servedTiers, startHarness } from '../support/offline.ts';
import { recordPath, ROME, sessionId } from './support/network.ts';
import {
  BACKENDS,
  BLACK_BELOW,
  expectClean,
  expectConnectivity,
  HEALTH,
  STEP_MS,
  worldBase,
} from './support/scenarios.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.describe.configure({ timeout: 240_000 });

for (const backend of BACKENDS)
  test(`connectivity drops mid-pan and returns after a flight on ${backend}: no hole, black pixel or pop, detail resumes (F298, F329)`, async ({
    page,
    context,
  }) => {
    const session = sessionId(`drop-${backend}`);
    await openHarness(page);
    const sources = [{ id: 'world', pattern: 'world', session }];
    await startHarness(page, { sources, view: ROME, backend });
    await page.evaluate((s) => window.offlineHarness?.installFixture(s), worldBase(session));
    await page.request.post(`/_fixture/${session}/rules`, { data: JSON.stringify([{ latencyMs: 100 }]) });
    await startHarness(page, { sources, view: ROME, backend, healthChecks: HEALTH, clockStepMs: STEP_MS });

    const online = await recordPath(
      page,
      [{ jump: ROME }, { move: { ...ROME, zoom: 9.5 }, frames: 30 }, { hold: 60 }],
      BLACK_BELOW,
    );
    await context.setOffline(true);
    const dropped = await recordPath(
      page,
      [
        { move: { ...ROME, longitudeDeg: 13.1, zoom: 9.5 }, frames: 30 },
        { hold: 40 },
        { fly: { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 8 }, durationMs: 3000 },
        { hold: 40 },
      ],
      BLACK_BELOW,
    );
    await expectConnectivity(page, 'offline');
    const fromNetwork = (await servedTiers(page))['network'] ?? 0;
    await context.setOffline(false);
    await expectConnectivity(page, 'online');
    const returned = await recordPath(
      page,
      [{ hold: 90 }, { move: { longitudeDeg: 2.6, latitudeDeg: 48.85, zoom: 8.5 }, frames: 30 }, { hold: 60 }],
      BLACK_BELOW,
    );
    for (const [phase, report] of Object.entries({ online, dropped, returned })) {
      console.log(`[network] drop-return ${backend} ${phase}: ${JSON.stringify(report)}`);
      expectClean(report, 40);
    }
    // Back online, the detail around Paris comes from the network again.
    expect((await servedTiers(page))['network'] ?? 0).toBeGreaterThan(fromNetwork);
  });
