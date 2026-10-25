import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import {
  canvasImage,
  expectCompleteGlobe,
  geoToScreen,
  nextFrame,
  openGlobe,
  screenToGeo,
  waitForIdle,
} from './support/globe.ts';
import { measureLargeShift } from './support/image.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;

/** An init script that makes every WebGPU texture view invalid (a mip level count no texture has). */
function breakTextureViews(): void {
  const prototype = (globalThis as { GPUTexture?: { prototype: GPUTexture } }).GPUTexture?.prototype;
  if (!prototype) return;
  const createView = prototype.createView;
  prototype.createView = function (this: GPUTexture, descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    return createView.call(this, { ...descriptor, mipLevelCount: 99 });
  };
}

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

/**
 * The image the globe should show: the pinned equirectangular imagery, decoded by the browser's 2D canvas and sampled
 * (bilinearly, in linear light) at the WGS84 position `screenToGeo` reports for each pixel center.
 */
async function expectedImagery(page: Page, width: number, height: number): Promise<PNG> {
  const data = await page.evaluate(
    async ({ widthPx, heightPx }) => {
      const image = new Image();
      image.src = '/imagery/natural-earth-4096.jpg';
      await image.decode();
      const source = document.createElement('canvas');
      source.width = image.width;
      source.height = image.height;
      const context = source.getContext('2d');
      if (!context) throw new Error('no 2D context');
      context.drawImage(image, 0, 0);
      const texels = context.getImageData(0, 0, image.width, image.height).data;
      const toLinear = (c: number): number => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const toSrgb = (c: number): number => 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
      const texel = (u: number, v: number, channel: number): number => {
        const x = ((u % image.width) + image.width) % image.width;
        const y = Math.min(Math.max(v, 0), image.height - 1);
        return toLinear(texels[(y * image.width + x) * 4 + channel] ?? 0);
      };
      const globe = window.vibeglobePlayground?.globe;
      const canvas = document.querySelector('#globe');
      if (!globe || !canvas) throw new Error('no globe');
      const cssPerPx = canvas.clientWidth / widthPx;
      const out: number[] = new Array<number>(widthPx * heightPx * 4).fill(0);
      for (let y = 0; y < heightPx; y++) {
        for (let x = 0; x < widthPx; x++) {
          const position = globe.screenToGeo({ xPx: (x + 0.5) * cssPerPx, yPx: (y + 0.5) * cssPerPx });
          if (!position) continue;
          const u = ((position.longitudeDeg + 180) / 360) * image.width - 0.5;
          const v = ((90 - position.latitudeDeg) / 180) * image.height - 0.5;
          const u0 = Math.floor(u);
          const v0 = Math.floor(v);
          const fu = u - u0;
          const fv = v - v0;
          for (let channel = 0; channel < 3; channel++) {
            const top = texel(u0, v0, channel) * (1 - fu) + texel(u0 + 1, v0, channel) * fu;
            const bottom = texel(u0, v0 + 1, channel) * (1 - fu) + texel(u0 + 1, v0 + 1, channel) * fu;
            out[(y * widthPx + x) * 4 + channel] = toSrgb(top * (1 - fv) + bottom * fv);
          }
          out[(y * widthPx + x) * 4 + 3] = 255;
        }
      }
      return out;
    },
    { widthPx: width, heightPx: height },
  );
  const png = new PNG({ width, height });
  for (let i = 0; i < data.length; i++) png.data[i] = Math.round(data[i] ?? 0);
  return png;
}

