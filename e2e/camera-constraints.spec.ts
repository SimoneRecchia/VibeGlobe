// Camera constraints (F209–F211) hold for every input and movement, frame by frame, approached without a jump.
import { expect, test, type Page } from '@playwright/test';
import type { CameraConstraints } from '@vibeglobe/core';
import { openGlobe } from './support/globe.ts';
import { Touch, type TouchPoint } from './support/controls.ts';

test.use({ viewport: { width: 320, height: 240 }, hasTouch: true });

interface Pose {
  lon: number;
  lat: number;
  zoom: number;
  tilt: number;
  chosenTilt: number;
}

/** Opens the playground with constraints and starts recording the camera of every frame. */
async function open(page: Page, query: string, constraints: CameraConstraints): Promise<Touch> {
  await openGlobe(page, `backend=webgl2&${query}`);
  await page.evaluate((c) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    globe.setConstraints(c);
    const record = window as unknown as { poses: Pose[] };
    record.poses = [];
    globe.on('frame', () => {
      const cam = globe.camera;
      record.poses.push({
        lon: cam.longitudeDeg,
        lat: cam.latitudeDeg,
        zoom: cam.zoom,
        tilt: cam.tiltDeg,
        chosenTilt: cam.chosenTiltDeg,
      });
    });
  }, constraints);
  return Touch.create(page);
}

/** Runs one input from a reset view and returns the frames it drew once they settle. */
async function drive(page: Page, reset: object, input: () => Promise<unknown>): Promise<Pose[]> {
  // Movements are awaited by `input`; inputs settle within the wait after it.
  await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), reset);
  await page.waitForTimeout(150);
  await page.evaluate(() => ((window as unknown as { poses: Pose[] }).poses = []));
  await input();
  await page.waitForTimeout(1200);
  return page.evaluate(() => (window as unknown as { poses: Pose[] }).poses);
}

async function glide(touch: Touch, from: TouchPoint[], to: TouchPoint[], steps = 8): Promise<void> {
  await touch.start(from);
  for (let i = 1; i <= steps; i++)
    await touch.move(
      from.map((p, k) => ({
        id: p.id,
        x: p.x + ((to[k]?.x ?? p.x) - p.x) * (i / steps),
        y: p.y + ((to[k]?.y ?? p.y) - p.y) * (i / steps),
      })),
    );
  await touch.end();
}

const api = (page: Page, script: string) => () =>
  page.evaluate((code) => new Function('globe', code)(window.vibeglobePlayground?.globe), script);

test('the zoom range holds for wheel, pinch, double-click, keys, buttons, flyTo and easeTo, reached without a jump or bounce (F209)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const touch = await open(page, 'lon=10&lat=45&zoom=6', { minZoom: 4, maxZoom: 7 });
  const press = (key: string) => async () => {
    await page.focus('#globe');
    for (let i = 0; i < 4; i++) await page.keyboard.press(key);
  };
  const click = (command: string) => async () => {
    for (let i = 0; i < 4; i++) await page.locator(`[data-command="${command}"]`).click();
  };
  const failures: string[] = [];
  for (const [direction, start, inputs] of [
    [
      1,
      6.5,
      {
        wheel: async () => {
          await page.mouse.move(160, 120);
          for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -300);
        },
        pinch: () =>
          glide(
            touch,
            [
              { id: 1, x: 140, y: 120 },
              { id: 2, x: 180, y: 120 },
            ],
            [
              { id: 1, x: 40, y: 120 },
              { id: 2, x: 280, y: 120 },
            ],
          ),
        dblclick: async () => {
          for (let i = 0; i < 3; i++) await page.mouse.dblclick(160, 120);
        },
        keys: press('+'),
        buttons: click('zoom-in'),
        flyTo: api(page, 'return globe.flyTo({ zoom: 12 }, { durationMs: 800 })'),
        easeTo: api(page, 'return globe.easeTo({ zoom: 12 }, { durationMs: 800 })'),
      },
    ],
    [
      -1,
      4.5,
      {
        wheel: async () => {
          await page.mouse.move(160, 120);
          for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
        },
        pinch: () =>
          glide(
            touch,
            [
              { id: 1, x: 40, y: 120 },
              { id: 2, x: 280, y: 120 },
            ],
            [
              { id: 1, x: 150, y: 120 },
              { id: 2, x: 170, y: 120 },
            ],
          ),
        keys: press('-'),
        buttons: click('zoom-out'),
        flyTo: api(page, 'return globe.flyTo({ zoom: 1 }, { durationMs: 800 })'),
        easeTo: api(page, 'return globe.easeTo({ zoom: 1 }, { durationMs: 800 })'),
      },
    ],
  ] as const) {
    for (const [name, input] of Object.entries(inputs)) {
      const poses = await drive(page, { longitudeDeg: 10, latitudeDeg: 45, zoom: start }, input);
      const limit = direction > 0 ? 7 : 4;
      if (!poses.some((p) => Math.abs(p.zoom - limit) < 0.05)) failures.push(`${name}: never reached ${limit}`);
      poses.forEach((pose, i) => {
        if (pose.zoom < 4 - 1e-6 || pose.zoom > 7 + 1e-6) failures.push(`${name}: zoom ${pose.zoom} at frame ${i}`);
        const before = poses[i - 1];
        if (!before) return;
        const step = pose.zoom - before.zoom;
        if (Math.abs(step) > 0.75) failures.push(`${name}: jump ${step} at frame ${i}`);
        // Toward the limit only: no bounce back from it.
        if (step * direction < -1e-6) failures.push(`${name}: moved back by ${step} at frame ${i}`);
      });
    }
  }
  expect(failures).toEqual([]);
});

