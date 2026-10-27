// Clustering (M10, F373): 100,000 points clustered in a worker; cluster counts add up to the points at every zoom from
// the globe to the street, and a click on a cluster fits the view to its points.
import { expect, test } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

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

/** Pixels whose color changed by more than a hint between two frames. */
function changedPixels(a: PNG, b: PNG): number {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta =
      Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) +
      Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) +
      Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    if (delta > 30) count++;
  }
  return count;
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`clusters split and merge across zoom levels without a pop, frame by frame, on ${backend} (F373)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // A fixed engine step per frame: the split and merge animations advance the same on every machine.
    await openGlobe(
      page,
      `backend=${backend}&scenario=data-cluster&lon=12.5&lat=41.9&zoom=5.99&clockStepMs=16.666666666666668`,
    );
    await page.waitForFunction(() => window.vibeglobeCluster !== undefined);
    await page.evaluate(() => window.vibeglobeCluster?.layer.loaded);
    for (const [from, to] of [
      [5.99, 6.01],
      [6.01, 5.99],
      [7.99, 8.01],
      [8.01, 7.99],
    ] as const) {
      await page.evaluate((zoom) => window.vibeglobePlayground?.globe.jumpTo({ zoom }), from);
      await waitForIdle(page);
      let previous = await canvasImage(page);
      // Across the level by a fiftieth of a zoom level: the map itself barely changes, the clusters split or merge.
      await page.evaluate((zoom) => window.vibeglobePlayground?.globe.jumpTo({ zoom }), to);
      const changes: number[] = [];
      for (let frame = 0; frame < 30; frame++) {
        const image = await canvasImage(page);
        changes.push(changedPixels(previous, image));
        previous = image;
      }
      const total = changes.reduce((sum, change) => sum + change, 0);
      console.log(`[cluster] ${backend} ${from} → ${to}: ${changes.join(',')}`);
      // The transition shows, spread over frames: no frame carries most of it, as a pop would.
      expect(total, `${from} → ${to}`).toBeGreaterThan(5000);
      expect(Math.max(...changes) / total, `${from} → ${to}`).toBeLessThan(0.4);
    }
  });
