// The network simulation suite (F315; F329's scenario frames): the navigation scenario (zoom, pan, a flight) on fully
// offline, 400 kbps, flaky, high-latency and LAN-only links, on WebGPU and forced WebGL2, every frame drawn on the
// engine's manual clock and checked in the page for holes, black pixels and pops, with every request intercepted for
// the retry analysis. A world base package (levels 0–3) is installed first: the base has loaded before the path.
import { expect, test, type Page } from '@playwright/test';
import { backoffViolations, LINKS, lanOnly, type NetworkLink } from '../../scripts/fixtures/network/links.ts';
import { openHarness, servedTiers, publishFixture, servePackages, startHarness } from '../support/offline.ts';
import { BACKENDS, BLACK_BELOW, expectClean, HEALTH, STEP_MS, worldBase, type Backend } from './support/scenarios.ts';
import { isHealthCheck, NAVIGATION, recordPath, ROME, sessionId, useLink } from './support/network.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.describe.configure({ timeout: 240_000 });

/** Starts the harness on `backend` with the base package installed and the online source behind `link`. */
async function startOn(page: Page, backend: Backend, link: NetworkLink, session: string) {
  await openHarness(page);
  const sources = [{ id: 'world', pattern: 'world', session }];
  await startHarness(page, { sources, view: ROME, backend });
  await page.evaluate((s) => window.offlineHarness?.installFixture(s), worldBase(session));
  const attempts = await useLink(page, session, link);
  await startHarness(page, { sources, view: ROME, backend, healthChecks: HEALTH, clockStepMs: STEP_MS });
  return attempts;
}

for (const backend of BACKENDS) {
  for (const link of LINKS)
    test(`the navigation scenario on a ${link.name} link on ${backend}: no hole, black pixel or pop; bounded retries with backoff (F315, F329)`, async ({
      page,
    }) => {
      const session = sessionId(`${link.name}-${backend}`);
      const attempts = await startOn(page, backend, link, session);
      const report = await recordPath(page, NAVIGATION, BLACK_BELOW);
      console.log(`[network] ${link.name} ${backend}: ${JSON.stringify(report)}`);
      expectClean(report);
      expect(
        backoffViolations(attempts, { maxAttempts: 6, healthMinIntervalMs: HEALTH.minIntervalMs, isHealthCheck }),
      ).toEqual([]);
    });

  test(`the navigation scenario in LAN-only mode on ${backend}: packages and tiles from the LAN server only, no hole, black pixel or pop (F315, F329)`, async ({
    page,
  }) => {
    const session = sessionId(`lan-${backend}`);
    await openHarness(page);
    const lan = await servePackages(page);
    const sources = [{ id: 'world', pattern: 'world', session }];
    await startHarness(page, { sources, view: ROME, backend });
    const base = await publishFixture(page, lan, worldBase(session));
    const lanHost = new URL(page.url()).host;
    const elsewhere: string[] = [];
    await page.route(
      (url) => !lanOnly(url, lanHost),
      (route) => {
        elsewhere.push(route.request().url());
        return route.abort('internetdisconnected');
      },
    );
    await startHarness(page, {
      sources,
      served: [base.manifestUrl],
      view: ROME,
      backend,
      healthChecks: HEALTH,
      clockStepMs: STEP_MS,
    });
    const report = await recordPath(page, NAVIGATION, BLACK_BELOW);
    console.log(`[network] LAN-only ${backend}: ${JSON.stringify(report)}`);
    expectClean(report);
    expect((await servedTiers(page))['package'] ?? 0).toBeGreaterThan(0);
    expect(elsewhere).toEqual([]);
  });
}
