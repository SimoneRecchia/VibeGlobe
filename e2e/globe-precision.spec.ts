import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, geoToScreen, openGlobe, waitForIdle } from './support/globe.ts';
import { measureShift } from './support/image.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;

/**
 * Every depth path (ADR 0005): hardware reversed-Z on WebGPU and on WebGL2 with `EXT_clip_control`, and WebGL2's
 * fragment-written fallback (forced here; automatic where the extension is missing, as in Firefox).
 */
const DEPTH_PATHS = [
  { name: 'webgpu', query: 'backend=webgpu', depthPath: 'reversed-z' },
  { name: 'webgl2', query: 'backend=webgl2', depthPath: 'auto' },
  { name: 'webgl2 with fragment depth', query: 'backend=webgl2&depth=fragment', depthPath: 'fragment' },
] as const;

/** The Mercator zoom that puts a straight-down camera about 0.94 m above the ground at a latitude (zoom 25.5 at 45.46°). */
function zoomForOneMeter(latitudeDeg: number): number {
  const cos = (deg: number): number => Math.cos((deg * Math.PI) / 180);
  return 25.5 + Math.log2(cos(latitudeDeg) / cos(45.46));
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
    // Uploaded at start-up only: the pinned base imagery, the one-texel texture of the cross-fade binding (F105), the
    // flat height grids of a surface without terrain and of its cross-fade binding (M4), and the one-texel textures of
    // the two overlay bindings and of their cross-fade bindings (ADR 0038, KB-155).
    expect(first.textureUploads).toBe(8);
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
    expect(after.textureUploads).toBe(first.textureUploads);
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
}

for (const path of DEPTH_PATHS) {
  test(`the scene depth is 32-bit float on ${path.name} (ADR 0005, KB-024)`, async ({ page }) => {
    await openGlobe(page, path.query);
    const capabilities = await page.evaluate(() => window.vibeglobePlayground?.globe.capabilities);
    const clipControl = await page.evaluate(
      () => document.createElement('canvas').getContext('webgl2')?.getExtension('EXT_clip_control') != null,
    );
    const expected = path.depthPath === 'auto' ? (clipControl ? 'reversed-z' : 'fragment') : path.depthPath;
    expect(capabilities?.depthPath).toBe(expected);
    expect(capabilities?.depthFormat).toBe('depth32float');
  });

  test(`near and far geometry show no z-fighting toward the horizon from 1 m on ${path.name} (F058)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // A small canvas keeps 240 captures affordable on a software GPU.
    await page.setViewportSize({ width: 480, height: 360 });
    await openGlobe(page, `${path.query}&scenario=depth-range&lon=9.19&lat=45.46&zoom=24.9&tilt=80`);
    await page.waitForFunction(() => (window.vibeglobePlayground?.globe.rendererStats().drawCalls ?? 0) > 100);
    await waitForIdle(page);
    const start = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
    if (!start) throw new Error('no camera');
    expect(start.altitudeMeters).toBeCloseTo(1, 0);
    const colors = (image: PNG): { red: number; blue: number } => {
      let red = 0;
      let blue = 0;
      for (let i = 0; i < image.data.length; i += 4) {
        const r = image.data[i] ?? 0;
        const b = image.data[i + 2] ?? 0;
        if (r > 180 && b < 120) red++;
        if (b > 180 && r < 120) blue++;
      }
      return { red, blue };
    };
    const first = await canvasImage(page);
    // Each red quad covers its blue one at every distance (1, 2 and 5 cm apart), and the lanes fill part of the view.
    expect(colors(first).blue).toBe(0);
    expect(colors(first).red).toBeGreaterThan(first.width * first.height * 0.2);
    // 120 static frames: identical, so no pixel alternates between surfaces (ADR 0005). Each capture draws its own
    // frame (Globe.captureFrame), so no frame needs to be requested before it.
    for (let i = 0; i < 120; i++) {
      expect(Buffer.compare((await canvasImage(page)).data, first.data), `static frame ${i}`).toBe(0);
    }
    // 120 frames of sub-pixel camera motion (0.1 mm steps east and back): the order holds in every one.
    const metersPerDegree = 111320 * Math.cos((start.latitudeDeg * Math.PI) / 180);
    for (let i = 0; i < 120; i++) {
      await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), {
        longitudeDeg: start.longitudeDeg + ((i % 2) * 0.0001) / metersPerDegree,
        latitudeDeg: start.latitudeDeg,
      });
      expect(colors(await canvasImage(page)).blue, `moving frame ${i}`).toBe(0);
    }
  });
}
