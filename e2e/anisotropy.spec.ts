// Anisotropic filtering (M11, F398): at the maximum tilt over detailed imagery, the distant imagery keeps more detail
// at the device's anisotropy level than without it, on both backends; the level is the device maximum reported by
// capability detection unless the quality settings lower it.
import { expect, test, type Page } from '@playwright/test';
import { canvasImage, openGlobe } from './support/globe.ts';
import { waitForStreaming } from './support/imagery.ts';

test.use({ viewport: { width: 480, height: 320 } });

/** The documented improvement: distant imagery has at least 15% more detail with anisotropic filtering. */
const IMPROVEMENT = 1.15;

/**
 * Detail of the distant imagery: the mean absolute difference between horizontally neighboring pixels in the band
 * below the horizon (rows 35–55% of the frame at this tilt), where the surface is seen most obliquely.
 */
async function distantDetail(page: Page): Promise<number> {
  await waitForStreaming(page);
  const image = await canvasImage(page);
  let sum = 0;
  let count = 0;
  for (let y = Math.floor(image.height * 0.35); y < Math.floor(image.height * 0.55); y++)
    for (let x = 0; x + 1 < image.width; x++) {
      const i = (y * image.width + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs((image.data[i + c] ?? 0) - (image.data[i + 4 + c] ?? 0));
      count += 3;
    }
  return sum / count;
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`anisotropic filtering keeps tilted imagery sharp at the device maximum, unless the quality lowers it, on ${backend} (F398)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&imagery=levels&lon=8&lat=46&zoom=10&tilt=85`);
    const levels = await page.evaluate(() => ({
      max: window.vibeglobePlayground?.globe.capabilities?.maxAnisotropy ?? 1,
      applied: window.vibeglobePlayground?.globe.qualitySettings.anisotropy,
    }));
    // The device maximum by default (capability detection).
    expect(levels.applied).toBe(levels.max);
    expect(levels.max).toBeGreaterThan(1);
    const sharp = await distantDetail(page);
    await page.evaluate(() => window.vibeglobePlayground?.globe.setQualitySettings({ anisotropy: 1 }));
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.qualitySettings.anisotropy)).toBe(1);
    const blurred = await distantDetail(page);
    console.log(`[anisotropy] ${backend}: max ${levels.max}, detail ${sharp.toFixed(2)} vs ${blurred.toFixed(2)} at 1`);
    expect(sharp).toBeGreaterThan(blurred * IMPROVEMENT);
    // Back at the maximum, the same detail returns.
    await page.evaluate((max) => window.vibeglobePlayground?.globe.setQualitySettings({ anisotropy: max }), levels.max);
    expect(await distantDetail(page)).toBeGreaterThan(blurred * IMPROVEMENT);
  });
