// 3D Tiles from the production build (KB-176): the playground's shipped bundle decodes the city's glTF content in the
// engine's workers (`parse-model`), so tiles draw and none fails, as on the development server.
import { expect, test } from '@playwright/test';

const PREVIEW = `http://localhost:${process.env['PLAYGROUND_PREVIEW_PORT'] ?? 5176}`;

test('the production build decodes and draws 3D Tiles content in the engine workers (KB-176, F463)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`${PREVIEW}/?scenario=3dtiles-city&tiles3d=draco`);
  await page.waitForFunction(() => window.vibeglobeTiles3d !== undefined, null, { timeout: 60_000 });
  // The globe alone draws about 20 tiles: the city's content adds its own draws once decoded.
  await expect
    .poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats().drawCalls ?? 0), {
      timeout: 60_000,
    })
    .toBeGreaterThan(30);
  expect(await page.evaluate(() => window.vibeglobeTiles3d?.errors ?? ['no hooks'])).toEqual([]);
});