for (const backend of BACKENDS) {
  test(`the imagery is georeferenced: features show where screenToGeo places them on ${backend} (F048)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 480, height: 360 });
    // Coastlines of Italy, Gibraltar, Japan and Chile, at a zoom where a screen pixel is smaller than an image texel.
    for (const [lon, lat] of [
      [15, 40],
      [-5, 37],
      [140, 36],
      [-70, -33],
    ] as const) {
      await openGlobe(page, `backend=${backend}&lon=${lon}&lat=${lat}&zoom=6`);
      await page.addStyleTag({ content: '#status, #cursor { visibility: hidden !important; }' });
      await waitForIdle(page);
      const rendered = await canvasImage(page);
      const expected = await expectedImagery(page, rendered.width, rendered.height);
      const shift = measureLargeShift(expected, rendered, 6);
      // One image texel is about four screen pixels here; a half-texel error would show as a 2 px shift.
      expect(Math.hypot(shift.dx, shift.dy)).toBeLessThan(0.5);
    }
  });
}

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

  test('when WebGPU fails its start-up self-test (ADR 0010 §2)', async ({ page }) => {
    // Every texture view WebGPU creates is invalid: init() succeeds, the first draw does not.
    await page.addInitScript(breakTextureViews);
    await openGlobe(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgl2');
    const fallback = await page.evaluate(() =>
      window.vibeglobePlayground?.events.find((event) => event.type === 'backend-fallback'),
    );
    expect(JSON.stringify(fallback?.payload)).toContain('self-test');
    await expectCompleteGlobe(page);
  });

  test('when forced with ?backend=webgl2', async ({ page }) => {
    await openGlobe(page, 'backend=webgl2');
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgl2');
    await expectCompleteGlobe(page);
  });
});

test('a forced WebGPU backend reports unsupported-device instead of falling back to WebGL2 (KB-019)', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined });
  });
  await page.goto('/?backend=webgpu');
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
  const outcome = await page.evaluate(async () => {
    try {
      await window.vibeglobePlayground?.globe.ready;
      return `started on ${String(window.vibeglobePlayground?.globe.backend)}`;
    } catch (error) {
      return String((error as { code?: string }).code);
    }
  });
  expect(outcome).toBe('unsupported-device');
});

test('a forced WebGPU backend that fails its start-up self-test reports unsupported-device (ADR 0010 §2)', async ({
  page,
}) => {
  await page.addInitScript(breakTextureViews);
  await page.goto('/?backend=webgpu');
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
  const outcome = await page.evaluate(async () => {
    try {
      await window.vibeglobePlayground?.globe.ready;
      return `started on ${String(window.vibeglobePlayground?.globe.backend)}`;
    } catch (error) {
      return `${String((error as { code?: string }).code)}: ${(error as Error).message}`;
    }
  });
  expect(outcome).toMatch(/^unsupported-device: .*self-test/);
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

  test(`navigation compiles no pipeline after the start-up warm-up on ${backend} (ADR 0010 §4)`, async ({ page }) => {
    // A small viewport: the wheel zooms from 3 to 23 through every phase, and a software GPU draws each of the frames
    // on the way at a fraction of the cost of a full-size canvas.
    await page.setViewportSize({ width: 480, height: 360 });
    await openGlobe(page, `backend=${backend}&debug=1&zoom=3`);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 80, { steps: 10 });
    await page.mouse.up();
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -300);
    await waitForIdle(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats().pipelineCompiles)).toBe(0);
    await expect(page.locator('.vibeglobe-debug-overlay [data-metric="pipeline-compiles"]')).toHaveText(
      'pipelines after warm-up 0',
    );
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

  test(`the imagery is complete at low altitude all over the world on ${backend} (F059, KB-012)`, async ({ page }) => {
    test.setTimeout(180_000);
    await openGlobe(page, `backend=${backend}&zoom=2`);
    for (const [lon, lat] of [
      [12.5, 41.9],
      [-74, 40.7],
      [151.2, -33.9],
      [25, 60],
      [-40, 80],
      [100, -80],
      [0, 7.1],
    ] as const) {
      for (const zoom of [8, 14, 20]) {
        await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), {
          longitudeDeg: lon,
          latitudeDeg: lat,
          zoom,
        });
        await expectCompleteGlobe(page);
      }
    }
  });

  test(`dragging keeps the grabbed point under the cursor, also near the edge and over a pole, on ${backend} (F060)`, async ({
    page,
  }) => {
    // A smaller viewport: each step waits for a frame, which a software GPU draws in proportion to the canvas size.
    await page.setViewportSize({ width: 640, height: 480 });
    await openGlobe(page, `backend=${backend}&lon=10&lat=60&zoom=2`);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    const center = { xPx: box.width / 2, yPx: box.height / 2 };
    // The globe's screen radius below the center: the last pixel that still shows the ellipsoid (a binary search, so
    // the test spends its time on the drags).
    let radiusPx = 0;
    let outsidePx = Math.floor(box.height - center.yPx);
    while (outsidePx - radiusPx > 1) {
      const middle = Math.floor((radiusPx + outsidePx) / 2);
      if (await screenToGeo(page, { ...center, yPx: center.yPx + middle })) radiusPx = middle;
      else outsidePx = middle;
    }
    expect(radiusPx).toBeGreaterThan(100);
    for (const [from, to] of [
      [center, { xPx: center.xPx + 150, yPx: center.yPx + 60 }],
      // From 95% of the way to the globe's edge, then a long vertical drag that carries the north pole under the
      // cursor.
      [
        { xPx: center.xPx, yPx: center.yPx + radiusPx * 0.95 },
        { xPx: center.xPx, yPx: center.yPx - 120 },
      ],
    ] as const) {
      const grabbed = await screenToGeo(page, from);
      // A second point 60 px to the side shows whether the view turns or jumps (ADR 0015 #10: no heading jump at the
      // pole): in a drag it moves along with the cursor.
      const companion = await screenToGeo(page, { xPx: from.xPx + 60, yPx: from.yPx });
      if (!grabbed || !companion) throw new Error('grab point off the globe');
      let companionShown = await geoToScreen(page, companion);
      await page.mouse.move(box.x + from.xPx, box.y + from.yPx);
      await page.mouse.down();
      const steps = 16;
      const stepPx = Math.hypot(to.xPx - from.xPx, to.yPx - from.yPx) / steps;
      for (let step = 1; step <= steps; step++) {
        const point = {
          xPx: from.xPx + ((to.xPx - from.xPx) * step) / steps,
          yPx: from.yPx + ((to.yPx - from.yPx) * step) / steps,
        };
        await page.mouse.move(box.x + point.xPx, box.y + point.yPx);
        // The move lands in the frame after the one that may already be under way when the event arrives (a loaded
        // CI runner measured one step behind): wait for the frame that applied it, then hold it to 1 px.
        // A failure names the step, the distance and whether the engine drew frames meanwhile.
        const framesBefore = await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
        const deadline = Date.now() + 5000;
        let distancePx: number;
        do {
          await nextFrame(page);
          const shown = await geoToScreen(page, grabbed);
          distancePx = Math.hypot(shown.xPx - point.xPx, shown.yPx - point.yPx);
        } while (distancePx >= 1 && Date.now() < deadline);
        const framesDrawn =
          (await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0)) - framesBefore;
        expect(distancePx, `step ${step} from ${JSON.stringify(from)}: ${framesDrawn} frames drawn`).toBeLessThan(1);
        const next = await geoToScreen(page, companion);
        expect(Math.hypot(next.xPx - companionShown.xPx, next.yPx - companionShown.yPx)).toBeLessThan(3 * stepPx);
        companionShown = next;
      }
      // Held still before the release, the drag ends without a glide (KB-177: a 150 ms hold zeroes the release
      // velocity), which on CI's software GPU took most of the test's time; F060 is the tracking during the drag.
      await page.waitForTimeout(200);
      await page.mouse.up();
      // The next drag's points are picked once the globe holds still.
      await waitForIdle(page);
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
      await nextFrame(page);
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
