// The space background (ADR 0181) through the playground's `?stars=1`: the stars stand where their celestial
// directions project for several camera poses and sky times, on both backends; their light is the same at pixel ratios
// 1 and 2 and steady under sub-pixel motion; the Milky Way follows the galactic plane; the background hides under the
// daytime sky near the ground; screenshots match their baselines. Helpers and predictions: `support/starfield.ts`.
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { BACKGROUND_RGB, canvasImage, openGlobe, waitForIdle } from './support/globe.ts';
import {
  DEG,
  EPOCH_MS,
  GALACTIC,
  type StarsWindow,
  behindGlobe,
  luminance,
  openStars,
  predictStars,
  setStars,
  siderealDeg,
  skyCamera,
  starLight,
  starsFound,
  topLight,
} from './support/starfield.ts';
import { CROSS_BACKEND, compareImages, expectMatchesBaseline } from './support/visual.ts';

test.use({ viewport: { width: 320, height: 240 } });

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`F601, F607: stars stand where their celestial directions project, for three poses and a sky six hours later, on ${backend}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const poses = [
      'lon=0&lat=0&zoom=1.2',
      'lon=120&lat=40&zoom=2&heading=90&tilt=40',
      'lon=-70&lat=-30&zoom=0.8&heading=200&tilt=20',
    ];
    for (const pose of poses) {
      await openStars(page, `backend=${backend}&${pose}`);
      await setStars(page, { milkyWay: false });
      for (const timeMs of [EPOCH_MS, EPOCH_MS + 6 * 3_600_000]) {
        await page.evaluate((t) => window.vibeglobePlayground?.globe.setAtmosphere({ timeMs: t }), timeMs);
        await waitForIdle(page);
        const stars = await predictStars(page, 5, timeMs);
        const found = starsFound(await canvasImage(page), stars);
        console.log(`[starfield] ${backend} ${pose} +${(timeMs - EPOCH_MS) / 3.6e6} h: ${found}/${stars.length}`);
        expect(stars.length).toBeGreaterThanOrEqual(5);
        expect(found / stars.length).toBeGreaterThanOrEqual(0.9);
      }
    }
  });
}

test('F602: the stars are equally bright at pixel ratios 1 and 2, and steady under sub-pixel motion', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const light: number[] = [];
  for (const deviceScaleFactor of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 320, height: 240 }, deviceScaleFactor });
    const page = await context.newPage();
    await openStars(page, 'backend=webgpu&zoom=0.6');
    await setStars(page, { milkyWay: false, stars: false });
    const backdrop = await canvasImage(page);
    await setStars(page, { stars: true });
    light.push(starLight(await canvasImage(page), deviceScaleFactor, backdrop));
    if (deviceScaleFactor === 1) {
      // Turn the view by steps of a tenth of a pixel at the frame's edge: the total light holds within 3 %.
      const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
      const steady: number[] = [];
      for (let step = 1; step <= 6; step++) {
        await page.evaluate(
          (heading) => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: heading }),
          (camera?.headingDeg ?? 0) + step * 0.03,
        );
        await waitForIdle(page);
        steady.push(starLight(await canvasImage(page), 1, backdrop));
      }
      const mean = steady.reduce((a, b) => a + b, 0) / steady.length;
      console.log(`[starfield] F602 light under motion ${steady.map((v) => (v / mean).toFixed(4)).join(' ')}`);
      for (const value of steady) expect(Math.abs(value / mean - 1)).toBeLessThan(0.03);
    }
    await context.close();
  }
  console.log(`[starfield] F602 light per CSS px at ratios 1, 2: ${light.map((v) => v.toFixed(2)).join(', ')}`);
  expect((light[1] ?? 0) / (light[0] ?? 1)).toBeGreaterThan(0.75);
  expect((light[1] ?? 0) / (light[0] ?? 1)).toBeLessThan(1.25);
});

test('F603: the Milky Way is brighter within 6° of the galactic plane than beyond 25°', async ({ page }) => {
  test.setTimeout(120_000);
  await openStars(page, 'backend=webgpu&zoom=0.6');
  await setStars(page, { stars: false });
  const image = await canvasImage(page);
  const camera = await skyCamera(page);
  const g = GALACTIC;
  // Every fourth pixel of the sky by its galactic latitude: the direction through it, back to J2000 axes, then galactic.
  const plane: number[] = [];
  const off: number[] = [];
  for (let y = 2; y < 238; y += 4)
    for (let x = 2; x < 318; x += 4) {
      const dir = camera.ray(x + 0.5, y + 0.5);
      if (behindGlobe(camera.eye, dir)) continue;
      const length = Math.hypot(dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0);
      // Undo the Earth's rotation; precession over 26 years (0.4°) is negligible against the 8° bands compared.
      const hour = Math.atan2(dir[1] ?? 0, dir[0] ?? 0) + siderealDeg(EPOCH_MS) * DEG;
      const dec = Math.asin((dir[2] ?? 0) / length);
      const eq = [Math.cos(dec) * Math.cos(hour), Math.cos(dec) * Math.sin(hour), Math.sin(dec)];
      const b = Math.asin(eq.reduce((sum, v, k) => sum + v * (g[2]?.[k] ?? 0), 0)) / DEG;
      const value = luminance(image, x, y);
      if (Math.abs(b) < 6) plane.push(value);
      else if (Math.abs(b) > 25) off.push(value);
    }
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  console.log(
    `[starfield] F603 plane ${mean(plane).toFixed(1)} (${plane.length}), 25° off ${mean(off).toFixed(1)} (${off.length})`,
  );
  expect(plane.length).toBeGreaterThanOrEqual(50);
  expect(off.length).toBeGreaterThanOrEqual(50);
  expect(mean(plane)).toBeGreaterThan(mean(off) + 4);
});

test('F604: hidden under the daytime sky near the ground, shown at night and from space', async ({ page }) => {
  // Six page loads with the atmosphere drawn by the software GPU.
  test.setTimeout(300_000);
  const ground = 'backend=webgpu&imagery=world&lon=8&lat=46&zoom=9&tilt=80&atmosphere=high';
  const noon = '&sun=2026-06-21T12:00:00Z';
  const night = '&sun=2026-06-21T23:00:00Z';
  const frame = async (query: string, stars: boolean): Promise<PNG> => {
    if (stars) await openStars(page, query);
    else {
      await openGlobe(page, query);
      await waitForIdle(page);
    }
    // The quality page applies `?sun=` once the globe is ready.
    await page.waitForFunction(() => window.vibeglobePlayground?.globe.atmosphere.sunLighting === true);
    await waitForIdle(page);
    console.log(`[starfield] F604 captured ${stars ? 'with' : 'without'} ${query}`);
    return canvasImage(page);
  };
  const dayWithout = await frame(ground + noon, false);
  const dayWith = await frame(ground + noon, true);
  expect(await page.evaluate(() => (window as StarsWindow).vibeglobeStars?.visibility)).toBe(0);
  expect(compareImages(dayWithout, dayWith, 0.05).ratio).toBeLessThanOrEqual(0.0001);
  const nightWithout = topLight(await frame(ground + night, false));
  const nightWith = topLight(await frame(ground + night, true));
  expect(await page.evaluate(() => (window as StarsWindow).vibeglobeStars?.visibility)).toBe(1);
  const spaceWithout = topLight(await frame(`backend=webgpu&zoom=1&atmosphere=high${noon}`, false));
  const spaceWith = topLight(await frame(`backend=webgpu&zoom=1&atmosphere=high${noon}`, true));
  console.log(
    `[starfield] F604 night ${nightWithout.toFixed(2)} → ${nightWith.toFixed(2)}, space ${spaceWithout.toFixed(2)} → ${spaceWith.toFixed(2)}`,
  );
  expect(nightWith).toBeGreaterThan(nightWithout + 0.5);
  expect(spaceWith).not.toBe(spaceWithout);
});

test('F600, F606: off without ?stars=1; added, it draws behind the globe, and removed, the frame is as before', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGlobe(page, 'backend=webgpu&zoom=1.2');
  await waitForIdle(page);
  expect(await page.evaluate(() => (window as StarsWindow).vibeglobeStars)).toBeUndefined();
  const without = await canvasImage(page);
  await openStars(page, 'backend=webgpu&zoom=1.2');
  const withStars = await canvasImage(page);
  // The background changes the sky, never the globe: the center pixel is the same.
  const center = (image: PNG): number => luminance(image, 160, 120);
  expect(center(withStars)).toBe(center(without));
  expect(compareImages(without, withStars, 0.05).ratio).toBeGreaterThan(0.05);
  await expect(
    page.evaluate(() => (window as StarsWindow).vibeglobeStars?.setOptions({ brightness: 9 })),
  ).rejects.toThrow(/brightness must be 0 to 8/);
  await page.evaluate(() => (window as StarsWindow).vibeglobeStars?.remove());
  await waitForIdle(page);
  expect(compareImages(without, await canvasImage(page), 0.05).ratio).toBe(0);
});

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`F608, F605: the space background matches its baseline on ${backend}, and both backends agree @baseline`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await openStars(page, `backend=${backend}&lon=30&lat=20&zoom=1.4&heading=30&tilt=30`);
    const image = await canvasImage(page);
    await expectMatchesBaseline(page, testInfo, `starfield-${backend}.png`, image);
    if (backend === 'webgl2') {
      // The sky of both backends agrees: the globe and 2 px around its limb (the backends' own edge anti-aliasing,
      // contrasted against black space) are left out, found where the frame without the background is not the page.
      await openStars(page, 'backend=webgpu&lon=30&lat=20&zoom=1.4&heading=30&tilt=30');
      const other = compareImages(await canvasImage(page), image, CROSS_BACKEND.threshold);
      await setStars(page, { visible: false });
      const globe = await canvasImage(page);
      const isGlobe = (x: number, y: number): boolean => {
        const i = (y * globe.width + x) * 4;
        return [0, 1, 2].some((c) => Math.abs((globe.data[i + c] ?? 0) - (BACKGROUND_RGB[c] ?? 0)) > 2);
      };
      let sky = 0;
      let differing = 0;
      for (let y = 0; y < globe.height; y++)
        for (let x = 0; x < globe.width; x++) {
          let near = false;
          for (let dy = -2; dy <= 2 && !near; dy++)
            for (let dx = -2; dx <= 2 && !near; dx++) {
              const nx = Math.min(globe.width - 1, Math.max(0, x + dx));
              const ny = Math.min(globe.height - 1, Math.max(0, y + dy));
              near = isGlobe(nx, ny);
            }
          if (near) continue;
          sky++;
          const i = (y * globe.width + x) * 4;
          // pixelmatch paints differing pixels pure red.
          if (other.diff.data[i] === 255 && other.diff.data[i + 1] === 0 && other.diff.data[i + 2] === 0) differing++;
        }
      if (differing / sky > CROSS_BACKEND.maxDiffRatio)
        writeFileSync(testInfo.outputPath('cross-backend-diff.png'), PNG.sync.write(other.diff));
      console.log(`[starfield] F608 sky pixels ${sky}, differing ${differing}`);
      expect(sky).toBeGreaterThan(10_000);
      expect(differing / sky).toBeLessThanOrEqual(CROSS_BACKEND.maxDiffRatio);
    }
  });
