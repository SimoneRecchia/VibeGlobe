// Both offline setups (F295, F296, F329's scenario frames) on WebGPU and forced WebGL2: packages read from a LAN server
// without installing, in hybrid mode with no internet (mode 1: every request for the tile source fails), and packages
// installed in browser storage in offline-only mode (mode 2: no request reaches the tile source). The navigation
// scenario draws every frame on the manual clock, checked for holes, black pixels and pops.
import { expect, test, type Page } from '@playwright/test';
import { openHarness, publishFixture, servedTiers, servePackages, startHarness } from '../support/offline.ts';
import { NAVIGATION, recordPath, ROME, sessionId } from './support/network.ts';
import {
  BACKENDS,
  BLACK_BELOW,
  expectClean,
  HEALTH,
  romeDetail,
  STEP_MS,
  worldBase,
  type Backend,
} from './support/scenarios.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.describe.configure({ timeout: 240_000 });

/** Records the requests for the source's tiles: an offline-only setup must make none. */
function recordSourceRequests(page: Page, session: string): string[] {
  const paths: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/fixture-tiles/${session}/`)) paths.push(new URL(request.url()).pathname);
  });
  return paths;
}

async function runSetup(page: Page, backend: Backend, setup: 'lan' | 'storage'): Promise<void> {
  const session = sessionId(`${setup}-${backend}`);
  await openHarness(page);
  const lan = await servePackages(page);
  const sources = [{ id: 'world', pattern: 'world', session }];
  await startHarness(page, { sources, view: ROME, backend });
  const served: string[] = [];
  for (const spec of [worldBase(session), romeDetail(session)]) {
    if (setup === 'lan') served.push((await publishFixture(page, lan, spec)).manifestUrl);
    else await page.evaluate((s) => window.offlineHarness?.installFixture(s), spec);
  }
  const requests = recordSourceRequests(page, session);
  // Mode 1 has no internet: the tile source cannot be reached, the LAN server can (KB-186).
  if (setup === 'lan')
    await page.route(`**/fixture-tiles/${session}/**`, (route) => route.abort('internetdisconnected'));
  await startHarness(page, {
    network: setup === 'lan' ? 'hybrid' : 'offline',
    sources,
    ...(setup === 'lan' ? { served } : {}),
    view: ROME,
    backend,
    healthChecks: HEALTH,
    clockStepMs: STEP_MS,
  });
  const report = await recordPath(page, NAVIGATION, BLACK_BELOW);
  console.log(`[network] ${setup} ${backend}: ${JSON.stringify(report)}`);
  expectClean(report);
  expect((await servedTiers(page))['package'] ?? 0).toBeGreaterThan(0);
  if (setup === 'lan') expect(lan.requests.length).toBeGreaterThan(0);
  // Offline-only mode never asks the network; hybrid mode does, and fails (mode 1).
  else expect(requests).toEqual([]);
}

for (const backend of BACKENDS) {
  test(`offline mode 1, packages on a LAN server in hybrid mode with no internet: the navigation scenario with no hole, black pixel or pop on ${backend} (F295, F329)`, async ({
    page,
  }) => runSetup(page, backend, 'lan'));

  test(`offline mode 2, packages in browser storage: the navigation scenario with no hole, black pixel or pop on ${backend} (F296, F329)`, async ({
    page,
  }) => runSetup(page, backend, 'storage'));
}
