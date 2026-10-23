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
      record.zoomFrames.push({ zoom: globe.camera.zoom, morph: globe.camera.morphFactor, ...shown });
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
