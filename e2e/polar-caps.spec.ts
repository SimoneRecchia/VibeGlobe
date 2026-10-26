// The polar caps beyond ±85.0511° (KB-211): zoomed in on a pole the globe used to flatten into the Web Mercator plane,
// which cannot show the caps, so the cap appeared as a crescent ending at the pole with nothing beyond and its tiles
// stretched into stripes. A view that reaches a cap now stays round, and a cap no imagery source covers shows its fill
// color as one disc, the color set at runtime; a geographic source that covers it shows instead.
import { expect, test, type Page } from '@playwright/test';
import { BACKGROUND_RGB, canvasImage, geoToScreen, openGlobe, waitForIdle } from './support/globe.ts';

const NORTH_RGB = [0x78, 0xa9, 0xcd];
const SOUTH_RGB = [0xf2, 0xf3, 0xf7];

/** The RGB of every 8th canvas pixel. */
async function samples(page: Page): Promise<number[][]> {
  const image = await canvasImage(page);
  const out: number[][] = [];
  for (let y = 4; y < image.height; y += 8)
    for (let x = 4; x < image.width; x += 8) {
      const at = (y * image.width + x) * 4;
      out.push([image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0]);
    }
  return out;
}

/** The RGB of the canvas pixel at a geographic position. */
async function colorAt(page: Page, longitudeDeg: number, latitudeDeg: number): Promise<number[]> {
  const { xPx, yPx } = await geoToScreen(page, { longitudeDeg, latitudeDeg });
  const image = await canvasImage(page);
  const at = (Math.round(yPx) * image.width + Math.round(xPx)) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

const near = (a: number[], b: number[], tolerance = 6): boolean =>
  a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tolerance);

test.describe('polar caps (KB-211)', () => {
  test.use({ viewport: { width: 320, height: 240 } });

  for (const [name, latitude, rgb] of [
    ['north', 89.9, NORTH_RGB],
    ['south', -89.9, SOUTH_RGB],
  ] as const) {
    test(`a view over the ${name} pole shows the whole cap in its fill color, with terrain`, async ({ page }) => {
      await openGlobe(page, `backend=webgl2&imagery=world&terrain=terrarium&lon=30&lat=${latitude}&zoom=5`);
      await waitForIdle(page);
      expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.morphFactor)).toBe(0);
      const pixels = await samples(page);
      // No pixel of the page behind the canvas: the cap is drawn beyond the pole too.
      expect(pixels.filter((p) => near(p, [...BACKGROUND_RGB], 2)).length).toBe(0);
      // One color, no stripes: every sample is the fill (the credits text aside).
      expect(pixels.filter((p) => !near(p, [...rgb])).length).toBeLessThan(pixels.length * 0.05);
    });
  }

  test('the fill color changes at runtime, and a view across the antimeridian near the pole is whole', async ({
    page,
  }) => {
    await openGlobe(page, 'backend=webgl2&imagery=world&lon=180&lat=87&zoom=4&tilt=40');
    await waitForIdle(page);
    expect(near(await colorAt(page, 180, 87.3), NORTH_RGB)).toBe(true);
    expect(near(await colorAt(page, -179.5, 87.3), NORTH_RGB)).toBe(true);
    await page.evaluate(() => window.vibeglobePlayground?.globe.setPolarCapColors({ north: '#204060' }));
    await waitForIdle(page);
    expect(near(await colorAt(page, 179.5, 87.3), [0x20, 0x40, 0x60])).toBe(true);
    expect(near(await colorAt(page, -179.5, 87.3), [0x20, 0x40, 0x60])).toBe(true);
    expect((await samples(page)).filter((p) => near(p, [...BACKGROUND_RGB], 2)).length).toBe(0);
  });

  test('a geographic source that covers the cap shows there instead of the fill', async ({ page }) => {
    await openGlobe(page, 'backend=webgl2&imagery=world&imageryTiling=geographic&lon=0&lat=89&zoom=4');
    await waitForIdle(page);
    expect(near(await colorAt(page, 0, 89), NORTH_RGB, 20)).toBe(false);
  });
});
