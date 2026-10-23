import { describe, expect, it } from 'vitest';
import { controlsHarness, type PointerInit } from './test-harness.js';

type Harness = ReturnType<typeof controlsHarness>;

function touch(h: Harness, type: string, id: number, x: number, y: number, t: number): void {
  const init: PointerInit = { x, y, t, id, pointerType: 'touch' };
  h.pointer(type, init);
}

/** Moves two fingers from their positions to new ones in `steps` frames of 10 ms each, starting at `t0`. */
function twoFingers(
  h: Harness,
  from: readonly [number, number, number, number],
  to: readonly [number, number, number, number],
  t0: number,
  steps = 10,
): number {
  let t = t0;
  for (let i = 1; i <= steps; i++) {
    t = t0 + i * 10;
    const s = i / steps;
    const at = from.map((v, k) => v + ((to[k] ?? 0) - v) * s);
    touch(h, 'pointermove', 1, at[0] ?? 0, at[1] ?? 0, t);
    touch(h, 'pointermove', 2, at[2] ?? 0, at[3] ?? 0, t);
    h.frame(10);
  }
  return t;
}

/** Puts two fingers down at once and runs the frame that baselines them. */
function press(h: Harness, at: readonly [number, number, number, number], t = 0): void {
  touch(h, 'pointerdown', 1, at[0], at[1], t);
  touch(h, 'pointerdown', 2, at[2], at[3], t);
  h.frame(10);
}

