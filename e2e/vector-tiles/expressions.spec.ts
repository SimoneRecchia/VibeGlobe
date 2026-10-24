// F446 in the browser (the operator families and legacy filters are unit tests, vector-style.test.ts): zoom-interpolated
// paint changes smoothly through a continuous zoom, and feature-state set at runtime restyles its feature on the next
// frame.
import { expect, test, type Page } from '@playwright/test';
import { capture, hex, near, openVector, rgbAt } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

const CENTER = { longitudeDeg: 9.1865, latitudeDeg: 45.465 };
/** Corso Buenos Aires, the primary avenue through the fixture city (e2e/vector-tiles/fixtures/city.ts). */
const AVENUE_ID = 5001;

/** The avenue's width at the view's center column, and its color there. */
async function avenue(page: Page, groundBlue?: number): Promise<{ width: number; color: number[]; ground: number }> {
  const image = await capture(page);
  const at = await page.evaluate((c) => window.vibeglobePlayground?.globe.geoToScreen(c), CENTER);
  if (at === undefined) throw new Error('off screen');
  // Sub-pixel width: each pixel's share of the avenue's color, from its blue channel between the ground's (above the
  // avenue) and the avenue's; the darker casing pixels around it are not the avenue.
  const x = Math.round(at.xPx);
  const ground = groundBlue ?? rgbAt(image, x, Math.round(at.yPx) - 30)[2];
  const fill = hex('#fcd6a4')[2];
  let width = 0;
  for (let y = Math.max(0, Math.round(at.yPx) - 20); y < Math.min(image.height, Math.round(at.yPx) + 20); y++) {
    const c = rgbAt(image, x, y);
    if (c[0] < 200) continue;
    width += Math.max(0, Math.min(1, (ground - c[2]) / (ground - fill)));
  }
  return { width, color: rgbAt(image, Math.round(at.xPx), Math.round(at.yPx)), ground };
}

test('interpolated paint changes smoothly through a continuous zoom (F446)', async ({ page }) => {
  test.setTimeout(120_000);
  // Inside the park, clear of the streets that cross it.
  const park = { longitudeDeg: 9.1735, latitudeDeg: 45.4745 };
  await openVector(page, 'scenario=mvt-flat&backend=webgl2&zoom=12&lon=9.1735&lat=45.4745');
  // The park's fill from red at zoom 12 to blue at zoom 14, linearly: 40 steps of 0.05, about 6.4 per step.
  await page.evaluate(() =>
    window.vibeglobeVectorTiles?.layer?.style.setPaintProperty('park', 'fill-color', [
      'interpolate',
      ['linear'],
      ['zoom'],
      12,
      '#ff0000',
      14,
      '#0000ff',
    ]),
  );
  let previous: number[] | undefined;
  for (let zoom = 12; zoom <= 14.001; zoom += 0.05) {
    await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), { ...park, zoom });
    const image = await capture(page);
    const at = await page.evaluate((g) => window.vibeglobePlayground?.globe.geoToScreen(g), park);
    if (at === undefined) throw new Error('off screen');
    const color = rgbAt(image, at.xPx, at.yPx);
    if (previous !== undefined) {
      const step = Math.max(...color.map((c, i) => Math.abs(c - (previous?.[i] ?? 0))));
      expect(step, `zoom ${zoom.toFixed(2)}: ${previous.join()} → ${color.join()}`).toBeLessThanOrEqual(24);
    }
    previous = color;
  }
  expect(near(previous ?? [], [0, 0, 255], 12)).toBe(true);
});

test('feature-state set at runtime restyles the feature on the next frame (F446)', async ({ page }) => {
  await openVector(page, 'scenario=mvt-flat&backend=webgl2&zoom=15&lon=9.1865&lat=45.465');
  expect(near((await avenue(page)).color, hex('#fcd6a4'), 12)).toBe(true);
  await page.evaluate(
    (id) => window.vibeglobeVectorTiles?.layer?.setFeatureState({ source: 'openmaptiles', id }, { selected: true }),
    AVENUE_ID,
  );
  // The fixture style colors selected roads #ff3b30.
  expect(near((await avenue(page)).color, hex('#ff3b30'), 24)).toBe(true);
  await page.evaluate(
    (id) => window.vibeglobeVectorTiles?.layer?.setFeatureState({ source: 'openmaptiles', id }, { selected: false }),
    AVENUE_ID,
  );
  expect(near((await avenue(page)).color, hex('#fcd6a4'), 12)).toBe(true);
});
