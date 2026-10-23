// Visual comparison helper (ADR 0012): compares a canvas capture with a baseline recorded in the pinned CI environment.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { hardwareGpu } from '../../scripts/browser/gpu-args.ts';
import { canvasImage } from './globe.ts';

/** Tolerances from ADR 0012. */
export const SAME_BACKEND = { threshold: 0.05, maxDiffRatio: 0.0001 } as const;
/** Tolerances from ADR 0012. */
export const CROSS_BACKEND = { threshold: 0.1, maxDiffRatio: 0.001 } as const;

const BASELINE_BROWSER_FILE = new URL('../__baselines__/browser.json', import.meta.url);

/** The globe's frame, read back by the engine (ADR 0012, Capture). */
export async function captureCanvas(page: Page): Promise<PNG> {
  return canvasImage(page);
}

/** Counts pixels that differ beyond the threshold (anti-aliasing detection on) and writes the diff image. */
export function compareImages(
  expected: PNG,
  actual: PNG,
  threshold: number,
): { differing: number; ratio: number; diff: PNG } {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new Error(`Image sizes differ: ${expected.width}×${expected.height} vs ${actual.width}×${actual.height}`);
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const differing = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, {
    threshold,
    includeAA: false,
  });
  return { differing, ratio: differing / (actual.width * actual.height), diff };
}

/** The Chromium version the committed baselines were recorded with. */
function baselineBrowserVersion(): string | undefined {
  if (!existsSync(BASELINE_BROWSER_FILE)) return undefined;
  return (JSON.parse(readFileSync(BASELINE_BROWSER_FILE, 'utf8')) as { chromium?: string }).chromium;
}

/**
 * Compares a capture with its baseline at `testInfo.snapshotPath(name)`. With `--update-snapshots` (only in the
 * baseline workflow's pinned environment) it writes the baseline instead. A browser build other than the baselines'
 * makes a mismatch advisory outside CI: the images are attached and the test is annotated, as ADR 0012 specifies.
 */
export async function expectMatchesBaseline(page: Page, testInfo: TestInfo, name: string, image: PNG): Promise<void> {
  const path = testInfo.snapshotPath(name);
  const browser = page.context().browser()?.version() ?? 'unknown';
  if (testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG.sync.write(image));
    mkdirSync(dirname(BASELINE_BROWSER_FILE.pathname), { recursive: true });
    writeFileSync(BASELINE_BROWSER_FILE, `${JSON.stringify({ chromium: browser }, null, 2)}\n`);
    return;
  }
  // Baselines come from the pinned CI environment's software GPU: elsewhere (another browser build, or a real GPU in
  // the hardware procedure) a mismatch is reported, not failed.
  const advisory = !process.env['CI'] && (baselineBrowserVersion() !== browser || hardwareGpu());
  if (!existsSync(path)) {
    expect(advisory, `No baseline ${path}: run the "Visual baselines" workflow (docs/guides/visual-tests.md)`).toBe(
      true,
    );
    testInfo.annotations.push({ type: 'advisory', description: `no baseline for ${name} on this browser build` });
    return;
  }
  const result = compareImages(PNG.sync.read(readFileSync(path)), image, SAME_BACKEND.threshold);
  if (result.ratio > SAME_BACKEND.maxDiffRatio) {
    await testInfo.attach(`${name}-actual`, { body: PNG.sync.write(image), contentType: 'image/png' });
    await testInfo.attach(`${name}-diff`, { body: PNG.sync.write(result.diff), contentType: 'image/png' });
    await testInfo.attach(`${name}-expected`, { body: readFileSync(path), contentType: 'image/png' });
  }
  if (advisory) {
    testInfo.annotations.push({
      type: 'advisory',
      description: `${name}: ${(result.ratio * 100).toFixed(4)}% differ on ${browser}; baselines come from another build`,
    });
    return;
  }
  expect(result.ratio, `${name}: ${result.differing} pixels differ`).toBeLessThanOrEqual(SAME_BACKEND.maxDiffRatio);
}

/** Records which test produced a capture, for readable attachment names. */
export function viewName(backend: string, view: string, suffix = ''): string {
  return `${view}-${backend}${suffix}.png`;
}
