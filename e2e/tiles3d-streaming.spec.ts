// 3D Tiles stream by screen-space error with REPLACE refinement and no holes (F461): while zooming in and out over
// the fixture city on both backends, on a normal and on a slow link, every drawn frame covers the city's footprint
// (a ray from each grid point inside it hits a drawn tile); the debug overlay shows each tile's level and error.
import { expect, test } from '@playwright/test';
import { CITY, openCity, settleTiles, startCoverage, stopCoverage, zoomSteps } from './support/tiles3d.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.setTimeout(180_000);

for (const backend of ['webgl2', 'webgpu'] as const)
  for (const link of ['fast', 'slow'] as const)
    test(`no holes while zooming in and out (${backend}, ${link} link) (F461)`, async ({ page }) => {
      if (link === 'slow')
        await page.route('**/tiles3d/**', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          await route.continue();
        });
      await openCity(page, `backend=${backend}&lon=${CITY.longitudeDeg}&lat=${CITY.latitudeDeg}&zoom=13&tilt=30`);
      await settleTiles(page);
      expect(await page.evaluate(() => window.vibeglobeTiles3d?.extension.stats().drawn)).toBeGreaterThan(0);
      await startCoverage(page);
      await zoomSteps(page, 13, 18, 20);
      await zoomSteps(page, 18, 13.5, 12);
      await zoomSteps(page, 13.5, 17, 10);
      const coverage = await stopCoverage(page);
      console.log(
        `${backend} ${link}: ${coverage.frames} frames, ${coverage.samples} samples, ${coverage.holes} holes`,
      );
      expect(coverage.frames).toBeGreaterThan(30);
      expect(coverage.samples).toBeGreaterThan(1000);
      expect(coverage.holes, `holes at ${JSON.stringify(coverage.worst)}`).toBe(0);
      // Refinement reached the leaves up close.
      const levels = await page.evaluate(() => window.vibeglobeTiles3d?.extension.debugTiles().map((t) => t.level));
      expect(Math.max(...(levels ?? []))).toBe(3);
    });

test("the debug overlay shows each drawn tile's level and screen-space error (F461)", async ({ page }) => {
  await openCity(page, `backend=webgl2&debug3dtiles&lon=${CITY.longitudeDeg}&lat=${CITY.latitudeDeg}&zoom=16.5&tilt=60`);
  await settleTiles(page);
  const drawn = await page.evaluate(() => window.vibeglobeTiles3d?.extension.debugTiles() ?? []);
  const labels = await page.$$eval('.vg-tiles3d-tile', (els) =>
    els.map((el) => ({
      id: (el as HTMLElement).dataset['tile'],
      level: Number((el as HTMLElement).dataset['level']),
      sse: Number((el as HTMLElement).dataset['sse']),
      text: el.textContent,
    })),
  );
  expect(labels.map((l) => l.id).sort()).toEqual(drawn.map((t) => t.id).sort());
  for (const label of labels) {
    const tile = drawn.find((t) => t.id === label.id);
    expect(label.level).toBe(tile?.level);
    expect(label.sse).toBeCloseTo(tile?.screenSpaceErrorPx ?? -1, 0);
    expect(label.text).toMatch(/^L\d \d+\.\d px$/);
  }
  expect(new Set(labels.map((l) => l.level)).size).toBeGreaterThan(1);
});
