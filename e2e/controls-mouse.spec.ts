// M6 input track: mouse, wheel and trackpad navigation on the controls harness (e2e/support/controls.html).
import { expect, test, type Page } from '@playwright/test';
import type { GeoPosition, ScreenPoint } from '@vibeglobe/core';
import {
  camera,
  CANVAS,
  frames,
  groundZoom,
  maxDrift,
  openControls,
  positionAt,
  record,
  settle,
  type RecordedFrame,
} from './support/controls.ts';

const BACKENDS = ['webgl2', 'webgpu'] as const;

/** Moves the mouse in `steps` events, one per display frame, so each frame applies one step. */
async function moveInFrames(page: Page, from: ScreenPoint, to: ScreenPoint, steps: number): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    await page.mouse.move(from.xPx + (to.xPx - from.xPx) * s, from.yPx + (to.yPx - from.yPx) * s);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  }
}

/** Grabs at `from`, drags to `to` and checks the grabbed position stays under the pointer in every frame. */
async function dragKeepsAnchor(page: Page, from: ScreenPoint, to: ScreenPoint): Promise<void> {
  const grabbed = await positionAt(page, from);
  expect(grabbed).not.toBeNull();
  await record(page, [grabbed as GeoPosition]);
  await page.mouse.move(from.xPx, from.yPx);
  await page.mouse.down();
  await moveInFrames(page, from, to, 6);
  await page.waitForTimeout(150);
  await page.mouse.up();
  const recorded = (await frames(page)).filter((frame) => frame.pointer !== null);
  expect(recorded.length).toBeGreaterThan(5);
  expect(maxDrift(recorded, (frame) => frame.pointer)).toBeLessThan(1);
  await settle(page);
}

for (const backend of BACKENDS) {
  test(`dragging keeps the grabbed point under the pointer on the globe, tilted, across the antimeridian and near the pole on ${backend} (F178)`, async ({
    page,
  }) => {
    await openControls(page, `backend=${backend}&lon=10&lat=45&zoom=3`);
    await dragKeepsAnchor(page, { xPx: 400, yPx: 300 }, { xPx: 520, yPx: 360 });
    await openControls(page, `backend=${backend}&lon=179.5&lat=0&zoom=6`);
    await dragKeepsAnchor(page, { xPx: 600, yPx: 300 }, { xPx: 300, yPx: 300 });
    expect((await camera(page)).longitudeDeg).toBeLessThan(0);
    await openControls(page, `backend=${backend}&lon=0&lat=88.5&zoom=5`);
    const before = await camera(page);
    await dragKeepsAnchor(page, { xPx: 400, yPx: 250 }, { xPx: 400, yPx: 450 });
    // No flip: the camera keeps looking the same way.
    expect(Math.abs((await camera(page)).headingDeg - before.headingDeg)).toBeLessThan(90);
    await openControls(page, `backend=${backend}&lon=10&lat=45&zoom=8&tilt=40&heading=30`);
    await dragKeepsAnchor(page, { xPx: 400, yPx: 400 }, { xPx: 300, yPx: 330 });
  });
}

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
  expect((all.at(-1)?.timeMs ?? 0) - (all[releasedAt]?.timeMs ?? 0)).toBeLessThan(2500);
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

for (const backend of BACKENDS) {
  test(`a double click zooms in exactly one level at the clicked point, and a single click does not zoom, on ${backend} (F170)`, async ({
    page,
  }) => {
    // A small canvas: frames fast enough to show the animation on a software GPU.
    await openControls(page, `backend=${backend}&lon=10&lat=45&zoom=4&size=320x240`);
    const zoom0 = groundZoom(await camera(page));
    await page.mouse.click(100, 100);
    await settle(page);
    expect(groundZoom(await camera(page))).toBe(zoom0);
    for (const [x, y] of [
      [100, 100],
      [208, 152],
      [160, 120],
    ] as const) {
      const clicked = await positionAt(page, { xPx: x, yPx: y });
      const zoom = groundZoom(await camera(page));
      await record(page, [clicked as GeoPosition]);
      await page.mouse.dblclick(x, y);
      await settle(page);
      const recorded = await frames(page);
      expect(new Set(recorded.map((frame) => groundZoom(frame.camera))).size).toBeGreaterThan(3);
      expect(groundZoom(await camera(page))).toBeCloseTo(zoom + 1, 6);
      expect(maxDrift(recorded, () => ({ xPx: x, yPx: y }))).toBeLessThan(1);
    }
  });
}

