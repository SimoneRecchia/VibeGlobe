// Selection highlights of data layers (M10, F381): every data-layer primitive selected by a click or through the API is
// highlighted in the next frame, unhighlighted on deselection, and the highlight follows camera moves and updates.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, nextFrame, openGlobe, waitForIdle } from './support/globe.ts';
import { waitForStreaming } from './support/imagery.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;

type Rgb = [number, number, number];
const isYellow = ([r, g, b]: Rgb): boolean => r > 200 && g > 200 && b < 90;
const isBlue = ([r, g, b]: Rgb): boolean => b > 180 && r < 90 && g < 120;
/** The red pyramid blended toward yellow. */
const isAmber = ([r, g, b]: Rgb): boolean => r > 150 && g > 90 && b < 70;

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
  { layer: 'sel-model', id: 'md', at: [12.35, 41.75] },
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
  if (target.layer === 'sel-model') return count(image, at, 6, isAmber) > 20;
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
    test.setTimeout(180_000);
    await openGlobe(page, `backend=${backend}&scenario=data-select`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const layers = window.vibeglobeLayers;
      if (!globe || !layers?.interaction) throw new Error('no layers');
      // The application's click handler selects the clicked feature, glTF models included.
      const models = (layers as { models?: (typeof layers.layers)[string] }).models;
      for (const layer of [...Object.values(layers.layers), ...(models ? [models] : [])])
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
    // Every primitive by click, then again through the API after clearing; each shows in the next frame.
    const selected = () =>
      page.evaluate(() => window.vibeglobeLayers?.interaction?.selection.map((f) => `${f.layerId}/${String(f.id)}`));
    for (const [i, target] of TARGETS.entries()) {
      const at = positions[i] ?? { xPx: 0, yPx: 0 };
      await page.mouse.click(box.x + at.xPx, box.y + at.yPx);
      await expect.poll(selected, `${target.layer} clicked`).toContain(`${target.layer}/${target.id}`);
      image = await frame(page);
      expect(highlighted(image, target, at), `${target.layer} selected by click`).toBe(true);
    }
    await page.evaluate(() => window.vibeglobeLayers?.interaction?.clearSelection());
    image = await frame(page);
    TARGETS.forEach((t, i) => expect(highlighted(image, t, positions[i] ?? { xPx: 0, yPx: 0 }), t.layer).toBe(false));
    for (const [i, target] of TARGETS.entries()) {
      await page.evaluate(({ layer, id }) => window.vibeglobeLayers?.interaction?.select(layer, id), target);
      image = await frame(page);
      expect(highlighted(image, target, positions[i] ?? { xPx: 0, yPx: 0 }), `${target.layer} selected`).toBe(true);
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

const isCyan = ([r, g, b]: Rgb): boolean => r < 90 && g > 180 && b > 200;
/** The red pyramid blended toward white (it shows about 226, 82, 82 in sRGB, hovered about 234, 152, 152). */
const isPink = ([r, g, b]: Rgb): boolean => r > 180 && g > 120 && b > 120 && g < 200;

/** Whether a target shows its hover style: cyan, the marker at 32 px, the model lightened. */
function hovered(image: PNG, target: (typeof TARGETS)[number], at: { xPx: number; yPx: number }): boolean {
  if (target.layer === 'sel-marker') {
    const blue = count(image, at, 20, isBlue);
    return blue > 700 && blue < 1300;
  }
  if (target.layer === 'sel-model') return count(image, at, 6, isPink) > 20;
  return count(image, at, 6, isCyan) > 4;
}

for (const backend of BACKENDS) {
  test(`hovering every primitive emits enter and leave once each with feature, layer and coordinates, and shows the hover style in the next frame on ${backend} (F379)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&scenario=data-select`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const layers = window.vibeglobeLayers;
      if (!globe || !layers) throw new Error('no layers');
      const recorded: string[] = [];
      (window as unknown as { recorded: string[] }).recorded = recorded;
      const models = (layers as { models?: (typeof layers.layers)[string] }).models;
      for (const layer of [...Object.values(layers.layers), ...(models ? [models] : [])])
        for (const type of ['hover-enter', 'hover-leave'] as const)
          layer.on(type, ({ feature, position }) =>
            recorded.push(
              `${type} ${feature.layerId}/${String(feature.id)} ${position?.longitudeDeg.toFixed(3) ?? '-'},${position?.latitudeDeg.toFixed(3) ?? '-'}`,
            ),
          );
      document.querySelector<HTMLElement>('#camera-controls')?.style.setProperty('display', 'none');
      globe.setViewMode('2d');
      globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.88, zoom: 9 });
    });
    await page.waitForTimeout(500);
    await waitForIdle(page);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    // A spot with no feature, between the visits.
    const empty = await screen(page, [12.66, 41.76]);
    await page.mouse.move(box.x + empty.xPx, box.y + empty.yPx);
    const expected: string[] = [];
    for (const target of TARGETS) {
      const at = await screen(page, target.at);
      await page.mouse.move(box.x + at.xPx, box.y + at.yPx);
      const key = `${target.layer}/${target.id}`;
      const where = `${target.at[0].toFixed(3)},${target.at[1].toFixed(3)}`;
      expected.push(`hover-enter ${key} ${where}`);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { recorded: string[] }).recorded.length))
        .toBe(expected.length);
      const image = await frame(page);
      expect(hovered(image, target, at), `${target.layer} hover style`).toBe(true);
      await page.mouse.move(box.x + empty.xPx, box.y + empty.yPx);
      expected.push(`hover-leave ${key} 12.660,41.760`);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { recorded: string[] }).recorded.length))
        .toBe(expected.length);
      const after = await frame(page);
      expect(hovered(after, target, at), `${target.layer} hover style removed`).toBe(false);
    }
    expect(await page.evaluate(() => (window as unknown as { recorded: string[] }).recorded)).toEqual(expected);
  });
}

