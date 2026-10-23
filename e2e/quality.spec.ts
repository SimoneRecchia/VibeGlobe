// Models and quality track: quality presets and adaptive quality on a real globe (F399–F402), on the quality harness
// (e2e/support/quality.html). Frame times are the harness's synthetic, pixel-proportional load (see quality-page.ts).
import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { FrameSample, QualityFrame } from './support/quality-page.ts';

const PAGE = `/@fs${resolve('e2e/support/quality.html')}`;
/** Shorter governor intervals than the defaults (the defaults are tested in Node, governor.test.ts). */
const GOVERNOR = { stableMs: 1500, minChangeIntervalMs: 1000 };
const TARGET_MS = 1000 / 60;

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${PAGE}?${query}`);
  await page.waitForFunction(() => window.qualityHarness !== undefined, undefined, { timeout: 60_000 });
}

/** Waits until `count` more frames are drawn. */
async function frames(page: Page, count: number): Promise<QualityFrame[]> {
  const start = await page.evaluate(() => window.qualityHarness?.frames.length ?? 0);
  await page.waitForFunction((n) => (window.qualityHarness?.frames.length ?? 0) >= n, start + count, {
    timeout: 60_000,
  });
  return page.evaluate((from) => window.qualityHarness?.frames.slice(from) ?? [], start);
}

const sample = (page: Page): Promise<FrameSample> =>
  page.evaluate(async () => {
    const harness = window.qualityHarness;
    if (!harness) throw new Error('no harness');
    return harness.sample();
  });

test('presets switch at runtime while the camera moves, each with its resolution, without black or frozen frames (F399)', async ({
  page,
}) => {
  await open(page, 'quality=high&adaptive=0');
  let previous = await sample(page);
  expect(previous.emptyPixels).toBe(0);
  for (const [preset, scale] of [
    ['ultra', 1.25],
    ['medium', 0.75],
    ['low', 0.5],
    ['high', 1],
  ] as const) {
    await page.evaluate((p) => window.qualityHarness?.quality.setPreset(p), preset);
    const drawn = await frames(page, 3);
    // Every frame after the switch has the preset's drawing buffer; the camera kept moving (no frozen frame).
    for (const frame of drawn)
      expect([frame.widthPx, frame.heightPx]).toEqual([Math.round(320 * scale), Math.round(240 * scale)]);
    const now = await sample(page);
    expect(now.frameNumber).toBeGreaterThan(previous.frameNumber);
    expect(now.emptyPixels, `${preset}: black or undrawn pixels`).toBe(0);
    // No flicker: the image keeps its brightness across the switch (the orbit moves it slowly).
    expect(Math.abs(now.meanLuminance - previous.meanLuminance) / previous.meanLuminance).toBeLessThan(0.15);
    previous = now;
  }
});

test('the start-up preset follows the capability profile, and an explicit preset overrides it (F400)', async ({
  page,
}) => {
  for (const [query, preset] of [
    ['profile=low-end', 'low'],
    ['profile=high-end', 'high'],
    ['profile=low-end&quality=ultra', 'ultra'],
    ['profile=high-end&quality=low', 'low'],
  ] as const) {
    await open(page, `${query}&adaptive=0`);
    expect(await page.evaluate(() => window.qualityHarness?.quality.preset), query).toBe(preset);
  }
});

test('adaptive quality lowers resolution under load and raises it back step by step once stable (F401, F402)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page, `quality=high&governor=${encodeURIComponent(JSON.stringify(GOVERNOR))}`);
  await frames(page, 40);
  expect(await page.evaluate(() => window.qualityHarness?.quality.level)).toBe(0);
  // About 30 ms per frame at full resolution: over the target by far.
  await page.evaluate(() => window.qualityHarness?.setLoad(312));
  await page.waitForFunction(
    () => {
      const h = window.qualityHarness;
      const last = h?.frames.slice(-40) ?? [];
      return (
        h?.changes.some((c) => c.reason === 'lower') === true &&
        last.length === 40 &&
        last.every((f) => f.frameMs <= (1000 / 60) * 1.15) &&
        last.every((f) => f.level === last[0]?.level)
      );
    },
    undefined,
    { timeout: 90_000 },
  );
  const lowered = await page.evaluate(() => ({
    changes: window.qualityHarness?.changes ?? [],
    frames: window.qualityHarness?.frames ?? [],
  }));
  const lowerings = lowered.changes.filter((c) => c.reason === 'lower');
  expect(lowerings.length).toBeGreaterThan(0);
  expect(lowerings.at(-1)?.settings.resolutionScale).toBeLessThan(1);
  // Reaction: the first lowering within the 30-frame window plus the 500 ms reaction time after the load started.
  const loaded = lowered.frames.findIndex((f) => f.frameMs > TARGET_MS * 1.15);
  const firstLower = lowered.frames.findIndex((f, i) => i > loaded && f.level > 0);
  const reactionMs = lowered.frames.slice(loaded, firstLower).reduce((sum, f) => sum + f.frameMs, 0);
  expect(reactionMs).toBeLessThanOrEqual(30 * 30 + 500 + 60);
  // No pop or flicker from a step: the view stays complete.
  expect((await sample(page)).emptyPixels).toBe(0);

  await page.evaluate(() => window.qualityHarness?.setLoad(0));
  await page.waitForFunction(() => window.qualityHarness?.quality.level === 0, undefined, { timeout: 90_000 });
  const raised = await page.evaluate(() => window.qualityHarness?.changes.filter((c) => c.reason === 'raise') ?? []);
  expect(raised.map((c) => c.level)).toEqual([...Array(lowerings.at(-1)?.level ?? 0).keys()].reverse());
  expect(await page.evaluate(() => window.qualityHarness?.quality.settings.resolutionScale)).toBe(1);
  expect((await sample(page)).emptyPixels).toBe(0);
});
