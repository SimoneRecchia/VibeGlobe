// Fog-aware detail (F395): the same tilted flight with the fog drawn, once loading coarser tiles where the fog hides the
// ground and once at full detail (`QualitySettings.fogAwareDetail`). The fog-aware run requests at least 25% fewer
// tiles, the fogged band near the horizon looks the same, and neither run has a black or empty pixel.
import { expect, test, type Page } from '@playwright/test';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** A hazy day: four times a clear day's aerosols. */
const HAZE = 4;

interface Run {
  requested: number;
  gpuBytes: number;
  holes: number;
  dark: number;
  /** The last frame's pixels, RGB. */
  pixels: number[];
}

async function fly(page: Page, backend: string, fogAwareDetail: boolean, haze: number): Promise<Run> {
  await openGlobe(
    page,
    `backend=${backend}&imagery=world&atmosphere=medium&clockStepMs=16.666666666666668` +
      '&lon=8&lat=45&zoom=12&tilt=85&heading=60',
  );
  await page.evaluate(
    ([on, hazeLevel]) => {
      const globe = window.vibeglobePlayground?.globe;
      globe?.setAtmosphere({ haze: hazeLevel });
      globe?.setQualitySettings({ fogAwareDetail: on });
    },
    [fogAwareDetail, haze] as const,
  );
  await waitForIdle(page);
  const before = await page.evaluate(() => window.vibeglobePlayground?.globe.imageryStats()?.requested ?? 0);
  const report = await page.evaluate(() => window.vibeglobePlayground?.recordScenario('tilted-flight', 0));
  if (!report) throw new Error('no report');
  await waitForIdle(page);
  const stats = await page.evaluate(() => window.vibeglobePlayground?.globe.imageryStats());
  if (!stats) throw new Error('no stats');
  const image = await canvasImage(page);
  const pixels: number[] = [];
  for (let i = 0; i < image.data.length; i += 4)
    pixels.push(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0);
  return {
    requested: stats.requested - before,
    gpuBytes: stats.gpuBytes,
    holes: report.holes,
    dark: report.dark,
    pixels,
  };
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`fog-aware detail requests at least 25% fewer tiles in a tilted flight, with no visible difference in the fogged band, on ${backend} (F395)`, async ({
    page,
  }) => {
    // Two full flights at four times the haze: about 80 s each here, over 90 s each in CI's software GPU, where 180 s
    // timed out (a timeout is not the failure `test.fail` expects).
    test.setTimeout(420_000);
    // KB-163: 7–13% fewer requests so far, at the default haze and at four times it.
    test.fail(true, 'KB-163');
    const aware = await fly(page, backend, true, HAZE);
    const full = await fly(page, backend, false, HAZE);
    const saved = 1 - aware.requested / full.requested;
    // The fogged band: the rows between the horizon's sky and the near ground, the upper third of the frame.
    let difference = 0;
    let count = 0;
    for (let y = 40; y < 80; y++)
      for (let x = 0; x < 320; x++)
        for (let c = 0; c < 3; c++) {
          const i = (y * 320 + x) * 3 + c;
          difference += Math.abs((aware.pixels[i] ?? 0) - (full.pixels[i] ?? 0));
          count++;
        }
    console.log(
      `[fog-detail] ${backend}: ${aware.requested} vs ${full.requested} tiles requested (${(saved * 100).toFixed(1)}% fewer), ` +
        `GPU ${aware.gpuBytes} vs ${full.gpuBytes} bytes, fogged band mean difference ${(difference / count).toFixed(2)}`,
    );
    expect(saved).toBeGreaterThanOrEqual(0.25);
    expect(difference / count).toBeLessThan(2);
    expect([aware.holes, aware.dark, full.holes, full.dark]).toEqual([0, 0, 0, 0]);
  });
