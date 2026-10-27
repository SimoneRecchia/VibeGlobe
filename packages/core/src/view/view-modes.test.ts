import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { createGlobe } from '../globe/create-globe.js';
import type { Globe, ViewInit } from '../globe/types.js';
import { fakeRenderer } from '../globe/test-renderer.js';
import { DEFAULT_VIEW_CURVES } from './curves.js';
import { ViewState } from './view-state.js';

const DEG = Math.PI / 180;

/** A started globe and a function that draws `count` frames. */
async function started(
  view: ViewInit,
): Promise<{ globe: Globe; frames: (count: number) => void; ticks: (count: number) => void }> {
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
  // Display ticks that draw only the frames the engine itself requested.
  const ticks = (count: number): void => {
    for (let i = 0; i < count; i++) {
      renderer.timers.advance(16);
      renderer.flush();
    }
  };
  return { globe, frames, ticks };
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
    // The tilt animates to 0° over a few frames (F162), each frame lower than the last.
    const tilts: number[] = [];
    for (let i = 0; i < 40; i++) {
      frames(1);
      tilts.push(globe.camera.tiltDeg);
    }
    expect(tilts[0]).toBeGreaterThan(0);
    expect(tilts.every((tilt, i) => i === 0 || tilt <= (tilts[i - 1] ?? 0))).toBe(true);
    expect(tilts.at(-1)).toBe(0);
    globe.setViewMode('3d');
    globe.jumpTo({ zoom: 12 });
    // The tilt eases to the chosen one over a few frames, then holds it at region scale too.
    frames(40);
    expect(globe.viewMode).toBe('manual');
    expect(globe.camera.tiltDeg).toBeCloseTo(DEFAULT_VIEW_CURVES.autoTiltDeg, 6);
    globe.setViewMode('auto');
    frames(40);
    expect(globe.camera.tiltDeg).toBe(0);
    // KB-093: the mode event can be subscribed to.
    const modes: string[] = [];
    globe.on('view-mode-change', ({ mode }) => modes.push(mode));
    globe.setViewMode('2d');
    expect(modes).toEqual(['2d']);
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

describe('view transitions keep the frame loop running (KB-095)', () => {
  it('finishes a mode change, a released clamp and new curves without outside render requests', async () => {
    const { globe, frames, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 18 });
    frames(40);
    globe.setViewMode('2d');
    ticks(60);
    expect(globe.camera.tiltDeg).toBe(0);
    // A view whose ground does not reach the polar caps, which keep the globe round (KB-211).
    globe.jumpTo({ zoom: 5.5 });
    frames(1);
    globe.setViewCurves({ morph: { startGroundZoom: 5, endGroundZoom: 7 } });
    ticks(60);
    // Ground zoom 6 (zoom 5.5 at 45°): smootherstep(5, 7, 6).
    expect(globe.camera.morphFactor).toBeCloseTo(0.5, 4);
    globe.setViewCurves({});
    ticks(60);
    // The default band, 4 to 6.5: smootherstep(4, 6.5, 6).
    expect(globe.camera.morphFactor).toBeCloseTo(0.94208, 4);
    globe.destroy();
  });
});

