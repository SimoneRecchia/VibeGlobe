// M6 input track: keyboard navigation and the zoom commands on the controls harness (e2e/support/controls.html).
import { expect, test, type Page } from '@playwright/test';
import type { GeoPosition } from '@vibeglobe/core';
import {
  camera,
  frames,
  groundZoom,
  maxDrift,
  openControls,
  positionAt,
  record,
  settle,
  type RecordedFrame,
} from './support/controls.ts';

/** Holds a key for `ms` while recording frames; returns them. */
async function hold(page: Page, key: string, ms: number) {
  await record(page, []);
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await settle(page);
  return frames(page);
}

/** Per-frame rates of a camera value, per engine millisecond. */
function rates(values: number[], times: number[]): number[] {
  return values.slice(1).map((v, i) => (v - (values[i] ?? 0)) / ((times[i + 1] ?? 0) - (times[i] ?? 0)));
}

test('arrow keys pan smoothly while held, only when the map has focus (F181)', async ({ page }) => {
  // A small canvas, so a software GPU draws enough frames to see the eased start and stop.
  await openControls(page, 'lon=10&lat=20&zoom=4&size=320x240');
  await page.focus('#text');
  const outside = await camera(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await settle(page);
  expect(await camera(page)).toEqual(outside);

  await page.focus('#globe');
  for (const [key, axis, sign] of [
    ['ArrowRight', 'longitudeDeg', 1],
    ['ArrowLeft', 'longitudeDeg', -1],
    ['ArrowUp', 'latitudeDeg', 1],
    ['ArrowDown', 'latitudeDeg', -1],
  ] as const) {
    const recorded = await hold(page, key, 1200);
    const values = recorded.map((frame) => frame.camera[axis]);
    const speeds = rates(
      values,
      recorded.map((frame) => frame.timeMs),
    ).map((r) => r * sign);
    expect(speeds.every((s) => s >= -1e-12)).toBe(true);
    const peak = Math.max(...speeds);
    const peakAt = speeds.indexOf(peak);
    // An eased start and stop: the speed rises to its peak and falls back to rest.
    expect(speeds[0]).toBeLessThan(peak * 0.8);
    expect(speeds.at(-1)).toBeLessThan(peak * 0.2);
    expect(peakAt).toBeGreaterThan(0);
  }
});

test('Shift+arrows rotate and tilt smoothly while held (F187)', async ({ page }) => {
  await openControls(page, 'lon=10&lat=45&zoom=8&size=320x240');
  await page.focus('#globe');
  await page.keyboard.down('Shift');
  // Warm-up: the first frames at a new heading are slow on a software GPU, and engine time takes at most 100 ms a frame.
  await hold(page, 'ArrowLeft', 300);
  const right = await hold(page, 'ArrowRight', 1200);
  const up = await hold(page, 'ArrowUp', 800);
  await page.keyboard.up('Shift');
  const state = await camera(page);
  expect(state.headingDeg).toBeGreaterThan(10);
  expect(state.tiltDeg).toBeGreaterThan(10);
  expect(state.longitudeDeg).toBeCloseTo(10, 6);
  for (const [recorded, field] of [
    [right, 'headingDeg'],
    [up, 'tiltDeg'],
  ] as const) {
    const values = recorded.map((frame) => frame.camera[field]);
    const speeds = rates(
      values,
      recorded.map((frame) => frame.timeMs),
    );
    expect(speeds[0]).toBeLessThan(Math.max(...speeds) * 0.8);
  }
});

test('+/- keys and the zoom commands zoom one level per press about the center, accumulating (F174)', async ({
  page,
}) => {
  await openControls(page, 'lon=10&lat=45&zoom=4');
  await page.focus('#globe');
  const center = await positionAt(page, { xPx: 400, yPx: 300 });
  const start = groundZoom(await camera(page));
  await record(page, [center as GeoPosition]);
  for (let i = 0; i < 5; i++) await page.keyboard.press('+');
  await settle(page);
  const recorded = await frames(page);
  expect(groundZoom(await camera(page)) - start).toBeCloseTo(5, 6);
  expect(maxDrift(recorded, () => ({ xPx: 400, yPx: 300 }))).toBeLessThan(1);
  // Continuous motion: no single frame takes more than the five levels' first share.
  const steps = recorded.map((frame, i) =>
    Math.abs(
      groundZoom(frame.camera) - (recorded[i - 1] ? groundZoom((recorded[i - 1] as RecordedFrame).camera) : start),
    ),
  );
  expect(Math.max(...steps)).toBeLessThan(5);
  expect(steps.filter((s) => s > 0).length).toBeGreaterThan(3);

  await page.keyboard.press('-');
  await page.evaluate(() => {
    window.controlsHarness?.controls.zoomOut();
    window.controlsHarness?.controls.zoomOut();
    window.controlsHarness?.controls.zoomIn();
  });
  await settle(page);
  expect(groundZoom(await camera(page)) - start).toBeCloseTo(3, 6);
});

test('every navigation action works from the keyboard alone, with a visible focus ring (F213)', async ({ page }) => {
  await openControls(page, 'lon=10&lat=45&zoom=6');
  await page.focus('#text');
  await page.keyboard.type('+-nN');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('globe');
  expect(await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle)).not.toBe('none');
  const start = await camera(page);
  // Keys typed into the text input did not move the map.
  expect(start.zoom).toBeCloseTo(6, 9);

  await page.keyboard.press('+');
  await settle(page);
  expect(groundZoom(await camera(page)) - groundZoom(start)).toBeCloseTo(1, 6);
  await page.keyboard.press('-');
  await settle(page);
  await hold(page, 'ArrowRight', 300);
  expect((await camera(page)).longitudeDeg).toBeGreaterThan(start.longitudeDeg);
  await page.keyboard.down('Shift');
  await hold(page, 'ArrowLeft', 400);
  await hold(page, 'ArrowUp', 400);
  await page.keyboard.up('Shift');
  const turned = await camera(page);
  expect(((turned.headingDeg % 360) + 360) % 360).toBeGreaterThan(180);
  expect(turned.tiltDeg).toBeGreaterThan(0);
  await page.keyboard.press('n');
  await settle(page);
  const north = (await camera(page)).headingDeg;
  expect(Math.min(north, 360 - north)).toBeLessThan(0.02);
  expect((await camera(page)).tiltDeg).toBeCloseTo(turned.tiltDeg, 6);
});
