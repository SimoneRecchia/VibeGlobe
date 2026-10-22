// Data layers drawn by the renderer (M10, ADR 0037): points, lines and polygons in the globe, 2D and tilted phases.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const DEG = Math.PI / 180;

type Rgb = [number, number, number];

/** The views of each phase (PLAN.md, Map experience): the whole globe, the flat 2D map and a tilted 3D view. */
const PHASES = [
  { name: 'globe', view: { longitudeDeg: 10, latitudeDeg: 30, zoom: 1.5 }, mode: 'auto' },
  { name: '2D', view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 }, mode: '2d' },
  { name: 'tilted', view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5, tiltDeg: 50 }, mode: 'manual' },
] as const;

async function openScenario(page: Page, backend: string, scenario: string): Promise<void> {
  await openGlobe(page, `backend=${backend}&scenario=${scenario}`);
  await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
}

async function showPhase(page: Page, phase: (typeof PHASES)[number]): Promise<PNG> {
  await page.evaluate(({ view, mode }) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    if (mode === '2d') globe.setViewMode('2d');
    else if (mode === 'auto') globe.setViewMode('auto');
    globe.jumpTo(view);
  }, phase);
  // View transitions ease over a few frames (KB-099).
  await page.waitForTimeout(500);
  await waitForIdle(page);
  return canvasImage(page);
}

function pixel(image: PNG, xPx: number, yPx: number): Rgb {
  const x = Math.round(xPx);
  const y = Math.round(yPx);
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

/** Whether any pixel within `radius` of a point has the color `test` accepts. */
function near(image: PNG, xPx: number, yPx: number, radius: number, test: (rgb: Rgb) => boolean): boolean {
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.round(xPx) + dx;
      const y = Math.round(yPx) + dy;
      if (x >= 0 && y >= 0 && x < image.width && y < image.height && test(pixel(image, x, y))) return true;
    }
  return false;
}

const isRed = ([r, g, b]: Rgb): boolean => r > 180 && g < 90 && b < 90;
const isBlue = ([r, g, b]: Rgb): boolean => b > 150 && r < 100 && g < 130;
const isGreen = ([r, g, b]: Rgb): boolean => g > 140 && r < 120 && b < 120;

/** Screen positions of positions (degrees), undefined behind the camera or off screen. */
async function project(page: Page, positions: readonly (readonly [number, number])[]) {
  return page.evaluate((list) => {
    const globe = window.vibeglobePlayground?.globe;
    const canvas = document.querySelector('canvas');
    if (!globe || !canvas) throw new Error('no globe');
    return list.map(([lon, lat]) => {
      const point = globe.geoToScreen({ longitudeDeg: lon ?? 0, latitudeDeg: lat ?? 0 });
      return point &&
        point.xPx >= 3 &&
        point.yPx >= 3 &&
        point.xPx < canvas.clientWidth - 3 &&
        point.yPx < canvas.clientHeight - 3
        ? point
        : undefined;
    });
  }, positions);
}

/** Whether a position faces the eye of a view centered on (lon0, lat0) seen from far away (the globe phase). */
function facing(lon: number, lat: number, lon0: number, lat0: number): number {
  return (
    Math.cos(lat * DEG) * Math.cos(lat0 * DEG) * Math.cos((lon - lon0) * DEG) +
    Math.sin(lat * DEG) * Math.sin(lat0 * DEG)
  );
}

