// Quality presets and adaptive quality in the playground (M11, F399, F401; hook C (4) of the models and quality track):
// `?quality=` applies @vibeglobe/quality's presets through `Globe.setQualitySettings`, `?gpuLoad=` injects a real GPU
// load (full-screen passes). The reference-desktop frame times of F399 and F401 are owner steps (docs/open-questions.md).
import { expect, test, type Page } from '@playwright/test';
import { QUALITY_PRESETS, type QualityChange, type QualityController } from '@vibeglobe/quality';
import { openGlobe } from './support/globe.ts';

declare global {
  interface Window {
    /** The quality page's test hooks (apps/playground/src/quality-demo.ts). */
    vibeglobeQuality?: {
      readonly quality: QualityController | undefined;
      readonly changes: QualityChange[];
      readonly frames: { frameNumber: number; frameMs: number; widthPx: number; heightPx: number; level: number }[];
      setGpuLoad(passes: number): void;
    };
  }
}

test.use({ viewport: { width: 320, height: 240 } });

/** Waits for `count` more drawn frames and returns them. */
async function frames(page: Page, count: number) {
  const start = await page.evaluate(() => window.vibeglobeQuality?.frames.at(-1)?.frameNumber ?? 0);
  await page.waitForFunction((n) => (window.vibeglobeQuality?.frames.at(-1)?.frameNumber ?? 0) >= n, start + count, {
    timeout: 60_000,
  });
  return page.evaluate((from) => window.vibeglobeQuality?.frames.filter((f) => f.frameNumber > from) ?? [], start);
}

/** Pixels of the next frame that are black or not drawn. */
const emptyPixels = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const { rgba } = (await window.vibeglobePlayground?.globe.captureFrame()) ?? { rgba: new Uint8ClampedArray() };
    let empty = 0;
    for (let i = 0; i < rgba.length; i += 4)
      if ((rgba[i + 3] ?? 0) < 255 || (rgba[i] ?? 0) + (rgba[i + 1] ?? 0) + (rgba[i + 2] ?? 0) < 12) empty++;
    return empty;
  });

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`every preset applies its level of detail, resolution and effects at runtime while the camera moves, without black or frozen frames, on ${backend} (F399)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openGlobe(page, `backend=${backend}&lon=10&lat=45&zoom=5&quality=high&qualityAdaptive=0`);
    await page.waitForFunction(() => window.vibeglobeQuality !== undefined);
    await page.evaluate(() => void window.vibeglobePlayground?.globe.orbit({ degreesPerSecond: 20 }));
    const maxAnisotropy = await page.evaluate(() => window.vibeglobePlayground?.globe.capabilities?.maxAnisotropy ?? 1);
    for (const preset of ['ultra', 'medium', 'low', 'high'] as const) {
      await page.evaluate((p) => window.vibeglobeQuality?.quality?.setPreset(p), preset);
      const drawn = await frames(page, 3);
      const expected = QUALITY_PRESETS[preset];
      const applied = await page.evaluate(() => window.vibeglobePlayground?.globe.qualitySettings);
      // `fogAwareDetail` is no preset's: it keeps its default, on (F395). The pixel-ratio cap stays with the quality
      // controller, which applies it through the resolution scale (at device pixel ratio 1 here, the preset's own).
      const engine = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'maxPixelRatio'));
      expect(applied, preset).toEqual({
        ...engine,
        fogAwareDetail: true,
        anisotropy: expected.anisotropy === 'max' ? maxAnisotropy : Math.min(expected.anisotropy, maxAnisotropy),
      });
      // The drawing buffer follows the preset's resolution scale from the next frame; the camera kept moving.
      for (const frame of drawn.slice(1))
        expect([frame.widthPx, frame.heightPx], preset).toEqual([
          Math.round(320 * expected.resolutionScale),
          Math.round(240 * expected.resolutionScale),
        ]);
      expect(await emptyPixels(page), `${preset}: black or undrawn pixels`).toBe(0);
    }
  });

test('an artificial GPU load makes adaptive quality lower the resolution, and the frame time falls (F401)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // The software GPU of the test browsers draws a loaded frame in more than the default 250 ms idle gap, which would
  // restart the measurement on every frame.
  const governor = encodeURIComponent(JSON.stringify({ stableMs: 1500, minChangeIntervalMs: 1000, idleGapMs: 10_000 }));
  await openGlobe(page, `backend=webgl2&lon=10&lat=45&zoom=5&quality=high&governor=${governor}`);
  await page.waitForFunction(() => window.vibeglobeQuality !== undefined);
  await page.evaluate(() => void window.vibeglobePlayground?.globe.orbit({ degreesPerSecond: 20 }));
  await page.evaluate(() => window.vibeglobeQuality?.setGpuLoad(40));
  const loaded = median((await frames(page, 10)).map((f) => f.frameMs));
  await page.waitForFunction(() => (window.vibeglobeQuality?.quality?.level ?? 0) > 0, undefined, { timeout: 120_000 });
  const level = await page.evaluate(() => window.vibeglobeQuality?.quality?.level ?? 0);
  const lowered = median((await frames(page, 10)).map((f) => f.frameMs));
  console.log(`[F401] loaded ${loaded.toFixed(1)} ms, at level ${level} ${lowered.toFixed(1)} ms`);
  expect(level).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.qualitySettings.resolutionScale)).toBeLessThan(1);
  expect(lowered).toBeLessThan(loaded);
  // The step shows no black or undrawn area.
  expect(await emptyPixels(page)).toBe(0);
});
