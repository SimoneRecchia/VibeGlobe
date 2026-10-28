// Polygon coverage clipped per pixel (F618, KB-209): a service that answers with white filler outside its country but
// inside its bounding box (basemap.at around Austria) shows the layer below there, not a white rectangle. The fixture
// overlay is white everywhere, limited to a triangle over Italy given as GeoJSON; the base layer is blue.
import { expect, test, type Page } from '@playwright/test';
import { canvasImage, geoToScreen, openGlobe } from './support/globe.ts';
import { fixtureSession, waitForImagery } from './support/imagery.ts';

/** The RGB of the canvas pixel at a geographic position. */
async function colorAt(page: Page, longitudeDeg: number, latitudeDeg: number): Promise<number[]> {
  const { xPx, yPx } = await geoToScreen(page, { longitudeDeg, latitudeDeg });
  const image = await canvasImage(page);
  const at = (Math.round(yPx) * image.width + Math.round(xPx)) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

const isWhite = ([r = 0, g = 0, b = 0]: number[]): boolean => r > 200 && g > 200 && b > 200;
const isBlue = ([r = 0, g = 0, b = 0]: number[]): boolean => b > r + 80 && b > g + 80;

test.describe('coverage clipped per pixel (F618, KB-209)', () => {
  test.use({ viewport: { width: 320, height: 240 } });

  test('a tile across the area border shows the source inside the polygon and the layer below outside it', async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    // The view is centered on the triangle's long side, which crosses 12° E at 43.5° N.
    await openGlobe(
      page,
      `backend=webgl2&imagery=blue&overlays=white&overlayArea=triangle&session=${session}&lon=12&lat=43.5&zoom=6`,
    );
    await waitForImagery(page);
    // Half a degree on each side of the border, in the same overlay tiles: inside the area the service's tile, outside
    // it (but inside its bounding box) the blue layer below, not the white filler.
    expect(isWhite(await colorAt(page, 11.5, 43))).toBe(true);
    expect(isBlue(await colorAt(page, 12.5, 44))).toBe(true);
    // Farther from the border, at the view's edges: outside the area (inside its bounding box) no white rectangle,
    // inside it the service's tiles.
    expect(isBlue(await colorAt(page, 13.5, 44.3))).toBe(true);
    expect(isWhite(await colorAt(page, 10.8, 43.6))).toBe(true);
  });

  test('tiles wholly of the blankTile color count as no data, so the layer below shows', async ({ page }) => {
    const session = await fixtureSession(page);
    await openGlobe(
      page,
      `backend=webgl2&imagery=blue&overlays=white&overlayBlank=ffffff&session=${session}&lon=0&lat=0&zoom=4`,
    );
    await waitForImagery(page);
    expect(isBlue(await colorAt(page, 0, 0))).toBe(true);
  });

  /** The pixels of the canvas's middle row, from left to right, classified white, blue or between. */
  async function middleRow(page: Page): Promise<string> {
    const image = await canvasImage(page);
    const y = Math.floor(image.height / 2);
    let row = '';
    for (let x = 0; x < image.width; x++) {
      const at = (y * image.width + x) * 4;
      const rgb = [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
      row += isWhite(rgb) ? 'w' : isBlue(rgb) ? 'b' : '-';
    }
    return row;
  }

  test('a feathered border fades from the layer below to the source over its width, with no edge at tile seams (KB-231)', async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    const view = `imagery=blue&overlays=white&session=${session}&lon=12&lat=43.5&zoom=6`;
    await openGlobe(page, `backend=webgl2&${view}&overlayArea=triangle`);
    await waitForImagery(page);
    // The sharp border: white inside (left), blue outside (right), at most two pixels between.
    const sharp = await middleRow(page);
    expect(sharp.replace(/^w+/, '').replace(/b+$/, '').length).toBeLessThanOrEqual(2);
    await openGlobe(page, `backend=webgl2&${view}&overlayArea=triangle&overlayFeather=16`);
    await waitForImagery(page);
    const feathered = await middleRow(page);
    console.log(`[clip] sharp ${sharp}\n[clip] feathered ${feathered}`);
    // White, then a fade of several pixels, then blue: one transition only, none at the overlay's tile seams.
    expect(feathered).toMatch(/^w+-{6,}b+$/);
  });

  test('a keyed area makes the pixels of the key color transparent outside it only (KB-231)', async ({ page }) => {
    const session = await fixtureSession(page);
    await openGlobe(
      page,
      `backend=webgl2&imagery=blue&overlays=white&overlayArea=triangle-key&session=${session}&lon=12&lat=43.5&zoom=6`,
    );
    await waitForImagery(page);
    // The white overlay is keyed out outside the triangle (the layer below shows), kept inside it.
    expect(isWhite(await colorAt(page, 11.5, 43))).toBe(true);
    expect(isBlue(await colorAt(page, 12.5, 44))).toBe(true);
    expect(isBlue(await colorAt(page, 13.5, 44.3))).toBe(true);
    expect(isWhite(await colorAt(page, 10.8, 43.6))).toBe(true);
  });
});
