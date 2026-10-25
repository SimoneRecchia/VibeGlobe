// The space background's cost (ADR 0181, F609), a timing measurement: windows with and without the background alternate
// during a continuous drag, as F119's HUD overhead check does, so a drift of the machine cancels out.
import { expect, test } from '@playwright/test';
import { openGlobe } from './support/globe.ts';

test.describe.configure({ timeout: 240_000 });
test.use({ viewport: { width: 320, height: 240 } });

type StarsWindow = Window & { vibeglobeStars?: { skyTimeMs: number; setOptions(o: { visible: boolean }): void } };

test('F609: the space background adds under 0.5 ms of main-thread time and keeps 80 % of the frame rate', async ({
  page,
}) => {
  await openGlobe(page, 'backend=webgpu&stars=1&scenario=drag&zoom=1.5&level=3');
  await page.waitForFunction(() => ((window as StarsWindow).vibeglobeStars?.skyTimeMs ?? 0) > 0);
  /** The median CPU frame time and the frames drawn in a 3 s window. */
  const measure = async (visible: boolean): Promise<{ cpuMs: number; frames: number }> => {
    await page.evaluate((v) => (window as StarsWindow).vibeglobeStars?.setOptions({ visible: v }), visible);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.vibeglobePlayground?.resetCpuSamples());
    const start = await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
    await page.waitForTimeout(3000);
    const end = await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
    const samples = await page.evaluate(() => window.vibeglobePlayground?.cpuFrameTimesMs() ?? []);
    samples.sort((a, b) => a - b);
    return { cpuMs: samples[Math.floor(samples.length / 2)] ?? 0, frames: end - start };
  };
  const cpu: number[] = [];
  const rates: number[] = [];
  for (let pair = 0; pair < 8; pair++) {
    // Every other pair measures the background first: the second window of a pair tends to run faster.
    const first = pair % 2 === 1;
    const a = await measure(first);
    const b = await measure(!first);
    const on = first ? a : b;
    const off = first ? b : a;
    cpu.push(on.cpuMs - off.cpuMs);
    rates.push(on.frames / Math.max(1, off.frames));
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((x, y) => x - y);
    return ((sorted[3] ?? 0) + (sorted[4] ?? 0)) / 2;
  };
  console.log(
    `[starfield] F609 CPU overhead ${cpu.map((v) => v.toFixed(3)).join(' ')} ms, frame-rate ratio ${rates.map((v) => v.toFixed(2)).join(' ')}`,
  );
  expect(median(cpu)).toBeLessThan(0.5);
  expect(median(rates)).toBeGreaterThanOrEqual(0.8);
});
