// The playground's offline engine (KB-185, KB-196; F271, F272, F291, F292): `?network=` wraps the fixture imagery in
// that network mode, `?debug=1` shows where tiles came from tier by tier, offline-only mode never asks the network, and
// a package installed in the playground draws the globe offline.
import { expect, test, type Page } from '@playwright/test';
import { expectCompleteGlobe, openGlobe, waitForIdle } from './support/globe.ts';
import { recordTileRequests } from './support/offline.ts';

/** The tier counts of the debug overlay's `tiers:` row. */
async function tiers(page: Page): Promise<{ package: number; network: number }> {
  const text = (await page.getByText(/^tiers: /).textContent()) ?? '';
  return {
    package: Number(/package (\d+)/.exec(text)?.[1] ?? NaN),
    network: Number(/network (\d+)$/.exec(text)?.[1] ?? NaN),
  };
}

test('?network= runs the playground on the offline engine: hybrid tiers in ?debug=1, offline-only asks no network (KB-185)', async ({
  page,
}) => {
  await openGlobe(page, 'imagery=world&session=playground-offline&network=hybrid&debug=1');
  await expect(page.getByText(/network hybrid · online/)).toBeVisible({ timeout: 30_000 });
  // The tiles of the view came from the network tier (nothing installed, the persistent cache empty).
  await expect
    .poll(async () => Number(/network (\d+)$/.exec((await page.getByText(/^tiers: /).textContent()) ?? '')?.[1] ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/fixture-tiles/playground-offline-2/')) requests.push(request.url());
  });
  await openGlobe(page, 'imagery=world&session=playground-offline-2&network=offline&debug=1');
  await expect(page.getByText(/network offline/)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  expect(requests).toEqual([]);
});

test('a world package installed in the playground draws the whole globe offline-only, and online mode never reads it (F291, F292, KB-196)', async ({
  page,
}) => {
  // Three page loads, a 21-tile package build and a complete globe: over the default 30 s on CI's software GPU.
  test.setTimeout(120_000);
  await openGlobe(page, 'imagery=world&session=playground-package&network=hybrid&zoom=1');
  const tiles = await page.evaluate(async () => {
    const demo = (
      window as {
        vibeglobeOffline?: {
          offline: { clearCache(): Promise<void> };
          installWorld(maxLevel: number): Promise<{ report?: { tiles: number } }>;
        };
      }
    ).vibeglobeOffline;
    const report = (await demo?.installWorld(2))?.report;
    // The view's tiles cached meanwhile would serve it first: only the package is left to draw from.
    await demo?.offline.clearCache();
    return report?.tiles ?? 0;
  });
  expect(tiles).toBe(1 + 4 + 16);

  // Offline-only, with the package installed (IndexedDB keeps it across the reload): the globe is complete from it.
  const requests = recordTileRequests(page);
  await openGlobe(page, 'imagery=world&session=playground-package&network=offline&debug=1&zoom=1');
  await expectCompleteGlobe(page);
  expect(requests).toEqual([]);
  expect((await tiers(page)).package).toBeGreaterThan(0);

  // Online-only: the network serves every tile, the installed package is never read (F291).
  await openGlobe(page, 'imagery=world&session=playground-package&network=online&debug=1&zoom=1.5');
  await waitForIdle(page);
  await expect.poll(async () => (await tiers(page)).network).toBeGreaterThan(0);
  expect((await tiers(page)).package).toBe(0);
});
