// Data layers drawn by the renderer (M10, ADR 0037): points, lines and polygons in the globe, 2D and tilted phases.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import type { DataLayer, InteractionController, LayerStack } from '@vibeglobe/layers';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

declare global {
  interface Window {
    /** The playground's data scenario (`apps/playground/src/layers-demo.ts`). */
    vibeglobeLayers?: { stack: LayerStack; layers: Record<string, DataLayer>; interaction?: InteractionController };
  }
}

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

/** A view in one phase, with the view mode to set first. */
interface PhaseView {
  readonly name: string;
  readonly view: { longitudeDeg: number; latitudeDeg: number; zoom: number; tiltDeg?: number };
  readonly mode: 'auto' | '2d' | 'manual';
}

async function showPhase(page: Page, phase: PhaseView): Promise<PNG> {
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

for (const backend of BACKENDS) {
  test(`labels and marker images show at their coordinates with their anchors, colors and rotations on ${backend} (F352, F357)`, async ({
    page,
  }) => {
    await openScenario(page, backend, 'data-labels');
    const labels = await showPhase(page, {
      name: 'globe',
      view: { longitudeDeg: 25, latitudeDeg: 45, zoom: 3 },
      mode: 'auto',
    });
    const [roma, athens] = await project(page, [
      [12.5, 41.9],
      [23.7, 38.0],
    ]);
    if (!roma || !athens) throw new Error('labels out of view');
    const yellow = ([r, g, b]: Rgb): boolean => r > 200 && g > 170 && b < 90;
    const cyan = ([r, g, b]: Rgb): boolean => b > 200 && g > 180 && r < 120;
    // Centered: text on both sides of its coordinate.
    expect(near(labels, roma.xPx - 30, roma.yPx, 4, yellow)).toBe(true);
    expect(near(labels, roma.xPx + 30, roma.yPx, 4, yellow)).toBe(true);
    // Anchored left: the text starts at its coordinate and runs right.
    expect(near(labels, athens.xPx + 25, athens.yPx, 4, cyan)).toBe(true);
    expect(near(labels, athens.xPx - 15, athens.yPx, 4, cyan)).toBe(false);
    await openScenario(page, backend, 'data-markers');
    const markers = await showPhase(page, {
      name: '2D',
      view: { longitudeDeg: 13.4, latitudeDeg: 41.4, zoom: 7 },
      mode: 'auto',
    });
    const [pin, square] = await project(page, [
      [12.5, 41.9],
      [14.25, 40.85],
    ]);
    if (!pin || !square) throw new Error('markers out of view');
    // The pin is anchored at its bottom: its image lies above the coordinate.
    expect(near(markers, pin.xPx, pin.yPx - 20, 3, isRed)).toBe(true);
    expect(near(markers, pin.xPx, pin.yPx + 8, 3, isRed)).toBe(false);
    // The square, rotated 45° about its center: a diamond, blue at its center and on its axes, not in its corners.
    const blue = ([r, , b]: Rgb): boolean => b > 180 && r < 90;
    expect(blue(pixel(markers, square.xPx, square.yPx))).toBe(true);
    expect(blue(pixel(markers, square.xPx, square.yPx - 20))).toBe(true);
    expect(blue(pixel(markers, square.xPx + 15, square.yPx - 15))).toBe(false);
  });
}

for (const backend of BACKENDS) {
  test(`circles keep their ground size in meters at any latitude in the globe, 2D and tilted phases on ${backend} (F356)`, async ({
    page,
  }) => {
    await openScenario(page, backend, 'data-circles');
    const orange = ([r, g, b]: Rgb): boolean => r > 200 && g > 90 && g < 180 && b < 80;
    // 500 km around (10°, 60°): about 4.5° of latitude; inside at 1° (in every view) and 3.5°, outside at 5.5°.
    for (const phase of [
      { name: 'globe', view: { longitudeDeg: 10, latitudeDeg: 60, zoom: 2.5 }, mode: 'auto' },
      { name: '2D', view: { longitudeDeg: 10, latitudeDeg: 60, zoom: 5.2 }, mode: '2d' },
      { name: 'tilted', view: { longitudeDeg: 10, latitudeDeg: 60, zoom: 5.2, tiltDeg: 40 }, mode: 'manual' },
    ] as const) {
      const image = await showPhase(page, phase);
      const [center, near1, inside, outside] = await project(page, [
        [10, 60],
        [10, 61],
        [10, 63.5],
        [10, 65.5],
      ]);
      expect(center && orange(pixel(image, center.xPx, center.yPx)), `${phase.name}: center`).toBe(true);
      expect(near1 && orange(pixel(image, near1.xPx, near1.yPx)), `${phase.name}: 1° in`).toBe(true);
      if (inside) expect(orange(pixel(image, inside.xPx, inside.yPx)), `${phase.name}: inside`).toBe(true);
      if (outside) expect(orange(pixel(image, outside.xPx, outside.yPx)), `${phase.name}: outside`).toBe(false);
    }
  });
}

for (const backend of BACKENDS) {
  test(`extrusions are shaded volumes at their heights, and points at absolute altitudes draw where those project, on ${backend} (F355, F362)`, async ({
    page,
  }) => {
    await openScenario(page, backend, 'data-extrusions');
    const view = { longitudeDeg: 12.4975, latitudeDeg: 41.889, zoom: 13.3, tiltDeg: 35 };
    const image = await showPhase(page, { name: 'tilted', view, mode: 'manual' });
    const tan = ([r, g, b]: Rgb): number => (r > 120 && r > b + 20 && g > b ? r + g + b : -1);
    // Each block's roof shows at its height; a wall below the roof is darker than the roof.
    const roofs = await page.evaluate(() =>
      [
        [12.4925, 41.8925, 100],
        [12.4975, 41.8925, 300],
        [12.5025, 41.8925, 400],
      ].map(([lon = 0, lat = 0, h = 0]) =>
        window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: lon, latitudeDeg: lat, heightMeters: h }),
      ),
    );
    for (const roof of roofs) {
      expect(roof).toBeDefined();
      if (roof) expect(tan(pixel(image, roof.xPx, roof.yPx))).toBeGreaterThan(0);
    }
    const [wall] = await page.evaluate(() => [
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: 12.4975, latitudeDeg: 41.89, heightMeters: 150 }),
    ]);
    const high = roofs[1];
    if (wall && high) expect(tan(pixel(image, wall.xPx, wall.yPx))).toBeLessThan(tan(pixel(image, high.xPx, high.yPx)));
    await openScenario(page, backend, 'data-altitudes');
    for (const phase of [
      { name: 'globe', view: { longitudeDeg: 12.55, latitudeDeg: 41.9, zoom: 4 }, mode: 'auto' },
      { name: 'tilted', view: { longitudeDeg: 12.55, latitudeDeg: 41.85, zoom: 10, tiltDeg: 60 }, mode: 'manual' },
    ] as const) {
      const shot = await showPhase(page, phase);
      const points = await page.evaluate(() =>
        [0, 1000, 10_000].map((h, i) =>
          window.vibeglobePlayground?.globe.geoToScreen({
            longitudeDeg: 12.5 + i * 0.05,
            latitudeDeg: 41.9,
            heightMeters: h,
          }),
        ),
      );
      const inView = points.filter(
        (p) => p && p.xPx > 2 && p.yPx > 2 && p.xPx < shot.width - 2 && p.yPx < shot.height - 2,
      );
      expect(inView.length, phase.name).toBeGreaterThanOrEqual(2);
      for (const point of inView) if (point) expect(near(shot, point.xPx, point.yPx, 1, isRed), phase.name).toBe(true);
    }
  });
}

