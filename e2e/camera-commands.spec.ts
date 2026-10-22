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
