// The playground's camera commands (M6): tilt control (F188), orientation (F191), reset to the globe (F193), home (F194).
import { expect, test, type Page } from '@playwright/test';
import { openGlobe } from './support/globe.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** The camera once the movement a command started has ended. */
async function afterCommand(page: Page, command: () => Promise<void>) {
  const ended = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const off = window.vibeglobePlayground?.globe.on('moveend', ({ outcome }) => {
          off?.();
          resolve(outcome);
        });
      }),
  );
  await command();
  expect(await ended).toBe('completed');
  return page.evaluate(() => {
    const camera = window.vibeglobePlayground?.globe.camera;
    if (!camera) throw new Error('no globe');
    return camera;
  });
}

test('the tilt control, the orientation buttons, reset to the globe and home move the camera as asked (F188, F191, F193, F194)', async ({
  page,
}) => {
  // Flights of up to 8 s of engine time, drawn frame by frame on the software GPU.
  test.setTimeout(120_000);
  await openGlobe(page, 'backend=webgl2&lon=12.5&lat=41.9&zoom=15&clockStepMs=16.666666666666668');
  await page.evaluate(() => window.vibeglobePlayground?.globe.setViewMode('2d'));
  // The tilt control (F188): from 2D it chooses the tilt (manual mode), animated, within the maximum tilt.
  // Filling a range input sets it and dispatches its change event.
  const tilted = await afterCommand(page, () => page.locator('#camera-controls input[aria-label="Tilt"]').fill('40'));
  expect(tilted.tiltDeg).toBeCloseTo(40, 6);
  expect(tilted.chosenTiltDeg).toBeCloseTo(40, 6);
  expect(tilted.viewMode).toBe('manual');
  await page.evaluate(() => window.vibeglobePlayground?.globe.setConstraints({ maxTiltDeg: 30 }));
  const capped = await afterCommand(page, () => page.evaluate(() => void window.vibeglobePlayground?.globe.tiltTo(60)));
  expect(capped.tiltDeg).toBeLessThanOrEqual(30 + 1e-6);
  await page.evaluate(() => window.vibeglobePlayground?.globe.setConstraints({}));
  // Orientation (F191): each heading, keeping center and tilt, the new heading chosen.
  for (const [label, heading] of [
    ['e', 90],
    ['s', 180],
    ['w', 270],
    ['n', 0],
  ] as const) {
    const camera = await afterCommand(page, () => page.locator(`[data-command="face-${label}"]`).click());
    const wrap = (deg: number): number => (((deg % 360) + 360) % 360) % 360;
    expect(wrap(camera.headingDeg + 1e-9)).toBeCloseTo(heading, 6);
    expect(wrap(camera.chosenHeadingDeg + 1e-9)).toBeCloseTo(heading, 6);
    expect(camera.longitudeDeg).toBeCloseTo(12.5, 6);
    expect(camera.latitudeDeg).toBeCloseTo(41.9, 6);
    expect(camera.tiltDeg).toBeCloseTo(capped.tiltDeg, 6);
  }
  // Reset to the globe (F193): the whole globe, centered on the previous center.
  const globeView = await afterCommand(page, () => page.locator('[data-command="reset-to-globe"]').click());
  expect(globeView.longitudeDeg).toBeCloseTo(12.5, 6);
  expect(globeView.latitudeDeg).toBeCloseTo(41.9, 6);
  expect(globeView.phase).toBe('globe');
  const corners = await page.evaluate(() =>
    [
      [12.5, 85],
      [12.5 + 90, 41.9],
      [12.5 - 90, 41.9],
    ].map(([lon = 0, lat = 0]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: lon, latitudeDeg: lat }),
    ),
  );
  for (const corner of corners) {
    expect(corner).toBeDefined();
    expect(corner?.xPx).toBeGreaterThanOrEqual(0);
    expect(corner?.xPx).toBeLessThanOrEqual(320);
    expect(corner?.yPx).toBeGreaterThanOrEqual(0);
    expect(corner?.yPx).toBeLessThanOrEqual(240);
  }
  // Home (F194): the start view, as no home view is configured in the playground.
  const home = await afterCommand(page, () => page.locator('[data-command="home"]').click());
  expect(home.longitudeDeg).toBeCloseTo(12.5, 9);
  expect(home.latitudeDeg).toBeCloseTo(41.9, 9);
  expect(home.zoom).toBeCloseTo(15, 6);
});

