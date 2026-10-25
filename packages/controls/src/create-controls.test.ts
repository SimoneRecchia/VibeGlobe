import { GlobeError } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { createControls } from './create-controls.js';
import { DEFAULT_CONTROLS_OPTIONS } from './options.js';
import { controlsHarness } from './test-harness.js';

describe('mouse pan (F178, ADR 0009 §3–4)', () => {
  it('records input in the handlers and drags once per frame, keeping the grabbed point under the pointer', () => {
    const h = controlsHarness();
    h.pointer('pointerdown', { x: 100, y: 100, t: 0 });
    const grabbed = h.camera.worldAt({ xPx: 100, yPx: 100 });
    h.pointer('pointermove', { x: 110, y: 105, t: 10 });
    h.pointer('pointermove', { x: 120, y: 110, t: 20 });
    // Handlers do no camera math.
    expect(h.camera.drags).toBe(0);
    h.frame();
    expect(h.camera.drags).toBe(1);
    expect(h.camera.pixelOf(grabbed)).toEqual({ xPx: 120, yPx: 110 });
    h.frame();
    expect(h.camera.drags).toBe(1);
  });

  it('costs no frame and does not zoom for a single click', () => {
    const h = controlsHarness();
    h.pointer('pointerdown', { x: 100, y: 100, t: 0 });
    h.pointer('pointerup', { x: 100, y: 100, t: 50 });
    h.run(1000);
    expect(h.camera.drags + h.camera.zooms).toBe(0);
  });
});

