import { expect, test } from '@playwright/test';
import { nextFrame, openGlobe } from './support/globe.js';
import { fixtureSession } from './support/imagery.js';

/**
 * F103: one draw per surface tile (the documented batching factor), one shared surface pipeline, so draw calls follow
 * the drawn tiles plus the output pass and pipeline changes stay within the material variants (docs/internal/plan/quality.md).
 */

test.describe.configure({ timeout: 120_000 });

const VIEWS = [
  { name: 'orbit', view: { longitudeDeg: -30, latitudeDeg: 20, zoom: 1.5 } },
  { name: 'europe', view: { longitudeDeg: 12, latitudeDeg: 45, zoom: 4 } },
  { name: 'north-pole', view: { longitudeDeg: 0, latitudeDeg: 85, zoom: 2 } },
  { name: 'antimeridian', view: { longitudeDeg: 180, latitudeDeg: -15, zoom: 3 } },
  { name: 'city', view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 11 } },
  { name: 'horizon', view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 12, tiltDeg: 75 } },
];

for (const backend of ['webgpu', 'webgl2'] as const) {
  for (const imagery of [false, true]) {
    test(`draw calls follow the drawn tiles and pipeline changes stay within the variants on ${backend}${
      imagery ? ' with tiled imagery' : ''
    } (F103)`, async ({ page }) => {
      const session = imagery ? await fixtureSession(page) : '';
      await openGlobe(page, `backend=${backend}&debug=1${imagery ? `&imagery=levels&session=${session}` : ''}`);
      const counts: { name: string; tiles: number; draws: number; switches: number }[] = [];
      for (const { name, view } of VIEWS) {
        await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo({ tiltDeg: 0, ...v }), view);
        // Two frames: the counters then describe a frame drawn for this view (imagery may still be arriving).
        await nextFrame(page);
        await page.evaluate(() => window.vibeglobePlayground?.globe.requestRender());
        await nextFrame(page);
        const { tiles, draws, switches } = await page.evaluate(() => {
          const globe = window.vibeglobePlayground?.globe;
          const stats = globe?.rendererStats();
          return {
            tiles: globe?.surfaceStats().tiles ?? 0,
            draws: stats?.drawCalls ?? 0,
            switches: stats?.pipelineSwitches ?? 0,
          };
        });
        counts.push({ name, tiles, draws, switches });
      }
      // The overlay shows the counters.
      await expect(page.locator('.vibeglobe-debug-overlay')).toContainText(/draw calls \d+ · pipeline switches \d+/);
      console.log(JSON.stringify(counts));
      for (const { name, tiles, draws, switches } of counts) {
        // One draw per tile, plus the output pass that copies the scene to the canvas.
        expect(draws, name).toBeLessThanOrEqual(tiles + 1);
        expect(switches, name).toBeLessThanOrEqual(3);
      }
    });
  }
}