test('the +/- buttons zoom one level per press about the center, rapid presses accumulating through the globe-to-flat morph (F174)', async ({
  page,
}) => {
  await openGlobe(page, 'backend=webgl2&lon=10&lat=45&zoom=3.5');
  const start = await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const center = globe.screenToGeo({ xPx: 160, yPx: 120 });
    if (!center) throw new Error('center off the globe');
    const record = window as unknown as { zoomFrames: { zoom: number; morph: number; xPx: number; yPx: number }[] };
    record.zoomFrames = [];
    globe.on('frame', () => {
      const shown = globe.geoToScreen(center);
      record.zoomFrames.push({
        zoom: globe.camera.zoom,
        morph: globe.camera.morphFactor,
        xPx: shown?.xPx ?? Number.NaN,
        yPx: shown?.yPx ?? Number.NaN,
      });
    });
    return globe.camera.zoom;
  });
  for (let i = 0; i < 5; i++) await page.locator('[data-command="zoom-in"]').click();
  const settled = (): Promise<number> =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const globe = window.vibeglobePlayground?.globe;
          let last = Number.NaN;
          const check = (): void => {
            const zoom = globe?.camera.zoom ?? Number.NaN;
            if (zoom === last) resolve(zoom);
            else {
              last = zoom;
              setTimeout(check, 500);
            }
          };
          check();
        }),
    );
  expect((await settled()) - start).toBeCloseTo(5, 6);
  const frames = await page.evaluate(
    () => (window as unknown as { zoomFrames: { zoom: number; morph: number; xPx: number; yPx: number }[] }).zoomFrames,
  );
  // The morph is crossed on the way, the center fixed within 1 px and no frame jumps the whole way.
  expect(frames.some((frame) => frame.morph > 0.05 && frame.morph < 0.95)).toBe(true);
  for (const frame of frames) expect(Math.hypot(frame.xPx - 160, frame.yPx - 120)).toBeLessThan(1);
  const steps = frames.map((frame, i) => frame.zoom - (frames[i - 1]?.zoom ?? start));
  expect(Math.max(...steps)).toBeLessThan(2);
  expect(steps.filter((step) => step > 0).length).toBeGreaterThan(5);
  await page.locator('[data-command="zoom-out"]').click();
  await page.locator('[data-command="zoom-out"]').click();
  expect((await settled()) - start).toBeCloseTo(3, 6);
});

test('zoom is continuous and fractional: the API keeps 10.37, a trackpad pinch never snaps to integers, and the ground scale follows it (F177)', async ({
  page,
}) => {
  await openGlobe(page, 'backend=webgl2&lon=10&lat=45&zoom=9.6');
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 10.37 }));
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.zoom)).toBeCloseTo(10.37, 9);
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const record = window as unknown as { scaleFrames: { zoom: number; metersPerPx: number }[] };
    record.scaleFrames = [];
    // Ground meters per pixel at the center, from the positions one pixel apart.
    const metersPerPx = (): number => {
      const a = globe.screenToGeo({ xPx: 160, yPx: 120 });
      const b = globe.screenToGeo({ xPx: 161, yPx: 120 });
      if (!a || !b) return Number.NaN;
      const rad = Math.PI / 180;
      const dLon = (b.longitudeDeg - a.longitudeDeg) * Math.cos(a.latitudeDeg * rad);
      return Math.hypot(dLon, b.latitudeDeg - a.latitudeDeg) * rad * 6371008.8;
    };
    globe.on('frame', () => record.scaleFrames.push({ zoom: globe.camera.zoom, metersPerPx: metersPerPx() }));
  });
  // A trackpad pinch: small ctrlKey wheel deltas, one per display frame.
  await page.evaluate(async () => {
    const canvas = document.querySelector('#globe') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    for (let i = 0; i < 40; i++) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -2,
          ctrlKey: true,
          clientX: rect.left + 160,
          clientY: rect.top + 120,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });
  const frames = await page.evaluate(
    () => (window as unknown as { scaleFrames: { zoom: number; metersPerPx: number }[] }).scaleFrames,
  );
  const zooms = frames.map((frame) => frame.zoom);
  // It crosses zoom 11 in many small steps, none landing on an integer.
  expect(Math.max(...zooms)).toBeGreaterThan(11);
  expect(new Set(zooms).size).toBeGreaterThan(10);
  expect(zooms.filter((zoom) => Math.abs(zoom - Math.round(zoom)) < 1e-6)).toEqual([]);
  // The ground scale changes with the zoom in every frame, by 2^-Δzoom, also across the integer boundary.
  for (let i = 1; i < frames.length; i++) {
    const [before, after] = [frames[i - 1], frames[i]];
    if (!before || !after || after.zoom === before.zoom) continue;
    expect(after.metersPerPx / before.metersPerPx).toBeCloseTo(2 ** (before.zoom - after.zoom), 2);
  }
});