describe('inertia (F179, ADR 0009 §6)', () => {
  const TAU_MS = DEFAULT_CONTROLS_OPTIONS.inertia.panTauMs;
  /**
   * Drags right at 1 px/ms for 100 ms, releasing at once or after holding still for `holdMs`; returns the harness and
   * the camera at the release, before the release frame (where inertia starts).
   */
  function fling(holdMs: number, dtMs = 1000 / 60) {
    const h = controlsHarness();
    h.pointer('pointerdown', { x: 100, y: 300, t: 0 });
    for (let t = 10; t <= 100; t += 10) h.pointer('pointermove', { x: 100 + t, y: 300, t });
    h.frame(dtMs);
    const released = h.camera.centerX;
    const releasedMs = h.globe.timeMs;
    h.pointer('pointerup', { x: 200, y: 300, t: 100 + holdMs });
    return { h, released, releasedMs };
  }

  it('continues at the release velocity and decays to rest along the drag direction', () => {
    const { h, released } = fling(0);
    const positions: number[] = [];
    for (let i = 0; i < 600; i++) {
      h.frame();
      positions.push(h.camera.centerX);
    }
    // The content keeps moving right, so the center moves left: v0·τ = 1 px/ms × τ in all.
    expect(released - (positions.at(-1) ?? 0)).toBeCloseTo(TAU_MS, 0);
    expect(released - (positions[0] ?? 0)).toBeCloseTo(TAU_MS * (1 - Math.exp(-1000 / 60 / TAU_MS)), 3);
    const steps = positions.map((p, i) => (i === 0 ? released : (positions[i - 1] ?? 0)) - p);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThanOrEqual((steps[i - 1] ?? 0) + 1e-9);
    expect(h.camera.centerY).toBe(0);
    // Every inertia step is marked as coasting for the engine's move events (F200), and the mark is cleared after.
    expect(h.camera.coastingChanges).toBeGreaterThan(10);
    expect(h.camera.coasting).toBe(false);
  });

  it('stops a running API movement on a press, before any drag (KB-127)', () => {
    const h = controlsHarness();
    h.pointer('pointerdown', { x: 100, y: 100, t: 0 });
    h.pointer('pointerup', { x: 100, y: 100, t: 50 });
    h.pointer('pointerdown', { x: 100, y: 100, t: 400, id: 2, pointerType: 'touch' });
    expect(h.camera.movementInterruptions).toBe(2);
  });

  it('does not coast after the pointer held still before the release', () => {
    const { h, released } = fling(150);
    h.run(2000);
    expect(h.camera.centerX).toBe(released);
  });

  it('follows the same trajectory at 30, 60, 120 and 144 Hz (F203)', () => {
    const at = (hz: number) => {
      const { h, released, releasedMs } = fling(0, 1000 / hz);
      h.run(releasedMs + 300 - 1e-6, 1000 / hz);
      // Land exactly 300 ms after the release.
      h.frame(releasedMs + 300 - h.globe.timeMs);
      return h.camera.centerX - released;
    };
    const reference = at(60);
    expect(reference).toBeCloseTo(-TAU_MS * (1 - Math.exp(-300 / TAU_MS)), 6);
    for (const hz of [30, 120, 144]) expect(at(hz)).toBeCloseTo(reference, 6);
  });

  it('continues from the time-correct position after a 250 ms stall, without overshoot (F203)', () => {
    const { h, released, releasedMs } = fling(0);
    h.run(releasedMs + 100);
    h.frame(250);
    // 350 ms after the release, as if no frame had stalled.
    const offset = (ms: number) => -TAU_MS * (1 - Math.exp(-ms / TAU_MS));
    expect(h.camera.centerX - released).toBeCloseTo(offset(h.globe.timeMs - releasedMs), 6);
    h.run(h.globe.timeMs + 10_000);
    expect(h.camera.centerX - released).toBeGreaterThanOrEqual(-TAU_MS - 1e-6);
  });

  it('is quartered under reduced motion', () => {
    const h = controlsHarness({ reducedMotion: 'reduce' });
    h.pointer('pointerdown', { x: 100, y: 300, t: 0 });
    for (let t = 10; t <= 100; t += 10) h.pointer('pointermove', { x: 100 + t, y: 300, t });
    h.frame();
    const start = h.camera.centerX;
    h.pointer('pointerup', { x: 200, y: 300, t: 100 });
    h.run(3000);
    expect(start - h.camera.centerX).toBeCloseTo(TAU_MS / 4, 0);
  });

  /**
   * Presses at x = 100, moves through `moves` ([time, x] pairs), releases at the last x at `releaseMs` and coasts at
   * `frameMs` (a number, or a cycle of irregular intervals); returns how far the glide went and how long it lasted.
   */
  function glide(moves: [number, number][], releaseMs: number, frameMs: number | number[] = 1000 / 60) {
    const h = controlsHarness();
    h.pointer('pointerdown', { x: 100, y: 300, t: 0 });
    for (const [t, x] of moves) h.pointer('pointermove', { x, y: 300, t });
    h.frame();
    const released = h.camera.centerX;
    const releasedMs = h.globe.timeMs;
    h.pointer('pointerup', { x: moves.at(-1)?.[1] ?? 100, y: 300, t: releaseMs });
    const intervals = typeof frameMs === 'number' ? [frameMs] : frameMs;
    let last = released;
    let endMs = releasedMs;
    for (let i = 0; h.globe.timeMs - releasedMs < 20_000; i++) {
      h.frame(intervals[i % intervals.length]);
      if (h.camera.centerX !== last) endMs = h.globe.timeMs;
      last = h.camera.centerX;
    }
    return { distancePx: released - h.camera.centerX, durationMs: endMs - releasedMs };
  }

  /** A trackpad flick: 2 px/ms for 100 ms, then slowing linearly to 0.1 px/ms over 100 ms, events every 8 ms. */
  function trackpadFlick(): [number, number][] {
    const moves: [number, number][] = [];
    let x = 100;
    for (let t = 8; t <= 200; t += 8) {
      const speed = t <= 100 ? 2 : 2 - (1.9 * (t - 100)) / 100;
      x += speed * 8;
      moves.push([t, x]);
    }
    return moves;
  }

  it('glides after a trackpad flick that slows down and lifts 90–120 ms after the last move (KB-177)', () => {
    for (const gapMs of [90, 120]) {
      const { distancePx } = glide(trackpadFlick(), 200 + gapMs);
      // The content keeps moving right, the way the flick went: a real glide, not a dead stop, and no faster than the
      // finger over its last 25 ms (about 0.3 px/ms, so at most 0.3 · 650 px): no jerk forward to the speed it had
      // before slowing down (KB-202).
      expect(distancePx).toBeGreaterThan(5);
      expect(distancePx).toBeLessThan(0.3 * 650);
    }
  });

  it('glides gently after a slow drag (KB-177)', () => {
    const moves: [number, number][] = [];
    for (let t = 20; t <= 600; t += 20) moves.push([t, 100 + t / 20]);
    // 0.05 px/ms: v0·τ ≈ 32 px.
    const { distancePx } = glide(moves, 610);
    expect(distancePx).toBeGreaterThan(10);
    expect(distancePx).toBeLessThan(60);
  });

  it('does not glide after the pointer was held still within 2 px for 150 ms, jitter included (KB-177)', () => {
    const moves = trackpadFlick();
    const x = moves.at(-1)?.[1] ?? 0;
    for (let t = 216; t <= 352; t += 16) moves.push([t, x + (t % 32 === 0 ? 1 : 0)]);
    moves.push([360, x]);
    expect(glide(moves, 360).distancePx).toBe(0);
  });

  it('glides the same distance for the same time at 60 Hz, 120 Hz and irregular frames (KB-177)', () => {
    const reference = glide(trackpadFlick(), 300);
    for (const frames of [1000 / 120, [7, 16.7, 33.3, 8.3, 25, 11]]) {
      const run = glide(trackpadFlick(), 300, frames);
      expect(Math.abs(run.distancePx / reference.distancePx - 1)).toBeLessThan(0.02);
      expect(Math.abs(run.durationMs / reference.durationMs - 1)).toBeLessThan(0.02);
    }
  });

  it('keeps more than a tenth of the release speed 1 s after the release by default (KB-177)', () => {
    const { panTauMs, rotateTauMs } = DEFAULT_CONTROLS_OPTIONS.inertia;
    expect(rotateTauMs).toBe(panTauMs);
    expect(Math.exp(-1000 / panTauMs)).toBeGreaterThan(0.1);
    // Measured on a glide at 1 px/ms: the step over the 17 ms after 1 s still moves faster than 0.1 px/ms.
    const { h, released, releasedMs } = fling(0);
    h.run(releasedMs + 1000);
    const before = h.camera.centerX;
    h.frame();
    expect((before - h.camera.centerX) / (1000 / 60)).toBeGreaterThan(0.1);
    expect(released).toBeGreaterThan(before);
  });
});

