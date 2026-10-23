// Labels (M10, F357): text at a coordinate in a chosen font, size, color, halo, anchor and offset; accented Latin,
// Greek, Cyrillic and CJK (through the system's fallback fonts) as wide as the browser sets them; and the anchor on its
// coordinate while panning and zooming.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;

type Rgb = [number, number, number];
const white = ([r, g, b]: Rgb): boolean => r > 220 && g > 220 && b > 220;
const magenta = ([r, g, b]: Rgb): boolean => r > 200 && g < 100 && b > 200;
const green = ([r, g, b]: Rgb): boolean => g > 200 && r < 140 && b < 140;
const yellow = ([r, g, b]: Rgb): boolean => r > 200 && g > 170 && b < 90;

/** The box of pixels passing `test` in a rectangle. */
function boxOf(image: PNG, x0: number, y0: number, x1: number, y1: number, test: (c: Rgb) => boolean) {
  let [bx0, by0, bx1, by1, n] = [Infinity, Infinity, -Infinity, -Infinity, 0];
  for (let y = Math.max(0, Math.round(y0)); y <= Math.min(image.height - 1, Math.round(y1)); y++)
    for (let x = Math.max(0, Math.round(x0)); x <= Math.min(image.width - 1, Math.round(x1)); x++) {
      const i = (y * image.width + x) * 4;
      if (!test([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0])) continue;
      [bx0, by0, bx1, by1, n] = [Math.min(bx0, x), Math.min(by0, y), Math.max(bx1, x + 1), Math.max(by1, y + 1), n + 1];
    }
  return { x0: bx0, y0: by0, x1: bx1, y1: by1, width: bx1 - bx0, pixels: n };
}

async function show(page: Page, view: { longitudeDeg: number; latitudeDeg: number; zoom: number }): Promise<PNG> {
  await page.evaluate((v) => {
    const globe = window.vibeglobePlayground?.globe;
    globe?.setViewMode('2d');
    globe?.jumpTo(v);
  }, view);
  await page.waitForTimeout(400);
  await waitForIdle(page);
  return canvasImage(page);
}

async function screen(page: Page, lon: number, lat: number) {
  const p = await page.evaluate(
    ([longitudeDeg, latitudeDeg]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: longitudeDeg ?? 0, latitudeDeg: latitudeDeg ?? 0 }),
    [lon, lat],
  );
  if (!p) throw new Error(`${lon}, ${lat} off screen`);
  return p;
}

/** The width the browser sets a text at in its default sans-serif stack, CSS pixels. */
function textWidth(page: Page, text: string, sizePx: number): Promise<number> {
  return page.evaluate(
    ([t, s]) => {
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('no canvas');
      context.font = `${String(s)}px sans-serif, system-ui`;
      return context.measureText(String(t)).width;
    },
    [text, sizePx] as const,
  );
}

