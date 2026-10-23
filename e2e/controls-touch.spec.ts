// M6 input track: touch gestures under Chromium touch emulation (CDP multi-touch) on the controls harness.
import { expect, test } from '@playwright/test';
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
  Touch,
  type TouchPoint,
} from './support/controls.ts';

test.use({ hasTouch: true });

const BACKENDS = ['webgl2', 'webgpu'] as const;
/** A small canvas: software GPUs draw it fast enough for touch events to arrive at a finger's pace. */
const SIZE = 'size=320x240';

/** Moves fingers from `from` to `to` in `steps` events about 16 ms apart; returns the last positions. */
async function glide(
  touch: Touch,
  from: readonly TouchPoint[],
  to: readonly TouchPoint[],
  steps: number,
  page: { waitForTimeout(ms: number): Promise<void> },
): Promise<TouchPoint[]> {
  let at: TouchPoint[] = [...from];
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    at = from.map((p, k) => ({
      id: p.id,
      x: p.x + ((to[k]?.x ?? p.x) - p.x) * s,
      y: p.y + ((to[k]?.y ?? p.y) - p.y) * s,
    }));
    await touch.move(at);
    await page.waitForTimeout(16);
  }
  return at;
}

const mid = (points: readonly TouchPoint[]) => ({
  xPx: points.reduce((sum, p) => sum + p.x, 0) / points.length,
  yPx: points.reduce((sum, p) => sum + p.y, 0) / points.length,
});

for (const backend of BACKENDS) {
  test(`one-finger drag pans keeping the grabbed point under the finger, and coasts on release, on ${backend} (F178, F179)`, async ({
    page,
  }) => {
    await openControls(page, `backend=${backend}&lon=10&lat=20&zoom=4&${SIZE}`);
    const touch = await Touch.create(page);
    const start = [{ id: 1, x: 100, y: 120 }];
    const grabbed = await positionAt(page, mid(start));
    await record(page, [grabbed as GeoPosition]);
    await touch.start(start);
    const end = await glide(touch, start, [{ id: 1, x: 200, y: 140 }], 12, page);
    await touch.end();
    await settle(page);
    const recorded = await frames(page);
    expect(
      maxDrift(
        recorded.filter((f) => f.pointer),
        (f) => f.pointer,
      ),
    ).toBeLessThan(1);
    // Inertia carries the grabbed point beyond the release position, along the drag.
    const final = recorded.at(-1)?.screens[0];
    expect(final?.xPx ?? 0).toBeGreaterThan((end[0]?.x ?? 0) + 5);
  });

  test(`pinch zooms continuously about the finger midpoint and ends with eased inertia on ${backend} (F173)`, async ({
    page,
  }) => {
    await openControls(page, `backend=${backend}&lon=10&lat=45&zoom=4&${SIZE}`);
    const touch = await Touch.create(page);
    const from = [
      { id: 1, x: 120, y: 120 },
      { id: 2, x: 200, y: 120 },
    ];
    const under = await positionAt(page, mid(from));
    const zoom = groundZoom(await camera(page));
    await record(page, [under as GeoPosition]);
    await touch.start(from);
    await glide(
      touch,
      from,
      [
        { id: 1, x: 80, y: 120 },
        { id: 2, x: 240, y: 120 },
      ],
      12,
      page,
    );
    await touch.end();
    await settle(page);
    const recorded = await frames(page);
    expect(maxDrift(recorded, () => mid(from))).toBeLessThan(1);
    // Distance 80 → 160 px is one level; the 0.1-level threshold is not caught up, inertia adds a little.
    expect(groundZoom(await camera(page)) - zoom).toBeGreaterThan(0.75);
    const zooms = recorded.map((f) => groundZoom(f.camera));
    expect(new Set(zooms).size).toBeGreaterThan(5);
  });
}

for (const backend of BACKENDS) {
  test(`a two-finger parallel drag pans about the midpoint and coasts like a mouse drag on ${backend} (F180)`, async ({
    page,
  }) => {
    await openControls(page, `backend=${backend}&lon=10&lat=20&zoom=4&${SIZE}`);
    const touch = await Touch.create(page);
    const from = [
      { id: 1, x: 80, y: 100 },
      { id: 2, x: 140, y: 140 },
    ];
    const under = await positionAt(page, mid(from));
    await record(page, [under as GeoPosition]);
    await touch.start(from);
    const end = await glide(
      touch,
      from,
      [
        { id: 1, x: 180, y: 110 },
        { id: 2, x: 240, y: 150 },
      ],
      12,
      page,
    );
    await touch.end();
    await settle(page);
    const recorded = await frames(page);
    expect(
      maxDrift(
        recorded.filter((f) => f.pointer),
        (f) => f.pointer,
      ),
    ).toBeLessThan(1);
    expect(recorded.at(-1)?.screens[0]?.xPx ?? 0).toBeGreaterThan(mid(end).xPx + 5);
  });
}

