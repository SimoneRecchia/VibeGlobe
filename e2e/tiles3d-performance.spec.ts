// The 3D Tiles city view during navigation (F471): the scripted city navigation (pan, zoom, rotate, tilt, a short
// flight) over the fixture city draws no hole and no black pixel after the root tile has loaded; its CPU frame times
// are reported, and gated (p95 at most 16.7 ms) only on a real GPU (ADR 0012): the container's software GPU measures
// the rasterizer, not the engine. The reference desktop and tablet runs and the benchmark history are the owner's
// and the main session's (docs/open-questions.md, hook request E (5)).
import { expect, test, type Page } from '@playwright/test';
import { hardwareGpu } from '../scripts/browser/gpu-args.ts';
import { canvasImage } from './support/globe.ts';
import { CITY, cityPoint, openCity, settleTiles, startCoverage, stopCoverage } from './support/tiles3d.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.setTimeout(240_000);

type View = { longitudeDeg: number; latitudeDeg: number; zoom: number; tiltDeg: number; headingDeg: number };

/** The scripted navigation: each step a view the camera jumps to, one drawn frame each, then a short flight. */
function script(): View[] {
  const views: View[] = [];
  const at = (east: number, north: number) => cityPoint(east, north);
  for (let i = 0; i <= 20; i++) views.push({ ...at(-300 + 30 * i, -100), zoom: 16.5, tiltDeg: 30, headingDeg: 0 }); // pan
  for (let i = 0; i <= 15; i++) views.push({ ...at(300, -100), zoom: 16.5 + i * 0.1, tiltDeg: 30, headingDeg: 0 }); // zoom
  for (let i = 0; i <= 18; i++) views.push({ ...at(300, -100), zoom: 18, tiltDeg: 30, headingDeg: i * 20 }); // rotate
  for (let i = 0; i <= 10; i++) views.push({ ...at(300, -100), zoom: 18, tiltDeg: 30 + 4 * i, headingDeg: 0 }); // tilt
  return views;
}

async function jump(page: Page, view: View): Promise<void> {
  await page.evaluate(async (v) => {
    await window.vibeglobePlayground?.globe.jumpTo(v);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, view);
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
};

test('the scripted city navigation draws no hole and no black pixel (F471)', async ({ page }) => {
  await openCity(page, `backend=webgl2&debug=1&lon=${CITY.longitudeDeg}&lat=${CITY.latitudeDeg}&zoom=15&tilt=0`);
  await settleTiles(page);
  await startCoverage(page, 32);
  await page.evaluate(() => window.vibeglobePlayground?.resetCpuSamples());
  let black = 0;
  const views = script();
  for (const [i, view] of views.entries()) {
    await jump(page, view);
    if (i % 10 === 0) {
      const image = await canvasImage(page);
      for (let p = 0; p < image.data.length; p += 4)
        if ((image.data[p] ?? 0) + (image.data[p + 1] ?? 0) + (image.data[p + 2] ?? 0) < 12) black++;
    }
  }
  // The short flight back across the city.
  const end = cityPoint(-300, 200);
  await page.evaluate(
    async (to) => {
      await window.vibeglobePlayground?.globe.flyTo({ ...to, zoom: 17, tiltDeg: 45 }, { durationMs: 3000 });
    },
    { longitudeDeg: end.longitudeDeg, latitudeDeg: end.latitudeDeg },
  );
  await settleTiles(page);
  const coverage = await stopCoverage(page);
  const times = await page.evaluate(() => window.vibeglobePlayground?.cpuFrameTimesMs() ?? []);
  const p95 = percentile(times, 0.95);
  console.log(
    `F471: ${coverage.frames} frames, ${coverage.samples} samples, ${coverage.holes} holes, ${black} black pixels, ` +
      `CPU frame time p95 ${p95.toFixed(1)} ms over ${times.length} frames${hardwareGpu() ? '' : ' (software GPU: not gated)'}`,
  );
  expect(coverage.frames).toBeGreaterThan(60);
  expect(coverage.holes, `holes at ${JSON.stringify(coverage.worst)}`).toBe(0);
  expect(black).toBe(0);
  if (hardwareGpu()) expect(p95).toBeLessThanOrEqual(16.7);
});