test('the maximum tilt holds for right-drag, two-finger tilt, Shift+arrows, the tilt control, view modes and movements (F210)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const touch = await open(page, 'lon=10&lat=45&zoom=14', { maxTiltDeg: 30 });
  const reset = { longitudeDeg: 10, latitudeDeg: 45, zoom: 14, tiltDeg: 10 };
  const failures: string[] = [];
  for (const [name, input] of Object.entries({
    rightDrag: async () => {
      await page.mouse.move(160, 200);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(160, 20, { steps: 8 });
      await page.mouse.up({ button: 'right' });
    },
    twoFingers: () =>
      glide(
        touch,
        [
          { id: 1, x: 130, y: 200 },
          { id: 2, x: 190, y: 200 },
        ],
        [
          { id: 1, x: 130, y: 40 },
          { id: 2, x: 190, y: 40 },
        ],
      ),
    shiftArrows: async () => {
      await page.focus('#globe');
      await page.keyboard.down('Shift');
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(1500);
      await page.keyboard.up('ArrowUp');
      await page.keyboard.up('Shift');
    },
    tiltControl: () => page.locator('#camera-controls input[aria-label="Tilt"]').fill('70'),
    viewMode3d: api(page, "globe.setViewMode('3d')"),
    viewModeAuto: api(page, "globe.jumpTo({ zoom: 18 }); globe.setViewMode('auto')"),
    tiltTo: api(page, 'return globe.tiltTo(80)'),
    flyTo: api(page, 'return globe.flyTo({ longitudeDeg: 11, tiltDeg: 75 }, { durationMs: 800 })'),
    easeTo: api(page, 'return globe.easeTo({ tiltDeg: 75 }, { durationMs: 800 })'),
  })) {
    const poses = await drive(page, reset, input);
    if (!poses.some((p) => p.tilt > 25)) failures.push(`${name}: never tilted toward the maximum`);
    poses.forEach((pose, i) => {
      if (pose.tilt > 30 + 1e-6 || pose.chosenTilt > 30 + 1e-6)
        failures.push(`${name}: tilt ${pose.tilt} chosen ${pose.chosenTilt} at frame ${i}`);
      const before = poses[i - 1];
      if (before && Math.abs(pose.tilt - before.tilt) > 10) failures.push(`${name}: tilt jump at frame ${i}`);
    });
  }
  expect(failures).toEqual([]);
});

for (const [label, bounds, start, outside] of [
  ['Europe', { westDeg: 5, southDeg: 40, eastDeg: 15, northDeg: 50 }, { longitudeDeg: 10, latitudeDeg: 45 }, 40],
  [
    'across the antimeridian',
    { westDeg: 170, southDeg: -20, eastDeg: -170, northDeg: 20 },
    { longitudeDeg: 179, latitudeDeg: 0 },
    0,
  ],
] as const) {
  test(`geographic bounds ${label} hold for drags, inertia, keyboard pan, wheel zoom-out and flights (F211)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // A manual clock: frames come evenly in engine time, so a frame-to-frame step measures the motion, not the
    // software GPU's pauses.
    await open(page, `lon=${start.longitudeDeg}&lat=${start.latitudeDeg}&zoom=6&clockStepMs=16.666666666666668`, {
      bounds,
    });
    const inside = (lon: number, lat: number): boolean => {
      const inLon =
        bounds.westDeg <= bounds.eastDeg
          ? lon >= bounds.westDeg - 1e-6 && lon <= bounds.eastDeg + 1e-6
          : lon >= bounds.westDeg - 1e-6 || lon <= bounds.eastDeg + 1e-6;
      return inLon && lat >= bounds.southDeg - 1e-6 && lat <= bounds.northDeg + 1e-6;
    };
    const failures: string[] = [];
    const drag = (dx: number, dy: number) => async () => {
      await page.mouse.move(160, 120);
      await page.mouse.down();
      await page.mouse.move(160 + dx, 120 + dy, { steps: 10 });
      await page.waitForTimeout(400);
      await page.mouse.up();
    };
    for (const [name, input] of Object.entries({
      dragWest: drag(300, 0),
      dragEast: drag(-300, 0),
      dragNorth: drag(0, 200),
      inertia: async () => {
        await page.mouse.move(60, 120);
        await page.mouse.down();
        await page.mouse.move(300, 120, { steps: 4 });
        await page.mouse.up();
      },
      keyboardPan: async () => {
        await page.focus('#globe');
        await page.keyboard.down('ArrowLeft');
        await page.waitForTimeout(2000);
        await page.keyboard.up('ArrowLeft');
      },
      wheelOut: async () => {
        await page.mouse.move(40, 40);
        for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
      },
      flyTo: api(
        page,
        `return globe.flyTo({ longitudeDeg: ${outside}, latitudeDeg: -60, zoom: 6 }, { durationMs: 800 })`,
      ),
    })) {
      const poses = await drive(page, { ...start, zoom: 6 }, input);
      poses.forEach((pose, i) => {
        if (!inside(pose.lon, pose.lat)) failures.push(`${name}: center ${pose.lon}, ${pose.lat} at frame ${i}`);
        const before = poses[i - 1];
        if (!before) return;
        const dLon = Math.abs(((pose.lon - before.lon + 540) % 360) - 180);
        // In screen pixels at the frame's zoom (256 px per 360° at zoom 0): a step to the edge would be hundreds.
        const stepPx = ((Math.hypot(dLon, pose.lat - before.lat) * 256) / 360) * 2 ** Math.max(pose.zoom, before.zoom);
        if (stepPx > 40) failures.push(`${name}: jump at frame ${i} ${JSON.stringify([before, pose])}`);
      });
    }
    expect(failures).toEqual([]);
  });
}