describe('chosen and applied tilt and heading (F164)', () => {
  it('changes the chosen values only on explicit tilt and heading input, over random zooms, pans and curve changes', async () => {
    const { globe, frames } = await started({
      longitudeDeg: 9,
      latitudeDeg: 45,
      zoom: 15,
      tiltDeg: 60,
      headingDeg: 20,
    });
    let expectedTiltDeg = 60;
    let expectedHeadingDeg = 20;
    // A seeded generator (mulberry32): the sequence is the same on every run.
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let step = 0; step < 300; step++) {
      const kind = Math.floor(random() * 5);
      if (kind === 0) globe.jumpTo({ zoom: 1 + random() * 18 });
      else if (kind === 1) globe.jumpTo({ longitudeDeg: -180 + random() * 360, latitudeDeg: -80 + random() * 160 });
      else if (kind === 2) {
        const start = 2 + random() * 8;
        globe.setViewCurves({ morph: { startGroundZoom: start, endGroundZoom: start + 0.5 + random() * 3 } });
      } else if (kind === 3) globe.navigation.zoomAt({ xPx: random() * 800, yPx: random() * 600 }, random() * 4 - 2);
      else {
        // Explicit input: the only steps that may change the choice.
        expectedTiltDeg = Math.round(random() * 85);
        // The public heading wraps into [−180°, 180°).
        expectedHeadingDeg = Math.round(random() * 359) - 180;
        globe.jumpTo({ tiltDeg: expectedTiltDeg, headingDeg: expectedHeadingDeg });
      }
      frames(1 + Math.floor(random() * 3));
      const camera = globe.camera;
      expect(camera.viewMode).toBe('manual');
      expect(camera.chosenTiltDeg).toBeCloseTo(expectedTiltDeg, 6);
      expect(camera.chosenHeadingDeg).toBeCloseTo(expectedHeadingDeg, 6);
      // The applied tilt is the public one, at most the choice (clamps only lower it).
      expect(camera.tiltDeg).toBeLessThanOrEqual(expectedTiltDeg + 1e-6);
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
    // At zoom 2 the horizon would sit below the top third at 60°: the limit is about 45° (KB-108).
    expect(clamped).toBeLessThan(50);
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

  it('lowers the tilt only as far as the surface probed under the eye requires (KB-096)', () => {
    const view = new ViewState(DEFAULT_VIEW_CURVES);
    view.chooseTilt(80 * DEG);
    const camera = new Camera();
    camera.widthPx = 800;
    camera.heightPx = 600;
    camera.pose.rangeMeters = 2000;
    camera.update();
    // A 1,900 m wall from 1,500 m behind the target: the eye must stay in front of it, not climb above it.
    const wall = {
      probeGround: (c: Camera): void => {
        c.groundHeightMeters = Math.sin(c.pose.tiltRad) * c.pose.rangeMeters > 1500 ? 1900 : 0;
      },
    };
    view.applyTilt(camera, 10, wall);
    const limitDeg = Math.asin(1500 / 2000) / DEG;
    expect(camera.pose.tiltRad / DEG).toBeLessThanOrEqual(limitDeg);
    expect(camera.pose.tiltRad / DEG).toBeGreaterThan(limitDeg - 0.05);
    expect(view.chosenTiltRad).toBeCloseTo(80 * DEG, 12);
  });

  it('keeps the tilt when even a vertical view leaves the eye under the terrain: the target is lifted instead (KB-104)', () => {
    const view = new ViewState(DEFAULT_VIEW_CURVES);
    view.chooseTilt(55 * DEG);
    const camera = new Camera();
    camera.widthPx = 320;
    camera.heightPx = 240;
    camera.pose.rangeMeters = 5;
    camera.update();
    // A jump leaves the target on the ellipsoid under a 3,800 m mountain until the frame lifts it.
    const mountain = { probeGround: (c: Camera): void => void (c.groundHeightMeters = 3800) };
    view.applyTilt(camera, 2, mountain);
    expect(camera.pose.tiltRad / DEG).toBeCloseTo(55, 9);
  });

  it('climbs back from the tilt a limit lowered by at most 4° a frame when even a vertical view stops clearing, instead of jumping back up (KB-153, KB-170)', () => {
    const view = new ViewState(DEFAULT_VIEW_CURVES);
    view.chooseTilt(55 * DEG);
    const camera = new Camera();
    camera.widthPx = 320;
    camera.heightPx = 240;
    camera.pose.rangeMeters = 2000;
    camera.update();
    // A slope whose ground rises under the eye as the view tilts: the limit holds the tilt below the wanted 55°.
    const slope = {
      probeGround: (c: Camera): void =>
        void (c.groundHeightMeters = c.eyeGeodetic.heightMeters - 1000 + 1500 * Math.sin(c.pose.tiltRad)),
    };
    view.applyTilt(camera, 2, slope);
    const limited = camera.pose.tiltRad / DEG;
    expect(limited).toBeLessThan(54);
    // Then the ground rises above even a vertical view's eye.
    const above = { probeGround: (c: Camera): void => void (c.groundHeightMeters = c.eyeGeodetic.heightMeters + 50) };
    view.applyTilt(camera, 2, above);
    expect(camera.pose.tiltRad / DEG).toBeGreaterThan(limited);
    expect(camera.pose.tiltRad / DEG - limited).toBeLessThanOrEqual(4 + 1e-9);
  });

  it('lowers the tilt under the terrain limit by at most 4° a frame (KB-170)', () => {
    const view = new ViewState(DEFAULT_VIEW_CURVES);
    view.chooseTilt(45 * DEG);
    const camera = new Camera();
    camera.widthPx = 320;
    camera.heightPx = 240;
    camera.pose.rangeMeters = 2000;
    camera.update();
    const flat = { probeGround: (c: Camera): void => void (c.groundHeightMeters = 0) };
    view.applyTilt(camera, 2, flat);
    expect(camera.pose.tiltRad / DEG).toBeCloseTo(45, 6);
    // The flank rises under the eye at once: the limit falls to about 20°, the tilt follows over several frames.
    const flank = {
      probeGround: (c: Camera): void =>
        void (c.groundHeightMeters = c.eyeGeodetic.heightMeters - 1880 * Math.cos(c.pose.tiltRad) + 1700),
    };
    let previous = 45;
    let relief = view.morph.factors[1] ?? 0;
    for (let frame = 0; frame < 16; frame++) {
      view.applyTilt(camera, 2, flank);
      const tilt = camera.pose.tiltRad / DEG;
      expect(previous - tilt, `frame ${frame}`).toBeLessThanOrEqual(4 + 1e-9);
      expect(relief - (view.morph.factors[1] ?? 0), `frame ${frame}`).toBeLessThan(0.065);
      previous = tilt;
      relief = view.morph.factors[1] ?? 0;
    }
    expect(previous).toBeLessThan(26);
    // Then the target sinks under the flank (a movement writes it onto the ellipsoid): no tilt clears, the lift keeps
    // the eye clear, and the tilt climbs back to the chosen 45° a step a frame instead of staying lowered.
    const under = { probeGround: (c: Camera): void => void (c.groundHeightMeters = c.eyeGeodetic.heightMeters + 50) };
    for (let frame = 0; frame < 30; frame++) {
      view.applyTilt(camera, 2, under);
      const tilt = camera.pose.tiltRad / DEG;
      expect(tilt - previous, `frame ${frame}`).toBeLessThanOrEqual(4 + 1e-9);
      previous = tilt;
    }
    expect(previous).toBeCloseTo(45, 3);
  });
});

describe('view regressions of the M5 review', () => {
  it('keeps the point under the cursor when a wheel zoom crosses the Auto tilt band (KB-098)', async () => {
    const { globe, frames } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 14 });
    frames(3);
    const cursor = { xPx: 700, yPx: 100 };
    for (let step = 0; step < 8; step++) {
      const grabbed = globe.screenToGeo(cursor);
      if (!grabbed) throw new Error('off the globe');
      globe.navigation.zoomAt(cursor, 0.25);
      frames(3);
      const shown = globe.geoToScreen(grabbed);
      expect(
        Math.hypot((shown?.xPx ?? NaN) - cursor.xPx, (shown?.yPx ?? NaN) - cursor.yPx),
        `step ${step}`,
      ).toBeLessThan(0.5);
    }
    globe.destroy();
  });

  it('eases a mode change over the same time whatever the frame rate (KB-099)', () => {
    const tiltAfter = (stepMs: number): number => {
      const view = new ViewState(DEFAULT_VIEW_CURVES);
      const camera = new Camera();
      camera.widthPx = 800;
      camera.heightPx = 600;
      camera.pose.rangeMeters = 300;
      camera.update();
      // Street scale in Auto: the curve's 50° tilt, applied.
      view.frameTimeMs[0] = 0;
      view.applyTilt(camera, 0);
      view.setMode('2d');
      for (let time = stepMs; time <= 192; time += stepMs) {
        view.frameTimeMs[0] = time;
        view.applyTilt(camera, 0);
      }
      return camera.pose.tiltRad / DEG;
    };
    // 120 Hz and 30 Hz reach the same tilt after the same 192 ms.
    expect(tiltAfter(8)).toBeGreaterThan(1);
    expect(tiltAfter(8)).toBeCloseTo(tiltAfter(32), 6);
  });
});

