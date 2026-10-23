// Streamed features (M10, F372): 100,000 points arriving from the application in chunks of 1,000 over 30 seconds show
// in the next frame each, without rebuilding the layer.
import { expect, test } from '@playwright/test';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

declare global {
  interface Window {
    vibeglobeStream?: { add(chunk: number): [number, number]; count(): number };
  }
}

test.use({ viewport: { width: 480, height: 360 } });

test('100,000 points streamed in chunks of 1,000 over 30 s each show in the next frame, with no layer rebuild (F372)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openGlobe(page, 'backend=webgl2&scenario=data-stream&lon=11.4&lat=41.4&zoom=5.4&viewMode=2d');
  await page.waitForFunction(() => window.vibeglobeStream !== undefined);
  await waitForIdle(page);
  const stats = () => page.evaluate(() => window.vibeglobePlayground?.globe.layerTarget()?.stats?.());
  let rebuilds: number | undefined;
  const started = Date.now();
  for (let chunk = 0; chunk < 100; chunk++) {
    const [west, south] = await page.evaluate((k) => window.vibeglobeStream?.add(k) ?? [0, 0], chunk);
    if (chunk % 10 === 0 || chunk === 99) {
      // The next frame drawn shows the chunk: a red point at its first position.
      const image = await canvasImage(page);
      const at = await page.evaluate(
        ([lon, lat]) =>
          window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: lon ?? 0, latitudeDeg: lat ?? 0 }),
        [west, south],
      );
      if (!at) throw new Error(`chunk ${chunk} off screen`);
      let red = 0;
      for (let y = Math.round(at.yPx) - 2; y <= Math.round(at.yPx) + 2; y++)
        for (let x = Math.round(at.xPx) - 2; x <= Math.round(at.xPx) + 2; x++) {
          const i = (y * image.width + x) * 4;
          if ((image.data[i] ?? 0) > 180 && (image.data[i + 1] ?? 0) < 90 && (image.data[i + 2] ?? 0) < 90) red++;
        }
      let total = 0;
      for (let i = 0; i < image.data.length; i += 4)
        if ((image.data[i] ?? 0) > 180 && (image.data[i + 1] ?? 0) < 90 && (image.data[i + 2] ?? 0) < 90) total++;
      expect(red, `chunk ${chunk} at ${JSON.stringify(at)}, ${total} red in all`).toBeGreaterThan(0);
    }
    // The layer's batch is built once, with the first chunk; later chunks are written into it.
    if (chunk === 0) rebuilds = (await stats())?.rebuilds;
    // A chunk every 300 ms of the 30 s.
    const due = started + (chunk + 1) * 300;
    if (Date.now() < due) await page.waitForTimeout(due - Date.now());
  }
  await waitForIdle(page);
  expect(await page.evaluate(() => window.vibeglobeStream?.count())).toBe(100_000);
  const after = await stats();
  expect(after?.rebuilds).toBe(rebuilds);
  expect(after?.rangeUploads ?? 0).toBeGreaterThan(50);
});