describe('touch gestures (ADR 0009 §4)', () => {
  it('pans with one finger keeping the grabbed point under it (F178)', () => {
    const h = controlsHarness();
    const grabbed = h.camera.worldAt({ xPx: 200, yPx: 200 });
    touch(h, 'pointerdown', 1, 200, 200, 0);
    h.frame();
    for (let i = 1; i <= 5; i++) {
      touch(h, 'pointermove', 1, 200 + 20 * i, 200 + 10 * i, i * 16);
      h.frame();
      expect(h.camera.pixelOf(grabbed).xPx).toBeCloseTo(200 + 20 * i, 9);
    }
  });

  it('pinches about the finger midpoint, continuously, once past the threshold (F173)', () => {
    const h = controlsHarness();
    press(h, [300, 300, 500, 300]);
    const mid = h.camera.worldAt({ xPx: 400, yPx: 300 });
    twoFingers(h, [300, 300, 500, 300], [200, 300, 600, 300], 0);
    // Distance 200 → 400 is one level, minus the 0.1-level threshold that unlocked it.
    expect(h.camera.zoom).toBeGreaterThan(0.85);
    expect(h.camera.zoom).toBeLessThan(1);
    expect(h.camera.pixelOf(mid).xPx).toBeCloseTo(400, 6);
    expect(h.camera.headingDeg).toBe(0);
    expect(h.camera.tiltDeg).toBe(0);
  });

  it('twists the heading about the midpoint, and ignores small twists below the threshold (F184)', () => {
    const h = controlsHarness();
    press(h, [300, 300, 500, 300]);
    // 5°: 100 px × 0.087 rad = 8.7 px along the circle, under the 25 px threshold.
    const small = (5 * Math.PI) / 180;
    twoFingers(
      h,
      [300, 300, 500, 300],
      [
        400 - 100 * Math.cos(small),
        300 - 100 * Math.sin(small),
        400 + 100 * Math.cos(small),
        300 + 100 * Math.sin(small),
      ],
      0,
    );
    expect(h.camera.headingDeg).toBe(0);
    const big = (45 * Math.PI) / 180;
    const at = [
      400 - 100 * Math.cos(big),
      300 - 100 * Math.sin(big),
      400 + 100 * Math.cos(big),
      300 + 100 * Math.sin(big),
    ] as const;
    twoFingers(
      h,
      [
        400 - 100 * Math.cos(small),
        300 - 100 * Math.sin(small),
        400 + 100 * Math.cos(small),
        300 + 100 * Math.sin(small),
      ],
      at,
      100,
    );
    // Clockwise on screen turns the heading back; it starts at the unlock (about 14.3°), so it does not catch up.
    const turned = 360 - h.camera.headingDeg;
    expect(turned).toBeGreaterThan(25);
    expect(turned).toBeLessThan(45 - 14);
    expect(h.camera.zoom).toBe(0);
  });

  it('tilts with a two-finger vertical drag, exclusively (F185)', () => {
    const h = controlsHarness();
    press(h, [300, 300, 500, 300]);
    twoFingers(h, [300, 300, 500, 300], [300, 180, 500, 180], 0);
    expect(h.camera.tiltDeg).toBeGreaterThan(15);
    expect(h.camera.drags).toBe(0);
    expect(h.camera.zoom).toBe(0);
    expect(h.camera.headingDeg).toBe(0);
  });

  it('does not tilt during a pinch or a two-finger pan', () => {
    for (const to of [
      [250, 280, 550, 280],
      [350, 200, 550, 200],
    ] as const) {
      const h = controlsHarness();
      press(h, [300, 300, 500, 300]);
      // A horizontal start first, then the fingers move up together.
      twoFingers(h, [300, 300, 500, 300], [320, 300, 520, 300], 0, 2);
      twoFingers(h, [320, 300, 520, 300], to, 20);
      expect(h.camera.tiltDeg).toBe(0);
    }
  });

  it('continues without a jump when fingers are added and lifted (F186)', () => {
    const h = controlsHarness();
    touch(h, 'pointerdown', 1, 300, 300, 0);
    h.frame();
    touch(h, 'pointermove', 1, 320, 300, 10);
    h.frame();
    const before = { x: h.camera.centerX, y: h.camera.centerY, z: h.camera.zoom };
    touch(h, 'pointerdown', 2, 500, 300, 20);
    h.frame();
    // The frame of the change makes no camera change: the gesture re-baselines with zero delta.
    expect({ x: h.camera.centerX, y: h.camera.centerY, z: h.camera.zoom }).toEqual(before);
    twoFingers(h, [320, 300, 500, 300], [250, 300, 570, 300], 20);
    const zoomed = h.camera.zoom;
    expect(zoomed).toBeGreaterThan(0.3);
    const after = { x: h.camera.centerX, y: h.camera.centerY };
    touch(h, 'pointerup', 2, 570, 300, 200);
    h.frame();
    expect({ x: h.camera.centerX, y: h.camera.centerY }).toEqual(after);
    const grabbed = h.camera.worldAt({ xPx: 250, yPx: 300 });
    touch(h, 'pointermove', 1, 260, 310, 216);
    h.frame();
    expect(h.camera.zoom).toBe(zoomed);
    touch(h, 'pointermove', 1, 280, 330, 232);
    h.frame();
    expect(h.camera.pixelOf(grabbed).xPx).toBeCloseTo(280, 6);
  });

  it('zooms out one level about the midpoint on a two-finger tap (F172)', () => {
    const h = controlsHarness();
    touch(h, 'pointerdown', 1, 300, 300, 0);
    touch(h, 'pointerdown', 2, 500, 300, 10);
    const mid = h.camera.worldAt({ xPx: 400, yPx: 300 });
    touch(h, 'pointerup', 1, 300, 300, 120);
    touch(h, 'pointerup', 2, 500, 300, 130);
    h.run(2000);
    expect(h.camera.zoom).toBeCloseTo(-1, 9);
    expect(h.camera.pixelOf(mid).xPx).toBeCloseTo(400, 6);
  });

  it('ignores two-finger touches that last too long or move too far', () => {
    for (const [upMs, moveTo] of [
      [400, 500],
      [120, 520],
    ] as const) {
      const h = controlsHarness();
      press(h, [300, 300, 500, 300]);
      touch(h, 'pointermove', 2, moveTo, 300, 50);
      touch(h, 'pointerup', 1, 300, 300, upMs);
      touch(h, 'pointerup', 2, moveTo, 300, upMs);
      h.run(2000);
      expect(h.camera.zoom).toBeGreaterThan(-0.5);
    }
  });

  it('zooms in one level at a double tap, but not after a single tap or a tap then drag (F171)', () => {
    const h = controlsHarness();
    const under = h.camera.worldAt({ xPx: 251, yPx: 220 });
    touch(h, 'pointerdown', 1, 250, 220, 0);
    touch(h, 'pointerup', 1, 250, 220, 80);
    h.run(500);
    expect(h.camera.zoom).toBe(0);
    touch(h, 'pointerdown', 1, 252, 221, 600);
    touch(h, 'pointerup', 1, 252, 221, 680);
    touch(h, 'pointerdown', 1, 251, 220, 750);
    touch(h, 'pointerup', 1, 251, 220, 820);
    h.run(3000);
    expect(h.camera.zoom).toBeCloseTo(1, 9);
    expect(h.camera.pixelOf(under).xPx).toBeCloseTo(251, 6);
    const drag = controlsHarness();
    touch(drag, 'pointerdown', 1, 250, 220, 0);
    touch(drag, 'pointerup', 1, 250, 220, 80);
    touch(drag, 'pointerdown', 1, 250, 220, 150);
    touch(drag, 'pointermove', 1, 300, 220, 200);
    touch(drag, 'pointerup', 1, 300, 220, 500);
    drag.run(2000);
    expect(drag.camera.zoom).toBe(0);
  });

  it('carries a two-finger pan on with inertia when both fingers lift (F180)', () => {
    const h = controlsHarness();
    press(h, [300, 300, 500, 300]);
    const end = twoFingers(h, [300, 300, 500, 300], [400, 300, 600, 300], 0);
    const released = h.camera.centerX;
    touch(h, 'pointerup', 1, 400, 300, end + 5);
    touch(h, 'pointerup', 2, 600, 300, end + 10);
    h.run(h.globe.timeMs + 2000);
    // 1 px/ms for τ = 200 ms: about 200 px more.
    expect(released - h.camera.centerX).toBeGreaterThan(150);
  });
});
