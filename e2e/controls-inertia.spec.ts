// Inertia of a released drag (F179), moved out of controls-mouse.spec.ts: it measures the camera's speed frame by
// frame, so it runs in the measurements project with the machine to itself (KB-150).
import { expect, test } from '@playwright/test';
import { DEFAULT_CONTROLS_OPTIONS } from '@vibeglobe/controls';
import { camera, frames, openControls, positionAt, record, settle } from './support/controls.ts';

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
  // The drag's speed over the whole drag: on a software GPU the moves arrive one per frame, so the camera's rate over
  // one or two frame intervals swings with their length (a 33 ms frame showing a whole 100 ms step).
  const dragStart = all.findIndex((frame) => frame.pointer !== null);
  const dragRate =
    ((lon[releasedAt - 1] ?? 0) - (lon[dragStart] ?? 0)) /
    ((all[releasedAt - 1]?.timeMs ?? 0) - (all[dragStart]?.timeMs ?? 1));
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

/**
 * Plays a flick in the page with real timing (KB-202): pointer events every `eventMs` from `fromX` along the canvas's
 * middle row, at `speed(t)` px/ms, then the lift `liftAfterMs` after the last move.
 */
async function flick(
  page: import('@playwright/test').Page,
  fromX: number,
  y: number,
  durationMs: number,
  eventMs: number,
  speed: string,
  liftAfterMs: number,
): Promise<void> {
  await page.evaluate(
    async ([fromXPx, yPx, duration, interval, speedSource, lift]) => {
      const canvas = document.querySelector('#globe')?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const target = document.elementFromPoint(canvas.left + fromXPx, canvas.top + yPx);
      const speedAt = new Function('t', `return ${speedSource};`) as (t: number) => number;
      const fire = (type: string, x: number): void =>
        void target?.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: canvas.left + x,
            clientY: canvas.top + yPx,
            bubbles: true,
            cancelable: true,
          }),
        );
      const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
      fire('pointerdown', fromXPx);
      const start = performance.now();
      let x = fromXPx;
      let last = start;
      while (performance.now() - start < duration) {
        await wait(interval);
        const now = performance.now();
        x += speedAt(now - start) * (now - last);
        last = now;
        fire('pointermove', x);
      }
      await wait(lift);
      fire('pointerup', x);
    },
    [fromX, y, durationMs, eventMs, speed, liftAfterMs] as const,
  );
}

for (const [eventMs, label] of [
  [1000 / 120, '120 Hz'],
  [1000 / 60, '60 Hz'],
] as const) {
  test(`flicks on a zoomed-out globe glide on past its edge and slow down smoothly to rest, never reversing, at ${label} (KB-202)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // The whole globe in a 480 × 360 canvas, surrounded by space; its radius is under 150 px.
    await openControls(page, 'lon=0&lat=0&zoom=0.3&size=480x360');
    for (const [name, fromX, durationMs, speed, liftMs] of [
      ['fast flick', 200, 120, '1.5 * Math.min(1, t / 40)', 2],
      [
        'flick slowing before the lift',
        190,
        140,
        't < 90 ? 1.5 * Math.min(1, t / 40) : 1.5 - (1.1 * (t - 90)) / 50',
        10,
      ],
      ['gentle flick', 230, 200, '0.3 * Math.min(1, t / 40)', 4],
    ] as const) {
      await settle(page);
      await record(page, []);
      await flick(page, fromX, 180, durationMs, eventMs, speed, liftMs);
      await settle(page);
      const all = await frames(page);
      const releasedAt = all.findIndex((frame, i) => i > 0 && frame.pointer === null);
      const lon = all.map((frame) => frame.camera.longitudeDeg);
      const step = (i: number): number => (((lon[i] ?? 0) - (lon[i - 1] ?? 0) + 540) % 360) - 180;
      const rate = (i: number): number => step(i) / ((all[i]?.timeMs ?? 0) - (all[i - 1]?.timeMs ?? 1));
      const trace = `${name}: ${JSON.stringify(all.map((f) => [f.timeMs.toFixed(1), f.camera.longitudeDeg.toFixed(4), f.pointer ? 1 : 0]))}`;
      // At least one drag frame (a software GPU draws a few frames a second at most).
      expect(releasedAt, trace).toBeGreaterThan(0);
      // The content moves east, the camera west: every frame from the release on, the same way.
      const glide = all.length - releasedAt;
      for (let i = releasedAt; i < all.length; i++) expect(step(i), trace).toBeLessThanOrEqual(0);
      // A glide, not a dead stop: at least half a second of frames that move.
      const moving = all.slice(releasedAt).filter((_, k) => step(releasedAt + k) < -1e-6);
      expect(glide, trace).toBeGreaterThan(5);
      expect((moving.at(-1)?.timeMs ?? 0) - (all[releasedAt]?.timeMs ?? 0), trace).toBeGreaterThan(500);
      // Slowing down: each frame's rate no faster than the one before (10% for the software GPU's uneven steps).
      for (let i = releasedAt + 2; i < all.length; i++)
        expect(Math.abs(rate(i)), `${trace} frame ${i}`).toBeLessThanOrEqual(Math.abs(rate(i - 1)) * 1.1 + 1e-6);
    }
  });
}

test('a drag that leaves the globe keeps turning it, and its release glides (KB-202)', async ({ page }) => {
  test.setTimeout(60_000);
  await openControls(page, 'lon=0&lat=0&zoom=0.3&size=480x360');
  await settle(page);
  // The globe's radius along the middle row: the last pixel right of the center that still shows it.
  let radiusPx = 0;
  while (radiusPx < 240 && (await positionAt(page, { xPx: 240 + radiusPx + 1, yPx: 180 }))) radiusPx++;
  expect(radiusPx).toBeLessThan(200);
  await record(page, []);
  // From the center to 230 px right, past the edge, at 0.33 px/ms.
  await flick(page, 240, 180, 700, 1000 / 120, '0.33', 2);
  await settle(page);
  const all = await frames(page);
  const releasedAt = all.findIndex((frame, i) => i > 0 && frame.pointer === null);
  const lon = all.map((frame) => frame.camera.longitudeDeg);
  const trace = JSON.stringify(
    all.map((f) => [f.timeMs.toFixed(1), f.camera.longitudeDeg.toFixed(4), f.pointer?.xPx.toFixed(0)]),
  );
  // While the pointer is beyond the edge, the globe keeps turning (westward camera, eastward content).
  const offDisc = all.flatMap((f, i) => ((f.pointer?.xPx ?? 0) > 240 + radiusPx + 2 ? [i] : []));
  expect(offDisc.length, `${radiusPx} px: ${trace}`).toBeGreaterThan(1);
  const step = (a: number, b: number): number => ((b - a + 540) % 360) - 180;
  expect(step(lon[offDisc[0] ?? 0] ?? 0, lon[offDisc.at(-1) ?? 0] ?? 0), trace).toBeLessThan(-1);
  // And the release glides on.
  expect(step(lon[releasedAt - 1] ?? 0, lon.at(-1) ?? 0), trace).toBeLessThan(-1);
});