test('a twist rotates the heading about the midpoint; a small one does not (F184)', async ({ page }) => {
  await openControls(page, `lon=10&lat=45&zoom=6&${SIZE}`);
  const touch = await Touch.create(page);
  const ring = (deg: number): TouchPoint[] => {
    const a = (deg * Math.PI) / 180;
    return [
      { id: 1, x: 160 - 50 * Math.cos(a), y: 120 - 50 * Math.sin(a) },
      { id: 2, x: 160 + 50 * Math.cos(a), y: 120 + 50 * Math.sin(a) },
    ];
  };
  const under = await positionAt(page, { xPx: 160, yPx: 120 });
  await touch.start(ring(0));
  await glide(touch, ring(0), ring(8), 6, page);
  await page.waitForTimeout(200);
  await settle(page);
  expect((await camera(page)).headingDeg).toBeCloseTo(0, 9);
  await record(page, [under as GeoPosition]);
  await glide(touch, ring(8), ring(70), 14, page);
  await touch.end();
  await settle(page);
  const heading = (await camera(page)).headingDeg;
  // Clockwise on screen: the heading decreases, by the twist past its threshold (25 px on a 50 px radius ≈ 29°).
  expect(heading).toBeLessThan(-25);
  expect(heading).toBeGreaterThan(-75);
  expect(maxDrift(await frames(page), () => ({ xPx: 160, yPx: 120 }))).toBeLessThan(1);
});

test('a twist combined with pinch and pan keeps the midpoint content under the midpoint (F184)', async ({ page }) => {
  await openControls(page, `lon=10&lat=45&zoom=6&${SIZE}`);
  const touch = await Touch.create(page);
  const at = (cx: number, cy: number, r: number, deg: number): TouchPoint[] => {
    const a = (deg * Math.PI) / 180;
    return [
      { id: 1, x: cx - r * Math.cos(a), y: cy - r * Math.sin(a) },
      { id: 2, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) },
    ];
  };
  const from = at(140, 120, 40, 0);
  const under = await positionAt(page, mid(from));
  const zoom = groundZoom(await camera(page));
  await record(page, [under as GeoPosition]);
  await touch.start(from);
  const end = await glide(touch, from, at(180, 130, 70, 60), 16, page);
  await page.waitForTimeout(150);
  await settle(page);
  const recorded = await frames(page);
  await touch.end();
  await settle(page);
  expect(
    maxDrift(
      recorded.filter((f) => f.pointer),
      (f) => f.pointer,
    ),
  ).toBeLessThan(1);
  expect(recorded.at(-1)?.screens[0]?.xPx).toBeCloseTo(mid(end).xPx, 0);
  expect(groundZoom(await camera(page)) - zoom).toBeGreaterThan(0.5);
  expect((await camera(page)).headingDeg).toBeLessThan(-20);
});

test('a two-finger vertical drag tilts, and pinch, twist and pan do not (F185)', async ({ page }) => {
  await openControls(page, `lon=10&lat=45&zoom=8&${SIZE}`);
  const touch = await Touch.create(page);
  const from = [
    { id: 1, x: 120, y: 160 },
    { id: 2, x: 200, y: 160 },
  ];
  await touch.start(from);
  await glide(
    touch,
    from,
    [
      { id: 1, x: 120, y: 80 },
      { id: 2, x: 200, y: 80 },
    ],
    10,
    page,
  );
  await touch.end();
  await settle(page);
  const tilted = await camera(page);
  expect(tilted.tiltDeg).toBeGreaterThan(10);
  expect(tilted.longitudeDeg).toBeCloseTo(10, 6);
  expect(tilted.headingDeg).toBeCloseTo(0, 9);

  for (const to of [
    [
      { id: 1, x: 90, y: 160 },
      { id: 2, x: 230, y: 160 },
    ],
    [
      { id: 1, x: 170, y: 160 },
      { id: 2, x: 250, y: 160 },
    ],
  ]) {
    await touch.start(from);
    await glide(touch, from, to, 10, page);
    await touch.end();
    await settle(page);
    expect((await camera(page)).tiltDeg).toBeCloseTo(tilted.tiltDeg, 6);
  }
});

