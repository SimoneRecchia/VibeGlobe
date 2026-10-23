// Clustering (M10, F373): 100,000 points clustered in a worker; cluster counts add up to the points at every zoom from
// the globe to the street, and a click on a cluster fits the view to its points.
import { expect, test } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

interface Item {
  key: string;
  longitudeDeg: number;
  latitudeDeg: number;
  count: number;
  clusterId?: number;
}

declare global {
  interface Window {
    vibeglobeCluster?: {
      readonly layer: {
        loaded: Promise<void>;
        shownZoom?: number;
        pointCount: number;
        shownPointCount(): number;
        shownItems(): Item[];
      };
      readonly tasks: readonly string[];
    };
  }
}

test('100,000 points cluster in a worker, counts add up at every zoom, and a click on a cluster fits its points (F373)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openGlobe(page, 'backend=webgl2&scenario=data-cluster&lon=12.5&lat=41.9&zoom=2');
  await page.waitForFunction(() => window.vibeglobeCluster !== undefined);
  await page.evaluate(() => window.vibeglobeCluster?.layer.loaded);
  // Built and queried in a worker of the engine's worker program.
  await expect
    .poll(() => page.evaluate(() => window.vibeglobeCluster?.tasks))
    .toEqual(expect.arrayContaining(['cluster-load', 'cluster-items']));
  for (const zoom of [2, 4, 6, 8, 10, 13, 16]) {
    // Mid-level: the clusters of an integer zoom show from it to the next.
    await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z + 0.5 }), zoom);
    await expect
      .poll(() => page.evaluate(() => window.vibeglobeCluster?.layer.shownZoom), { timeout: 30_000 })
      .toBe(zoom);
    await waitForIdle(page);
    const counts = await page.evaluate(() => {
      const layer = window.vibeglobeCluster?.layer;
      return { shown: layer?.shownPointCount(), total: layer?.pointCount };
    });
    expect(counts.shown, `zoom ${zoom}`).toBe(100_000);
    expect(counts.total).toBe(100_000);
  }
  // A click on the largest cluster in view fits the view to its points.
  await page.evaluate(() =>
    window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6.5 }),
  );
  await expect.poll(() => page.evaluate(() => window.vibeglobeCluster?.layer.shownZoom), { timeout: 30_000 }).toBe(6);
  await waitForIdle(page);
  const target = await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const items = window.vibeglobeCluster?.layer.shownItems() ?? [];
    const inView = items
      .filter((item) => item.clusterId !== undefined)
      .map((item) => ({ item, at: globe?.geoToScreen(item) }))
      .filter(({ at }) => at && at.xPx > 20 && at.yPx > 20 && at.xPx < 460 && at.yPx < 340);
    inView.sort((a, b) => b.item.count - a.item.count);
    return inView[0];
  });
  if (!target?.at) throw new Error('no cluster in view');
  const zoomBefore = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.zoom ?? 0);
  const box = await page.locator('#globe').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.click(box.x + target.at.xPx, box.y + target.at.yPx);
  await expect
    .poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.camera.zoom ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(zoomBefore + 0.5);
  await waitForIdle(page);
  // The cluster's position is still in view, now larger.
  const after = await page.evaluate((item) => window.vibeglobePlayground?.globe.geoToScreen(item), target.item);
  expect(after && after.xPx > 0 && after.xPx < 480 && after.yPx > 0 && after.yPx < 360).toBe(true);
});
