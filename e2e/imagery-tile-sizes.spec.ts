import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { canvasImage, openGlobe } from './support/globe.ts';
import { fixtureSession, requestLog, waitForStreaming, type LoggedRequest } from './support/imagery.ts';
import { compareImages, CROSS_BACKEND, SAME_BACKEND } from './support/visual.ts';

/**
 * Tile sizes and high-DPI variants (F240, F241) with the fixture `checker` imagery, a checkerboard of 1/4096 of the
 * Web Mercator world that looks the same at every level and tile size: a 512-pixel pyramid serves the next finer surface
 * level, so it shows as sharp as the 256-pixel one from a quarter of the tiles; `@2x` tiles keep the 1x level on a 2x
 * canvas, so features keep their CSS size.
 */
const BACKENDS = ['webgpu', 'webgl2'] as const;
const VIEWS = ['viewMode=2d&lon=10&lat=50&zoom=7.4', 'lon=10&lat=40&zoom=5.6'] as const;

test.use({ viewport: { width: 320, height: 240 } });

/** Mean projected texel size over the drawn tiles, in CSS pixels. */
async function meanTexelPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tiles = window.vibeglobePlayground?.globe.surfaceTiles() ?? [];
    return tiles.reduce((sum, tile) => sum + tile.texelErrorPx, 0) / tiles.length;
  });
}

/** Imagery requests of a session beyond the pinned base (levels 0–3 of every source, F084). */
function viewRequests(log: LoggedRequest[]): LoggedRequest[] {
  return log.filter((request) => request.source === 'checker' && request.level > 3);
}

/**
 * The imagery tiles the view draws, each of which was requested: a surface tile's imagery tile is its ancestor at the
 * imagery level. Tiles loaded ahead around the view (F284) are left out.
 */
async function drawnTiles(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...new Set(
      (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).map((tile) => {
        const level = tile.imageryLevel ?? -1;
        const shift = 2 ** (tile.level - level);
        return `${level}/${Math.floor(tile.x / shift)}/${Math.floor(tile.y / shift)}`;
      }),
    ),
  ]);
}

/** A device-pixel capture averaged down by `factor` in each direction, to compare with a 1x capture. */
function downscale(image: PNG, factor: number): PNG {
  const out = new PNG({ width: image.width / factor, height: image.height / factor });
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++)
          for (let dx = 0; dx < factor; dx++)
            sum += image.data[((y * factor + dy) * image.width + x * factor + dx) * 4 + c] ?? 0;
        out.data[(y * out.width + x) * 4 + c] = Math.round(sum / (factor * factor));
      }
  return out;
}

async function setDeviceScale(page: Page, ratio: number): Promise<void> {
  await (
    await page.context().newCDPSession(page)
  ).send('Emulation.setDeviceMetricsOverride', { width: 320, height: 240, deviceScaleFactor: ratio, mobile: false });
}

for (const backend of BACKENDS) {
  test.describe(backend, () => {
    for (const [index, view] of VIEWS.entries()) {
      test(`256- and 512-pixel pyramids look the same at the same view, from a quarter of the tiles, view ${index + 1} on ${backend} (F240)`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        // Enough tiles across the canvas that the ones partly visible along its edges weigh little in the count.
        await page.setViewportSize({ width: 960, height: 540 });
        const frames: PNG[] = [];
        const texels: number[] = [];
        const requests: number[] = [];
        for (const size of ['256', '512']) {
          const session = await fixtureSession(page);
          await openGlobe(
            page,
            `backend=${backend}&session=${session}&imagery=checker&imageryTileSize=${size}&${view}`,
          );
          await waitForStreaming(page);
          frames.push(await canvasImage(page));
          texels.push(await meanTexelPx(page));
          const drawn = await drawnTiles(page);
          const requested = new Set(
            viewRequests(await requestLog(page, session)).map((r) => `${r.level}/${r.x}/${r.y}`),
          );
          expect(drawn.filter((key) => !requested.has(key))).toEqual([]);
          requests.push(drawn.length);
        }
        const [small, large] = frames;
        if (!small || !large) throw new Error('missing frame');
        console.log(
          `[tile-sizes] ${backend} view ${index + 1}: texels ${texels.join(' / ')} px, requests ${requests.join(' / ')}`,
        );
        // Two textures of different sizes sample checker edges a hair apart where they are minified: the tolerance of
        // renderings that differ in sampling only, as across backends.
        const result = compareImages(small, large, CROSS_BACKEND.threshold);
        expect(result.ratio).toBeLessThanOrEqual(CROSS_BACKEND.maxDiffRatio);
        const [texel256 = 0, texel512 = 0] = texels;
        expect(Math.abs(texel512 / texel256 - 1)).toBeLessThan(0.1);
        const [requests256 = 0, requests512 = 0] = requests;
        // About a quarter of the tiles, plus the partly visible ones along the canvas edges.
        expect(requests256).toBeGreaterThanOrEqual(12);
        expect(requests512 / requests256).toBeGreaterThanOrEqual(0.2);
        expect(requests512 / requests256).toBeLessThanOrEqual(0.45);
      });
    }

    test(`@2x tiles are requested only at device pixel ratio 2 and show features at the same CSS size on ${backend} (F241)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const captures: PNG[] = [];
      for (const ratio of [1, 2]) {
        await setDeviceScale(page, ratio);
        const session = await fixtureSession(page);
        await openGlobe(page, `backend=${backend}&session=${session}&imagery=checker&imageryHiDpi=1&${VIEWS[0]}`);
        await waitForStreaming(page);
        const requests = viewRequests(await requestLog(page, session));
        expect(requests.length).toBeGreaterThan(0);
        const variants = new Set(requests.map((request) => request.path.includes('@2x.')));
        expect([...variants]).toEqual([ratio === 2]);
        captures.push(await canvasImage(page));
      }
      const [one, two] = captures;
      if (!one || !two) throw new Error('missing capture');
      expect([two.width, two.height]).toEqual([2 * one.width, 2 * one.height]);
      // The 2x capture averaged to CSS pixels shows the checkerboard where the 1x one does: same cells, same size.
      const result = compareImages(one, downscale(two, 2), SAME_BACKEND.threshold);
      console.log(`[tile-sizes] ${backend} 1x vs 2x: ${(result.ratio * 100).toFixed(3)}% differ`);
      expect(result.ratio).toBeLessThanOrEqual(0.01);
    });

    test(`the resolution scale setting switches between 1x and @2x tiles on ${backend} (F241)`, async ({ page }) => {
      test.setTimeout(120_000);
      const session = await fixtureSession(page);
      await openGlobe(page, `backend=${backend}&session=${session}&imagery=checker&imageryHiDpi=1&${VIEWS[0]}`);
      await waitForStreaming(page);
      const variants: boolean[][] = [];
      let seen = (await requestLog(page, session)).length;
      for (const scale of [2, 1]) {
        await page.evaluate((s) => window.vibeglobePlayground?.globe.setResolutionScale(s), scale);
        await waitForStreaming(page);
        const log = await requestLog(page, session);
        variants.push([...new Set(viewRequests(log.slice(seen)).map((request) => request.path.includes('@2x.')))]);
        seen = log.length;
      }
      expect(variants).toEqual([[true], [false]]);
    });
  });
}