for (const backend of BACKENDS) {
  test(`clicking and tapping every primitive emits click with the feature, layer, coordinates and elevation, the topmost of overlapping ones, on ${backend} (F380)`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 480, height: 360 }, hasTouch: true });
    const page = await context.newPage();
    await openGlobe(page, `backend=${backend}&scenario=data-select`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const layers = window.vibeglobeLayers;
      if (!globe || !layers) throw new Error('no layers');
      const recorded: string[] = [];
      (window as unknown as { recorded: string[] }).recorded = recorded;
      const models = (layers as { models?: (typeof layers.layers)[string] }).models;
      for (const layer of [...Object.values(layers.layers), ...(models ? [models] : [])])
        layer.on('click', ({ feature, position }) =>
          recorded.push(
            `${feature.layerId}/${String(feature.id)} ${position?.longitudeDeg.toFixed(3) ?? '-'},${position?.latitudeDeg.toFixed(3) ?? '-'} ${String(position?.heightMeters ?? '-')}`,
          ),
        );
      // The playground's buttons sit over the canvas's top corners; a tap near one is snapped to it (touch adjustment).
      for (const id of ['#camera-controls', '#view-modes'])
        document.querySelector<HTMLElement>(id)?.style.setProperty('display', 'none');
      globe.setViewMode('2d');
      globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.88, zoom: 9 });
    });
    await page.waitForTimeout(500);
    await waitForIdle(page);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    const recorded = () => page.evaluate(() => (window as unknown as { recorded: string[] }).recorded);
    const expected: string[] = [];
    // Every primitive by mouse and by touch, and where a point lies under the polygon (an upper layer, opaque) the
    // polygon, which is drawn on top there.
    const targets = [...TARGETS, { layer: 'sel-polygon', id: 'pg', at: [12.68, 42.02] } as const];
    for (const input of ['mouse', 'touch'] as const)
      for (const target of targets) {
        const at = await screen(page, target.at);
        if (input === 'mouse') await page.mouse.click(box.x + at.xPx, box.y + at.yPx);
        else await page.touchscreen.tap(box.x + at.xPx, box.y + at.yPx);
        // Without terrain the ground is the ellipsoid: elevation 0.
        expected.push(`${target.layer}/${target.id} ${target.at[0].toFixed(3)},${target.at[1].toFixed(3)} 0`);
        await expect.poll(recorded, `${input} ${target.layer}`).toHaveLength(expected.length);
      }
    expect(await recorded()).toEqual(expected);
    await context.close();
  });

  test(`a click on a ground-clamped point over terrain carries the terrain's elevation on ${backend} (F380)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(
      page,
      `backend=${backend}&terrain=terrarium&scenario=data-clamped&lon=6.86&lat=45.78&zoom=9.8&tilt=45`,
    );
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await waitForStreaming(page);
    const result = await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      document.querySelector<HTMLElement>('#camera-controls')?.style.setProperty('display', 'none');
      // Point c44 at (6.81°, 45.80°), on the mountain's flank.
      const ground = globe.elevationAt({ longitudeDeg: 6.81, latitudeDeg: 45.8 });
      const at = globe.geoToScreen({ longitudeDeg: 6.81, latitudeDeg: 45.8, heightMeters: ground.heightMeters });
      return { at, ground: ground.heightMeters };
    });
    if (!result.at) throw new Error('off screen');
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    // The handler is registered before the click is sent: a click dispatched while the registering script had not run
    // yet was never reported (KB-220).
    await page.evaluate(() => {
      const target = window as unknown as { clampedClick?: Promise<{ id: string; heightMeters: number | undefined }> };
      target.clampedClick = new Promise((resolve) =>
        window.vibeglobeLayers?.layers['clamped']?.on('click', ({ feature, position }) =>
          resolve({ id: String(feature.id), heightMeters: position?.heightMeters }),
        ),
      );
    });
    await page.mouse.click(box.x + result.at.xPx, box.y + result.at.yPx);
    const event = await page.evaluate(
      () =>
        (window as unknown as { clampedClick: Promise<{ id: string; heightMeters: number | undefined }> }).clampedClick,
    );
    expect(event.id).toBe('c44');
    expect(Math.abs((event.heightMeters ?? NaN) - result.ground)).toBeLessThan(30);
    expect(result.ground).toBeGreaterThan(1000);
  });
}
