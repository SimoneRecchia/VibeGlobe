// Signed distance field labels (F358, ADR 0045): "Sharp" at 8 to 64 px at device pixel ratios 1, 2 and 3 keeps a crisp
// edge, a continuous zoom shows no blur step or shimmer, and the fields are generated in a worker and cached.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

/** `apps/playground/src/layers-styled.ts` `LABEL_SIZES`, with the latitudes `labelSizesLayer` places them at. */
const SIZES = [8, 12, 16, 24, 32, 48, 64];
const LATITUDES: number[] = [];
for (let latDeg = 40, i = 0; i < SIZES.length; latDeg -= 1 + (SIZES[i] ?? 0) / 10, i++) LATITUDES.push(latDeg);
/**
 * The documented edge sharpness (ADR 0045): across the rows of a label that cross its strokes, the median of each row's
 * largest step between neighboring pixels, as a share of the label's contrast, is at least this: an edge spread over
 * two pixels or more stays below it. Measured 0.60–0.98 on both backends (2026-10-24).
 */
const SHARPNESS = 0.5;
/** Mean change per channel allowed in the "Zoom" label between two frames 0.05 zoom levels apart. */
const SHIMMER_LIMIT = 4;
const BACKENDS = ['webgpu', 'webgl2'] as const;

function luminance(image: PNG, x: number, y: number): number {
  const i = (y * image.width + x) * 4;
  return 0.2126 * (image.data[i] ?? 0) + 0.7152 * (image.data[i + 1] ?? 0) + 0.0722 * (image.data[i + 2] ?? 0);
}

/** The sharpness of the label in a box (device pixels), as {@link SHARPNESS} defines it. */
function sharpness(image: PNG, box: { x0: number; y0: number; x1: number; y1: number }): number {
  let low = 255;
  let high = 0;
  const rows: { step: number; range: number }[] = [];
  for (let y = Math.max(0, box.y0); y < Math.min(image.height, box.y1); y++) {
    let step = 0;
    let rowLow = 255;
    let rowHigh = 0;
    for (let x = Math.max(0, box.x0); x < Math.min(image.width, box.x1); x++) {
      const l = luminance(image, x, y);
      rowLow = Math.min(rowLow, l);
      rowHigh = Math.max(rowHigh, l);
      if (x > box.x0) step = Math.max(step, Math.abs(l - luminance(image, x - 1, y)));
    }
    low = Math.min(low, rowLow);
    high = Math.max(high, rowHigh);
    rows.push({ step, range: rowHigh - rowLow });
  }
  const contrast = high - low;
  const crossing = rows.filter((r) => r.range > contrast / 2).map((r) => r.step / contrast);
  crossing.sort((a, b) => a - b);
  return crossing[Math.floor(crossing.length / 2)] ?? 0;
}

async function screen(page: Page, lon: number, lat: number): Promise<{ xPx: number; yPx: number }> {
  const p = await page.evaluate(
    ([longitudeDeg, latitudeDeg]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: longitudeDeg ?? 0, latitudeDeg: latitudeDeg ?? 0 }),
    [lon, lat],
  );
  if (!p) throw new Error(`${lon}, ${lat} off screen`);
  return p;
}

async function jump(page: Page, view: { longitudeDeg: number; latitudeDeg: number; zoom: number }): Promise<PNG> {
  await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), view);
  await waitForIdle(page);
  return canvasImage(page);
}

async function open(page: Page, backend: string): Promise<void> {
  await openGlobe(page, `backend=${backend}&scenario=data-label-sizes`);
  await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    globe?.setViewMode('2d');
    globe?.jumpTo({ longitudeDeg: -30, latitudeDeg: 30, zoom: 3 });
  });
  // The fields arrive from the worker: the labels show once they are in the atlas.
  await page.waitForTimeout(500);
  await waitForIdle(page);
}

for (const backend of BACKENDS)
  test(`labels stay crisp from 8 to 64 px at pixel ratios 1 to 3, through a continuous zoom, from fields generated in a worker, on ${backend} (F358)`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const measured: string[] = [];
    for (const deviceScaleFactor of [1, 2, 3]) {
      const context = await browser.newContext({ deviceScaleFactor, viewport: { width: 400, height: 560 } });
      const page = await context.newPage();
      try {
        await open(page, backend);
        const image = await canvasImage(page);
        const values: number[] = [];
        for (const [i, size] of SIZES.entries()) {
          const at = await screen(page, -30, LATITUDES[i] ?? 0);
          const half = { x: 1.6 * size, y: 0.6 * size };
          const box = {
            x0: Math.round((at.xPx - half.x) * deviceScaleFactor),
            x1: Math.round((at.xPx + half.x) * deviceScaleFactor),
            y0: Math.round((at.yPx - half.y) * deviceScaleFactor),
            y1: Math.round((at.yPx + half.y) * deviceScaleFactor),
          };
          values.push(sharpness(image, box));
        }
        measured.push(`DPR ${deviceScaleFactor}: ${values.map((v) => v.toFixed(2)).join(' ')}`);
        for (const value of values) expect(value).toBeGreaterThanOrEqual(SHARPNESS);
        if (deviceScaleFactor === 1) {
          // A continuous zoom around "Zoom": the label's pixels change by no more than shimmer.
          let previous: PNG | undefined;
          let worst = 0;
          for (let zoom = 4; zoom <= 5.001; zoom += 0.05) {
            const frame = await jump(page, { longitudeDeg: -50, latitudeDeg: 20, zoom });
            if (previous) {
              let sum = 0;
              let count = 0;
              const cx = Math.round(frame.width / 2);
              const cy = Math.round(frame.height / 2);
              for (let y = cy - 10; y < cy + 10; y++)
                for (let x = cx - 26; x < cx + 26; x++)
                  for (let c = 0; c < 3; c++) {
                    const i = (y * frame.width + x) * 4 + c;
                    sum += Math.abs((frame.data[i] ?? 0) - (previous.data[i] ?? 0));
                    count++;
                  }
              worst = Math.max(worst, sum / count);
            }
            previous = frame;
          }
          // The label is in the compared box: its white text, not only the sea behind it.
          let white = 0;
          if (previous)
            for (let y = previous.height / 2 - 10; y < previous.height / 2 + 10; y++)
              for (let x = previous.width / 2 - 26; x < previous.width / 2 + 26; x++)
                if (luminance(previous, x, y) > 220) white++;
          expect(white).toBeGreaterThan(40);
          measured.push(`zoom: largest step ${worst.toFixed(2)}`);
          expect(worst).toBeLessThan(SHIMMER_LIMIT);
          const fields = await page.evaluate(
            () =>
              (
                window.vibeglobePlayground?.globe as unknown as {
                  renderer?: { layers?: { stats(): { labelFields: { worker?: number; inline?: number } } } };
                }
              ).renderer?.layers?.stats().labelFields,
          );
          measured.push(`fields ${JSON.stringify(fields)}`);
          // Every field from the worker, each text once: "Sharp" serves every size, "Zoom" every zoom.
          expect(fields).toEqual({ worker: 2, inline: 0 });
        }
      } finally {
        await context.close();
      }
    }
    console.log(`[sdf-labels] ${backend}: ${measured.join('; ')}`);
  });
