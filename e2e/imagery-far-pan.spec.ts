// Panning from far away stays sharp (KB-218): at 3000 km above the ground, once a lap around the world has been seen,
// every tile of a second lap shows its own imagery level, not a blurrier ancestor's. The layer is the Europe preset's
// shape: a chain whose first source starts at level 5 (the offline package) over a world source below it (NASA's Blue
// Marble), so the world source's low levels are the base that must stay in memory.
import { expect, test, type Page } from '@playwright/test';
import { nextFrame, openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession } from './support/imagery.ts';

test.use({ viewport: { width: 480, height: 360 } });

/** Tiles drawn from an imagery level coarser than their own. */
async function blurryTiles(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).filter(
        (t) => t.imageryLevel !== null && t.imageryLevel < Math.min(t.level, 18),
      ).length,
  );
}

/** One lap of `steps` frames around the world at a latitude and zoom; the blurry tiles of each frame. */
async function lap(page: Page, zoom: number, steps: number): Promise<number[]> {
  const blurry: number[] = [];
  for (let i = 1; i <= steps; i++) {
    await page.evaluate(
      ([longitudeDeg, z]) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg, latitudeDeg: 40, zoom: z }),
      [(((i * 360) / steps + 180) % 360) - 180, zoom] as const,
    );
    await nextFrame(page);
    blurry.push(await blurryTiles(page));
  }
  return blurry;
}

test('a second lap around the world at 3000 km shows every tile at its own level, none blurry (KB-218)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openGlobe(page, 'backend=webgl2&imagery=world&imageryMin=5&chain=levels:7&lon=0&lat=40&zoom=3');
  await waitForIdle(page);
  // The zoom that puts the camera 3000 km above the ground.
  const zoom = await page.evaluate(() => {
    const camera = window.vibeglobePlayground?.globe.camera;
    return (camera?.zoom ?? 3) + Math.log2((camera?.altitudeMeters ?? 3e6) / 3e6);
  });
  await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
  await waitForIdle(page);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters ?? 0)).toBeGreaterThan(
    2.9e6,
  );
  // The first lap may wait for tiles; the camera then rests, and the second lap must find them all in memory.
  await lap(page, zoom, 72);
  await waitForIdle(page);
  const second = await lap(page, zoom, 72);
  console.log(`[KB-218] blurry tiles per frame of the second lap: max ${String(Math.max(...second))}`);
  expect(second.filter((n) => n > 0)).toEqual([]);
});

test("a chain whose first source starts deeper pins its world source's low levels: any far view is sharp at once (KB-218)", async ({
  page,
}) => {
  // Every tile but the world's first takes 600 ms, as from a slow online server: only pinned tiles show at once.
  const session = await fixtureSession(page, [{ minLevel: 1, latencyMs: 600 }]);
  await openGlobe(
    page,
    `backend=webgl2&imagery=world&imageryMin=5&chain=levels:7&session=${session}&lon=0&lat=40&zoom=2`,
  );
  await waitForIdle(page);
  // The other side of the world, never seen: its tiles show the pinned levels (to 2 at least) in the next frames.
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 180, latitudeDeg: -20, zoom: 2 }));
  await nextFrame(page);
  await nextFrame(page);
  const tiles = await page.evaluate(() =>
    (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).map((t) => [t.level, t.imageryLevel ?? -1]),
  );
  expect(tiles.length).toBeGreaterThan(0);
  expect(tiles.filter(([level = 0, imagery = -1]) => imagery < Math.min(level, 2))).toEqual([]);
});