test('adding and lifting fingers mid-gesture continues without a jump (F186)', async ({ page }) => {
  await openControls(page, `lon=10&lat=20&zoom=4&${SIZE}`);
  const touch = await Touch.create(page);
  await record(page, []);
  const one = [{ id: 1, x: 100, y: 120 }];
  await touch.start(one);
  const a = await glide(touch, one, [{ id: 1, x: 130, y: 120 }], 5, page);
  const two = [...a, { id: 2, x: 220, y: 120 }];
  await touch.start(two);
  const b = await glide(
    touch,
    two,
    [
      { id: 1, x: 110, y: 120 },
      { id: 2, x: 250, y: 120 },
    ],
    6,
    page,
  );
  await touch.end([b[0] as TouchPoint]);
  await glide(touch, [b[0] as TouchPoint], [{ id: 1, x: 150, y: 140 }], 5, page);
  await page.waitForTimeout(200);
  await touch.end();
  await settle(page);
  const recorded = await frames(page);
  // Jump threshold: no frame moves the center by more than a tenth of the viewport or zooms by more than half a level.
  for (let i = 1; i < recorded.length; i++) {
    const p = recorded[i - 1]?.camera;
    const c = recorded[i]?.camera;
    if (!p || !c) continue;
    const metersPerDeg = 111_000;
    const moved = Math.hypot(c.longitudeDeg - p.longitudeDeg, c.latitudeDeg - p.latitudeDeg) * metersPerDeg;
    expect(moved).toBeLessThan(c.rangeMeters * 0.1);
    expect(Math.abs(groundZoom(c) - groundZoom(p))).toBeLessThan(0.5);
  }
});

test('taps: a double tap zooms in one level at the tap, a two-finger tap zooms out, single taps and tap-then-drag do not (F171, F172)', async ({
  page,
}) => {
  await openControls(page, `lon=10&lat=45&zoom=5&${SIZE}`);
  const touch = await Touch.create(page);
  const z0 = groundZoom(await camera(page));
  await touch.start([{ id: 1, x: 100, y: 100 }]);
  await touch.end();
  await settle(page);
  expect(groundZoom(await camera(page))).toBe(z0);

  const tapped = await positionAt(page, { xPx: 100, yPx: 100 });
  await record(page, [tapped as GeoPosition]);
  for (let i = 0; i < 2; i++) {
    await touch.start([{ id: 1, x: 100, y: 100 }]);
    await touch.end();
    await page.waitForTimeout(60);
  }
  await settle(page);
  expect(groundZoom(await camera(page)) - z0).toBeCloseTo(1, 6);
  expect(maxDrift(await frames(page), () => ({ xPx: 100, yPx: 100 }))).toBeLessThan(1);

  const z1 = groundZoom(await camera(page));
  const midpoint = await positionAt(page, { xPx: 160, yPx: 120 });
  await record(page, [midpoint as GeoPosition]);
  await touch.start([
    { id: 1, x: 130, y: 120 },
    { id: 2, x: 190, y: 120 },
  ]);
  await touch.end();
  await settle(page);
  expect(groundZoom(await camera(page)) - z1).toBeCloseTo(-1, 6);
  expect(maxDrift(await frames(page), () => ({ xPx: 160, yPx: 120 }))).toBeLessThan(1);

  // A tap, then a drag: no zoom.
  const z2 = groundZoom(await camera(page));
  await touch.start([{ id: 1, x: 100, y: 100 }]);
  await touch.end();
  await touch.start([{ id: 1, x: 100, y: 100 }]);
  await glide(touch, [{ id: 1, x: 100, y: 100 }], [{ id: 1, x: 160, y: 100 }], 6, page);
  await page.waitForTimeout(200);
  await touch.end();
  await settle(page);
  expect(groundZoom(await camera(page))).toBeCloseTo(z2, 9);
  // A two-finger touch that moves beyond the tap tolerance: no zoom out.
  await touch.start([
    { id: 1, x: 130, y: 120 },
    { id: 2, x: 190, y: 120 },
  ]);
  await touch.move([
    { id: 1, x: 130, y: 120 },
    { id: 2, x: 210, y: 120 },
  ]);
  await touch.end();
  await settle(page);
  expect(groundZoom(await camera(page))).toBeGreaterThan(z2 - 0.5);
  const z3 = groundZoom(await camera(page));
  // A two-finger touch held too long: no zoom.
  await touch.start([
    { id: 1, x: 130, y: 120 },
    { id: 2, x: 190, y: 120 },
  ]);
  await page.waitForTimeout(400);
  await touch.end();
  await settle(page);
  expect(groundZoom(await camera(page))).toBeCloseTo(z3, 9);
});

test('touch drags over the map never scroll the page (F189)', async ({ page }) => {
  await openControls(page, 'embed=1&lon=10&lat=45&zoom=4');
  await page.evaluate(() => window.scrollTo(0, 700));
  const touch = await Touch.create(page);
  await touch.start([{ id: 1, x: 400, y: 300 }]);
  await glide(touch, [{ id: 1, x: 400, y: 300 }], [{ id: 1, x: 400, y: 100 }], 6, page);
  await touch.end();
  await settle(page);
  expect(await page.evaluate(() => [window.scrollY, window.visualViewport?.scale ?? 1])).toEqual([700, 1]);
});
