import { describe, expect, it } from 'vitest';
import { controlsHarness } from './test-harness.js';

describe('keyboard (F181, F187, F174, F213)', () => {
  it('pans while an arrow is held, with an eased start and stop, in the matching direction', () => {
    const h = controlsHarness();
    h.key('keydown', 'ArrowRight');
    expect(h.prevented()).toBe(1);
    const steps: number[] = [];
    let last = h.camera.centerX;
    for (let i = 0; i < 60; i++) {
      h.frame();
      steps.push(h.camera.centerX - last);
      last = h.camera.centerX;
    }
    h.key('keyup', 'ArrowRight');
    for (let i = 0; i < 60; i++) {
      h.frame();
      steps.push(h.camera.centerX - last);
      last = h.camera.centerX;
    }
    // The view moves right; speed rises to 0.8 viewport heights per second, then falls back to rest.
    expect(steps.every((s) => s >= 0)).toBe(true);
    expect(steps[2]).toBeLessThan(steps[30] ?? 0);
    expect(steps[30]).toBeCloseTo((0.8 * 600) / 60, 0);
    expect(steps.at(-1)).toBeLessThan(0.05);
    expect(h.camera.centerY).toBeCloseTo(0, 9);
  });

  it('moves the same distance at 30 and 144 Hz (F203)', () => {
    const distance = (hz: number) => {
      const h = controlsHarness();
      h.key('keydown', 'ArrowUp');
      h.frame(1000 / hz);
      h.run(1000, 1000 / hz);
      return h.camera.centerY;
    };
    expect(distance(30)).toBeCloseTo(distance(144), 6);
  });

  it('rotates with Shift+Left/Right and tilts with Shift+Up/Down', () => {
    const h = controlsHarness();
    h.key('keydown', 'Shift');
    h.key('keydown', 'ArrowRight', { shiftKey: true });
    h.run(1000);
    h.key('keyup', 'ArrowRight', { shiftKey: true });
    h.key('keydown', 'ArrowUp', { shiftKey: true });
    h.run(2000);
    h.key('keyup', 'ArrowUp', { shiftKey: true });
    h.run(4000);
    expect(h.camera.headingDeg).toBeGreaterThan(60);
    expect(h.camera.tiltDeg).toBeGreaterThan(30);
    expect(h.camera.drags).toBe(0);
  });

  it('zooms by one level per +/- press about the center, and rapid presses accumulate', () => {
    const h = controlsHarness();
    const center = h.camera.worldAt({ xPx: 400, yPx: 300 });
    for (let i = 0; i < 5; i++) h.key('keydown', '+');
    h.frame();
    const zooms: number[] = [];
    for (let i = 0; i < 120; i++) {
      h.frame();
      zooms.push(h.camera.zoom);
    }
    expect(h.camera.zoom).toBeCloseTo(5, 9);
    expect(h.camera.pixelOf(center).xPx).toBeCloseTo(400, 6);
    h.key('keydown', '-');
    h.controls.zoomOut();
    h.controls.zoomIn();
    h.run(h.globe.timeMs + 2000);
    expect(h.camera.zoom).toBeCloseTo(4, 9);
  });

  it('turns to north up along the shortest arc with N', () => {
    const h = controlsHarness();
    h.camera.headingDeg = 300;
    h.key('keydown', 'n');
    h.frame();
    h.frame();
    expect(h.camera.headingDeg).toBeGreaterThan(300);
    h.run(3000);
    expect(Math.min(h.camera.headingDeg, 360 - h.camera.headingDeg)).toBeCloseTo(0, 9);
  });

  it('leaves keys with Ctrl, Alt or Meta to the browser and releases held keys on blur', () => {
    const h = controlsHarness();
    h.key('keydown', 'ArrowLeft', { ctrlKey: true });
    h.key('keydown', '+', { metaKey: true });
    h.run(500);
    expect(h.prevented()).toBe(0);
    expect(h.camera.drags + h.camera.zooms).toBe(0);
    h.key('keydown', 'ArrowLeft');
    h.fire('blur', {});
    h.run(3000);
    expect(Math.abs(h.camera.centerX)).toBeLessThan(40);
  });

  it('flies home with Home and switches view modes with 2, 3 and A when the engine has them', () => {
    const h = controlsHarness();
    const calls: string[] = [];
    Object.assign(h.globe, {
      goHome: () => void calls.push('home'),
      setViewMode: (mode: string) => void calls.push(mode),
    });
    for (const key of ['Home', '2', '3', 'a']) h.key('keydown', key);
    expect(calls).toEqual(['home', '2d', '3d', 'auto']);
    expect(h.prevented()).toBe(4);
  });

  it('shows a focus ring when focused from the keyboard', () => {
    const h = controlsHarness();
    h.fire('focus', {});
    expect(h.element.style.outline).not.toBe('');
    h.fire('blur', {});
    expect(h.element.style.outline).toBe('');
    h.element.focusVisible = false;
    h.fire('focus', {});
    expect(h.element.style.outline).toBe('');
  });
});
