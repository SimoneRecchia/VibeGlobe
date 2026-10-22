import { GlobeError } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { createControls } from './create-controls.js';
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
    for (let i = 0; i < 120; i++) {
      h.frame();
      positions.push(h.camera.centerX);
    }
    // The content keeps moving right, so the center moves left: v0·τ = 1 px/ms × 200 ms in all.
    expect(released - (positions.at(-1) ?? 0)).toBeCloseTo(200, 0);
    expect(released - (positions[0] ?? 0)).toBeCloseTo(200 * (1 - Math.exp(-1000 / 60 / 200)), 3);
    const steps = positions.map((p, i) => (i === 0 ? released : (positions[i - 1] ?? 0)) - p);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThanOrEqual((steps[i - 1] ?? 0) + 1e-9);
    expect(h.camera.centerY).toBe(0);
  });

  it('does not coast after the pointer held still before the release', () => {
    const { h, released } = fling(120);
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
    expect(reference).toBeCloseTo(-200 * (1 - Math.exp(-1.5)), 6);
    for (const hz of [30, 120, 144]) expect(at(hz)).toBeCloseTo(reference, 6);
  });

  it('is quartered under reduced motion', () => {
    const h = controlsHarness({ reducedMotion: 'reduce' });
    h.pointer('pointerdown', { x: 100, y: 300, t: 0 });
    for (let t = 10; t <= 100; t += 10) h.pointer('pointermove', { x: 100 + t, y: 300, t });
    h.frame();
    const start = h.camera.centerX;
    h.pointer('pointerup', { x: 200, y: 300, t: 100 });
    h.run(3000);
    expect(start - h.camera.centerX).toBeCloseTo(50, 0);
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

  it('suppresses the context menu, and leaves rotation off until a globe is connected', () => {
    const h = controlsHarness({}, { connect: false });
    h.fire('contextmenu', {});
    expect(h.prevented()).toBe(1);
    h.pointer('pointerdown', { x: 400, y: 300, t: 0, button: 2 });
    h.pointer('pointermove', { x: 500, y: 300, t: 100, button: 2 });
    h.frame();
    expect(h.camera.headingDeg + h.camera.drags).toBe(0);
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
