import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, geoToScreen, openGlobe, waitForIdle } from './support/globe.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;

/** The Mercator zoom that puts a straight-down camera about 0.94 m above the ground at a latitude (zoom 25.5 at 45.46°). */
function zoomForOneMeter(latitudeDeg: number): number {
  const cos = (deg: number): number => Math.cos((deg * Math.PI) / 180);
  return 25.5 + Math.log2(cos(latitudeDeg) / cos(45.46));
}

/** Luminance of a pixel. */
function luminance(image: PNG, x: number, y: number): number {
  const i = (y * image.width + x) * 4;
  return 0.299 * (image.data[i] ?? 0) + 0.587 * (image.data[i + 1] ?? 0) + 0.114 * (image.data[i + 2] ?? 0);
}

/**
 * Estimates the sub-pixel translation from `before` to `after` over the central region (Lucas–Kanade least squares on
 * image gradients); valid for shifts well under a pixel.
 */
function measureShift(before: PNG, after: PNG): { dx: number; dy: number } {
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxt = 0;
  let syt = 0;
  const x0 = Math.floor(before.width * 0.2);
  const y0 = Math.floor(before.height * 0.2);
  for (let y = y0; y < before.height - y0; y++) {
    for (let x = x0; x < before.width - x0; x++) {
      const ix = (luminance(before, x + 1, y) - luminance(before, x - 1, y)) / 2;
      const iy = (luminance(before, x, y + 1) - luminance(before, x, y - 1)) / 2;
      const it = luminance(after, x, y) - luminance(before, x, y);
      sxx += ix * ix;
      sxy += ix * iy;
      syy += iy * iy;
      sxt += ix * it;
      syt += iy * it;
    }
  }
  const det = sxx * syy - sxy * sxy;
  return { dx: (-syy * sxt + sxy * syt) / det, dy: (sxy * sxt - sxx * syt) / det };
}

async function stats(page: Page): Promise<{ textureUploads: number; matrixUpdates: number; drawCalls: number }> {
  const result = await page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats());
  if (!result) throw new Error('no stats');
  return result;
}

for (const backend of BACKENDS) {
  test(`tiles get no automatic matrix updates and textures upload only when scheduled on ${backend} (F052)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&lon=10&lat=45&zoom=3`);
    await waitForIdle(page);
    const first = await stats(page);
    // The pinned base imagery is the only texture the engine schedules in M2.
    expect(first.textureUploads).toBe(1);
    expect(first.matrixUpdates).toBe(0);
    expect(first.drawCalls).toBeGreaterThan(0);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 50, { steps: 10 });
    await page.mouse.up();
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -200);
    await waitForIdle(page);
    const after = await stats(page);
    expect(after.textureUploads).toBe(1);
    expect(after.matrixUpdates).toBe(0);
  });

  test(`no vertex jitter at street level under sub-millimeter camera moves on ${backend} (F057)`, async ({ page }) => {
    test.setTimeout(240_000);
    for (const [lon, lat] of [
      [9.19, 45.46],
      [139.69, 35.68],
      [151.21, -33.87],
      [15.63, 78.22],
      [179.99, -17.8],
      [-78.5, -0.18],
    ] as const) {
      await openGlobe(
        page,
        `backend=${backend}&scenario=street-level-jitter&lon=${lon}&lat=${lat}&zoom=${zoomForOneMeter(lat)}`,
      );
      await page.waitForFunction(() => (window.vibeglobePlayground?.globe.rendererStats().drawCalls ?? 0) > 1);
      await waitForIdle(page);
      expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters)).toBeLessThan(1.5);
      const reference = { longitudeDeg: lon, latitudeDeg: lat };
      const base = await canvasImage(page);
      const baseScreen = await geoToScreen(page, reference);
      // 0.2 mm steps east with a slow turn: each step moves the image by about a tenth of a pixel.
      const metersPerDegree = 111320 * Math.cos((lat * Math.PI) / 180);
      for (let step = 1; step <= 4; step++) {
        await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), {
          longitudeDeg: lon + (step * 0.0002) / metersPerDegree,
          latitudeDeg: lat,
          headingDeg: step * 1e-5,
        });
        await waitForIdle(page);
        const shown = await geoToScreen(page, reference);
        const measured = measureShift(base, await canvasImage(page));
        const expectedDx = shown.xPx - baseScreen.xPx;
        const expectedDy = shown.yPx - baseScreen.yPx;
        expect(Math.hypot(measured.dx - expectedDx, measured.dy - expectedDy)).toBeLessThan(0.1);
      }
    }
  });

  test(`near and far geometry show no z-fighting toward the horizon from 1 m on ${backend} (F058)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&scenario=depth-range&lon=9.19&lat=45.46&zoom=24.9&tilt=80`);
    await page.waitForFunction(() => (window.vibeglobePlayground?.globe.rendererStats().drawCalls ?? 0) > 100);
    await waitForIdle(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters)).toBeCloseTo(1, 0);
    const frames: PNG[] = [];
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.vibeglobePlayground?.globe.requestRender());
      await waitForIdle(page);
      frames.push(await canvasImage(page));
    }
    const first = frames[0];
    if (!first) throw new Error('no frame');
    let red = 0;
    let blue = 0;
    for (let i = 0; i < first.data.length; i += 4) {
      const r = first.data[i] ?? 0;
      const b = first.data[i + 2] ?? 0;
      if (r > 180 && b < 120) red++;
      if (b > 180 && r < 120) blue++;
    }
    // The 4 cm layer covers the 1 cm layer at every distance (correct order), and it fills a large part of the view.
    expect(blue).toBe(0);
    expect(red).toBeGreaterThan(first.width * first.height * 0.2);
    // A static camera draws identical frames: no pixel alternates between surfaces.
    for (const frame of frames.slice(1)) expect(Buffer.compare(frame.data, first.data)).toBe(0);
  });
}