describe('wheel and trackpad zoom (F168, F169)', () => {
  it('smooths a notch over several frames, anchored at the cursor, ending exactly one notch further', () => {
    const h = controlsHarness();
    const under = h.camera.worldAt({ xPx: 200, yPx: 150 });
    h.fire('wheel', { clientX: 210, clientY: 170, deltaY: -100, deltaMode: 0, ctrlKey: false });
    const zooms: number[] = [];
    for (let i = 0; i < 60; i++) {
      h.frame();
      zooms.push(h.camera.zoom);
    }
    expect(h.camera.zoom).toBeCloseTo(1 / 3, 9);
    expect(zooms.filter((z, i) => z !== (zooms[i - 1] ?? 0)).length).toBeGreaterThan(4);
    const at = h.camera.pixelOf(under);
    expect(at.xPx).toBeCloseTo(200, 6);
    expect(at.yPx).toBeCloseTo(150, 6);
  });

  it('applies trackpad pixel deltas in the next frame, summed, and pinch (ctrlKey) at a third of the distance', () => {
    const h = controlsHarness();
    h.fire('wheel', { clientX: 210, clientY: 170, deltaY: -3.5, deltaMode: 0, ctrlKey: false });
    h.fire('wheel', { clientX: 210, clientY: 170, deltaY: -2.5, deltaMode: 0, ctrlKey: false });
    h.frame();
    expect(h.camera.zooms).toBe(1);
    expect(h.camera.zoom).toBeCloseTo(6 / 300, 12);
    h.fire('wheel', { clientX: 210, clientY: 170, deltaY: -2, deltaMode: 0, ctrlKey: true });
    h.frame();
    expect(h.camera.zoom).toBeCloseTo(6 / 300 + 2 / 100, 12);
    // With the Ctrl key really held, Ctrl+wheel is a plain wheel.
    h.key('keydown', 'Control');
    h.fire('wheel', { clientX: 210, clientY: 170, deltaY: -3, deltaMode: 0, ctrlKey: true });
    h.frame();
    expect(h.camera.zoom).toBeCloseTo(6 / 300 + 2 / 100 + 3 / 300, 12);
    expect(h.prevented()).toBe(4);
  });

  it('forgets a held Ctrl when the window loses focus, so a later pinch stays a pinch (KB-151)', () => {
    const h = controlsHarness();
    // Ctrl+L: the keyup lands in the address bar.
    h.key('keydown', 'Control');
    h.fireWindow('blur');
    h.fire('wheel', { clientX: 210, clientY: 170, deltaY: -2, deltaMode: 0, ctrlKey: true });
    h.frame();
    expect(h.camera.zoom).toBeCloseTo(2 / 100, 12);
  });

  it('learns a Ctrl held before the page had focus from the mouse moving over the map (KB-151)', () => {
    const h = controlsHarness();
    // No keydown reached the page; the mouse reports the key.
    h.pointer('pointermove', { x: 210, y: 170, t: 0, ctrlKey: true });
    h.fire('wheel', { clientX: 220, clientY: 190, deltaY: -3, deltaMode: 0, ctrlKey: true });
    h.frame();
    expect(h.camera.zoom).toBeCloseTo(3 / 300, 12);
  });

  it('ignores Safari gesture events during a two-finger touch, which iPadOS sends for it too (KB-152)', () => {
    const h = controlsHarness();
    h.pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, pointerType: 'touch' });
    h.pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, pointerType: 'touch' });
    h.fire('gesturestart', {});
    h.fire('gesturechange', { scale: 2, rotation: 10, clientX: 160, clientY: 120 });
    h.frame();
    expect([h.camera.zooms, h.camera.headingDeg]).toEqual([0, 0]);
  });

  it('applies a notch in one step once two animation frames in a row came three time constants late (slow displays)', async () => {
    let host = 0;
    const h = controlsHarness({}, { hostNow: () => host });
    const flush = () => new Promise<void>((done) => queueMicrotask(done));
    /** One notch, its animation's frames 400 ms of host time apart; returns the frames it took. */
    const notch = async (): Promise<number> => {
      h.fire('wheel', { clientX: 210, clientY: 170, deltaY: -100, deltaMode: 0 });
      let frames = 0;
      do {
        h.frame();
        frames++;
        await flush();
        host += 400;
      } while (frames < 50 && Math.abs(h.camera.zoom * 3 - Math.round(h.camera.zoom * 3)) > 1e-9);
      return frames;
    };
    // The first notch animates and measures two slow frames; the next ones apply at once.
    expect(await notch()).toBeGreaterThan(2);
    expect(await notch()).toBe(1);
    expect(await notch()).toBe(1);
    expect(h.camera.zoom).toBeCloseTo(1, 12);
    // After 5 s without a measurement, animations are tried again.
    host += 6000;
    expect(await notch()).toBeGreaterThan(1);
  });

  it('converts line deltas to pixels and caps the lead at two levels', () => {
    const h = controlsHarness();
    for (let i = 0; i < 20; i++) h.fire('wheel', { clientX: 410, clientY: 320, deltaY: -10, deltaMode: 1 });
    h.run(2000);
    expect(h.camera.zoom).toBeCloseTo(2, 9);
  });
});