for (const backend of BACKENDS) {
  test(`points render at their projected positions in the globe, 2D and tilted phases, hidden behind the globe, on ${backend} (F351)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openScenario(page, backend, 'data-points');
    const positions = await page.evaluate(() => {
      const layer = window.vibeglobeLayers?.layers['points'];
      if (!layer) throw new Error('no layer');
      const spiral = Array.from({ length: 1000 }, (_, i) => {
        const lat = (Math.asin(-1 + (2 * (i + 0.5)) / 1000) * 180) / Math.PI;
        const lon = ((((i * 137.50776405) % 360) + 540) % 360) - 180;
        return [lon, lat] as const;
      });
      const grid = Array.from(
        { length: 100 },
        (_, i) => [9.8 + (i % 10) * 0.6, 39.2 + Math.floor(i / 10) * 0.6] as const,
      );
      return [...spiral, ...grid];
    });
    for (const phase of PHASES) {
      const image = await showPhase(page, phase);
      const screen = await project(page, positions);
      // On the globe a point is in view where it faces the eye beyond the horizon's cosine R / (R + altitude).
      const altitude = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.altitudeMeters ?? 0);
      const horizon = 6371000 / (6371000 + altitude);
      const shown = screen.filter((point, i) => {
        const [lon = 0, lat = 0] = positions[i] ?? [];
        return point && (phase.name !== 'globe' || facing(lon, lat, 10, 30) > horizon + 0.05);
      });
      expect(shown.length, phase.name).toBeGreaterThan(5);
      // Every visible point is drawn where its coordinate projects, within a pixel.
      for (const point of shown) if (point) expect(near(image, point.xPx, point.yPx, 1, isRed), phase.name).toBe(true);
      if (phase.name === 'globe') {
        // Points on the far side project inside the disk but are hidden: no red there unless a front point is close.
        const front = shown.flatMap((point) => (point ? [point] : []));
        let checked = 0;
        for (const [i, point] of screen.entries()) {
          const [lon = 0, lat = 0] = positions[i] ?? [];
          if (!point || facing(lon, lat, 10, 30) > horizon - 0.05) continue;
          if (front.some((f) => Math.hypot(f.xPx - point.xPx, f.yPx - point.yPx) < 12)) continue;
          checked++;
          expect(isRed(pixel(image, point.xPx, point.yPx))).toBe(false);
        }
        expect(checked).toBeGreaterThan(5);
      }
    }
  });

  test(`lines keep their pixel width and follow the surface, and polygons keep their holes, in every phase on ${backend} (F353, F354)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openScenario(page, backend, 'data-lines');
    // The Rome to New York line in the globe phase: points along its great circle facing the eye are drawn blue.
    const image = await showPhase(page, {
      name: 'globe',
      view: { longitudeDeg: -30, latitudeDeg: 45, zoom: 1.6 },
      mode: 'auto',
    });
    const along: [number, number][] = [];
    const a = [12.5 * DEG, 41.9 * DEG];
    const b = [-74 * DEG, 40.7 * DEG];
    const unit = ([lon = 0, lat = 0]: number[]) => [
      Math.cos(lat) * Math.cos(lon),
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat),
    ];
    const p = unit(a);
    const q = unit(b);
    const angle = Math.acos(p.reduce((sum, v, i) => sum + v * (q[i] ?? 0), 0));
    for (let f = 0.1; f <= 0.9; f += 0.1) {
      const wa = Math.sin((1 - f) * angle) / Math.sin(angle);
      const wb = Math.sin(f * angle) / Math.sin(angle);
      const [x = 0, y = 0, z = 0] = p.map((v, i) => wa * v + wb * (q[i] ?? 0));
      along.push([Math.atan2(y, x) / DEG, Math.atan2(z, Math.hypot(x, y)) / DEG]);
    }
    for (const point of await project(page, along)) {
      expect(point).toBeDefined();
      if (point) expect(near(image, point.xPx, point.yPx, 2, isBlue)).toBe(true);
    }
    // The 2 px line near Rome keeps its width at two zooms (a vertical scan across its middle).
    for (const zoom of [9, 11]) {
      const view = await showPhase(page, {
        name: '2D',
        view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom },
        mode: '2d',
      });
      const [middle] = await project(page, [[12.5, 41.9]]);
      expect(middle).toBeDefined();
      let width = 0;
      for (let dy = -10; dy <= 10; dy++) if (isBlue(pixel(view, middle?.xPx ?? 0, (middle?.yPx ?? 0) + dy))) width++;
      expect(width, `zoom ${zoom}`).toBeGreaterThanOrEqual(2);
      expect(width, `zoom ${zoom}`).toBeLessThanOrEqual(4);
    }
    await openScenario(page, backend, 'data-polygons');
    for (const phase of [
      { name: 'globe', view: { longitudeDeg: 5, latitudeDeg: 45, zoom: 3 }, mode: 'auto' },
      { name: '2D', view: { longitudeDeg: 5, latitudeDeg: 45, zoom: 4.5 }, mode: '2d' },
      { name: 'tilted', view: { longitudeDeg: 5, latitudeDeg: 45, zoom: 4.5, tiltDeg: 40 }, mode: 'manual' },
    ] as const) {
      const view = await showPhase(page, phase);
      const [hole, ring] = await project(page, [
        [5, 45],
        [1.5, 45],
      ]);
      expect(hole && !near(view, hole.xPx, hole.yPx, 2, isGreen), `${phase.name}: hole empty`).toBe(true);
      expect(ring && isGreen(pixel(view, ring.xPx, ring.yPx)), `${phase.name}: ring filled`).toBe(true);
    }
    // The continent-sized polygon on the globe: its interior shows everywhere it faces the eye (no triangle cuts
    // through the globe and hides below the surface).
    const continent = await showPhase(page, {
      name: 'globe',
      view: { longitudeDeg: 133, latitudeDeg: -25, zoom: 2 },
      mode: 'auto',
    });
    const interior: [number, number][] = [];
    for (let lon = 116; lon <= 151; lon += 5) for (let lat = -36; lat <= -14; lat += 4) interior.push([lon, lat]);
    for (const point of await project(page, interior))
      if (point) expect(isGreen(pixel(continent, point.xPx, point.yPx))).toBe(true);
  });
}

