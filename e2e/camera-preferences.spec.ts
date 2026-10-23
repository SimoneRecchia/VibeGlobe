// Reduced motion (F214) and the user's chosen tilt and heading (F215, F216) in the playground.
import { expect, test, type Page } from '@playwright/test';
import type { CameraState } from '@vibeglobe/core';
import { openGlobe } from './support/globe.ts';
import { Touch } from './support/controls.ts';

test.use({ viewport: { width: 480, height: 360 }, hasTouch: true });

const camera = (page: Page): Promise<CameraState> =>
  page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    return { ...globe.camera };
  });

/** Waits until the camera holds still for half a second. */
async function settle(page: Page): Promise<CameraState> {
  let last = '';
  for (;;) {
    await page.waitForTimeout(500);
    const now = await camera(page);
    const key = JSON.stringify(now);
    if (key === last) return now;
    last = key;
  }
}

/** A quick drag released at speed; returns how far the view center moved after the release, degrees of longitude. */
async function coast(page: Page): Promise<number> {
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 10, latitudeDeg: 0, zoom: 4 }));
  await page.waitForTimeout(300);
  await page.mouse.move(100, 180);
  await page.mouse.down();
  await page.mouse.move(250, 180, { steps: 5 });
  await page.mouse.up();
  const released = (await camera(page)).longitudeDeg;
  return Math.abs((await settle(page)).longitudeDeg - released);
}

test('with reduced motion a flight fades to its target, inertia is shortened, and both follow the setting at runtime (F214)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGlobe(page, 'backend=webgl2&lon=9.19&lat=45.46&zoom=12');
  const fullCoast = await coast(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The media query's change event arrives with the page's next task.
  await expect.poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.reducedMotion)).toBe(true);
  const flight = await page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    await globe.jumpTo({ longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 12 });
    const longitudes: number[] = [];
    const off = globe.on('frame', () => longitudes.push(globe.camera.longitudeDeg));
    const startMs = globe.timeMs;
    const outcome = await globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.68, zoom: 12 });
    off();
    return { outcome, longitudes, elapsedMs: globe.timeMs - startMs };
  });
  expect(flight.outcome).toBe('completed');
  // A fade: never between Milan and Tokyo, within the short fade.
  expect(flight.longitudes.filter((lon) => Math.abs(lon - 9.19) > 1e-6 && Math.abs(lon - 139.69) > 1e-6)).toEqual([]);
  expect(flight.elapsedMs).toBeLessThan(600);
  // Inertia is quartered (docs/guides/controls.md).
  const reducedCoast = await coast(page);
  expect(reducedCoast).toBeLessThan(fullCoast * 0.6);
  // Back to full motion without a reload: the flight traverses the path again.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.reducedMotion)).toBe(false);
  const traversed = await page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const longitudes: number[] = [];
    const off = globe.on('frame', () => longitudes.push(globe.camera.longitudeDeg));
    await globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.68, zoom: 12 }, { durationMs: 1500 });
    off();
    return longitudes.filter((lon) => lon > 20 && lon < 130).length;
  });
  expect(traversed).toBeGreaterThan(0);
});

/** Rotation rates of a right-drag: 180° of heading per canvas width, 90° of tilt per canvas height. */
const HEADING_PER_PX = 180 / 480;
const TILT_PER_PX = 90 / 360;

