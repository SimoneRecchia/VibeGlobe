// Copernicus DEM GLO-30 terrain in the playground (F339): the test-mont-blanc configuration's terrain, built from the
// public AWS Open Data bucket when its output is missing (`vibeglobe-data build test-mont-blanc.json --dataset
// terrain`; about 140 MB downloaded once, resumed and checksummed), is loaded through the engine's Terrarium adapter.
// VIBEGLOBE_TOOLS_DEM=<folder> uses another build's folder.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { runBuild } from '../pipeline/build.js';

const CONFIG = join(import.meta.dirname, '../../configs/test-mont-blanc.json');
const FOLDER =
  process.env['VIBEGLOBE_TOOLS_DEM'] ?? join(import.meta.dirname, '../../node_modules/.vibeglobe-data/test-mont-blanc');
const OUTPUT = join(FOLDER, 'output', 'terrain');
/** Mont Blanc's summit, 4,806 m above the geoid (2021 survey; the 30 m DEM's cell holds a little less). */
const SUMMIT = { longitudeDeg: 6.86515, latitudeDeg: 45.83265 };
/** A view well inside the built area (6.68° to 7.03° E, 45.83° to 46.07° N), the Mer de Glace and Aiguilles below. */
const INSIDE = { longitudeDeg: 6.86, latitudeDeg: 45.95, zoom: 13, tiltDeg: 45 };
/** The playground page background behind its transparent canvas. */
const BACKGROUND = [11, 16, 32];
/** Full relief at every zoom (it rises from ground zoom 10 by default, F154). */
const FULL_RELIEF = encodeURIComponent(JSON.stringify({ relief: { startGroundZoom: -2, endGroundZoom: -1 } }));

test.beforeAll(async () => {
  test.setTimeout(1_200_000);
  if (existsSync(join(OUTPUT, 'metadata.json'))) return;
  await runBuild({
    configPath: CONFIG,
    outDir: FOLDER,
    sample: false,
    yes: true,
    interactive: false,
    until: 'package',
    datasets: ['terrain'],
    fetch,
    ask: () => Promise.resolve(false),
    report: () => undefined,
  });
});

/** Answers the playground's fixture Terrarium terrain from the build's static folder (404 outside it). */
async function serveTerrain(page: Page): Promise<string[]> {
  const served: string[] = [];
  await page.route('**/fixture-tiles/**/terrain/mercator/*/*/*.terrarium.png', async (route) => {
    const [, z, x, y] = /mercator\/(\d+)\/(\d+)\/(\d+)\.terrarium\.png$/.exec(route.request().url()) ?? [];
    const file = join(OUTPUT, String(z), String(x), `${String(y)}.png`);
    if (!existsSync(file)) return route.fulfill({ status: 404 });
    served.push(`${String(z)}/${String(x)}/${String(y)}`);
    return route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(file) });
  });
  return served;
}

/** Waits until no imagery or terrain tile is waiting, loading or decoding, and the frame has settled. */
async function settle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          type Busy = { queued: number; loading: number; decoding: number; uploadsPending: number } | undefined;
          const globe = (
            globalThis as unknown as { vibeglobePlayground?: { globe: { imageryStats(): Busy; terrainStats(): Busy } } }
          ).vibeglobePlayground?.globe;
          if (!globe) return -1;
          return [globe.imageryStats(), globe.terrainStats()].reduce(
            (n, s) => n + (s ? s.queued + s.loading + s.decoding + s.uploadsPending : 0),
            0,
          );
        }),
      { timeout: 60_000 },
    )
    .toBe(0);
  await page.waitForTimeout(600);
}

/**
 * Background-colored or black pixels between 50% and 90% of the frame's height: on the terrain at this tilt, below the
 * playground's controls and above its credit line.
 */
async function holes(page: Page): Promise<number> {
  const shot = await page.locator('canvas').first().screenshot();
  const { PNG } = await import('pngjs');
  const image = PNG.sync.read(shot);
  let count = 0;
  for (let y = Math.floor(image.height * 0.5); y < Math.floor(image.height * 0.9); y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const [r = 0, g = 0, b = 0] = [image.data[i], image.data[i + 1], image.data[i + 2]];
      const background =
        Math.abs(r - (BACKGROUND[0] ?? 0)) + Math.abs(g - (BACKGROUND[1] ?? 0)) + Math.abs(b - (BACKGROUND[2] ?? 0)) <
        12;
      if (background || r + g + b < 15) count++;
    }
  return count;
}

test('the output carries the Copernicus DEM notice with the modification statement (F339)', () => {
  const metadata = JSON.parse(readFileSync(join(OUTPUT, 'metadata.json'), 'utf8')) as {
    attribution: string;
    sources: { url: string }[];
    encoding: string;
  };
  expect(metadata.attribution).toMatch(/^produced using Copernicus WorldDEM-30 © DLR e\.V\. 2010-2014 and © Airbus/);
  expect(metadata.sources[0]?.url).toBe('https://registry.opendata.aws/copernicus-dem/');
  expect(metadata.encoding).toBe('terrarium');
});

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`Copernicus DEM terrain shows Mont Blanc's relief with no cracks through the terrain adapter on ${backend} (F339)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 320 });
    const served = await serveTerrain(page);
    await page.goto(
      `/?backend=${backend}&imagery=world&terrain=terrarium&terrainMax=13&session=copernicus&lon=${SUMMIT.longitudeDeg}&lat=${SUMMIT.latitudeDeg}&zoom=12&tilt=45&curves=${FULL_RELIEF}`,
    );
    // Settled once the terrain has started streaming: its counters read zero before the first frame.
    await page.waitForFunction(
      () =>
        ((
          globalThis as unknown as {
            vibeglobePlayground?: { globe: { terrainStats(): { requested: number } | undefined } };
          }
        ).vibeglobePlayground?.globe.terrainStats()?.requested ?? 0) > 0,
    );
    await settle(page);
    expect(served.length, 'terrain tiles of the build').toBeGreaterThan(0);
    const summit = await page.evaluate(
      (p) =>
        (
          globalThis as unknown as {
            vibeglobePlayground: { globe: { elevationAt(p: object): { heightMeters: number; noData: boolean } } };
          }
        ).vibeglobePlayground.globe.elevationAt(p),
      SUMMIT,
    );
    console.log(`[dem] ${backend}: summit ${summit.heightMeters.toFixed(0)} m from ${String(served.length)} tiles`);
    expect(summit.noData).toBe(false);
    expect(summit.heightMeters).toBeGreaterThan(4700);
    expect(summit.heightMeters).toBeLessThan(4850);
    // An orbit inside the built area (Mont Blanc lies on its southern edge, beyond which this source has no data): no
    // background or black pixel shows through the relief.
    for (const headingDeg of [0, 60, 120, 180, 240, 300]) {
      await page.evaluate(
        (view) =>
          (
            globalThis as unknown as { vibeglobePlayground: { globe: { jumpTo(v: object): void } } }
          ).vibeglobePlayground.globe.jumpTo(view),
        { ...INSIDE, headingDeg },
      );
      await settle(page);
      expect(await holes(page), `heading ${String(headingDeg)}`).toBe(0);
    }
  });
