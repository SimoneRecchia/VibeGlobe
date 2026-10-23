import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe } from './support/globe.ts';
import { fixtureSession, waitForStreaming } from './support/imagery.ts';
import { SOLID_COLORS, worldColor } from '../scripts/fixtures/tiles/generate.ts';

/**
 * Tile image formats (F242): the same fixture pyramid as PNG, JPEG, WebP and AVIF renders alike; transparent PNG and
 * WebP areas show the layer below; AVIF tiles that cannot be decoded fall back to their parents.
 */
const BACKENDS = ['webgpu', 'webgl2'] as const;
const VIEW = 'viewMode=2d&lon=10&lat=50&zoom=6.4';
/** Mean difference per channel from the PNG frame each lossy format may show (JPEG and WebP at 90, AVIF at 80). */
const TOLERANCE: Record<string, number> = { jpg: 2, webp: 2, avif: 3 };

test.use({ viewport: { width: 320, height: 240 } });

async function frameOf(page: Page, query: string, rules: unknown[] = []): Promise<PNG> {
  const session = await fixtureSession(page, rules);
  await openGlobe(page, `session=${session}&${query}`);
  await waitForStreaming(page);
  return canvasImage(page);
}

function meanDifference(a: PNG, b: PNG): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++) sum += Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0));
  return sum / (3 * a.width * a.height);
}

/** Pixels whose channels are all near zero: no fixture tile, background or layer is that dark. */
function blackPixels(image: PNG): number {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if ((image.data[i] ?? 0) <= 8 && (image.data[i + 1] ?? 0) <= 8 && (image.data[i + 2] ?? 0) <= 8) count++;
  return count;
}

/** Whether a position falls in a transparent cell of the `holes` pattern (256 × 256 cells over the Mercator world). */
function inHole(lonDeg: number, latDeg: number): boolean {
  const lat = (latDeg * Math.PI) / 180;
  const mx = (lonDeg + 180) / 360;
  const my = (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2;
  return (Math.floor(mx * 256) + Math.floor(my * 256)) % 2 === 0;
}

for (const backend of BACKENDS) {
  test.describe(backend, () => {
    test(`PNG, JPEG, WebP and AVIF tiles render alike on ${backend} (F242)`, async ({ page }) => {
      test.setTimeout(180_000);
      const reference = await frameOf(page, `backend=${backend}&imagery=smooth&${VIEW}`);
      for (const format of ['jpg', 'webp', 'avif']) {
        const frame = await frameOf(page, `backend=${backend}&imagery=smooth&imageryFormat=${format}&${VIEW}`);
        const difference = meanDifference(reference, frame);
        console.log(`[formats] ${backend} ${format}: mean difference ${difference.toFixed(2)}`);
        expect(difference).toBeLessThanOrEqual(TOLERANCE[format] ?? 0);
        expect(blackPixels(frame)).toBe(0);
      }
    });

    test(`transparent PNG and WebP areas show the layer below on ${backend} (F242)`, async ({ page }) => {
      test.setTimeout(120_000);
      for (const format of ['png', 'webp']) {
        const image = await frameOf(
          page,
          `backend=${backend}&imagery=red&overlays=holes&overlayFormat=${format}&${VIEW}`,
        );
        const samples = await page.evaluate(() => {
          const points = [];
          for (let y = 6; y < 240; y += 12)
            for (let x = 6; x < 320; x += 12)
              points.push({
                x,
                y,
                // The sample and four points 2 px around it, to leave out samples on a cell edge.
                geos: [
                  [0, 0],
                  [-2, 0],
                  [2, 0],
                  [0, -2],
                  [0, 2],
                ].map(([dx = 0, dy = 0]) =>
                  window.vibeglobePlayground?.globe.screenToGeo({ xPx: x + dx, yPx: y + dy }),
                ),
              });
          return points;
        });
        let matching = 0;
        let inside = 0;
        for (const { x, y, geos } of samples) {
          const [geo] = geos;
          if (
            !geo ||
            geos.some((g) => !g || inHole(g.longitudeDeg, g.latitudeDeg) !== inHole(geo.longitudeDeg, geo.latitudeDeg))
          )
            continue;
          inside++;
          const i = (y * image.width + x) * 4;
          const shown = [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
          const expected = inHole(geo.longitudeDeg, geo.latitudeDeg)
            ? (SOLID_COLORS['red'] ?? [0, 0, 0])
            : worldColor((geo.longitudeDeg * Math.PI) / 180, (geo.latitudeDeg * Math.PI) / 180);
          if (shown.every((value, c) => Math.abs(value - (expected[c] ?? 0)) <= 12)) matching++;
        }
        console.log(`[formats] ${backend} ${format} holes: ${matching}/${inside} samples as expected`);
        // Away from cell edges, the layer below shows in every hole and the overlay everywhere else.
        expect(inside).toBeGreaterThan(400);
        expect(matching).toBe(inside);
      }
    });

    test(`AVIF tiles that cannot be decoded fall back to their parents without black pixels on ${backend} (F242)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });
      // Tiles from level 6 on arrive as bytes no decoder reads, labeled AVIF.
      const image = await frameOf(page, `backend=${backend}&imagery=world&imageryFormat=avif&${VIEW}`, [
        { minLevel: 6, randomBytes: 2048, contentType: 'image/avif' },
      ]);
      expect(blackPixels(image)).toBe(0);
      const levels = await page.evaluate(() =>
        (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).map((tile) => [tile.level, tile.imageryLevel]),
      );
      expect(levels.some(([level]) => (level ?? 0) >= 6)).toBe(true);
      expect(levels.every(([level, imagery]) => imagery !== null && (imagery ?? 0) <= Math.min(5, level ?? 0))).toBe(
        true,
      );
      expect(warnings.some((text) => text.includes('fixture-world: tile'))).toBe(true);
    });
  });
}
