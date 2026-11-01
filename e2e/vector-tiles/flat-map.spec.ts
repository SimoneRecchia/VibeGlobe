// F440: vector tiles on the flat 2D map, crisp at every fractional zoom and without seams at tile edges: canonical
// views against reviewed baselines (recorded in the pinned environment, hook request D (3)), line widths that change
// continuously through integer zooms, and tile boundaries without gaps, doubled lines or color steps.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { expectMatchesBaseline } from '../support/visual.ts';
import { BACKENDS, capture, hex, near, openVector, rgbAt, settle } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

const CITY = { longitudeDeg: 9.19, latitudeDeg: 45.465 };
const PRIMARY = hex('#fcd6a4');

const jump = (page: Page, zoom: number, at = CITY) =>
  page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), { ...at, zoom });

for (const backend of BACKENDS) {
  test(`canonical flat-map views match their baselines (${backend}, F440) @baseline`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await openVector(page, `scenario=mvt-flat&backend=${backend}`);
    for (const zoom of [4, 8.5, 12, 14.25, 16]) {
      await jump(page, zoom);
      await settle(page);
      await expectMatchesBaseline(page, testInfo, `mvt-flat-${zoom}-${backend}.png`, await capture(page));
    }
  });
}

/** The primary avenue's width in pixels where it crosses a column. */
async function avenueWidth(page: Page): Promise<number> {
  // The frame first: screen positions follow the last drawn frame.
  const image = await capture(page);
  // The view's center column, between the city's north-south roads.
  const at = await page.evaluate(() =>
    window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: 9.1865, latitudeDeg: 45.465 }),
  );
  if (at === undefined) throw new Error('off screen');
  let n = 0;
  for (let y = Math.max(0, Math.round(at.yPx) - 40); y < Math.min(image.height, Math.round(at.yPx) + 40); y++)
    if (near(rgbAt(image, Math.round(at.xPx), y), PRIMARY, 12)) n++;
  return n;
}

test('line widths change continuously through integer zooms (F440)', async ({ page }) => {
  test.setTimeout(180_000);
  const center = { longitudeDeg: 9.1865, latitudeDeg: 45.465 };
  await openVector(page, 'scenario=mvt-flat&backend=webgl2&zoom=10&lon=9.1865&lat=45.465');
  const widths: [number, number][] = [];
  for (let zoom = 10; zoom <= 16.001; zoom += 0.25) {
    await jump(page, zoom, center);
    await settle(page);
    widths.push([zoom, await avenueWidth(page)]);
  }
  // Wider as the zoom grows, a little at a time.
  for (let i = 1; i < widths.length; i++) {
    const [zoom, width] = widths[i] ?? [0, 0];
    const previous = widths[i - 1]?.[1] ?? 0;
    expect(width, `zoom ${zoom}: ${JSON.stringify(widths)}`).toBeGreaterThanOrEqual(previous - 1);
  }
  // Just below and just above each integer zoom: the same width (no step where the paint's zoom pair changes). Every
  // width here and above is read once the view's tiles are drawn: a source's tiles load when a layer draws at the zoom
  // (KB-292), and the check is about the paint, not the loading.
  for (const zoom of [11, 12, 13, 14, 15]) {
    await jump(page, zoom - 0.01, center);
    await settle(page);
    const below = await avenueWidth(page);
    await jump(page, zoom + 0.01, center);
    await settle(page);
    const above = await avenueWidth(page);
    expect(Math.abs(above - below), `at zoom ${zoom}`).toBeLessThanOrEqual(1);
  }
});

/** Pixels on a tile edge that differ from both sides while the sides agree: a gap, a doubled line or a color step. */
function edgeDefects(image: PNG, edges: { vertical: number[]; horizontal: number[] }): number {
  let defects = 0;
  const check = (x: number, y: number, dx: number, dy: number) => {
    if (x - 3 * dx < 0 || y - 3 * dy < 0 || x + 3 * dx >= image.width || y + 3 * dy >= image.height) return;
    const a = rgbAt(image, x - 3 * dx, y - 3 * dy);
    const b = rgbAt(image, x + 3 * dx, y + 3 * dy);
    const c = rgbAt(image, x, y);
    if (near(a, b, 4) && !near(c, a, 10)) defects++;
  };
  for (const x of edges.vertical) for (let y = 0; y < image.height; y++) check(Math.round(x), y, 1, 0);
  for (const y of edges.horizontal) for (let x = 0; x < image.width; x++) check(x, Math.round(y), 0, 1);
  return defects;
}

for (const backend of BACKENDS) {
  test(`tile edges show no gap, doubled line or color step (${backend}, F440)`, async ({ page }) => {
    for (const zoom of [8.5, 12.5, 14.25]) {
      await openVector(page, `scenario=mvt-flat&backend=${backend}&zoom=${zoom}&lon=9.19&lat=45.465`);
      // Labels may sit anywhere, edges included: they are not part of this check.
      await page.evaluate(() => {
        const layer = window.vibeglobeVectorTiles?.layer;
        for (const l of layer?.style.layers ?? []) if (l.type === 'symbol') layer?.style.setVisibility(l.id, false);
      });
      await settle(page);
      // The screen positions of the drawn targets' edges.
      const edges = await page.evaluate(() => {
        const globe = window.vibeglobePlayground?.globe;
        const vertical = new Set<number>();
        const horizontal = new Set<number>();
        for (const d of window.vibeglobeVectorTiles?.layer?.drawnTiles() ?? []) {
          const [z, x, y] = d.target.split('/').map(Number) as [number, number, number];
          const n = 2 ** z;
          const lon = (x / n) * 360 - 180;
          const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
          const p = globe?.geoToScreen({ longitudeDeg: lon, latitudeDeg: lat });
          if (p === undefined) continue;
          if (p.xPx > 4 && p.xPx < 316) vertical.add(Math.round(p.xPx));
          if (p.yPx > 4 && p.yPx < 236) horizontal.add(Math.round(p.yPx));
        }
        return { vertical: [...vertical], horizontal: [...horizontal] };
      });
      expect(edges.vertical.length + edges.horizontal.length, `edges in view at zoom ${zoom}`).toBeGreaterThan(0);
      expect(edgeDefects(await capture(page), edges), `zoom ${zoom}`).toBe(0);
    }
  });
}