describe('double-click (F170)', () => {
  it('zooms in exactly one level, animated, anchored at the clicked point', () => {
    const h = controlsHarness();
    const under = h.camera.worldAt({ xPx: 300, yPx: 200 });
    for (const t of [0, 100]) {
      h.pointer('pointerdown', { x: 300, y: 200, t });
      h.pointer('pointerup', { x: 301, y: 200, t: t + 40 });
    }
    h.frame();
    h.frame();
    expect(h.camera.zoom).toBeGreaterThan(0);
    expect(h.camera.zoom).toBeLessThan(1);
    h.run(2000);
    expect(h.camera.zoom).toBeCloseTo(1, 12);
    expect(h.camera.pixelOf(under).xPx).toBeCloseTo(300, 6);
  });
});

describe('rotate and tilt drags (F182, F183)', () => {
  it('right-drag rotates with horizontal and tilts with vertical motion, and Ctrl+drag does the same', () => {
    const results = [{ button: 2 }, { button: 0, ctrlKey: true }].map((press) => {
      const h = controlsHarness();
      h.pointer('pointerdown', { x: 400, y: 300, t: 0, ...press });
      h.pointer('pointermove', { x: 600, y: 300, t: 500, ...press });
      h.frame();
      h.pointer('pointermove', { x: 600, y: 150, t: 1000, ...press });
      h.frame();
      h.pointer('pointerup', { x: 600, y: 150, t: 1200, ...press });
      h.run(2000);
      return [h.camera.headingDeg, h.camera.tiltDeg, h.camera.drags];
    });
    // 180° per viewport width, 90° per viewport height; the center target is not panned.
    expect(results[0]).toEqual([45, 22.5, 0]);
    expect(results[1]).toEqual(results[0]);
  });

  it('ends a Ctrl+drag rotation when Ctrl is released, without starting a pan', () => {
    const h = controlsHarness();
    h.pointer('pointerdown', { x: 400, y: 300, t: 0, ctrlKey: true });
    h.pointer('pointermove', { x: 500, y: 300, t: 100, ctrlKey: true });
    h.frame();
    h.pointer('pointermove', { x: 600, y: 300, t: 200 });
    h.run(1000);
    expect(h.camera.headingDeg).toBe(22.5);
    expect(h.camera.drags).toBe(0);
  });

  it('suppresses the context menu, and rotates through the navigation API without a connected globe', () => {
    const h = controlsHarness({}, { connect: false });
    h.fire('contextmenu', {});
    expect(h.prevented()).toBe(1);
    h.pointer('pointerdown', { x: 400, y: 300, t: 0, button: 2 });
    h.pointer('pointermove', { x: 500, y: 300, t: 100, button: 2 });
    h.frame();
    expect(h.camera.headingDeg).toBeGreaterThan(0);
    expect(h.camera.drags).toBe(0);
  });
});

