// The playground's offline engine (KB-185; F271, F272, F291, F292): `?network=` wraps the fixture imagery in that
// network mode, `?debug=1` shows where tiles came from tier by tier, and offline-only mode never asks the network.
import { expect, test } from '@playwright/test';
import { openGlobe } from './support/globe.ts';

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
