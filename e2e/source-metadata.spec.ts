import { expect, test } from '@playwright/test';
import { openGlobe } from './support/globe.ts';
import { waitForStreaming } from './support/imagery.ts';

/**
 * Source metadata (F220): fixture sources declare their reference system, levels, tile size, coverage, rate limit,
 * credits, loading permissions and authentication; the engine reports them through `Globe.imageryLayers` and the
 * playground's debug overlay (`?debug=1`). Invalid metadata is covered by Vitest (imagery-stack, imagery-globe).
 */
test.use({ viewport: { width: 640, height: 400 } });

test('sources report their declared metadata through the inspection API and the debug overlay (F220)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openGlobe(
    page,
    'imagery=world&rateLimit=20&coverage=italy&overlays=patches&overlayAuth=1&debug=1&lon=12&lat=42&zoom=5',
  );
  await waitForStreaming(page);
  const sources = await page.evaluate(() =>
    window.vibeglobePlayground?.globe.imageryLayers.list().flatMap((layer) => layer.sources),
  );
  expect(sources).toHaveLength(2);
  const [base, overlay] = sources ?? [];
  expect(base).toMatchObject({
    id: 'fixture-world',
    crs: 'EPSG:3857',
    minLevel: 0,
    maxLevel: 18,
    tileSizePx: 256,
    pixelRatio: 1,
    maxRequestsPerSecond: 20,
    attribution: [{ text: 'Fixture world', url: 'https://example.com/fixtures/world' }],
    keepInMemory: true,
    prefetch: true,
    authenticated: false,
  });
  expect(base?.coverageDeg).toHaveLength(1);
  expect(overlay).toMatchObject({ id: 'overlay-patches', authenticated: true });
  const panel = page.locator('[aria-label="Engine diagnostics"]');
  await expect(panel).toContainText('source fixture-world EPSG:3857 z0–18 256px 20/s cache prefetch');
  await expect(panel).toContainText('source overlay-patches EPSG:3857 z0–18 256px cache prefetch auth');
});
