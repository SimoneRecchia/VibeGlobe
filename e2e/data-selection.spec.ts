// Selection highlights of data layers (M10, F381): every data-layer primitive selected by a click or through the API is
// highlighted in the next frame, unhighlighted on deselection, and the highlight follows camera moves and updates.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, nextFrame, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;

type Rgb = [number, number, number];
const isYellow = ([r, g, b]: Rgb): boolean => r > 200 && g > 200 && b < 90;
const isBlue = ([r, g, b]: Rgb): boolean => b > 180 && r < 90 && g < 120;

/** Pixels passing `test` in a square of half-size `half` around a point. */
function count(image: PNG, at: { xPx: number; yPx: number }, half: number, test: (rgb: Rgb) => boolean): number {
  let n = 0;
  for (let y = Math.round(at.yPx) - half; y <= Math.round(at.yPx) + half; y++)
    for (let x = Math.round(at.xPx) - half; x <= Math.round(at.xPx) + half; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * 4;
      if (test([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0])) n++;
    }
  return n;
}

/** Each primitive's layer, feature and a position inside it (`apps/playground/src/layers-select.ts`). */
const TARGETS = [
  { layer: 'sel-point', id: 'pt', at: [12.35, 42.0] },
  { layer: 'sel-line', id: 'ln', at: [12.5, 42.0] },
  { layer: 'sel-polygon', id: 'pg', at: [12.65, 42.0] },
  { layer: 'sel-circle', id: 'cr', at: [12.35, 41.85] },
  { layer: 'sel-marker', id: 'mk', at: [12.5, 41.85] },
  { layer: 'sel-label', id: 'lb', at: [12.65, 41.85] },
  { layer: 'sel-extrusion', id: 'ex', at: [12.5, 41.74] },
] as const;

async function screen(page: Page, [lon, lat]: readonly [number, number]): Promise<{ xPx: number; yPx: number }> {
  const point = await page.evaluate(
    ([longitudeDeg, latitudeDeg]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: longitudeDeg ?? 0, latitudeDeg: latitudeDeg ?? 0 }),
    [lon, lat],
  );
  if (!point) throw new Error(`${lon}, ${lat} off screen`);
  return point;
}

/** Whether a target shows its highlight: yellow, or for the marker its larger size (blue pixels). */
function highlighted(image: PNG, target: (typeof TARGETS)[number], at: { xPx: number; yPx: number }): boolean {
  if (target.layer === 'sel-marker') return count(image, at, 20, isBlue) > 900;
  return count(image, at, 6, isYellow) > 4;
}

async function frame(page: Page): Promise<PNG> {
  await nextFrame(page);
  await nextFrame(page);
  return canvasImage(page);
}

for (const backend of BACKENDS) {
  test(`features of every data-layer primitive selected by click or API are highlighted in the next frame, follow camera moves and updates, and clear on deselection on ${backend} (F381)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&scenario=data-select`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const layers = window.vibeglobeLayers;
      if (!globe || !layers?.interaction) throw new Error('no layers');
      // The application's click handler selects the clicked feature.
      for (const layer of Object.values(layers.layers))
        layer.on('click', ({ feature }) => layers.interaction?.select(feature.layerId, feature.id));
      // The playground's camera buttons sit over the top of the canvas, where the first row of features is.
      document.querySelector<HTMLElement>('#camera-controls')?.style.setProperty('display', 'none');
      globe.setViewMode('2d');
      globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.88, zoom: 9 });
    });
    await page.waitForTimeout(500);
    await waitForIdle(page);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    let image = await canvasImage(page);
    const positions = await Promise.all(TARGETS.map((t) => screen(page, t.at)));
    TARGETS.forEach((t, i) => expect(highlighted(image, t, positions[i] ?? { xPx: 0, yPx: 0 }), t.layer).toBe(false));
    // The first three by click, the others through the API; each shows in the next frame.
    for (const [i, target] of TARGETS.entries()) {
      const at = positions[i] ?? { xPx: 0, yPx: 0 };
      if (i < 3) {
        await page.mouse.click(box.x + at.xPx, box.y + at.yPx);
        await expect
          .poll(() =>
            page.evaluate(
              ({ layer, id }) => window.vibeglobeLayers?.layers[layer]?.getFeatureState(id)?.['selected'],
              target,
            ),
          )
          .toBe(true);
      } else await page.evaluate(({ layer, id }) => window.vibeglobeLayers?.interaction?.select(layer, id), target);
      image = await frame(page);
      expect(highlighted(image, target, at), `${target.layer} selected`).toBe(true);
    }
    // The camera pans: every highlight is at its feature's new screen position.
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 12.55, latitudeDeg: 41.9 }));
    image = await frame(page);
    for (const target of TARGETS)
      expect(highlighted(image, target, await screen(page, target.at)), `${target.layer} after the pan`).toBe(true);
    // The selected point moves: its highlight goes with it.
    await page.evaluate(() => window.vibeglobeLayers?.layers['sel-point']?.setFeaturePosition('pt', 12.4, 41.95));
    image = await frame(page);
    expect(highlighted(image, TARGETS[0], await screen(page, [12.4, 41.95])), 'moved point').toBe(true);
    expect(count(image, await screen(page, [12.35, 42.0]), 6, isYellow), 'old point position').toBe(0);
    // Deselection removes each highlight in the next frame.
    for (const target of TARGETS) {
      await page.evaluate(({ layer, id }) => window.vibeglobeLayers?.interaction?.deselect(layer, id), target);
      image = await frame(page);
      const at = await screen(page, target.layer === 'sel-point' ? [12.4, 41.95] : target.at);
      expect(highlighted(image, target, at), `${target.layer} deselected`).toBe(false);
    }
  });
}
