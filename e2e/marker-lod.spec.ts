// Marker level of detail (M10, F374): of 100,000 markers, distant or dense ones draw as simplified dots and near ones as
// full markers, as the debug overlay shows; the switch is a cross-fade, and the layer stays within its draw calls.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

declare global {
  interface Window {
    vibeglobeMarkerLod?: import('@vibeglobe/layers').MarkerLodLayer;
  }
}

test.use({ viewport: { width: 480, height: 320 } });

const BUDGET = (
  JSON.parse(readFileSync('quality/budgets.json', 'utf8')) as { dataLayers: { markerLodDrawCallsPerLayer: number } }
).dataLayers;
/** The grid's marker at 10° E, 47° N (column 200, row 125). */
const CENTER_ID = 125 * 400 + 200;

/** The debug overlay's row: markers in full, simplified and fading. */
async function overlayCounts(page: Page): Promise<{ full: number; simplified: number; fading: number }> {
  const text = (await page.locator('[data-metric="marker-lod"]').textContent()) ?? '';
  const [, full = 'NaN', simplified = 'NaN', fading = 'NaN'] =
    /full (\d+) · simplified (\d+) · fading (\d+)/.exec(text) ?? [];
  return { full: Number(full), simplified: Number(simplified), fading: Number(fading) };
}

/** Waits until the layer has decided every marker and no cross-fade runs, then for the overlay to show it. */
async function settled(page: Page): Promise<{ full: number; simplified: number; fading: number }> {
  await expect
    .poll(() => page.evaluate(() => window.vibeglobeMarkerLod?.lodStats.fading ?? -1), { timeout: 60_000 })
    .toBe(0);
  await waitForIdle(page);
  // The overlay refreshes on its own frames, a few times a second.
  await page.evaluate(() => window.vibeglobePlayground?.globe.requestRender());
  await expect.poll(async () => (await overlayCounts(page)).fading, { timeout: 10_000 }).toBe(0);
  return overlayCounts(page);
}

/** Mean absolute difference over a box around a screen point. */
function boxDifference(a: PNG, b: PNG, xPx: number, yPx: number, half = 14): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.round(yPx) - half; y <= Math.round(yPx) + half; y++)
    for (let x = Math.round(xPx) - half; x <= Math.round(xPx) + half; x++) {
      if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue;
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0));
      n += 3;
    }
  return sum / Math.max(1, n);
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`distant and dense markers are simplified, near ones full, switching by a cross-fade, on ${backend} (F374)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // Engine time steps 10 ms per drawn frame: a 250 ms cross-fade spans 25 frames.
    await openGlobe(page, `backend=${backend}&scenario=data-markers-lod&debug=1&clockStepMs=10&lon=10&lat=47&zoom=4`);
    await page.waitForFunction(() => window.vibeglobeMarkerLod !== undefined);
    // Continental view: every marker of the grid shares its bin with others.
    const continental = await settled(page);
    expect(continental.full + continental.simplified).toBe(100_000);
    expect(continental.full).toBe(0);
    // Street level: the markers in view stand alone and show in full; the others stay simplified.
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 13, tiltDeg: 0 }));
    const street = await settled(page);
    expect(street.full).toBeGreaterThan(0);
    expect(street.simplified).toBeGreaterThan(99_000);
    expect(await page.evaluate((id) => window.vibeglobeMarkerLod?.isFull(id), CENTER_ID)).toBe(true);
    // Tilted toward the horizon: the near marker in full, a distant one ahead (crowded on screen) simplified.
    await page.evaluate(() =>
      window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 10, latitudeDeg: 46.9, zoom: 12, tiltDeg: 70 }),
    );
    await settled(page);
    const near = 122 * 400 + 200; // 10° E, 46.88° N
    const far = 140 * 400 + 200; // 10° E, 47.6° N
    expect(await page.evaluate((id) => window.vibeglobeMarkerLod?.isFull(id), near)).toBe(true);
    expect(await page.evaluate((id) => window.vibeglobeMarkerLod?.isFull(id), far)).toBe(false);
    // The switch is a cross-fade: frame by frame the center marker changes in small steps, no step a pop.
    await page.evaluate(() =>
      window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 10, latitudeDeg: 47, zoom: 9, tiltDeg: 0 }),
    );
    await settled(page);
    expect(await page.evaluate((id) => window.vibeglobeMarkerLod?.isFull(id), CENTER_ID)).toBe(false);
    const before = await canvasImage(page);
    const point = await page.evaluate(() =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: 10, latitudeDeg: 47 }),
    );
    if (!point) throw new Error('the center marker is not in view');
    // Zoomed in two levels, the center marker stands alone: it fades from the dot to the marker.
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 11 }));
    const frames: PNG[] = [];
    const fades: number[] = [];
    for (let k = 0; k < 40; k++) {
      frames.push(await canvasImage(page));
      fades.push(await page.evaluate(() => window.vibeglobeMarkerLod?.lodStats.fading ?? 0));
      if (k > 5 && fades.at(-1) === 0) break;
      await page.evaluate(() => window.vibeglobePlayground?.globe.requestRender());
    }
    const after = await canvasImage(page);
    // The fade's whole change, from the first frame at the new zoom (still the dot) to the last (the marker).
    const total = boxDifference(frames[0] ?? before, after, point.xPx, point.yPx);
    const steps = frames.slice(1).map((frame, i) => boxDifference(frames[i] ?? frame, frame, point.xPx, point.yPx));
    console.log(
      `[marker-lod] ${backend}: change ${total.toFixed(1)}, steps ${steps.map((s) => s.toFixed(1)).join(' ')}`,
    );
    expect(await page.evaluate((id) => window.vibeglobeMarkerLod?.isFull(id), CENTER_ID)).toBe(true);
    expect(
      fades.some((n) => n > 0),
      'markers were fading',
    ).toBe(true);
    // No frame carries more than half of the whole change: it is spread over the fade, not a pop.
    expect(Math.max(...steps)).toBeLessThan(total * 0.5);
    // Draw calls of the layer: its markers and its simplified symbols.
    const drawCalls = async (visible: boolean): Promise<number> => {
      await page.evaluate((v) => window.vibeglobeMarkerLod?.setVisible(v), visible);
      await waitForIdle(page);
      return page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats().drawCalls ?? NaN);
    };
    const hidden = await drawCalls(false);
    const shown = await drawCalls(true);
    expect(shown - hidden).toBeLessThanOrEqual(BUDGET.markerLodDrawCallsPerLayer);
    expect(shown - hidden).toBeGreaterThan(0);
  });
