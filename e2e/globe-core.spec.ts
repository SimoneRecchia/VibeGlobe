import { expect, test, type Page } from '@playwright/test';
import { expectCompleteGlobe, geoToScreen, openGlobe, screenToGeo, waitForIdle } from './support/globe.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;

/** Collects uncaught page errors and console errors, which every test asserts are absent. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test('positions in and out of the public API are WGS84 degrees and meters (F043)', async ({ page }) => {
  await openGlobe(page, 'lon=12.5&lat=41.9&zoom=5');
  const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
  expect(camera?.longitudeDeg).toBeCloseTo(12.5, 9);
  expect(camera?.latitudeDeg).toBeCloseTo(41.9, 9);
  expect(camera?.altitudeMeters).toBeGreaterThan(1000);
  const center = await page.evaluate(() => {
    const canvas = document.querySelector('#globe');
    return { xPx: (canvas?.clientWidth ?? 0) / 2, yPx: (canvas?.clientHeight ?? 0) / 2 };
  });
  const position = await screenToGeo(page, center);
  expect(position?.longitudeDeg).toBeCloseTo(12.5, 6);
  expect(position?.latitudeDeg).toBeCloseTo(41.9, 6);
  expect(Object.keys(position ?? {}).sort()).toEqual(['heightMeters', 'latitudeDeg', 'longitudeDeg']);
});

test('the cursor readout reports the WGS84 position under the pointer and nothing off the globe (F048)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // Rome's Colosseum at zoom 12: one pixel is about 20 m on the ground.
  await openGlobe(page, 'lon=12.4922&lat=41.8902&zoom=12');
  const box = await page.locator('#globe').boundingBox();
  if (!box) throw new Error('no canvas');
  const target = await geoToScreen(page, { longitudeDeg: 12.4922, latitudeDeg: 41.8902 });
  await page.mouse.move(box.x + target.xPx, box.y + target.yPx);
  const [lat, lon] = ((await page.locator('#cursor').textContent()) ?? '')
    .split(',')
    .map((part) => Number.parseFloat(part));
  // Within one pixel's ground size (about 20 m, so 2e-4°).
  expect(Math.abs((lat ?? NaN) - 41.8902)).toBeLessThan(2e-4);
  expect(Math.abs((lon ?? NaN) - 12.4922)).toBeLessThan(2e-4);
  await openGlobe(page, 'zoom=1');
  await page.mouse.move(box.x + 3, box.y + 3);
  await expect(page.locator('#cursor')).toHaveText('Off the globe');
  expect(errors).toEqual([]);
});

test('renders with WebGPU by default where WebGPU is available (F053)', async ({ page }) => {
  await openGlobe(page, 'debug=1');
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgpu');
  await expect(page.locator('.vibeglobe-debug-overlay [data-metric="backend"]')).toHaveText('backend webgpu');
  await expectCompleteGlobe(page);
});

test.describe('falls back to WebGL2 when WebGPU is unavailable (F054)', () => {
  test('without navigator.gpu', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined });
    });
    await openGlobe(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgl2');
    await expectCompleteGlobe(page);
  });

  test('when the adapter request fails', async ({ page }) => {
    await page.addInitScript(() => {
      const gpu = navigator.gpu as GPU | undefined;
      if (gpu) gpu.requestAdapter = () => Promise.resolve(null);
    });
    await openGlobe(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgl2');
    await expectCompleteGlobe(page);
  });

  test('when forced with ?backend=webgl2', async ({ page }) => {
    await openGlobe(page, 'backend=webgl2');
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgl2');
    await expectCompleteGlobe(page);
  });
});

test('reports a typed unsupported-device error when neither WebGPU nor WebGL2 exists, and the page survives (F055)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined });
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return type === 'webgl2' || type === 'webgl'
        ? null
        : (getContext as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof getContext;
  });
  await page.goto('/');
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
  const outcome = await page.evaluate(async () => {
    try {
      await window.vibeglobePlayground?.globe.ready;
      return 'started';
    } catch (error) {
      return (error as { code?: string; message: string }).code + ': ' + (error as Error).message;
    }
  });
  expect(outcome).toMatch(/^unsupported-device: .*neither WebGPU nor WebGL2/);
  expect(await page.evaluate(() => window.vibeglobePlayground?.events.map((e) => e.type))).toContain('error');
  await expect(page.locator('#status')).toContainText('could not start');
  expect(errors).toEqual([]);
});

for (const backend of BACKENDS) {
  test(`reports the backend, GPU limits and memory hints through the API and the overlay on ${backend} (F056)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&debug=1`);
    const caps = await page.evaluate(() => window.vibeglobePlayground?.globe.capabilities);
    expect(caps?.backend).toBe(backend);
    expect(caps?.maxTextureSize).toBeGreaterThanOrEqual(4096);
    expect(caps?.maxAnisotropy).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(caps?.compressedTextureFormats)).toBe(true);
    const overlay = page.locator('.vibeglobe-debug-overlay');
    await expect(overlay.locator('[data-metric="backend"]')).toHaveText(`backend ${backend}`);
    await expect(overlay.locator('[data-metric="max-texture-size"]')).toHaveText(`max texture ${caps?.maxTextureSize}`);
    await expect(overlay.locator('[data-metric="max-anisotropy"]')).toHaveText(`anisotropy ${caps?.maxAnisotropy}`);
    await expect(overlay.locator('[data-metric="compressed-formats"]')).toContainText('compressed');
    await expect(overlay.locator('[data-metric="device-memory"]')).toContainText('memory');
  });

  test(`the globe is complete from orbit at every longitude and over both poles on ${backend} (F059)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&zoom=1`);
    for (const [lon, lat] of [
      [0, 0],
      [60, 0],
      [120, 0],
      [180, 0],
      [-120, 0],
      [-60, 0],
      [0, 90],
      [45, -90],
    ] as const) {
      await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), {
        longitudeDeg: lon,
        latitudeDeg: lat,
      });
      await expectCompleteGlobe(page);
    }
  });

  test(`dragging keeps the grabbed point under the cursor, also near the edge and over a pole, on ${backend} (F060)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&lon=10&lat=60&zoom=2`);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    for (const [from, to] of [
      [
        { xPx: box.width / 2, yPx: box.height / 2 },
        { xPx: box.width / 2 + 150, yPx: box.height / 2 + 60 },
      ],
      // From just inside the globe's edge, then a long vertical drag that carries the north pole under the cursor.
      [
        { xPx: box.width / 2, yPx: box.height / 2 + 150 },
        { xPx: box.width / 2, yPx: box.height / 2 - 120 },
      ],
    ] as const) {
      const grabbed = await screenToGeo(page, from);
      if (!grabbed) throw new Error('grab point off the globe');
      await page.mouse.move(box.x + from.xPx, box.y + from.yPx);
      await page.mouse.down();
      for (let step = 1; step <= 8; step++) {
        const point = {
          xPx: from.xPx + ((to.xPx - from.xPx) * step) / 8,
          yPx: from.yPx + ((to.yPx - from.yPx) * step) / 8,
        };
        await page.mouse.move(box.x + point.xPx, box.y + point.yPx);
        const shown = await geoToScreen(page, grabbed);
        expect(Math.hypot(shown.xPx - point.xPx, shown.yPx - point.yPx)).toBeLessThan(1);
      }
      await page.mouse.up();
    }
    await expectCompleteGlobe(page);
  });

  test(`wheel zoom stays anchored at the cursor from orbit to about 1 m and back on ${backend} (F061)`, async ({
    page,
  }) => {
    // 160 wheel steps, each drawn by a software rasterizer in CI.
    test.setTimeout(180_000);
    await openGlobe(page, `backend=${backend}&lon=9.19&lat=45.46&zoom=2`);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    const cursor = { xPx: box.width / 2 + 40, yPx: box.height / 2 - 30 };
    await page.mouse.move(box.x + cursor.xPx, box.y + cursor.yPx);
    for (let i = 0; i < 80; i++) {
      const anchor = await screenToGeo(page, cursor);
      if (!anchor) throw new Error('cursor off the globe');
      await page.mouse.wheel(0, -100);
      const shown = await geoToScreen(page, anchor);
      expect(Math.hypot(shown.xPx - cursor.xPx, shown.yPx - cursor.yPx)).toBeLessThan(1);
    }
    const altitude = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters ?? NaN);
    expect(altitude).toBeGreaterThanOrEqual(0.5);
    expect(altitude).toBeLessThan(1.5);
    await waitForIdle(page);
    for (let i = 0; i < 80; i++) await page.mouse.wheel(0, 100);
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 9.19, latitudeDeg: 45.46 }));
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.zoom ?? NaN)).toBeLessThan(3);
    await expectCompleteGlobe(page);
  });
}
