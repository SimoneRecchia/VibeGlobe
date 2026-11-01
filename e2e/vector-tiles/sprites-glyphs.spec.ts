// F448: the style's sprite at the device pixel ratio (the 2x sheet at ratio 2) with icons drawn sharp, signed-distance
// text crisp from 10 to 32 px, glyph ranges requested only for the characters in use, and labels in Latin, Cyrillic,
// Greek and CJK (CJK from the configured local font: the fixture glyphs have no CJK ranges) without missing glyphs.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { capture, near, openVector, rgbAt, settle } from './support.ts';

test.use({ viewport: { width: 480, height: 360 } });

const POIS = 'scenario=mvt-flat&backend=webgl2&zoom=14.6&lon=9.218&lat=45.4568';
/** The square icon of the fixture sprite (e2e/vector-tiles/fixtures/generate.ts) and the background land. */
const SQUARE = { longitudeDeg: 9.218, latitudeDeg: 45.4555 };
const SQUARE_RGB = [40, 90, 220];
const LAND_RGB = [242, 231, 210];

function requests(page: Page, part: string): string[] {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(part)) urls.push(r.url());
  });
  return urls;
}

const labelTexts = async (page: Page) =>
  (
    (await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.placedLabels() ?? [])) as unknown as {
      text: string;
    }[]
  ).map((l) => l.text);

/** Pixels across the icon's right edge, along its center row, that are a blend of two of its colors and the land. */
function blendedAcrossEdge(image: PNG, x: number, y: number, ratio: number): number {
  const colors = [SQUARE_RGB, [255, 255, 255], LAND_RGB];
  let blended = 0;
  for (let dx = 0; dx < 14 * ratio; dx++) {
    const c = rgbAt(image, x + dx, y);
    if (!colors.some((k) => near(c, k, 24))) blended++;
  }
  return blended;
}

for (const ratio of [1, 2]) {
  test.describe(`at device pixel ratio ${ratio}`, () => {
    test.use({ deviceScaleFactor: ratio });

    test(`the ${ratio}x sprite is used and icons are sharp (F448)`, async ({ page }) => {
      // Four times the pixels at ratio 2: CI's software GPU took over the default 30 s once (docs/internal/test-changes.md).
      test.setTimeout(90_000);
      const sprites = requests(page, '/vector-tiles/sprite');
      await openVector(page, POIS);
      const sheet = ratio === 2 ? 'sprite@2x.png' : 'sprite.png';
      expect(sprites.some((u) => u.endsWith(sheet))).toBe(true);
      expect(sprites.filter((u) => u.endsWith('.png') && !u.endsWith(sheet))).toEqual([]);
      const image = await capture(page);
      const at = await page.evaluate((p) => window.vibeglobePlayground?.globe.geoToScreen(p), SQUARE);
      if (at === undefined) throw new Error('icon off screen');
      const x = Math.round(at.xPx * ratio);
      const y = Math.round(at.yPx * ratio);
      expect(image.width).toBe(480 * ratio);
      // The icon's own color (sRGB as drawn in the sprite), then at most one blended pixel per color change.
      expect(near(rgbAt(image, x, y), SQUARE_RGB, 12), String(rgbAt(image, x, y))).toBe(true);
      expect(blendedAcrossEdge(image, x, y, ratio)).toBeLessThanOrEqual(2);
    });
  });
}

test('text is crisp from 10 to 32 px (F448)', async ({ page }) => {
  // Four text sizes, each laid out and drawn again on a software GPU: 27 s on CI, past the default 30 s on a slow runner.
  test.setTimeout(60_000);
  await openVector(page, POIS);
  for (const size of [10, 14, 20, 32]) {
    await page.evaluate(
      (s) => window.vibeglobeVectorTiles?.layer?.style.setLayoutProperty('poi', 'text-size', s),
      size,
    );
    await expect.poll(async () => (await labelTexts(page)).includes('Москва'), { timeout: 10_000 }).toBe(true);
    await settle(page);
    const image = await capture(page);
    const label = (
      (await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.placedLabels() ?? [])) as unknown as {
        text: string;
        boxes: { minX: number; minY: number; maxX: number; maxY: number }[];
      }[]
    ).find((l) => l.text === 'Москва');
    const box = label?.boxes[0];
    if (box === undefined) throw new Error('no label');
    let dark = 0;
    let mid = 0;
    let darkest = 255;
    for (let y = Math.ceil(box.minY); y < box.maxY; y++)
      for (let x = Math.ceil(box.minX); x < box.maxX; x++) {
        const [r, g, b] = rgbAt(image, x, y);
        const lum = (r + g + b) / 3;
        darkest = Math.min(darkest, lum);
        if (lum < 90) dark++;
        else if (lum < 200) mid++;
      }
    // Strokes reach the text color, and the anti-aliased pixels grow with the outline's length (the size), not with
    // its area as a blurred edge's would: about 9 per pixel of size here.
    expect(darkest, `size ${size}`).toBeLessThan(110);
    expect(mid / size, `size ${size}: ${dark} dark, ${mid} edge pixels`).toBeLessThan(13);
  }
});

test('glyph ranges are requested only for the characters in use (F448)', async ({ page }) => {
  const glyphs = requests(page, '/vector-tiles/glyphs/');
  const ranges = (font: string) =>
    new Set(
      glyphs.filter((u) => u.includes(encodeURIComponent(font))).map((u) => Number(/(\d+)-\d+\.pbf$/.exec(u)?.[1])),
    );
  // Street names in Latin: the first range only.
  await openVector(page, 'scenario=mvt-labels&backend=webgl2');
  expect([...ranges('Inter Regular')]).toEqual([0]);
  expect([...ranges('Inter Bold')]).toEqual([0]);
  // The points of interest add exactly the ranges of their Greek, Cyrillic and CJK characters.
  await page.evaluate(() =>
    window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 9.218, latitudeDeg: 45.4568, zoom: 14.6 }),
  );
  await settle(page);
  const needed = new Set<number>([0]);
  for (const text of ['Café Über', 'Москва', 'Αθήνα', '東京', 'Ελλάδα', '北京'])
    for (const char of text) needed.add(Math.floor((char.codePointAt(0) ?? 0) / 256) * 256);
  expect([...ranges('Inter Regular')].sort((a, b) => a - b)).toEqual([...needed].sort((a, b) => a - b));
});

test('Latin, Cyrillic, Greek and CJK labels render without missing glyphs (F448)', async ({ page }) => {
  await openVector(page, POIS);
  const texts = await labelTexts(page);
  for (const name of ['Москва', 'Αθήνα', 'Ελλάδα', '東京', '北京']) expect(texts).toContain(name);
  // Every character has a glyph: from the style's ranges, or drawn locally (CJK).
  const missing = await page.evaluate(() => {
    const placer = (
      window.vibeglobeVectorTiles?.layer as unknown as {
        placer: { glyphs: { resolve(code: number, font: string[]): unknown } };
      }
    ).placer;
    return [...'МоскваΑθήναΕλλάδα東京北京'].filter(
      (c) => placer.glyphs.resolve(c.codePointAt(0) ?? 0, ['Inter Regular']) === undefined,
    );
  });
  expect(missing).toEqual([]);
});
