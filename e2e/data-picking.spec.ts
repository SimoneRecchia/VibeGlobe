// Picking data-layer features (M10, F384): 1,000 known positions in each of the globe, 2D, tilted and street-level
// views, and picks during a running flight, each returning the feature drawn there in that frame.
import { expect, test, type Page } from '@playwright/test';
import { nextFrame, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 960, height: 540 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const CLOCK = 'clockStepMs=16.666666666666668';

/** The features of `?scenario=data-pick` (`apps/playground/src/layers-many.ts`): id, longitude, latitude. */
function features(): [string, number, number][] {
  const list: [string, number, number][] = [];
  for (let i = 0; i < 6000; i++)
    list.push([
      `w${String(i)}`,
      ((((i * 137.50776405) % 360) + 540) % 360) - 180,
      (Math.asin(-1 + (2 * (i + 0.5)) / 6000) * 180) / Math.PI,
    ]);
  const grid = (prefix: string, west: number, south: number, step: number, columns: number, rows: number) => {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < columns; c++)
        list.push([`${prefix}${String(r * columns + c)}`, west + c * step, south + r * step]);
  };
  grid('r', 10.5, 40.9, 0.05, 60, 40);
  grid('s', 12.494, 41.9008, 0.0001, 40, 40);
  return list;
}

interface PickReport {
  readonly picked: number;
  readonly wrong: readonly string[];
}

/**
 * Picks up to `limit` features at their projected positions: those on screen, facing the eye, and at least 7 px (radius 3 plus the 3 px pick tolerance) from
 * every other feature on screen (so the expected feature is unambiguous); returns how many were picked and the mismatches.
 */
async function pickVisible(page: Page, limit: number): Promise<PickReport> {
  return page.evaluate(
    async ({ list, limit }) => {
      const globe = window.vibeglobePlayground?.globe;
      const layers = window.vibeglobeLayers;
      const target = globe?.layerTarget();
      if (!globe || !layers || !target?.pick) throw new Error('no layers');
      const deg = Math.PI / 180;
      const { longitudeDeg: lon0, latitudeDeg: lat0, phase } = globe.camera;
      const width = document.querySelector('canvas')?.clientWidth ?? 0;
      const height = document.querySelector('canvas')?.clientHeight ?? 0;
      // Every feature on screen, by 8 px cell; a feature is chosen only when no other one is within 7 px.
      const cells = new Map<string, [number, number][]>();
      const visible: [string, number, number][] = [];
      for (const [id, lon, lat] of list) {
        // On the globe, only the hemisphere facing the eye (the far side projects too, behind the globe).
        const facing =
          Math.cos(lat * deg) * Math.cos(lat0 * deg) * Math.cos((lon - lon0) * deg) +
          Math.sin(lat * deg) * Math.sin(lat0 * deg);
        if (phase === 'globe' && facing < 0.2) continue;
        const p = globe.geoToScreen({ longitudeDeg: lon, latitudeDeg: lat });
        if (!p || p.xPx < 0 || p.yPx < 0 || p.xPx > width || p.yPx > height) continue;
        const key = `${Math.floor(p.xPx / 8)},${Math.floor(p.yPx / 8)}`;
        cells.set(key, [...(cells.get(key) ?? []), [p.xPx, p.yPx]]);
        visible.push([id, p.xPx, p.yPx]);
      }
      const chosen: [string, number, number][] = [];
      for (const [id, xPx, yPx] of visible) {
        if (chosen.length >= limit) break;
        if (xPx < 8 || yPx < 8 || xPx > width - 8 || yPx > height - 8) continue;
        const cx = Math.floor(xPx / 8);
        const cy = Math.floor(yPx / 8);
        let others = 0;
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (const [x, y] of cells.get(`${cx + dx},${cy + dy}`) ?? [])
              if (Math.hypot(x - xPx, y - yPx) < 7) others++;
        // The feature itself is one of them.
        if (others === 1) chosen.push([id, xPx, yPx]);
      }
      const wrong: string[] = [];
      for (const [id, xPx, yPx] of chosen) {
        const hit = layers.stack.resolvePick(await target.pick({ xPx, yPx }));
        const got = hit ? String(hit.feature.id) : 'nothing';
        if (got !== id) wrong.push(`${id} at ${xPx.toFixed(1)},${yPx.toFixed(1)}: ${got}`);
      }
      return { picked: chosen.length, wrong };
    },
    { list: features(), limit },
  );
}

const PHASES = [
  { name: 'globe', view: { longitudeDeg: 10, latitudeDeg: 30, zoom: 2 }, mode: 'auto' },
  { name: '2D', view: { longitudeDeg: 12, latitudeDeg: 41.9, zoom: 7 }, mode: '2d' },
  { name: 'tilted', view: { longitudeDeg: 12, latitudeDeg: 41.6, zoom: 7, tiltDeg: 45 }, mode: '3d' },
  { name: 'street', view: { longitudeDeg: 12.496, latitudeDeg: 41.9028, zoom: 17 }, mode: 'auto' },
] as const;

for (const backend of BACKENDS) {
  test(`1,000 picks per phase at known positions return their features, at street level and during a flight, on ${backend} (F384)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openGlobe(page, `${CLOCK}&backend=${backend}&scenario=data-pick`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    for (const phase of PHASES) {
      await page.evaluate(({ view, mode }) => {
        const globe = window.vibeglobePlayground?.globe;
        globe?.setViewMode(mode);
        globe?.jumpTo(view);
      }, phase);
      for (let i = 0; i < 30; i++) await nextFrame(page);
      await waitForIdle(page);
      const camera = await page.evaluate(() => {
        const c = window.vibeglobePlayground?.globe.camera;
        return { phase: c?.phase, tiltDeg: c?.tiltDeg ?? 0 };
      });
      if (phase.name === 'tilted') expect(camera.tiltDeg, phase.name).toBeGreaterThan(30);
      else expect(camera.phase, phase.name).toBe({ globe: 'globe', '2D': '2d', street: '3d' }[phase.name]);
      const report = await pickVisible(page, 1000);
      console.log(
        `[picking] ${backend} ${phase.name}: ${report.picked} picks, ${report.wrong.length} wrong ${report.wrong.slice(0, 5).join('; ')}`,
      );
      expect(report.picked, phase.name).toBe(1000);
      expect(report.wrong, phase.name).toEqual([]);
    }
    // During a flight from the region to the street: every tenth frame, the picks match that frame's drawing.
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      globe?.setViewMode('auto');
      globe?.jumpTo({ longitudeDeg: 12, latitudeDeg: 41.9, zoom: 7 });
      void globe
        ?.flyTo({ longitudeDeg: 12.496, latitudeDeg: 41.9028, zoom: 17 })
        .then(() => ((window as unknown as { landed: boolean }).landed = true));
    });
    let checked = 0;
    for (let frame = 1; frame <= 300; frame++) {
      await nextFrame(page);
      if (frame % 10 !== 0) continue;
      const report = await pickVisible(page, 100);
      checked += report.picked;
      expect(report.wrong, `flight frame ${frame}`).toEqual([]);
      if (await page.evaluate(() => (window as unknown as { landed?: boolean }).landed)) break;
    }
    expect(checked).toBeGreaterThan(200);
  });
}
