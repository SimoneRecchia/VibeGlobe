// A model set (F627): 2,000 copies of one light turbine (`?scenario=wind-farm`) drawn instanced, the model within
// 3,000 m of the eye and a placeholder beyond, copies out of view not drawn, each copy picked.
import { expect, test, type Page } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';

declare global {
  interface Window {
    vibeglobeWindFarm?: {
      stack: { resolvePick(id: number): { feature: { id: string | number } } | undefined };
      farm: {
        setVisible(visible: boolean): void;
        getPosition(id: string): { longitudeDeg: number; latitudeDeg: number } | undefined;
      };
    };
  }
}

test.use({ viewport: { width: 640, height: 480 } });

/** The turbine's triangles and the placeholder's (an octahedron). */
const TURBINE_TRIANGLES = 84;
const PLACEHOLDER_TRIANGLES = 8;

/** Draw calls and triangles the farm adds to a frame: drawn with it shown, then hidden. */
async function farmCost(page: Page): Promise<{ drawCalls: number; triangles: number }> {
  const stats = async (visible: boolean) => {
    await page.evaluate((v) => window.vibeglobeWindFarm?.farm.setVisible(v), visible);
    await waitForIdle(page);
    return page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats() ?? { drawCalls: 0, triangles: 0 });
  };
  const shown = await stats(true);
  const hidden = await stats(false);
  await page.evaluate(() => window.vibeglobeWindFarm?.farm.setVisible(true));
  // Drawn again, so picking reads the farm as shown.
  await waitForIdle(page);
  return { drawCalls: shown.drawCalls - hidden.drawCalls, triangles: shown.triangles - hidden.triangles };
}

test('2,000 turbines: the model near the eye and placeholders beyond, a few instanced draws, none out of view (F627)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGlobe(page, 'backend=webgl2&scenario=wind-farm&lon=9.15&lat=45.25&zoom=15&tilt=60&heading=20');
  await page.waitForFunction(() => window.vibeglobeWindFarm !== undefined, undefined, { timeout: 60_000 });
  await waitForIdle(page);
  // About 1.2 km from the ground: the turbines in view drawn as the model, its three meshes and the placeholder as four
  // instanced draws whatever the number of copies.
  const near = await farmCost(page);
  console.log(`[F627] near: ${JSON.stringify(near)}`);
  expect(near.drawCalls).toBeLessThanOrEqual(4);
  expect(near.triangles).toBeGreaterThanOrEqual(10 * TURBINE_TRIANGLES);
  // A copy picks as its feature: the turbine nearest the screen center, picked at its hub.
  const picked = await page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    const farm = window.vibeglobeWindFarm;
    const position = farm?.farm.getPosition('turbine-11-24');
    const point = position && globe?.geoToScreen({ ...position, heightMeters: 60 });
    const target = globe?.layerTarget();
    if (!point || !target?.pick || !farm) return undefined;
    return farm.stack.resolvePick(await target.pick(point))?.feature.id;
  });
  expect(picked).toBe('turbine-11-24');
  // 14 km away: only placeholders, one draw, and only the copies in view (fewer than all 2,000).
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 11.5, tiltDeg: 40 }));
  const far = await farmCost(page);
  console.log(`[F627] far: ${JSON.stringify(far)}`);
  expect(far.drawCalls).toBe(1);
  expect(far.triangles % PLACEHOLDER_TRIANGLES).toBe(0);
  expect(far.triangles / PLACEHOLDER_TRIANGLES).toBeGreaterThan(100);
  expect(far.triangles / PLACEHOLDER_TRIANGLES).toBeLessThan(2000);
  // Looking elsewhere: the farm costs nothing.
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 12, latitudeDeg: 42, zoom: 13 }));
  expect(await farmCost(page)).toEqual({ drawCalls: 0, triangles: 0 });
});
