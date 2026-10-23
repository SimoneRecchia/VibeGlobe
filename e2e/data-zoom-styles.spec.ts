// Zoom-dependent styles (M10, F370): a point's radius and opacity and a line's width interpolate continuously while
// zooming from 6 to 10, frame by frame on the manual clock, and a point styled with a step appears exactly at zoom 8.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, nextFrame, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const CLOCK = 'clockStepMs=16.666666666666668';

type Rgb = [number, number, number];
const reddish = ([r, g, b]: Rgb): boolean => r - Math.max(g, b) > 60;
const greenish = ([r, g, b]: Rgb): boolean => g - Math.max(r, b) > 50;
const bluish = ([r, g, b]: Rgb): boolean => b - Math.max(r, g) > 80;

function rgb(image: PNG, x: number, y: number): Rgb {
  const at = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

function count(image: PNG, x0: number, y0: number, x1: number, y1: number, test: (c: Rgb) => boolean): number {
  let n = 0;
  for (let y = Math.round(y0); y <= Math.round(y1); y++)
    for (let x = Math.round(x0); x <= Math.round(x1); x++) if (test(rgb(image, x, y))) n++;
  return n;
}

async function screen(page: Page, lon: number, lat: number) {
  const p = await page.evaluate(
    ([longitudeDeg, latitudeDeg]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: longitudeDeg ?? 0, latitudeDeg: latitudeDeg ?? 0 }),
    [lon, lat],
  );
  if (!p) throw new Error('off screen');
  return p;
}

interface Sample {
  zoom: number;
  radiusPx: number;
  widthPx: number;
  centerGreen: number;
  stepShown: boolean;
}

for (const backend of BACKENDS) {
  test(`interpolated size, width and opacity change smoothly while zooming and a stepped style switches exactly at its stop on ${backend} (F370)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openGlobe(page, `${CLOCK}&backend=${backend}&scenario=data-zoom&viewMode=2d&lon=12.5&lat=41.9&zoom=6`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await waitForIdle(page);
    const samples: Sample[] = [];
    const zooms = [...Array.from({ length: 101 }, (_, k) => 6 + k * 0.04), 7.99].sort((a, b) => a - b);
    for (const zoom of zooms) {
      await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
      await nextFrame(page);
      await nextFrame(page);
      const image = await canvasImage(page);
      const dot = await screen(page, 12.5, 41.9);
      const roi = 3 + 12 * ((zoom - 6) / 4) + 3;
      const line = await screen(page, 12.45, 41.88);
      const step = await screen(page, 12.5, 41.92);
      const fade = await screen(page, 12.56, 41.9);
      samples.push({
        zoom,
        // Within a few pixels of the expected radius, so the fading dot nearby is never counted.
        radiusPx: Math.sqrt(
          count(image, dot.xPx - roi, dot.yPx - roi, dot.xPx + roi, dot.yPx + roi, reddish) / Math.PI,
        ),
        widthPx: count(image, line.xPx, line.yPx - 12, line.xPx, line.yPx + 12, greenish),
        centerGreen: rgb(image, fade.xPx, fade.yPx)[1],
        stepShown: count(image, step.xPx - 6, step.yPx - 6, step.xPx + 6, step.yPx + 6, bluish) > 10,
      });
    }
    for (const [i, s] of samples.entries()) {
      const t = (s.zoom - 6) / 4;
      const label = `zoom ${s.zoom.toFixed(2)}`;
      // Each interpolated value follows its stops, within the pixel grid's resolution.
      expect(Math.abs(s.radiusPx - (3 + 12 * t)), `${label}: radius ${s.radiusPx.toFixed(2)}`).toBeLessThan(1.5);
      expect(Math.abs(s.widthPx - (2 + 10 * t)), `${label}: width ${s.widthPx}`).toBeLessThanOrEqual(2);
      // The step: hidden below 8, shown from 8 on.
      expect(s.stepShown, label).toBe(s.zoom >= 8 - 1e-9);
      const previous = samples[i - 1];
      if (!previous) continue;
      // No visible jump between frames: each value moves by about one frame's share of its range.
      expect(Math.abs(s.radiusPx - previous.radiusPx), `${label}: radius jump`).toBeLessThan(1);
      expect(Math.abs(s.widthPx - previous.widthPx), `${label}: width jump`).toBeLessThanOrEqual(1);
      // Opacity 0.4 → 1 of the fading red dot: its center's green channel falls toward the dot's own, never jumping.
      expect(Math.abs(s.centerGreen - previous.centerGreen), `${label}: opacity jump`).toBeLessThan(12);
    }
    const first = samples[0];
    const last = samples.at(-1);
    expect((first?.centerGreen ?? 0) - (last?.centerGreen ?? 0), 'opacity rises').toBeGreaterThan(60);
  });
}
