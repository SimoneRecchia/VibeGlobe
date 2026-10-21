import { expect, test, type Page } from '@playwright/test';
import { canvasImage, emptyPixelsInside, openGlobe, silhouetteRadiusPx } from './support/globe.js';
import { fixtureSession, waitForImagery } from './support/imagery.js';

/**
 * F113: a slow tile server never slows the frames down or blanks them. Frame times are compared with the same motion
 * over a fast server in the same run, since absolute times on the software GPU say nothing (ADR 0012); this file runs
 * in the isolated measurements project.
 */

test.describe.configure({ timeout: 240_000 });

/**
 * Pans east continuously for `durationMs` and returns the intervals between drawn frames. With `capture`, it reads
 * frames back meanwhile and checks each is complete (readbacks stall the GPU, so timing passes capture nothing).
 */
async function pan(page: Page, durationMs: number, capture: boolean): Promise<number[]> {
  const radius = await silhouetteRadiusPx(page);
  await page.evaluate((duration) => {
    const globe = window.vibeglobePlayground?.globe;
    const times: number[] = [];
    (window as unknown as { frameTimes: number[] }).frameTimes = times;
    globe?.on('frame', () => times.push(performance.now()));
    const start = performance.now();
    const step = (): void => {
      const elapsed = performance.now() - start;
      globe?.jumpTo({ longitudeDeg: 12.5 + elapsed * 0.004, latitudeDeg: 41.9 });
      if (elapsed < duration) requestAnimationFrame(step);
    };
    step();
  }, durationMs);
  const deadline = Date.now() + durationMs;
  if (capture) while (Date.now() < deadline) expect(emptyPixelsInside(await canvasImage(page), radius)).toBe(0);
  else await page.waitForTimeout(durationMs + 200);
  const times = await page.evaluate(() => (window as unknown as { frameTimes: number[] }).frameTimes);
  return times.slice(1).map((time, i) => time - (times[i] ?? time));
}

const p95 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] ?? 0;

test('a very slow, low-bandwidth server keeps frames as fluid as a fast one and never blanks them (F113)', async ({
  page,
}) => {
  const fast = await fixtureSession(page);
  await openGlobe(page, `imagery=levels&session=${fast}&zoom=8&lon=12.5&lat=41.9`);
  await waitForImagery(page);
  const fastIntervals = await pan(page, 5000, false);
  const slow = await fixtureSession(page, [{ minLevel: 4, latencyMs: 3000, bandwidthBytesPerS: 20_000 }]);
  await openGlobe(page, `imagery=levels&session=${slow}&zoom=8&lon=12.5&lat=41.9`);
  const slowIntervals = await pan(page, 5000, false);
  console.log(
    `frame interval p95: fast server ${p95(fastIntervals).toFixed(1)} ms, slow ${p95(slowIntervals).toFixed(1)} ms`,
  );
  expect(slowIntervals.length).toBeGreaterThan(fastIntervals.length * 0.6);
  expect(p95(slowIntervals)).toBeLessThanOrEqual(p95(fastIntervals) * 1.5 + 10);
  // Still waiting for the slow server: every frame shows the base or an ancestor, never a hole.
  await pan(page, 5000, true);
});