for (const backend of BACKENDS) {
  test(`picks return the point under the pointer in every phase, and hover and click events carry the feature on ${backend} (F379, F380, F384)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openScenario(page, backend, 'data-points');
    for (const phase of PHASES) {
      await showPhase(page, phase);
      // Each grid point near Rome (ids g0–g99) is picked at its projected position.
      const picks = await page.evaluate(async () => {
        const globe = window.vibeglobePlayground?.globe;
        const layers = window.vibeglobeLayers;
        if (!globe || !layers?.interaction) throw new Error('no layers');
        const results: { expected: string; picked: string | undefined }[] = [];
        for (let i = 0; i < 100; i += 7) {
          const point = globe.geoToScreen({
            longitudeDeg: 9.8 + (i % 10) * 0.6,
            latitudeDeg: 39.2 + Math.floor(i / 10) * 0.6,
          });
          if (!point || point.xPx < 0 || point.yPx < 0 || point.xPx > 480 || point.yPx > 360) continue;
          const target = globe.layerTarget();
          const id = (await target?.pick?.(point)) ?? 0;
          const hit = layers.stack.resolvePick(id);
          results.push({ expected: `g${String(i)}`, picked: hit ? String(hit.feature.id) : undefined });
        }
        return results;
      });
      expect(picks.length, phase.name).toBeGreaterThan(3);
      for (const { expected, picked } of picks) expect(picked, phase.name).toBe(expected);
    }
    // Hover and click through the pointer: enter, click and leave, once each, in order, with the feature and position.
    const events = await page.evaluate(() => {
      const layer = window.vibeglobeLayers?.layers['points'];
      const recorded: { type: string; id: string; lon: number | undefined }[] = [];
      if (!layer) throw new Error('no layer');
      for (const type of ['hover-enter', 'hover-leave', 'click'] as const)
        layer.on(type, ({ feature, position }) =>
          recorded.push({ type, id: String(feature.id), lon: position?.longitudeDeg }),
        );
      (window as unknown as { recorded: typeof recorded }).recorded = recorded;
      const globe = window.vibeglobePlayground?.globe;
      return globe?.geoToScreen({ longitudeDeg: 9.8 + 4 * 0.6, latitudeDeg: 39.2 + 4 * 0.6 });
    });
    expect(events).toBeDefined();
    const box = await page.locator('#globe').boundingBox();
    if (!box || !events) throw new Error('no canvas');
    // From and back to a corner with no feature, in single moves, so the path crosses no other point.
    await page.mouse.move(box.x + 5, box.y + box.height - 5);
    await page.mouse.move(box.x + events.xPx, box.y + events.yPx);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.move(box.x + 5, box.y + box.height - 5);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { recorded: { type: string }[] }).recorded.map((e) => e.type)),
      )
      .toEqual(['hover-enter', 'click', 'hover-leave']);
    const recorded = await page.evaluate(
      () => (window as unknown as { recorded: { id: string; lon: number }[] }).recorded,
    );
    for (const event of recorded) expect(event.id).toBe('g44');
    // Enter and click carry the position under the pointer; leave, where the pointer went.
    for (const event of recorded.slice(0, 2)) expect(event.lon).toBeCloseTo(9.8 + 4 * 0.6, 1);
  });
}
