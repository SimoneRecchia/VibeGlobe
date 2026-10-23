// Per-feature updates of a 100,000-point data layer (M10, F376, F377), frame by frame on the manual engine clock: each
// change shows in the next frame and uploads only its feature's vertices, within the update budget.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, nextFrame, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const CLOCK = 'clockStepMs=16.666666666666668';
const BUDGET = (
  JSON.parse(readFileSync('quality/budgets.json', 'utf8')) as {
    dataLayers: { featureUpdateP95Ms: number; uploadedVerticesPerFeature: number };
  }
).dataLayers;

type Rgb = [number, number, number];
const isRed = ([r, g, b]: Rgb): boolean => r > 180 && g < 90 && b < 90;
const isBlue = ([r, g, b]: Rgb): boolean => b > 180 && r < 90 && g < 120;

/** Whether any pixel within `radius` of a point passes `test`. */
function near(image: PNG, xPx: number, yPx: number, radius: number, test: (rgb: Rgb) => boolean): boolean {
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const at = ((Math.round(yPx) + dy) * image.width + Math.round(xPx) + dx) * 4;
      if (test([image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0])) return true;
    }
  return false;
}

async function open100k(page: Page, backend: string): Promise<void> {
  await openGlobe(page, `${CLOCK}&backend=${backend}&scenario=data-points-100k`);
  await page.waitForFunction(() => window.vibeglobeLayers !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    globe?.setViewMode('2d');
    globe?.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 7 });
  });
  for (let i = 0; i < 30; i++) await nextFrame(page);
  await waitForIdle(page);
}

const stats = (page: Page) =>
  page.evaluate(() => {
    const s = window.vibeglobePlayground?.globe.layerTarget()?.stats?.();
    if (!s) throw new Error('no layer stats');
    return s;
  });

/** Runs `change` in the page, timing it, then draws one frame and returns the time and the frame. */
async function changeAndDraw(page: Page, change: string): Promise<{ ms: number; image: PNG }> {
  const ms = await page.evaluate((body) => {
    const layer = window.vibeglobeLayers?.layers['points'];
    if (!layer) throw new Error('no layer');
    const started = performance.now();
    new Function('layer', body)(layer);
    return performance.now() - started;
  }, change);
  await nextFrame(page);
  await nextFrame(page);
  return { ms, image: await canvasImage(page) };
}

async function screenOf(page: Page, lon: number, lat: number): Promise<{ xPx: number; yPx: number }> {
  const point = await page.evaluate(
    ([longitudeDeg, latitudeDeg]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: longitudeDeg ?? 0, latitudeDeg: latitudeDeg ?? 0 }),
    [lon, lat],
  );
  if (!point) throw new Error(`${lon}, ${lat} off screen`);
  return point;
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Infinity;
}

for (const backend of BACKENDS) {
  test(`one of 100,000 points moves every frame, shown in the next frame and uploading only its vertices, on ${backend} (F376)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await open100k(page, backend);
    const before = await stats(page);
    const times: number[] = [];
    const FRAMES = 40;
    for (let k = 1; k <= FRAMES; k++) {
      // Grid point g44 at (12.2°, 41.6°) walks east along 41.75°N, 0.02° a frame.
      const lon = 12.2 + k * 0.02;
      const { ms, image } = await changeAndDraw(page, `layer.setFeaturePosition('g44', ${lon}, 41.75)`);
      times.push(ms);
      // Every eighth frame is read back: the point is at its new position, and no longer at the previous one.
      if (k % 8 === 0) {
        const now = await screenOf(page, lon, 41.75);
        const previous = await screenOf(page, lon - 0.16, 41.75);
        expect(near(image, now.xPx, now.yPx, 1, isRed), `frame ${k}: new position`).toBe(true);
        expect(near(image, previous.xPx, previous.yPx, 1, isRed), `frame ${k}: earlier position`).toBe(false);
      }
    }
    const after = await stats(page);
    expect(after.rebuilds).toBe(before.rebuilds);
    expect(after.rangeUploads - before.rangeUploads).toBe(FRAMES);
    expect((after.uploadedVertices - before.uploadedVertices) / FRAMES).toBe(BUDGET.uploadedVerticesPerFeature);
    expect(p95(times), `update times ${times.map((t) => t.toFixed(2)).join(' ')}`).toBeLessThanOrEqual(
      BUDGET.featureUpdateP95Ms,
    );
  });

  test(`hiding, recoloring and resizing single points of 100,000 shows in the next frame and uploads only their vertices on ${backend} (F377)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await open100k(page, backend);
    const before = await stats(page);
    // Grid points g44 (12.2°, 41.6°), g45 (12.8°, 41.6°) and g54 (12.2°, 42.2°).
    const g44 = await screenOf(page, 12.2, 41.6);
    const g45 = await screenOf(page, 12.8, 41.6);
    const g54 = await screenOf(page, 12.2, 42.2);
    const times: number[] = [];
    let step = await changeAndDraw(page, `layer.setFeatureVisible('g44', false)`);
    times.push(step.ms);
    expect(near(step.image, g44.xPx, g44.yPx, 2, isRed), 'hidden').toBe(false);
    expect(near(step.image, g45.xPx, g45.yPx, 1, isRed), 'neighbor unchanged').toBe(true);
    step = await changeAndDraw(page, `layer.updateFeature('g45', { properties: { r: 4, c: '#2040ff' } })`);
    times.push(step.ms);
    expect(near(step.image, g45.xPx, g45.yPx, 1, isBlue), 'recolored').toBe(true);
    step = await changeAndDraw(page, `layer.updateFeature('g54', { properties: { r: 12, c: '#ff2020' } })`);
    times.push(step.ms);
    expect(near(step.image, g54.xPx + 9, g54.yPx, 1, isRed), 'enlarged').toBe(true);
    step = await changeAndDraw(page, `layer.setFeatureVisible('g44', true)`);
    times.push(step.ms);
    expect(near(step.image, g44.xPx, g44.yPx, 1, isRed), 'shown again').toBe(true);
    const after = await stats(page);
    expect(after.rebuilds).toBe(before.rebuilds);
    expect(after.rangeUploads - before.rangeUploads).toBe(4);
    expect((after.uploadedVertices - before.uploadedVertices) / 4).toBe(BUDGET.uploadedVerticesPerFeature);
    // The update cost over 40 more changes of each kind, timed in the page (four samples alone make the p95 their
    // maximum, one scheduler hiccup away from the budget).
    times.push(
      ...(await page.evaluate(() => {
        const layer = window.vibeglobeLayers?.layers['points'];
        if (!layer) throw new Error('no layer');
        const out: number[] = [];
        for (let i = 0; i < 40; i++)
          for (const change of [
            () => layer.setFeatureVisible('g44', i % 2 === 1),
            () => layer.updateFeature('g45', { properties: { r: 4, c: i % 2 ? '#2040ff' : '#ff2020' } }),
            () => layer.updateFeature('g54', { properties: { r: 4 + (i % 8), c: '#ff2020' } }),
          ]) {
            const started = performance.now();
            change();
            out.push(performance.now() - started);
          }
        return out;
      })),
    );
    expect(p95(times), `p95 of ${times.length} updates`).toBeLessThanOrEqual(BUDGET.featureUpdateP95Ms);
  });
}
