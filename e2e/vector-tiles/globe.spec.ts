// F441: vector tiles on the globe and through the globe-to-flat morph: no hole or black pixel inside the globe at any
// frame of a zoom from the whole globe to city level (the antimeridian and the polar caps included), vector features
// stay on the engine's projection through the morph (no jump or slide), and the same area looks the same in the
// globe, 2D and 3D phases.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { compareImages } from '../support/visual.ts';
import { BACKENDS, capture, hex, near, openVector, rgbAt, settle } from './support.ts';

test.use({ viewport: { width: 400, height: 300 } });

const LAND = hex('#efe9de');
const WATER = hex('#a8cfe0');

/**
 * A point on the fixture coast, Eurasia's edge from 8° E 44° N to 15° E 38° N, land to its north-east: its midpoint
 * in Web Mercator, where the tiles' straight edge runs.
 */
const COAST = { longitudeDeg: 11.5, latitudeDeg: 41.068387 };

async function view(page: Page, v: Record<string, number>): Promise<void> {
  await page.evaluate((target) => window.vibeglobePlayground?.globe.jumpTo(target), v);
}

/** The colors 8 px either side of the coast, perpendicular to it, at the current frame. */
async function coastSides(page: Page, image: PNG): Promise<{ land: number[]; water: number[] }> {
  const points = await page.evaluate((c) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const pxPerDeg = (512 * 2 ** globe.camera.zoom) / 360;
    // The coast runs south-east; its land side lies north-east.
    const d = 8 / pxPerDeg / Math.SQRT2;
    const land = globe.geoToScreen({ longitudeDeg: c.longitudeDeg + d, latitudeDeg: c.latitudeDeg + d });
    const water = globe.geoToScreen({ longitudeDeg: c.longitudeDeg - d, latitudeDeg: c.latitudeDeg - d });
    return { land, water };
  }, COAST);
  if (points.land === undefined || points.water === undefined) throw new Error('coast off screen');
  return {
    land: rgbAt(image, points.land.xPx, points.land.yPx),
    water: rgbAt(image, points.water.xPx, points.water.yPx),
  };
}

for (const backend of BACKENDS) {
  test(`a zoom from the globe to the city has no hole, and features stay on the projection (${backend}, F441)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openVector(page, `scenario=mvt-globe-zoom&backend=${backend}&lon=11.5&lat=41.05&zoom=1`);
    // The antimeridian and the polar caps in view first.
    for (const v of [
      { longitudeDeg: 180, latitudeDeg: 60, zoom: 1.5 },
      { longitudeDeg: -170, latitudeDeg: 85, zoom: 2.5 },
      { longitudeDeg: 30, latitudeDeg: -80, zoom: 2.5 },
    ]) {
      await view(page, v);
      await settle(page);
      const report = await page.evaluate(() => window.vibeglobePlayground?.checkFrame(16));
      expect(report?.holes, JSON.stringify(v)).toBe(0);
      expect(report?.dark, JSON.stringify(v)).toBe(0);
    }
    for (let zoom = 1; zoom <= 14; zoom += 0.25) {
      await view(page, { ...COAST, zoom });
      if (zoom % 2 === 0) await settle(page);
      const report = await page.evaluate(() => window.vibeglobePlayground?.checkFrame(16));
      expect(report?.holes, `zoom ${zoom}`).toBe(0);
      expect(report?.dark, `zoom ${zoom}`).toBe(0);
      // Through the morph (zoom 4 to 6.5) and after it, the drawn coast stays where the engine projects it. The coast
      // comes from zoom-3 tiles (no deeper fixture tiles there): one of their units spans 4 px at zoom 8, so the check
      // stops there, where the data's own precision would decide.
      if (zoom >= 3 && zoom <= 8) {
        const sides = await coastSides(page, await capture(page));
        expect(near(sides.land, LAND, 12), `land side at zoom ${zoom}: ${sides.land.join()}`).toBe(true);
        expect(near(sides.water, WATER, 12), `water side at zoom ${zoom}: ${sides.water.join()}`).toBe(true);
      }
    }
  });
}

test('the same area looks the same in the globe, 2D and 3D phases (F441)', async ({ page }) => {
  test.setTimeout(120_000);
  const city = { longitudeDeg: 9.19, latitudeDeg: 45.465, zoom: 12, headingDeg: 0 };
  await openVector(page, 'scenario=mvt-globe-zoom&backend=webgl2&zoom=12&lon=9.19&lat=45.465');
  // 2D: the default curves are flat at zoom 12, tilt 0.
  await view(page, city);
  await settle(page);
  const flat = await capture(page);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.morphFactor)).toBe(1);
  // Globe: curves that keep the globe round up to zoom 18.
  await page.evaluate(() =>
    window.vibeglobePlayground?.globe.setViewCurves({
      morph: { startGroundZoom: 18, endGroundZoom: 19 },
      tilt: { startGroundZoom: 19, endGroundZoom: 20 },
    }),
  );
  await view(page, city);
  await settle(page);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.morphFactor)).toBe(0);
  const round = await capture(page);
  const difference = compareImages(flat, round, 0.1);
  // The globe's curvature moves features by a pixel or so at the view's edges.
  expect(difference.ratio, 'globe and 2D phases differ').toBeLessThan(0.03);
  // 3D: tilted, the same features with the same colors and screen-space line widths.
  await page.evaluate(() => window.vibeglobePlayground?.globe.setViewCurves({}));
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    globe?.setViewMode('3d');
    globe?.jumpTo({ longitudeDeg: 9.19, latitudeDeg: 45.465, zoom: 12, tiltDeg: 40 });
  });
  await settle(page);
  const tilted = await capture(page);
  for (const [name, color] of [
    ['land', '#efe9de'],
    ['park', '#c8e6b0'],
    ['primary', '#fcd6a4'],
  ] as const) {
    const share = (image: PNG) => {
      let n = 0;
      for (let i = 0; i < image.data.length; i += 4)
        if (near([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0], hex(color), 10)) n++;
      return n / (image.width * image.height);
    };
    expect(share(tilted), `${name} present in 3D`).toBeGreaterThan(0);
    expect(share(flat), `${name} present in 2D`).toBeGreaterThan(0);
  }
  // Line widths are screen-space: the primary avenue across the view is as wide tilted as flat.
  const width = (image: PNG, x: number) => {
    let n = 0;
    for (let y = 0; y < image.height; y++) if (near(rgbAt(image, x, y), hex('#fcd6a4'), 10)) n++;
    return n;
  };
  const x = await page.evaluate(
    () => window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: 9.17, latitudeDeg: 45.465 })?.xPx ?? 0,
  );
  expect(Math.abs(width(tilted, x) - width(flat, flat.width * 0.2))).toBeLessThanOrEqual(2);
});
