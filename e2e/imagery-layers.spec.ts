// Imagery layer stack (M7, ADR 0038): order (F243), opacity (F244), visibility (F245) and blend modes (F246) of
// fixture layers in a single color each, changed at runtime through `Globe.imageryLayers`.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { SOLID_COLORS } from '../scripts/fixtures/tiles/generate.ts';
import { canvasImage, nextFrame, openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession, requestLog, waitForImagery } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

type Rgb = readonly [number, number, number];
const BACKENDS = ['webgpu', 'webgl2'] as const;
/** Per channel, for 8-bit rounding on both ends of the blend. */
const TOLERANCE = 4;

const solid = (name: string): Rgb => SOLID_COLORS[name] ?? [0, 0, 0];
const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number): number => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
/** A blend of two sRGB colors in linear light, as the surface shader composes layers. */
function blend(below: Rgb, over: Rgb, opacity: number, mode: 'normal' | 'multiply' | 'screen'): Rgb {
  return below.map((b, i) => {
    const lb = toLinear(b);
    const lo = toLinear(over[i] ?? 0);
    const blended = mode === 'normal' ? lo : mode === 'multiply' ? lb * lo : 1 - (1 - lb) * (1 - lo);
    return toSrgb(lb + (blended - lb) * opacity);
  }) as unknown as Rgb;
}

