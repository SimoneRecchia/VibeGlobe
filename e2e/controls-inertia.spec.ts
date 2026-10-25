// Inertia of a released drag (F179), moved out of controls-mouse.spec.ts: it measures the camera's speed frame by
// frame, so it runs in the measurements project with the machine to itself (KB-150).
import { expect, test } from '@playwright/test';
import { DEFAULT_CONTROLS_OPTIONS } from '@vibeglobe/controls';
import { camera, frames, openControls, record, settle } from './support/controls.ts';

test('a released drag coasts with time-based inertia, and a release after holding still does not (F179)', async ({
  page,
}) => {
  // A small canvas: software GPUs draw it fast enough for mouse events to arrive at a mouse's pace.
  await openControls(page, 'lon=10&lat=20&zoom=4&size=320x240');
  // Warm-up: the first drag frames after start-up are slow, which would bunch the fling's events together.
  await page.mouse.move(160, 120);
  await page.mouse.down();
  await page.mouse.move(170, 125, { steps: 5 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await settle(page);
  await record(page, []);
  await page.mouse.move(100, 120);
  await page.mouse.down();
  // Moves 16 ms apart, as a mouse reports them, and the release right after the last.
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(100 + 8 * i, 120);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await settle(page);
  const all = await frames(page);
  const releasedAt = all.findIndex((frame) => frame.pointer === null);
  const lon = all.map((frame) => frame.camera.longitudeDeg);
  const rate = (i: number): number =>
    ((lon[i] ?? 0) - (lon[i - 1] ?? 0)) / ((all[i]?.timeMs ?? 0) - (all[i - 1]?.timeMs ?? 1));
  const trace = JSON.stringify(
    all.map((f) => [f.timeMs.toFixed(1), f.camera.longitudeDeg.toFixed(5), f.pointer ? 1 : 0]),
  );
  expect(releasedAt, trace).toBeGreaterThan(3);
  expect(all.length - releasedAt, trace).toBeGreaterThan(3);
  // The release frame starts inertia part-way through its step; from the next frame on, inertia runs at the drag's
  // speed (the content moves east, the center west) and slows monotonically to rest within the time constant.
  const dragRate = (rate(releasedAt - 1) + rate(releasedAt - 2)) / 2;
  const first = releasedAt + 1;
  expect(rate(first), trace).toBeLessThan(0);
  // A sanity bound: that frame averages a stretch already decaying, over uneven engine steps on a software GPU; the
  // exact release velocity is the unit tests' (create-controls.test.ts, inertia).
  expect(rate(first) / dragRate, trace).toBeGreaterThan(0.4);
  expect(rate(first) / dragRate, trace).toBeLessThan(1.6);
  for (let i = first + 1; i < lon.length; i++) {
    expect(Math.abs(rate(i)), trace).toBeLessThanOrEqual(Math.abs(rate(i - 1)) + 1e-9);
  }
  // Inertia rests once under 0.1 px of motion remains (ADR 0009 §6): v0·τ·e^(−t/τ) < 0.1 px. The drag moves at most
  // 8 px per 16 ms (0.5 px/ms), so the glide ends within τ·ln(0.5 τ / 0.1) of the release, plus two engine steps.
  const tauMs = DEFAULT_CONTROLS_OPTIONS.inertia.panTauMs;
  const restMs = tauMs * Math.log((0.5 * tauMs) / 0.1) + 200;
  expect((all.at(-1)?.timeMs ?? 0) - (all[releasedAt]?.timeMs ?? 0)).toBeLessThan(restMs);
  // Along the drag's direction: an east-west drag on the equator keeps the latitude.
  expect(Math.abs((all.at(-1)?.camera.latitudeDeg ?? 0) - (all[releasedAt]?.camera.latitudeDeg ?? 0))).toBeLessThan(
    0.5,
  );

  // Held still for 200 ms before the release: no coasting.
  await page.mouse.move(100, 120);
  await page.mouse.down();
  await page.mouse.move(180, 120, { steps: 8 });
  await page.waitForTimeout(200);
  await settle(page);
  const before = await camera(page);
  await page.mouse.up();
  await settle(page);
  expect((await camera(page)).longitudeDeg).toBeCloseTo(before.longitudeDeg, 9);
});