/** Right-drags by (dx, dy) pixels, centered on the canvas center, holding still before the release. */
async function rightDrag(page: Page, dx: number, dy: number): Promise<CameraState> {
  await page.mouse.move(240 - dx / 2, 180 - dy / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(240 + dx / 2, 180 + dy / 2, { steps: 10 });
  await page.waitForTimeout(400);
  await page.mouse.up({ button: 'right' });
  return settle(page);
}

const zoomTo = (page: Page, zoom: number) =>
  page.evaluate((z) => window.vibeglobePlayground?.globe.easeTo({ zoom: z }, { durationMs: 500 }), zoom);

test('a tilt chosen by hand persists at every zoom until the user tilts again or picks a view mode (F215)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGlobe(page, 'backend=webgl2&lon=9.19&lat=45.46&zoom=16&viewMode=auto');
  const before = await camera(page);
  expect(before.viewMode).toBe('auto');
  // Up by 30° minus the curve's tilt.
  const tilted = await rightDrag(page, 0, -(30 - before.tiltDeg) / TILT_PER_PX);
  expect(tilted.viewMode).toBe('manual');
  expect(tilted.chosenTiltDeg).toBeCloseTo(30, 0);
  const chosen = tilted.chosenTiltDeg;
  await zoomTo(page, 2);
  const globeView = await settle(page);
  expect(globeView.phase).toBe('globe');
  expect(globeView.chosenTiltDeg).toBeCloseTo(chosen, 6);
  await zoomTo(page, 16);
  const back = await settle(page);
  expect(back.chosenTiltDeg).toBeCloseTo(chosen, 6);
  expect(back.tiltDeg).toBeCloseTo(chosen, 6);
  const again = await rightDrag(page, 0, -15 / TILT_PER_PX);
  expect(again.chosenTiltDeg).toBeCloseTo(45, 0);
  expect(again.tiltDeg).toBeCloseTo(again.chosenTiltDeg, 6);
  for (const [mode, shows] of [
    ['2d', '2d'],
    ['3d', 'manual'],
    ['auto', 'auto'],
  ] as const) {
    await page.locator(`#view-modes button[data-mode="${mode}"]`).click();
    const state = await settle(page);
    expect(state.viewMode).toBe(shows);
    if (mode === '2d') expect(state.tiltDeg).toBeCloseTo(0, 6);
    // 3D chooses its default tilt (50°), replacing the 45° chosen by hand; Auto follows the zoom curves.
    if (mode === '3d') expect(state.chosenTiltDeg).toBeCloseTo(50, 6);
  }
});

test('a heading chosen by right-drag or a two-finger twist persists at every zoom, phase and view mode (F216)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGlobe(page, 'backend=webgl2&lon=9.19&lat=45.46&zoom=14');
  // Two drags of 60°.
  await rightDrag(page, 60 / HEADING_PER_PX, 0);
  const turned = await rightDrag(page, 60 / HEADING_PER_PX, 0);
  expect(turned.headingDeg).toBeCloseTo(120, 0);
  const checkHeld = async (heading: number) => {
    for (const step of [
      () => zoomTo(page, 2),
      () => zoomTo(page, 14),
      () => page.locator('#view-modes button[data-mode="2d"]').click(),
      () => page.locator('#view-modes button[data-mode="3d"]').click(),
      () => page.locator('#view-modes button[data-mode="auto"]').click(),
    ]) {
      await step();
      const state = await settle(page);
      expect(state.headingDeg).toBeCloseTo(heading, 6);
      expect(state.chosenHeadingDeg).toBeCloseTo(heading, 6);
    }
  };
  await checkHeld(turned.headingDeg);
  // A two-finger twist about the center chooses a new heading, which persists the same way.
  const touch = await Touch.create(page);
  const radius = 60;
  const at = (angleDeg: number) =>
    [0, 180].map((offset, k) => ({
      id: k + 1,
      x: 240 + radius * Math.cos(((angleDeg + offset) * Math.PI) / 180),
      y: 180 + radius * Math.sin(((angleDeg + offset) * Math.PI) / 180),
    }));
  await touch.start(at(0));
  for (let i = 1; i <= 12; i++) await touch.move(at(i * 5));
  await page.waitForTimeout(400);
  await touch.end();
  const twisted = await settle(page);
  expect(Math.abs(twisted.headingDeg - turned.headingDeg)).toBeGreaterThan(30);
  await checkHeld(twisted.headingDeg);
  // Only an explicit command changes it.
  await page.locator('[data-command="face-n"]').click();
  expect((await settle(page)).headingDeg % 360).toBeCloseTo(0, 6);
});