test('Shift+drag draws a zoom box and fits it on release; Escape cancels it (F175)', async ({ page }) => {
  await openControls(page, 'lon=10&lat=45&zoom=4');
  const box = { x0: 300, y0: 250, x1: 460, y1: 330 };
  const corners = await Promise.all(
    [
      [box.x0, box.y0],
      [box.x1, box.y0],
      [box.x0, box.y1],
      [box.x1, box.y1],
    ].map(([x, y]) => positionAt(page, { xPx: x ?? 0, yPx: y ?? 0 })),
  );
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x0, box.y0);
  await page.mouse.down();
  await page.mouse.move(box.x1, box.y1, { steps: 5 });
  const overlay = page.locator('[data-vibeglobe-zoom-box]');
  await expect(overlay).toHaveCount(1);
  expect(await overlay.boundingBox()).toMatchObject({ width: 160, height: 80 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(overlay).toHaveCount(0);
  await settle(page);
  const shown = await page.evaluate(
    (positions) => positions.map((p) => window.controlsHarness?.globe.geoToScreen(p as GeoPosition) ?? null),
    corners,
  );
  for (const point of shown) {
    expect(point?.xPx).toBeGreaterThanOrEqual(-2);
    expect(point?.xPx).toBeLessThanOrEqual(CANVAS.widthPx + 2);
    expect(point?.yPx).toBeGreaterThanOrEqual(-2);
    expect(point?.yPx).toBeLessThanOrEqual(CANVAS.heightPx + 2);
  }
  // The box is wider in proportion (160 / 80 vs 800 / 600): its width fills the viewport.
  const width = Math.max(...shown.map((p) => p?.xPx ?? 0)) - Math.min(...shown.map((p) => p?.xPx ?? 0));
  expect(width / CANVAS.widthPx).toBeGreaterThan(0.95);
  expect(width / CANVAS.widthPx).toBeLessThan(1.05);

  const before = await camera(page);
  await page.keyboard.down('Shift');
  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.move(400, 400, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await settle(page);
  await expect(overlay).toHaveCount(0);
  expect(await camera(page)).toEqual(before);
});

/** Drags with a button and modifier, returns the heading and tilt change and whether the center target moved. */
async function rotateDrag(page: Page, button: 'right' | 'left', ctrl: boolean, dx: number, dy: number) {
  const before = await camera(page);
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.move(400, 300);
  await page.mouse.down({ button });
  await page.mouse.move(400 + dx, 300 + dy, { steps: 10 });
  await page.mouse.up({ button });
  if (ctrl) await page.keyboard.up('Control');
  await settle(page);
  const after = await camera(page);
  return {
    heading: (after.headingDeg - before.headingDeg + 360) % 360,
    tilt: after.tiltDeg - before.tiltDeg,
    centerMoved: Math.hypot(after.longitudeDeg - before.longitudeDeg, after.latitudeDeg - before.latitudeDeg),
  };
}

for (const backend of BACKENDS) {
  test(`right-drag rotates and tilts about the center target without a context menu on ${backend} (F182)`, async ({
    page,
  }) => {
    await openControls(page, `backend=${backend}&lon=10&lat=45&zoom=8`);
    await page.evaluate(() => {
      window.addEventListener(
        'contextmenu',
        (event) => ((window as { menus?: number }).menus = event.defaultPrevented ? 0 : 1),
      );
    });
    const horizontal = await rotateDrag(page, 'right', false, 200, 0);
    expect(horizontal.heading).toBeGreaterThan(30);
    expect(horizontal.tilt).toBe(0);
    expect(horizontal.centerMoved).toBeLessThan(1e-9);
    const vertical = await rotateDrag(page, 'right', false, 0, -150);
    expect(vertical.tilt).toBeGreaterThan(15);
    expect(vertical.centerMoved).toBeLessThan(1e-9);
    expect(await page.evaluate(() => (window as { menus?: number }).menus ?? 0)).toBe(0);
  });
}

test('Ctrl+drag rotates and tilts exactly like right-drag, and releasing Ctrl ends it without a jump (F183)', async ({
  page,
}) => {
  await openControls(page, 'lon=10&lat=45&zoom=8');
  const right = await rotateDrag(page, 'right', false, 120, -90);
  await openControls(page, 'lon=10&lat=45&zoom=8');
  const ctrl = await rotateDrag(page, 'left', true, 120, -90);
  expect(ctrl.heading).toBeCloseTo(right.heading, 6);
  expect(ctrl.tilt).toBeCloseTo(right.tilt, 6);

  await record(page, []);
  await page.keyboard.down('Control');
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(500, 300, { steps: 10 });
  await page.keyboard.up('Control');
  await page.mouse.move(600, 300, { steps: 10 });
  await page.mouse.up();
  await settle(page);
  const recorded = await frames(page);
  const last = recorded.at(-1)?.camera;
  // Rotation stopped where Ctrl was released: nothing panned or rotated afterwards.
  const atRelease = recorded.find((frame, i) => i > 0 && frame.camera.headingDeg === last?.headingDeg)?.camera;
  expect(last?.longitudeDeg).toBe(atRelease?.longitudeDeg);
  for (let i = 1; i < recorded.length; i++) {
    const step = Math.abs((recorded[i]?.camera.headingDeg ?? 0) - (recorded[i - 1]?.camera.headingDeg ?? 0));
    expect(Math.min(step, 360 - step)).toBeLessThan(20);
  }
});

/** Dispatches wheel events on the canvas directly (deltaMode and ctrlKey, which page.mouse.wheel cannot set). */
async function wheel(
  page: Page,
  events: { x: number; y: number; deltaY: number; deltaMode?: number; ctrlKey?: boolean }[],
) {
  await page.evaluate(async (list) => {
    const target = document.querySelector('#globe') as HTMLCanvasElement;
    const rect = target.getBoundingClientRect();
    for (const e of list) {
      target.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: rect.left + e.x,
          clientY: rect.top + e.y,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode ?? 0,
          ctrlKey: e.ctrlKey ?? false,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((done) => requestAnimationFrame(done));
    }
  }, events);
}

for (const backend of BACKENDS) {
  test(`wheel notches zoom smoothly anchored at the cursor in pixel and line modes on ${backend} (F168)`, async ({
    page,
  }) => {
    await openControls(page, `backend=${backend}&lon=10&lat=45&zoom=4&size=320x240`);
    for (const [x, y, deltaMode, deltaY] of [
      [100, 100, 0, -100],
      [224, 152, 1, -3],
      [160, 120, 0, 100],
    ] as const) {
      const under = await positionAt(page, { xPx: x, yPx: y });
      const zoom = groundZoom(await camera(page));
      await record(page, [under as GeoPosition]);
      await wheel(page, [{ x, y, deltaY, deltaMode }]);
      await settle(page);
      const recorded = await frames(page);
      expect(maxDrift(recorded, () => ({ xPx: x, yPx: y }))).toBeLessThan(1);
      // One notch animates over several frames with a decreasing step.
      const zooms = recorded.map((frame) => groundZoom(frame.camera));
      expect(new Set(zooms).size).toBeGreaterThan(4);
      expect(groundZoom(await camera(page)) - zoom).toBeCloseTo(-(deltaY * (deltaMode === 1 ? 16 : 1)) / 300, 6);
    }
  });
}

test('a wheel over empty sky zooms toward the screen center (F168)', async ({ page }) => {
  await openControls(page, 'lon=10&lat=45&zoom=1.5');
  expect(await positionAt(page, { xPx: 20, yPx: 20 })).toBeNull();
  const center = await positionAt(page, { xPx: 400, yPx: 300 });
  await record(page, [center as GeoPosition]);
  await wheel(page, [{ x: 20, y: 20, deltaY: -100 }]);
  await settle(page);
  expect(maxDrift(await frames(page), () => ({ xPx: 400, yPx: 300 }))).toBeLessThan(1);
});

test('trackpad scrolls and pinches zoom continuously at the cursor, in proportion to the deltas (F169)', async ({
  page,
}) => {
  await openControls(page, 'lon=10&lat=45&zoom=4');
  const at = { xPx: 300, yPx: 260 };
  const under = await positionAt(page, at);
  // A macOS-like two-finger scroll (fractional pixel deltas, decaying momentum) then a Windows precision-touchpad pinch
  // (ctrlKey with small deltas).
  const scroll = [-2, -4.5, -6, -7.25, -6, -4, -3, -2, -1.5, -1, -0.5].map((deltaY) => ({
    x: at.xPx,
    y: at.yPx,
    deltaY,
  }));
  const pinch = [-1, -2, -3, -3, -2, -1].map((deltaY) => ({ x: at.xPx, y: at.yPx, deltaY, ctrlKey: true }));
  const zoom = groundZoom(await camera(page));
  await record(page, [under as GeoPosition]);
  await wheel(page, [...scroll, ...pinch]);
  await settle(page);
  const recorded = await frames(page);
  const total = scroll.reduce((sum, e) => sum - e.deltaY / 300, 0) + pinch.reduce((sum, e) => sum - e.deltaY / 100, 0);
  expect(groundZoom(await camera(page)) - zoom).toBeCloseTo(total, 6);
  expect(maxDrift(recorded, () => at)).toBeLessThan(1);
  // No stepping: the largest frame-to-frame change is the largest single delta, not an accumulation.
  const steps = recorded.map((frame, i) =>
    Math.abs(
      groundZoom(frame.camera) - (recorded[i - 1] ? groundZoom((recorded[i - 1] as RecordedFrame).camera) : zoom),
    ),
  );
  expect(Math.max(...steps)).toBeLessThanOrEqual(3 / 100 + 1e-9);
});

test('input over the map never scrolls or zooms the page, while the page scrolls outside it (F189)', async ({
  page,
}) => {
  await openControls(page, 'embed=1&lon=10&lat=45&zoom=4');
  // The map spans 932–1532 px of the page: scrolled by 700, all of it is in the window.
  await page.evaluate(() => window.scrollTo(0, 700));
  const map = await page.locator('#globe').boundingBox();
  if (!map) throw new Error('no map');
  const cx = map.x + map.width / 2;
  const cy = map.y + map.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 300);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.evaluate(() => {
    const target = document.querySelector('#globe') as HTMLCanvasElement;
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await settle(page);
  expect(await page.evaluate(() => [window.scrollY, window.visualViewport?.scale ?? 1])).toEqual([700, 1]);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#globe') as Element).touchAction)).toBe(
    'none',
  );
  // Outside the map the page scrolls as usual.
  await page.mouse.move(cx, map.y + map.height + 100);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700);
});
