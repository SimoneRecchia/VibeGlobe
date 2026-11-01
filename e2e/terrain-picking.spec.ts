// Picking bare terrain (M10, F383): the position and elevation under a pixel on the fixture mountain (terrarium terrain,
// a 4,000 m peak at 6.86°E, 45.83°N) in the globe, 2D and tilted phases, at several zooms.
import { expect, test } from '@playwright/test';
import { openGlobe } from './support/globe.ts';
import { waitForStreaming } from './support/imagery.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;

// `relief`: whether the view curves draw relief there (from ground zoom 10, `DEFAULT_VIEW_CURVES`; ground zoom does not
// depend on latitude, ADR 0008: Mercator zoom 10 here is about ground zoom 10.5). Below, the surface is flat and no
// terrain loads (KB-293): the ground picked is the ellipsoid, with no terrain data.
const VIEWS = [
  { name: 'globe', mode: 'auto', relief: false, view: { longitudeDeg: 6.86, latitudeDeg: 45.83, zoom: 3 } },
  { name: '2D zoom 8', mode: '2d', relief: false, view: { longitudeDeg: 6.86, latitudeDeg: 45.83, zoom: 8 } },
  { name: '2D zoom 10', mode: '2d', relief: true, view: { longitudeDeg: 6.86, latitudeDeg: 45.83, zoom: 10 } },
  {
    name: 'tilted zoom 10',
    mode: '3d',
    relief: true,
    view: { longitudeDeg: 6.86, latitudeDeg: 45.78, zoom: 10, tiltDeg: 50 },
  },
  {
    name: 'tilted zoom 12',
    mode: '3d',
    relief: true,
    view: { longitudeDeg: 7.0, latitudeDeg: 45.75, zoom: 12, tiltDeg: 45 },
  },
] as const;

for (const backend of BACKENDS) {
  test(`picking bare terrain returns the position within a ground pixel and the terrain's elevation in every phase on ${backend} (F383)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&terrain=terrarium&lon=6.86&lat=45.83&zoom=8`);
    for (const { name, mode, relief, view } of VIEWS) {
      await page.evaluate(
        ({ mode, view }) => {
          const globe = window.vibeglobePlayground?.globe;
          globe?.setViewMode(mode);
          globe?.jumpTo(view);
        },
        { mode, view },
      );
      await page.waitForTimeout(500);
      await waitForStreaming(page);
      const results = await page.evaluate(() => {
        const globe = window.vibeglobePlayground?.globe;
        if (!globe) throw new Error('no globe');
        const deg = Math.PI / 180;
        const meters = (a: { longitudeDeg: number; latitudeDeg: number }, b: typeof a): number =>
          6_371_000 *
          Math.hypot(
            (b.longitudeDeg - a.longitudeDeg) * deg * Math.cos(a.latitudeDeg * deg),
            (b.latitudeDeg - a.latitudeDeg) * deg,
          );
        const out = [];
        // Known locations: where the frame draws each one on its terrain is clicked.
        // Positions rounded to 0.0001° near nine screen points (the terrain hides parts of tilted views over high
        // relief, so the locations are taken where the view shows ground).
        for (const xPx of [120, 240, 360])
          for (const yPx of [90, 180, 270]) {
            const near = globe.screenToGeo({ xPx, yPx });
            if (!near) continue;
            const known = {
              longitudeDeg: Math.round(near.longitudeDeg * 10_000) / 10_000,
              latitudeDeg: Math.round(near.latitudeDeg * 10_000) / 10_000,
            };
            const ground = globe.elevationAt(known);
            const at = globe.geoToScreen({ ...known, heightMeters: ground.heightMeters });
            if (!at || at.xPx < 2 || at.yPx < 2 || at.xPx > 478 || at.yPx > 358) continue;
            const picked = globe.screenToGeo(at);
            const right = globe.screenToGeo({ xPx: at.xPx + 1, yPx: at.yPx });
            const below = globe.screenToGeo({ xPx: at.xPx, yPx: at.yPx + 1 });
            if (!picked || !right || !below) {
              out.push({ error: `missed at ${at.xPx.toFixed(1)},${at.yPx.toFixed(1)}` });
              continue;
            }
            const pixelMeters = Math.max(meters(picked, right), meters(picked, below));
            out.push({
              offMeters: meters(known, picked),
              pixelMeters,
              heightError: Math.abs((picked.heightMeters ?? NaN) - ground.heightMeters),
              noData: ground.noData,
              heightMeters: ground.heightMeters,
            });
          }
        return out;
      });
      expect(results.length, name).toBeGreaterThan(3);
      for (const result of results) {
        if ('error' in result) throw new Error(`${name}: ${String(result.error)}`);
        expect(result.noData, name).toBe(!relief);
        // Within one screen pixel on the ground, and the terrain's height there within 2 m plus a pixel of 45° slope.
        expect(result.offMeters, `${name}: ${JSON.stringify(result)}`).toBeLessThanOrEqual(result.pixelMeters);
        expect(result.heightError, `${name}: ${JSON.stringify(result)}`).toBeLessThanOrEqual(2 + result.pixelMeters);
      }
      // The tilted views draw the mountain's relief, from fine terrain: the picks are on it. (The globe and the flat map
      // draw no relief, so the terrain stays coarse there and averages the peak away.)
      if (mode === '3d')
        expect(
          Math.max(...results.map((r) => ('heightMeters' in r ? (r.heightMeters ?? 0) : 0))),
          name,
        ).toBeGreaterThan(1000);
    }
  });
}