for (const backend of BACKENDS) {
  test(`ground-clamped points sit on the terrain once it has loaded, in the tilted view on ${backend} (F363)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(
      page,
      `backend=${backend}&terrain=terrarium&scenario=data-clamped&lon=6.86&lat=45.78&zoom=9.8&tilt=45`,
    );
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    // Every terrain tile settled, then one more frame: the points were placed again on the finest terrain.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const stats = window.vibeglobePlayground?.globe.terrainStats();
            return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : -1;
          }),
        { timeout: 90_000 },
      )
      .toBe(0);
    await page.waitForTimeout(300);
    await waitForIdle(page);
    const image = await canvasImage(page);
    const points = await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      return Array.from({ length: 100 }, (_, i) => {
        const position = { longitudeDeg: 6.61 + (i % 10) * 0.05, latitudeDeg: 45.6 + Math.floor(i / 10) * 0.05 };
        const ground = globe.elevationAt(position).heightMeters;
        return { ground, screen: globe.geoToScreen({ ...position, heightMeters: ground }) };
      });
    });
    const inView = points.filter(
      ({ screen }) => screen && screen.xPx > 3 && screen.yPx > 3 && screen.xPx < 477 && screen.yPx < 357,
    );
    expect(inView.length).toBeGreaterThan(20);
    // Some of them stand high on the mountain: on the ellipsoid they would draw far from these positions.
    expect(Math.max(...inView.map((p) => p.ground))).toBeGreaterThan(2000);
    for (const { screen } of inView) if (screen) expect(near(image, screen.xPx, screen.yPx, 1, isRed)).toBe(true);
  });
}

/** Waits until no terrain tile is queued, loading, decoding or waiting for its upload, then for an idle frame. */
async function waitForTerrain(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = window.vibeglobePlayground?.globe.terrainStats();
          return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : -1;
        }),
      { timeout: 90_000 },
    )
    .toBe(0);
  await page.waitForTimeout(300);
  await waitForIdle(page);
}

/** Screen positions of positions (degrees) at the height of the terrain under them, inside the canvas only. */
async function onTerrain(page: Page, positions: readonly (readonly [number, number])[]) {
  return page.evaluate((list) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    return list.flatMap(([lon = 0, lat = 0]) => {
      const position = { longitudeDeg: lon, latitudeDeg: lat };
      const point = globe.geoToScreen({ ...position, heightMeters: globe.elevationAt(position).heightMeters });
      return point && point.xPx > 3 && point.yPx > 3 && point.xPx < 477 && point.yPx < 357 ? [point] : [];
    });
  }, positions);
}

for (const backend of BACKENDS) {
  test(`lines and polygons draped over the fixture peak follow its relief in the tilted view on ${backend} (F364, F365)`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const view = 'lon=6.86&lat=45.7&zoom=10&tilt=55';
    await openGlobe(page, `backend=${backend}&terrain=terrarium&scenario=draped-lines&${view}`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await waitForTerrain(page);
    const line = await canvasImage(page);
    const along: [number, number][] = [];
    for (let lon = 6.55; lon <= 7.15; lon += 0.04) along.push([lon, 45.83]);
    const lineScreen = await onTerrain(page, along);
    expect(lineScreen.length).toBeGreaterThan(8);
    for (const point of lineScreen) expect(near(line, point.xPx, point.yPx, 2, isBlue)).toBe(true);
    // From higher up: at 55° the peak hides part of its far slope.
    await openGlobe(
      page,
      `backend=${backend}&terrain=terrarium&scenario=draped-polygons&lon=6.86&lat=45.8&zoom=10&tilt=25`,
    );
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await waitForTerrain(page);
    const fill = await canvasImage(page);
    const inside: [number, number][] = [];
    for (let lon = 6.73; lon <= 6.97; lon += 0.04)
      for (let lat = 45.75; lat <= 45.92; lat += 0.04) inside.push([lon, lat]);
    const fillScreen = await onTerrain(page, inside);
    expect(fillScreen.length).toBeGreaterThan(10);
    for (const point of fillScreen) expect(near(fill, point.xPx, point.yPx, 1, isGreen)).toBe(true);
  });
}

for (const backend of BACKENDS) {
  test(`glTF models stand at their coordinates, turned by their heading on the local axes, and a corrupt file is rejected on ${backend} (F361)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&scenario=data-models&lon=12.5&lat=41.88&zoom=11.5&tilt=40`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await page.waitForTimeout(300);
    await waitForIdle(page);
    const image = await canvasImage(page);
    const red = ([r, g, b]: Rgb): boolean => r > 90 && r > 2.5 * g && r > 2.5 * b;
    // The fixture pyramid, scaled 500: its apex 500 m up, its nose 1,500 m ahead (−Z) and 100 m up.
    const metersNorth = 1500 / 111_320;
    const metersEast = 1500 / (111_320 * Math.cos(41.9 * DEG));
    const points = await page.evaluate(
      ([north, east]) => {
        const globe = window.vibeglobePlayground?.globe;
        if (!globe) throw new Error('no globe');
        const at = (lon: number, lat: number, h: number) =>
          globe.geoToScreen({ longitudeDeg: lon, latitudeDeg: lat, heightMeters: h });
        return {
          apex: at(12.45, 41.9, 500),
          noseNorth: at(12.45, 41.9 + (north ?? 0) * 0.7, 100),
          turnedNoseEast: at(12.55 + (east ?? 0) * 0.7, 41.9, 100),
          turnedNotNorth: at(12.55, 41.9 + (north ?? 0) * 0.7, 100),
        };
      },
      [metersNorth, metersEast] as const,
    );
    for (const name of ['apex', 'noseNorth', 'turnedNoseEast'] as const) {
      const point = points[name];
      expect(point, name).toBeDefined();
      if (point) expect(near(image, point.xPx, point.yPx, 2, red), name).toBe(true);
    }
    const notNorth = points.turnedNotNorth;
    if (notNorth) expect(near(image, notNorth.xPx, notNorth.yPx, 2, red)).toBe(false);
    // A truncated file: the promise rejects with a typed error, and the view keeps drawing.
    const error = await page.evaluate(async () => {
      const globe = window.vibeglobePlayground?.globe;
      try {
        await globe?.addModel({
          data: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]).buffer,
          position: { longitudeDeg: 0, latitudeDeg: 0 },
        });
        return 'resolved';
      } catch (caught) {
        return (caught as { code?: string }).code ?? 'untyped';
      }
    });
    expect(error).toBe('invalid-option');
    await waitForIdle(page);
  });
}