test('movement promises settle as completed, interrupted or cancelled, events carry their cause, and invalid calls reject without moving (F200)', async ({
  page,
}) => {
  await openGlobe(page, 'backend=webgl2&lon=10&lat=45&zoom=5&clockStepMs=16.666666666666668');
  const outcomes = await page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const events: string[] = [];
    globe.on('movestart', ({ cause }) => events.push(`start:${cause}`));
    globe.on('moveend', ({ cause, outcome }) => events.push(`end:${cause}:${outcome}`));
    const completed = [
      await globe.flyTo({ longitudeDeg: 12, latitudeDeg: 44, zoom: 6 }, { durationMs: 300 }),
      await globe.easeTo({ longitudeDeg: 11, latitudeDeg: 45 }, { durationMs: 300 }),
      await globe.jumpTo({ zoom: 6.5 }),
      await globe.tour([
        { target: { zoom: 6 }, movement: 'ease', durationMs: 200 },
        { target: { zoom: 5.5 }, movement: 'jump' },
      ]),
    ];
    const first = globe.flyTo({ longitudeDeg: 30, latitudeDeg: 10, zoom: 4 }, { durationMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = globe.easeTo({ zoom: 5 }, { durationMs: 200 });
    const interrupted = [await first, await second];
    const cancelled: string[] = [];
    const stopped: number[] = [];
    for (const start of [
      (signal?: AbortSignal) =>
        globe.flyTo({ longitudeDeg: 40, latitudeDeg: 0, zoom: 3 }, { durationMs: 2000, ...(signal ? { signal } : {}) }),
      (signal?: AbortSignal) =>
        globe.easeTo({ longitudeDeg: 40, latitudeDeg: 0 }, { durationMs: 2000, ...(signal ? { signal } : {}) }),
      (signal?: AbortSignal) =>
        globe.tour(
          [{ target: { longitudeDeg: 40, latitudeDeg: 0 }, movement: 'ease', durationMs: 2000 }],
          signal ? { signal } : {},
        ),
    ]) {
      for (const how of ['cancel', 'signal'] as const) {
        const controller = new AbortController();
        const movement = start(how === 'signal' ? controller.signal : undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (how === 'cancel') movement.cancel();
        else controller.abort();
        cancelled.push(await movement);
        const at = globe.camera.longitudeDeg;
        await new Promise((resolve) => setTimeout(resolve, 100));
        stopped.push(globe.camera.longitudeDeg - at);
      }
    }
    const before = globe.camera.longitudeDeg;
    const errors: string[] = [];
    for (const call of [
      () => globe.flyTo({ zoom: Number.NaN }),
      () => globe.easeTo({ latitudeDeg: 200 }),
      () => globe.jumpTo({ longitudeDeg: Number.POSITIVE_INFINITY }),
    ]) {
      try {
        await call();
        errors.push('none');
      } catch (error) {
        errors.push(`${(error as Error).name}:${(error as { code?: string }).code}`);
      }
    }
    return { completed, interrupted, cancelled, stopped, events, errors, moved: globe.camera.longitudeDeg - before };
  });
  expect(outcomes.completed).toEqual(['completed', 'completed', 'completed', 'completed']);
  expect(outcomes.interrupted).toEqual(['interrupted', 'completed']);
  expect(outcomes.cancelled).toEqual(Array(6).fill('cancelled'));
  for (const delta of outcomes.stopped) expect(delta).toBe(0);
  expect(outcomes.errors).toEqual(Array(3).fill('GlobeError:invalid-coordinate'));
  expect(outcomes.moved).toBe(0);
  expect(outcomes.events.slice(0, 2)).toEqual(['start:api', 'end:api:completed']);
  expect(outcomes.events.every((event) => event.includes(':api'))).toBe(true);
});

test('a drag released at speed is announced as user movement, then as inertia, with at most one move per frame (F200)', async ({
  page,
}) => {
  await openGlobe(page, 'backend=webgl2&lon=10&lat=45&zoom=5');
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const record = window as unknown as { moveEvents: string[] };
    record.moveEvents = [];
    globe.on('movestart', ({ cause }) => record.moveEvents.push(`start:${cause}`));
    globe.on('move', ({ cause }) => record.moveEvents.push(`move:${cause}`));
    globe.on('moveend', ({ cause }) => record.moveEvents.push(`end:${cause}`));
    globe.on('frame', () => record.moveEvents.push('frame'));
  });
  const box = await page.locator('#globe').boundingBox();
  if (!box) throw new Error('no canvas');
  // A warm-up drag: the first one after the page load meets slow frames, which the measured one should not.
  await page.mouse.move(box.x + 200, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 120, { steps: 3 });
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.evaluate(() => ((window as unknown as { moveEvents: string[] }).moveEvents = []));
  await page.mouse.move(box.x + 100, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 120, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(2000);
  const events = await page.evaluate(() => (window as unknown as { moveEvents: string[] }).moveEvents);
  const bounds = events.filter((event) => !event.startsWith('move:') && event !== 'frame');
  // User movements (a frame without a pointer move may end one, and the next move start another), then the inertia;
  // every start has its end, with the same cause.
  expect(bounds.slice(-2)).toEqual(['start:inertia', 'end:inertia']);
  const user = bounds.slice(0, -2);
  expect(user.length).toBeGreaterThan(0);
  expect(user).toEqual(user.map((_, i) => (i % 2 === 0 ? 'start:user' : 'end:user')));
  // Between two frames there is at most one move event.
  let moves = 0;
  for (const event of events) {
    if (event === 'frame') moves = 0;
    else if (event.startsWith('move:')) expect(++moves).toBe(1);
  }
});
