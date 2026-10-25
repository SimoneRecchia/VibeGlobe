// Label collision and decluttering (M10, F359): 10,000 labels of five priorities in a dense area. The debug collision
// boxes of the visible labels never overlap, every hidden label collides with a shown one of higher or equal
// priority, the drawn text stays inside the shown boxes, and zooming in shows hidden labels as space frees up, with
// the collision work sliced within its per-frame budget.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const BUDGET = (
  JSON.parse(readFileSync('quality/budgets.json', 'utf8')) as { dataLayers: { labelCollisionFrameP95Ms: number } }
).dataLayers;

interface Box {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  placed: boolean;
}

interface DenseLayer {
  collisionBoxes: Box[];
  setVisible?: (visible: boolean) => void;
  placer: { pending: boolean; frameMs: number[]; frameStallMs: number[] };
}

const overlaps = (a: Box, b: Box): boolean => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
const rank = (box: Box): number => Number(box.id.slice(1, box.id.indexOf('-')));

/** Waits until placement has caught up with the view and the fades have ended, and returns the boxes. */
async function settled(page: Page): Promise<Box[]> {
  await page.waitForFunction(
    () => !(window.vibeglobeLayers?.layers['dense'] as unknown as DenseLayer | undefined)?.placer.pending,
  );
  await page.waitForTimeout(400);
  await waitForIdle(page);
  return page.evaluate(() =>
    (window.vibeglobeLayers?.layers['dense'] as unknown as DenseLayer).collisionBoxes.map((b) => ({
      ...b,
      id: String(b.id),
    })),
  );
}

function checkPlacement(boxes: Box[], zoom: number): Box[] {
  const placed = boxes.filter((b) => b.placed);
  expect(placed.length, `zoom ${zoom}: labels shown`).toBeGreaterThan(50);
  expect(placed.length, `zoom ${zoom}: labels hidden`).toBeLessThan(boxes.length);
  const byX = [...placed].sort((a, b) => a.minX - b.minX);
  const overlapping: string[] = [];
  for (let i = 0; i < byX.length; i++) {
    const a = byX[i] as Box;
    for (let j = i + 1; j < byX.length && (byX[j] as Box).minX < a.maxX; j++)
      if (overlaps(a, byX[j] as Box)) overlapping.push(`${a.id}/${(byX[j] as Box).id}`);
  }
  expect(overlapping, `zoom ${zoom}: shown labels overlapping`).toEqual([]);
  const unexplained = boxes
    .filter((b) => !b.placed)
    .filter((hidden) => !placed.some((p) => overlaps(p, hidden) && rank(p) <= rank(hidden)))
    .map((b) => b.id);
  expect(unexplained, `zoom ${zoom}: hidden without a blocker of higher or equal priority`).toEqual([]);
  return placed;
}

/** Pixels that differ between two frames outside every shown box (grown by `marginPx`). */
function strayPixels(shown: PNG, hidden: PNG, boxes: Box[], marginPx: number): number {
  const inside = new Uint8Array(shown.width * shown.height);
  for (const b of boxes)
    for (let y = Math.max(0, Math.floor(b.minY - marginPx)); y < Math.min(shown.height, b.maxY + marginPx); y++)
      for (let x = Math.max(0, Math.floor(b.minX - marginPx)); x < Math.min(shown.width, b.maxX + marginPx); x++)
        inside[y * shown.width + x] = 1;
  let stray = 0;
  for (let i = 0; i < inside.length; i++) {
    if (inside[i]) continue;
    const d = Math.max(...[0, 1, 2].map((c) => Math.abs((shown.data[i * 4 + c] ?? 0) - (hidden.data[i * 4 + c] ?? 0))));
    if (d > 40) stray++;
  }
  return stray;
}

for (const backend of BACKENDS) {
  test(`10,000 labels never overlap, keep the higher priority on every collision, and show more as zooming in frees space, within the collision budget, on ${backend} (F359)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&scenario=data-labels-dense&viewMode=2d&lon=12.5&lat=41.9&zoom=8`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('#camera-controls')?.style.setProperty('display', 'none'),
    );
    const before = checkPlacement(await settled(page), 8);
    // The drawn text lies inside the shown labels' boxes: hiding the layer changes no pixel outside them.
    const shown = await canvasImage(page);
    await page.evaluate(() => window.vibeglobeLayers?.stack.setVisible('dense', false));
    await waitForIdle(page);
    const hidden = await canvasImage(page);
    await page.evaluate(() => window.vibeglobeLayers?.stack.setVisible('dense', true));
    await waitForIdle(page);
    expect(strayPixels(shown, hidden, before, 1), 'text outside the shown boxes').toBe(0);
    // Zooming in: labels hidden before appear, the collision work sliced within its budget.
    await page.evaluate(() => {
      const placer = (window.vibeglobeLayers?.layers['dense'] as unknown as DenseLayer).placer;
      placer.frameMs.length = 0;
      placer.frameStallMs.length = 0;
    });
    let previous = before;
    for (const zoom of [9, 10]) {
      await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
      const after = checkPlacement(await settled(page), zoom);
      const wasShown = new Set(previous.map((b) => b.id));
      expect(after.filter((b) => !wasShown.has(b.id)).length, `labels shown at zoom ${zoom}`).toBeGreaterThan(100);
      previous = after;
    }
    // The work of each slice: its time without the stalls in it, when the thread did not run (KB-171: on CI's busy
    // CPU, with a software GPU, the main thread waits whole scheduler ticks of 4 ms in the middle of a slice).
    const times = await page.evaluate(() => {
      const placer = (window.vibeglobeLayers?.layers['dense'] as unknown as DenseLayer).placer;
      return placer.frameMs.map((ms, i) => ms - (placer.frameStallMs[i] ?? 0)).sort((a, b) => a - b);
    });
    expect(times.length, 'placement sliced across frames').toBeGreaterThan(2);
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? Infinity;
    expect(p95, `collision work per frame: ${times.map((t) => t.toFixed(1)).join(' ')}`).toBeLessThanOrEqual(
      BUDGET.labelCollisionFrameP95Ms,
    );
  });
}