for (const backend of BACKENDS) {
  test(`labels show their font, size, color, halo, anchor and offset, every script's glyphs, and stay on their coordinates on ${backend} (F357)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&scenario=data-labels`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    {
      const image = await show(page, { longitudeDeg: 18.5, latitudeDeg: 43.8, zoom: 5 });
      // The same narrow text: wider in a monospace font than in the default proportional one.
      const mono = await screen(page, 16.0, 45.5);
      const sans = await screen(page, 16.0, 44.0);
      const monoBox = boxOf(image, mono.xPx - 2, mono.yPx - 14, mono.xPx + 200, mono.yPx + 14, white);
      const sansBox = boxOf(image, sans.xPx - 2, sans.yPx - 14, sans.xPx + 200, sans.yPx + 14, white);
      expect(monoBox.width, `monospace ${monoBox.width}, default ${sansBox.width}`).toBeGreaterThan(
        1.5 * sansBox.width,
      );
      // The halo in its color around white text.
      const halo = await screen(page, 19.0, 44.5);
      expect(boxOf(image, halo.xPx - 40, halo.yPx - 16, halo.xPx + 40, halo.yPx + 16, magenta).pixels).toBeGreaterThan(
        40,
      );
      expect(boxOf(image, halo.xPx - 40, halo.yPx - 16, halo.xPx + 40, halo.yPx + 16, white).pixels).toBeGreaterThan(
        20,
      );
      // Offset two ems (40 px at 20 px) upward: the text is above its coordinate, not on it.
      const up = await screen(page, 21.0, 41.5);
      const raised = boxOf(image, up.xPx - 20, up.yPx - 60, up.xPx + 20, up.yPx + 12, green);
      expect(
        Math.abs((raised.y0 + raised.y1) / 2 - (up.yPx - 40)),
        `offset text at ${raised.y0}–${raised.y1}`,
      ).toBeLessThan(4);
    }
    // Every script, set by the browser's own text engine with fallbacks: each label as wide as the browser measures it.
    for (const { name, lon, lat, text, size, color, view } of [
      { name: 'accented Latin', lon: 12.5, lat: 41.9, text: 'Roma – Città', size: 20, color: yellow, view: 0 },
      {
        name: 'Greek',
        lon: 23.7,
        lat: 38.0,
        text: 'Αθήνα',
        size: 16,
        color: (c: Rgb) => c[2] > 200 && c[1] > 180 && c[0] < 120,
        view: 0,
      },
      {
        name: 'Cyrillic',
        lon: 37.6,
        lat: 55.75,
        text: 'Москва',
        size: 24,
        color: (c: Rgb) => c[0] > 200 && c[2] > 200 && c[1] < 150,
        view: 1,
      },
      { name: 'CJK', lon: 139.7, lat: 35.7, text: '東京', size: 18, color: white, view: 2 },
    ] as const) {
      const centers = [
        { longitudeDeg: 18, latitudeDeg: 40, zoom: 4.5 },
        { longitudeDeg: 37.6, latitudeDeg: 55, zoom: 5 },
        { longitudeDeg: 139.7, latitudeDeg: 35, zoom: 5 },
      ];
      const image = await show(page, centers[view] ?? { longitudeDeg: 18, latitudeDeg: 40, zoom: 4.5 });
      const at = await screen(page, lon, lat);
      const box = boxOf(image, at.xPx - 120, at.yPx - 40, at.xPx + 120, at.yPx + 40, color);
      const expected = await textWidth(page, text, size);
      expect(box.pixels, name).toBeGreaterThan(20);
      expect(
        Math.abs(box.width - expected) / expected,
        `${name}: ${box.width} px, the browser sets ${expected.toFixed(1)}`,
      ).toBeLessThan(0.2);
    }
    // The centered label stays on its coordinate within a pixel while panning and zooming: the text's offset from its
    // projected coordinate (its ink is not exactly centered, glyphs have side bearings) never changes by more.
    const offsets: number[] = [];
    for (const view of [
      { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 },
      { longitudeDeg: 13.3, latitudeDeg: 42.4, zoom: 6 },
      { longitudeDeg: 11.9, latitudeDeg: 41.5, zoom: 7.3 },
    ]) {
      const image = await show(page, view);
      const roma = await screen(page, 12.5, 41.9);
      const box = boxOf(image, roma.xPx - 90, roma.yPx - 20, roma.xPx + 90, roma.yPx + 20, yellow);
      expect(box.pixels, `zoom ${view.zoom}`).toBeGreaterThan(20);
      offsets.push((box.x0 + box.x1) / 2 - roma.xPx, (box.y0 + box.y1) / 2 - roma.yPx);
    }
    for (const axis of [0, 1]) {
      const values = offsets.filter((_, i) => i % 2 === axis);
      expect(Math.max(...values) - Math.min(...values), `anchor drift ${values.join(', ')}`).toBeLessThanOrEqual(1);
    }
  });
}