describe('zoom box (F175)', () => {
  it('draws a box during Shift+drag and on release fits it to the view', () => {
    const h = controlsHarness();
    h.pointer('pointerdown', { x: 100, y: 100, t: 0, shiftKey: true });
    h.pointer('pointermove', { x: 300, y: 250, t: 50, shiftKey: true });
    expect(h.overlays).toHaveLength(1);
    expect(h.overlays[0]?.style).toMatchObject({ left: '110px', top: '120px', width: '200px', height: '150px' });
    const center = h.camera.worldAt({ xPx: 200, yPx: 175 });
    h.pointer('pointerup', { x: 300, y: 250, t: 100, shiftKey: true });
    expect(h.overlays[0]?.removed).toBe(true);
    h.run(2000);
    // 800 / 200 and 600 / 150 are both 4: two levels, with the box center at the screen center.
    expect(h.camera.zoom).toBeCloseTo(2, 9);
    expect(h.camera.pixelOf(center).xPx).toBeCloseTo(400, 6);
    expect(h.camera.pixelOf(center).yPx).toBeCloseTo(300, 6);
  });

  it('cancels with Escape without moving anything', () => {
    const h = controlsHarness();
    h.pointer('pointerdown', { x: 100, y: 100, t: 0, shiftKey: true });
    h.pointer('pointermove', { x: 300, y: 250, t: 50, shiftKey: true });
    h.key('keydown', 'Escape');
    h.pointer('pointerup', { x: 300, y: 250, t: 100, shiftKey: true });
    h.run(2000);
    expect(h.overlays[0]?.removed).toBe(true);
    expect(h.camera.zooms + h.camera.drags).toBe(0);
  });
});

describe('settings and lifecycle', () => {
  it('rejects invalid options with a typed error', () => {
    expect(() => createControls({ inertia: { panTauMs: 0 } })).toThrow(GlobeError);
    expect(() => createControls({ gestures: { dragPan: 'yes' as unknown as boolean } })).toThrow(/gestures.dragPan/);
    expect(() => createControls({ maxTiltDeg: 95 })).toThrow(/maxTiltDeg/);
    expect(() => createControls({ wheel: { unknown: 1 } as never })).toThrow(/wheel.unknown/);
  });

  it('turns gestures off by switch', () => {
    const h = controlsHarness({ gestures: { wheelZoom: false, dragPan: false } });
    h.fire('wheel', { clientX: 210, clientY: 170, deltaY: -100, deltaMode: 0 });
    h.pointer('pointerdown', { x: 100, y: 100, t: 0 });
    h.pointer('pointermove', { x: 200, y: 100, t: 50 });
    h.run(1000);
    expect(h.camera.zooms + h.camera.drags).toBe(0);
  });

  it('owns touch gestures while attached and removes every listener on destroy', () => {
    const h = controlsHarness();
    expect(h.element.style.touchAction).toBe('none');
    h.instance.destroy();
    expect(h.element.listeners.size).toBe(0);
    expect(h.doc.listeners.size).toBe(0);
    expect(h.element.style.touchAction).toBe('auto');
  });
});
