import { expect, test } from '@playwright/test';
import { openGlobe } from './support/globe.js';

/**
 * The performance HUD's overhead (F119), a timing measurement: it runs in the isolated measurements project, alone on
 * its runner, like the other timing checks (playwright.config.ts, ADR 0022).
 */

test.describe.configure({ timeout: 180_000 });

test('the performance HUD shows frame time, frame rate and per-phase costs live, within its documented overhead (F119)', async ({
  page,
}) => {
  await openGlobe(page, 'backend=webgl2&scenario=drag&zoom=3&level=4');
  // The median CPU frame time of a 1.5 s window: GC pauses and the odd slow frame do not count as the HUD's cost.
  const cpuMedian = async (): Promise<number> => {
    await page.evaluate(() => window.vibeglobePlayground?.resetCpuSamples());
    await page.waitForTimeout(1500);
    const samples = await page.evaluate(() => window.vibeglobePlayground?.cpuFrameTimesMs() ?? []);
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)] ?? 0;
  };
  const showHud = (on: boolean): Promise<void> =>
    page.evaluate((show) => window.vibeglobePlayground?.showHud(show), on);
  // Windows without and with the HUD alternate, so a drift of the machine or the scenario between them cancels out;
  // the overhead is the median of the pairs' differences, so one disturbed window does not decide it (test-changes).
  const differences: number[] = [];
  let without = 0;
  let withHud = 0;
  const pairs = 8;
  for (let pair = 0; pair < pairs; pair++) {
    // Every other pair measures the HUD first: the second window of a pair tends to run faster, a bias that cancels.
    const hudFirst = pair % 2 === 1;
    await showHud(hudFirst);
    const first = await cpuMedian();
    await showHud(!hudFirst);
    const second = await cpuMedian();
    const on = hudFirst ? first : second;
    const off = hudFirst ? second : first;
    differences.push(on - off);
    without += off / pairs;
    withHud += on / pairs;
  }
  differences.sort((a, b) => a - b);
  const overhead = ((differences[pairs / 2 - 1] ?? 0) + (differences[pairs / 2] ?? 0)) / 2;
  // The HUD, shown again after the last window, updates live.
  await showHud(true);
  const hud = page.locator('.vibeglobe-hud');
  await expect(hud).toContainText(/\d+(\.\d+)? ms · \d+ fps/);
  for (const phase of ['update', 'selection', 'scheduling', 'upload', 'render']) await expect(hud).toContainText(phase);
  const first = await hud.innerText();
  await expect.poll(() => hud.innerText(), { timeout: 5000 }).not.toBe(first);
  console.log(
    `CPU frame time without HUD ${without.toFixed(3)} ms, with HUD ${withHud.toFixed(3)} ms, median overhead ${overhead.toFixed(3)} ms`,
  );
  // docs/guides/debugging.md documents the HUD's overhead: at most 0.5 ms of main-thread time per frame.
  expect(overhead).toBeLessThan(0.5);
});