describe('the globe stays round where the view reaches a polar cap (KB-211)', () => {
  /** The morph factor of a 480 × 360 view at a target latitude and Mercator zoom (ground zoom when `ground`). */
  const morphAt = (latitudeDeg: number, zoom: number, ground = false): number => {
    const view = new ViewState(DEFAULT_VIEW_CURVES);
    const camera = new Camera();
    camera.widthPx = 480;
    camera.heightPx = 360;
    camera.pose.targetLatitudeRad = latitudeDeg * DEG;
    // The range of Mercator zoom `zoom` at that latitude: ground zoom plus log2 of the Mercator scale.
    const scale = ground ? 1 : 1 / Math.cos(Math.min(Math.abs(latitudeDeg), 85.0511) * DEG);
    const metersPerPixel = (2 * Math.PI * 6378137) / 512 / 2 ** (zoom + Math.log2(scale));
    camera.pose.rangeMeters = (metersPerPixel * camera.heightPx) / 2 / Math.tan(camera.fovYRad / 2);
    camera.update();
    view.update(camera);
    return view.morph.factors[0] ?? 0;
  };

  it('does not flatten a view that shows the pole or the cap beyond 85.05°, north or south', () => {
    // The Mercator plane cannot show the caps: zoomed in there it drew a band ending at the pole, nothing beyond.
    expect(morphAt(89.9, 5)).toBe(0);
    expect(morphAt(-89.9, 5)).toBe(0);
    expect(morphAt(86, 8)).toBe(0);
    expect(morphAt(82, 3)).toBe(0);
  });

  it('flattens as before where the caps are out of view, and eases in between', () => {
    expect(morphAt(45, 8)).toBe(1);
    expect(morphAt(70, 8)).toBe(1);
    expect(morphAt(84.9, 15)).toBe(1);
    // Panning north keeps the camera's range: the factor falls without a jump.
    let previous = morphAt(60, 7, true);
    expect(previous).toBe(1);
    for (let latitude = 60; latitude <= 90; latitude += 0.02) {
      const m = morphAt(latitude, 7, true);
      expect(Math.abs(m - previous), `${latitude.toFixed(2)}°`).toBeLessThan(0.05);
      previous = m;
    }
    expect(previous).toBe(0);
  });
});
