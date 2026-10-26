// Navigation modes: 'free' (the default, a trackball like Google Earth) and 'north-up' (north stays up, the camera
// stops at the poles), chosen with `?navigationMode=` at start and the playground's selector at runtime.
import { expect, test, type Page } from '@playwright/test';
import type { CameraState, ScreenPoint } from '@vibeglobe/core';
import { geoToScreen, nextFrame, openGlobe, screenToGeo, waitForIdle } from './support/globe.ts';

const camera = (page: Page): Promise<CameraState> =>
  page.evaluate(() => {
    const state = window.vibeglobePlayground?.globe.camera;
    if (!state) throw new Error('no globe');
    return state;
  });

/** Drags with the mouse from `from` to `to` in `steps` frames and returns the camera before the release. */
async function drag(page: Page, from: ScreenPoint, to: ScreenPoint, steps = 20): Promise<CameraState> {
  await page.mouse.move(from.xPx, from.yPx);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    await page.mouse.move(from.xPx + (to.xPx - from.xPx) * s, from.yPx + (to.yPx - from.yPx) * s);
    await nextFrame(page);
  }
  // Held still before the release: no glide afterwards.
  await page.waitForTimeout(200);
  await nextFrame(page);
  const state = await camera(page);
  await page.mouse.up();
  return state;
}

/** A point 20 px beyond the north pole, below the page's buttons, and the drag from it 160 px down. */
async function overThePole(page: Page): Promise<{ from: ScreenPoint; to: ScreenPoint }> {
  const pole = await geoToScreen(page, { longitudeDeg: 0, latitudeDeg: 90 });
  const from = { xPx: pole.xPx, yPx: pole.yPx - 20 };
  expect(from.yPx).toBeGreaterThan(80);
  return { from, to: { xPx: from.xPx, yPx: from.yPx + 160 } };
}

test.describe('navigation modes', () => {
  test.use({ viewport: { width: 480, height: 360 } });

  test("'free' turns the globe over the pole with the grabbed point under the cursor, the heading turning with it", async ({
    page,
  }) => {
    await openGlobe(page, 'backend=webgl2&lon=0&lat=88&zoom=1');
    await waitForIdle(page);
    const { from, to } = await overThePole(page);
    const grabbed = await screenToGeo(page, from);
    const state = await drag(page, from, to);
    const under = await screenToGeo(page, to);
    expect(under?.latitudeDeg).toBeCloseTo(grabbed?.latitudeDeg ?? NaN, 2);
    expect(Math.abs(Math.abs(under?.longitudeDeg ?? 0) - 180)).toBeLessThan(0.01);
    // The camera went over the pole: its target is on the far side, looking south.
    expect(Math.abs(state.longitudeDeg)).toBeGreaterThan(179);
    expect(Math.abs(Math.abs(state.headingDeg) - 180)).toBeLessThan(1);
    // The compass works as before: north up again.
    await page.locator('[data-command="face-n"]').click();
    await waitForIdle(page);
    expect(Math.abs((await camera(page)).headingDeg)).toBeLessThan(0.5);
  });

  test("'north-up' holds the heading, turns about the polar axis and stops at the pole without a flip", async ({
    page,
  }) => {
    await openGlobe(page, 'backend=webgl2&lon=0&lat=88&zoom=1');
    await page.locator('#navigation-mode').selectOption('north-up');
    await waitForIdle(page);
    const { from, to } = await overThePole(page);
    const state = await drag(page, from, to);
    expect(state.headingDeg).toBe(0);
    expect(state.latitudeDeg).toBeCloseTo(89.9, 9);
    expect(Math.abs(state.longitudeDeg)).toBeLessThan(1e-6);
    // A horizontal drag turns about the polar axis: longitude changes, latitude and heading stay.
    await openGlobe(page, 'backend=webgl2&lon=0&lat=40&zoom=3&navigationMode=north-up');
    await waitForIdle(page);
    const turned = await drag(page, { xPx: 300, yPx: 200 }, { xPx: 180, yPx: 200 });
    expect(turned.headingDeg).toBe(0);
    expect(turned.longitudeDeg).toBeGreaterThan(1);
    expect(turned.latitudeDeg).toBeCloseTo(40, 0);
  });

  test("'north-up' keeps the inertia of a flick", async ({ page }) => {
    await openGlobe(page, 'backend=webgl2&lon=0&lat=40&zoom=3&navigationMode=north-up');
    await waitForIdle(page);
    // Warm-up: the first drag frames after start-up are slow (controls-inertia.spec.ts).
    await drag(page, { xPx: 240, yPx: 200 }, { xPx: 250, yPx: 205 }, 5);
    await waitForIdle(page);
    await page.mouse.move(300, 200);
    await page.mouse.down();
    // Moves 16 ms apart and the release right after the last, not waiting for the page to handle it (KB-205).
    for (let i = 1; i < 8; i++) {
      await page.mouse.move(300 - 12 * i, 200);
      await page.waitForTimeout(16);
    }
    const last = page.mouse.move(300 - 12 * 8, 200);
    await page.waitForTimeout(16);
    await page.mouse.up();
    await last;
    await nextFrame(page);
    const released = await camera(page);
    await waitForIdle(page);
    const settled = await camera(page);
    expect(settled.longitudeDeg).toBeGreaterThan(released.longitudeDeg + 0.1);
    expect(settled.headingDeg).toBe(0);
  });
});
