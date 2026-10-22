import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { createGlobe } from '../globe/create-globe.js';
import type { Globe, ViewInit } from '../globe/types.js';
import { fakeRenderer } from '../globe/test-renderer.js';
import { DEFAULT_VIEW_CURVES } from './curves.js';
import { ViewState } from './view-state.js';

const DEG = Math.PI / 180;

/** A started globe and a function that draws `count` frames. */
async function started(view: ViewInit): Promise<{ globe: Globe; frames: (count: number) => void }> {
  const { renderer, factory } = fakeRenderer();
  const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', view });
  await Promise.resolve();
  await Promise.resolve();
  renderer.flush();
  await globe.ready;
  const frames = (count: number): void => {
    for (let i = 0; i < count; i++) {
      globe.requestRender();
      renderer.timers.advance(16);
      renderer.flush();
    }
  };
  return { globe, frames };
}

describe('view modes (F161–F164)', () => {
  it('starts in Auto, where the zoom curves tilt only at street scale', async () => {
    const { globe, frames } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 12 });
    frames(2);
    expect(globe.viewMode).toBe('auto');
    expect(globe.camera.tiltDeg).toBe(0);
    globe.jumpTo({ zoom: 18 });
    // A jump across the tilt band: the applied tilt eases to the curve's.
    frames(40);
    expect(globe.camera.tiltDeg).toBeCloseTo(DEFAULT_VIEW_CURVES.autoTiltDeg, 6);
    expect(globe.camera.viewMode).toBe('auto');
    globe.destroy();
  });

  it('keeps 0° at every zoom in 2D, chooses the default tilt in 3D and restores the curves in Auto', async () => {
    const { globe, frames } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 18 });
    globe.setViewMode('2d');
    frames(1);
    expect(globe.camera.tiltDeg).toBe(0);
    globe.setViewMode('3d');
    globe.jumpTo({ zoom: 12 });
    // The tilt eases to the chosen one over a few frames, then holds it at region scale too.
    frames(40);
    expect(globe.viewMode).toBe('manual');
    expect(globe.camera.tiltDeg).toBeCloseTo(DEFAULT_VIEW_CURVES.autoTiltDeg, 6);
    globe.setViewMode('auto');
    frames(1);
    expect(globe.camera.tiltDeg).toBe(0);
    expect(() => globe.setViewMode('globe' as '2d')).toThrow(expect.objectContaining({ code: 'invalid-option' }));
    globe.destroy();
  });

  it('keeps a chosen tilt and heading at every zoom, apart from the applied values', async () => {
    const { globe, frames } = await started({
      longitudeDeg: 9,
      latitudeDeg: 45,
      zoom: 15,
      tiltDeg: 30,
      headingDeg: 40,
    });
    frames(1);
    expect(globe.viewMode).toBe('manual');
    for (const zoom of [15, 10, 7]) {
      globe.jumpTo({ zoom });
      frames(40);
      expect(globe.camera.chosenTiltDeg).toBeCloseTo(30, 9);
      expect(globe.camera.tiltDeg).toBeCloseTo(30, 6);
      expect(globe.camera.chosenHeadingDeg).toBeCloseTo(40, 9);
    }
    globe.destroy();
  });
});

describe('temporary tilt clamps (F165, F166)', () => {
  it('lowers the applied tilt where empty sky would fill the screen and restores the chosen one smoothly', async () => {
    const { globe, frames } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 15, tiltDeg: 60 });
    globe.jumpTo({ zoom: 2 });
    frames(1);
    const clamped = globe.camera.tiltDeg;
    expect(clamped).toBeLessThan(30);
    expect(globe.camera.chosenTiltDeg).toBeCloseTo(60, 9);
    globe.jumpTo({ zoom: 15 });
    const tilts: number[] = [];
    for (let i = 0; i < 40; i++) {
      frames(1);
      tilts.push(globe.camera.tiltDeg);
    }
    // Back to the choice over several frames, each step a fraction of the way.
    expect(tilts.at(-1)).toBeCloseTo(60, 6);
    const steps = tilts.map((tilt, i) => tilt - (tilts[i - 1] ?? clamped));
    expect(steps.every((step) => step >= 0 && step < 0.3 * (60 - clamped) + 1e-9)).toBe(true);
    expect(steps.filter((step) => step > 0).length).toBeGreaterThan(4);
    globe.destroy();
  });

  it('lowers the applied tilt where the eye would enter the terrain, and only while it would', () => {
    const view = new ViewState(DEFAULT_VIEW_CURVES);
    view.chooseTilt(80 * DEG);
    const camera = new Camera();
    camera.widthPx = 800;
    camera.heightPx = 600;
    camera.pose.rangeMeters = 2000;
    camera.update();
    // A cliff under the eye 1,900 m above the target: the eye must stay 10 m above it.
    camera.groundHeightMeters = 1900;
    view.applyTilt(camera, 10);
    const clamped = camera.pose.tiltRad;
    expect(Math.cos(clamped) * 2000).toBeGreaterThanOrEqual(1910 - 1);
    expect(view.chosenTiltRad).toBeCloseTo(80 * DEG, 12);
    // The cliff passes: the tilt rises back over frames.
    camera.groundHeightMeters = 0;
    view.applyTilt(camera, 10);
    expect(camera.pose.tiltRad).toBeGreaterThan(clamped);
    expect(camera.pose.tiltRad).toBeLessThan(80 * DEG);
  });
});
