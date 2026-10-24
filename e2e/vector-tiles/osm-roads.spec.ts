// F453 on the fixture city (the Italy OpenStreetMap tiles of the data pipeline are open question 25): a bridge draws
// above the tunnel and the canal it crosses, and road names run along the roads at street zoom.
import { expect, test } from '@playwright/test';
import { capture, hex, near, openVector, rgbAt } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** Where the bridge (primary, `layer` 1) crosses the tunnel (minor, `layer` −1); e2e/vector-tiles/fixtures/city.ts. */
const CROSSING = { longitudeDeg: 9.183, latitudeDeg: 45.4505 };
const OVER_CANAL = { longitudeDeg: 9.183, latitudeDeg: 45.452 };

test('bridges draw above the tunnels and water they cross; road names follow the roads (F453)', async ({ page }) => {
  await openVector(page, 'scenario=mvt-flat&backend=webgl2&zoom=16&lon=9.183&lat=45.4512');
  await page.evaluate(() => {
    const layer = window.vibeglobeVectorTiles?.layer;
    for (const l of layer?.style.layers ?? []) if (l.type === 'symbol') layer?.style.setVisibility(l.id, false);
  });
  const image = await capture(page);
  for (const at of [CROSSING, OVER_CANAL]) {
    const p = await page.evaluate((g) => window.vibeglobePlayground?.globe.geoToScreen(g), at);
    if (p === undefined) throw new Error('off screen');
    expect(near(rgbAt(image, p.xPx, p.yPx), hex('#fcd6a4'), 12), String(rgbAt(image, p.xPx, p.yPx))).toBe(true);
    const picked = await page.evaluate(
      (q) => window.vibeglobeVectorTiles?.layer?.queryRenderedFeatures(q).map((f) => f.layerId) ?? [],
      { xPx: p.xPx, yPx: p.yPx },
    );
    // Topmost first: the bridge, then what lies under it.
    expect(picked[0]).toBe('bridge');
  }
  await page.evaluate(() => {
    const layer = window.vibeglobeVectorTiles?.layer;
    for (const l of layer?.style.layers ?? []) if (l.type === 'symbol') layer?.style.setVisibility(l.id, true);
    window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 9.19, latitudeDeg: 45.465, zoom: 15 });
  });
  await expect
    .poll(
      async () =>
        (
          (await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.placedLabels() ?? [])) as unknown as {
            layerId: string;
            boxes: unknown[];
          }[]
        ).filter((l) => l.layerId === 'road-label' && l.boxes.length > 3).length,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
});