function center(image: PNG): Rgb {
  const at = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

function expectColor(actual: Rgb, expected: Rgb, label: string): void {
  for (let i = 0; i < 3; i++)
    expect(
      Math.abs((actual[i] ?? 0) - (expected[i] ?? 0)),
      `${label}: ${actual.join()} vs ${expected.join()}`,
    ).toBeLessThanOrEqual(TOLERANCE);
}

/** Pixels darker than any fixture color (every channel at least 40): a missing layer or an empty draw. */
function blackPixels(image: PNG): number {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if ((image.data[i] ?? 0) < 20 && (image.data[i + 1] ?? 0) < 20 && (image.data[i + 2] ?? 0) < 20) count++;
  return count;
}

/** Opens a close view over Italy, every pixel on the globe, with the layers of `overlays` above a red layer. */
async function openStack(page: Page, backend: string, overlays: string, session: string): Promise<void> {
  await openGlobe(
    page,
    `backend=${backend}&imagery=red&overlays=${overlays}&session=${session}&lon=12.5&lat=41.9&zoom=7`,
  );
  await waitForImagery(page);
}

async function setLayer(page: Page, id: string, changes: Record<string, unknown>): Promise<void> {
  await page.evaluate(([layer, look]) => window.vibeglobePlayground?.globe.imageryLayers.set(layer, look), [
    id,
    changes,
  ] as const);
}

/** The center color of the next frame, which shows the change just made. */
async function nextCenter(page: Page): Promise<{ color: Rgb; black: number }> {
  await nextFrame(page);
  const image = await canvasImage(page);
  return { color: center(image), black: blackPixels(image) };
}

for (const backend of BACKENDS) {
  test(`reordered layers show the new top layer on the next frame, never a missing one, on ${backend} (F243)`, async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    await openStack(page, backend, 'green,blue', session);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.imageryLayers.list().map((l) => l.id))).toEqual([
      'fixture-red',
      'overlay-green',
      'overlay-blue',
    ]);
    for (const [id, index, top] of [
      ['overlay-blue', 0, 'green'],
      ['fixture-red', 2, 'red'],
      ['overlay-blue', 2, 'blue'],
      ['overlay-green', 2, 'green'],
    ] as const) {
      await page.evaluate(([layer, to]) => window.vibeglobePlayground?.globe.imageryLayers.move(layer, to), [
        id,
        index,
      ] as const);
      const shown = await nextCenter(page);
      expectColor(shown.color, solid(top), `${id} to ${index}`);
      expect(shown.black).toBe(0);
    }
  });

  test(`a layer's opacity blends it over the layers below, changes smoothly, and at 0 requests nothing on ${backend} (F244)`, async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    await openStack(page, backend, 'green', session);
    for (const opacity of [0, 0.25, 0.5, 1]) {
      await setLayer(page, 'overlay-green', { opacity });
      const shown = await nextCenter(page);
      expectColor(shown.color, blend(solid('red'), solid('green'), opacity, 'normal'), `opacity ${opacity}`);
    }
    // An animation stepped frame by frame (a second at 8 frames per second of the manual steps): the green channel
    // rises in every frame, never back.
    let previous = -1;
    for (let frame = 0; frame <= 8; frame++) {
      await setLayer(page, 'overlay-green', { opacity: frame / 8 });
      const { color, black } = await nextCenter(page);
      expect(color[1]).toBeGreaterThanOrEqual(previous);
      expect(black).toBe(0);
      previous = color[1];
    }
    // At opacity 0 the layer asks for no tile: a pan to a new area requests only the red layer's.
    await setLayer(page, 'overlay-green', { opacity: 0 });
    const before = (await requestLog(page, session)).length;
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 2.35, latitudeDeg: 48.85 }));
    await waitForImagery(page);
    const after = (await requestLog(page, session)).slice(before);
    expect(after.some((r) => r.path.includes('/red/'))).toBe(true);
    expect(after.filter((r) => r.path.includes('/green/'))).toEqual([]);
  });

  test(`a hidden layer requests nothing and is not drawn, and shows its cached tiles again at once on ${backend} (F245)`, async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    await openStack(page, backend, 'blue', session);
    await setLayer(page, 'overlay-blue', { visible: false });
    const hidden = await nextCenter(page);
    expectColor(hidden.color, solid('red'), 'hidden');
    expect(hidden.black).toBe(0);
    // Hidden, a pan away and back requests none of its tiles.
    const before = (await requestLog(page, session)).length;
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 14, latitudeDeg: 41 }));
    await waitForImagery(page);
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.9 }));
    await waitForIdle(page);
    expect((await requestLog(page, session)).slice(before).filter((r) => r.path.includes('/blue/'))).toEqual([]);
    // Shown again: its cached tiles draw on the next frame.
    await setLayer(page, 'overlay-blue', { visible: true });
    const shown = await nextCenter(page);
    expectColor(shown.color, solid('blue'), 'shown again');
    expect(shown.black).toBe(0);
  });

  test(`an overlay's first tiles fade in over the layers below and never darken them on ${backend} (KB-304)`, async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    await openStack(page, `${backend}&clockStepMs=16.666666666666668`, '', session);
    // The same red over the red layer, nearly opaque: added on the running globe, its tiles arrive and fade in from
    // nothing, and every frame meanwhile shows red; a fade that mixed in black dipped by a quarter halfway (KB-304).
    await page.evaluate(
      async ([repo, url]) => {
        const sources = (await import(
          /* @vite-ignore */ `${repo}/packages/sources/src/index.ts`
        )) as typeof import('@vibeglobe/sources');
        window.vibeglobePlayground?.globe.imageryLayers.add({
          sources: [sources.xyzImagery({ id: 'late-red', url, maxLevel: 18 })],
          opacity: 0.99,
        });
      },
      [`/@fs${process.cwd()}`, `/fixture-tiles/${session}/red/mercator/{z}/{x}/{y}.png?late=1`] as const,
    );
    const reds: number[] = [];
    for (let frame = 0; frame < 40; frame++) reds.push(center(await canvasImage(page))[0]);
    await waitForImagery(page);
    expect((await requestLog(page, session)).some((r) => r.query === '?late=1' && r.status === 200)).toBe(true);
    expect(Math.min(...reds), reds.join()).toBeGreaterThanOrEqual(solid('red')[0] - TOLERANCE);
  });

  test(`normal, multiply and screen blending match their formulas on ${backend} (F246)`, async ({ page }) => {
    const session = await fixtureSession(page);
    await openStack(page, backend, 'shade', session);
    for (const mode of ['normal', 'multiply', 'screen'] as const) {
      for (const opacity of [1, 0.5]) {
        await setLayer(page, 'overlay-shade', { blend: mode, opacity });
        const shown = await nextCenter(page);
        expectColor(shown.color, blend(solid('red'), solid('shade'), opacity, mode), `${mode} at ${opacity}`);
      }
    }
  });
}
