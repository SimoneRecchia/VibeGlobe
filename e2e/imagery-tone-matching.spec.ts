// Tone matching of a source chain (F249, ADR 0044): the `smooth` fixture first, to zoom 8, and the same field darker and
// warmer (`toned`) inside Italy to zoom 18. Zoomed in across Italy's western edge, the harmonized frame matches the
// first source's own colors on both sides of the boundary, zooming through the switch shows no jump, and with
// harmonization off the second source's raw tone shows.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** Just inside Italy's western coverage edge (6° E): the boundary is about 110 pixels left of the center at zoom 10. */
const VIEW = { longitudeDeg: 6.15, latitudeDeg: 44 };
/** Mean absolute difference per channel allowed between the harmonized frame and the first source's own colors. */
const BOUNDARY_LIMIT = 6;
/** Mean absolute change per channel allowed between two frames a quarter zoom level apart. */
const JUMP_LIMIT = 6;

/** Mean absolute difference per channel between two frames. */
function meanDifference(a: PNG, b: PNG): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++) {
      sum += Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0));
      count++;
    }
  return sum / count;
}

/** Waits until no imagery tile is pending and the engine is idle. */
async function settle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = window.vibeglobePlayground?.globe.imageryStats();
          return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : 1;
        }),
      { timeout: 60_000 },
    )
    .toBe(0);
  await waitForIdle(page);
}

async function zoomTo(page: Page, zoom: number): Promise<PNG> {
  await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
  await settle(page);
  return canvasImage(page);
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`a chain's second source of another tone shows neither its boundary nor the switch, and its raw colors with harmonization off, on ${backend} (F249)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const at = `lon=${VIEW.longitudeDeg}&lat=${VIEW.latitudeDeg}&zoom=10`;
    // The first source's own colors at the final view.
    await openGlobe(page, `backend=${backend}&imagery=smooth&session=${await fixtureSession(page)}&${at}`);
    await settle(page);
    const reference = await canvasImage(page);

    await openGlobe(
      page,
      `backend=${backend}&imagery=smooth&imageryMax=8&chain=toned:18:italy&clockStepMs=16.666666666666668` +
        `&session=${await fixtureSession(page)}&lon=${VIEW.longitudeDeg}&lat=${VIEW.latitudeDeg}&zoom=7`,
    );
    await settle(page);
    // Zooming through level 8, where the second source takes over inside Italy.
    let previous = await canvasImage(page);
    let jump = 0;
    for (let zoom = 7.25; zoom <= 10; zoom += 0.25) {
      const frame = await zoomTo(page, zoom);
      jump = Math.max(jump, meanDifference(previous, frame));
      previous = frame;
    }
    const harmonized = meanDifference(previous, reference);
    await page.evaluate(() => window.vibeglobePlayground?.globe.imageryLayers.set('chain', { harmonize: false }));
    await settle(page);
    const raw = meanDifference(await canvasImage(page), reference);
    console.log(
      `[tones] ${backend}: harmonized ${harmonized.toFixed(2)}, raw ${raw.toFixed(2)}, largest step ${jump.toFixed(2)}`,
    );
    expect(harmonized).toBeLessThan(BOUNDARY_LIMIT);
    expect(jump).toBeLessThan(JUMP_LIMIT);
    // The raw tone differs from the first source by several times the limit.
    expect(raw).toBeGreaterThan(3 * BOUNDARY_LIMIT);
  });
