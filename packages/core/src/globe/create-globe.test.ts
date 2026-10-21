import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { createGlobe } from './create-globe.js';
import { GlobeError } from './errors.js';
import { fakeRenderer } from './test-renderer.js';
import type { GeoPosition, GlobeOptions, NavigationApi, ScreenPoint } from './types.js';

async function started(overrides: Partial<GlobeOptions> = {}) {
  const { renderer, factory } = fakeRenderer();
  const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'world.jpg', ...overrides });
  await Promise.resolve();
  await Promise.resolve();
  renderer.flush();
  await globe.ready;
  return { globe, renderer };
}

describe('createGlobe', () => {
  it('draws a first frame, resolves ready and reports WGS84 degrees and meters', async () => {
    const { globe, renderer } = await started({ view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 4 } });
    expect(globe.frameNumber).toBe(1);
    expect(renderer.drawCount).toBe(1);
    expect(renderer.lastTiles).toBeGreaterThan(0);
    expect(globe.backend).toBe('webgl2');
    const camera = globe.camera;
    expect(camera.longitudeDeg).toBeCloseTo(12.5, 9);
    expect(camera.latitudeDeg).toBeCloseTo(41.9, 9);
    expect(camera.zoom).toBeCloseTo(4, 9);
    const center = globe.screenToGeo({ xPx: 400, yPx: 300 });
    expect(center?.longitudeDeg).toBeCloseTo(12.5, 6);
    expect(center?.latitudeDeg).toBeCloseTo(41.9, 6);
    expect(globe.screenToGeo({ xPx: 0, yPx: 0 })).toBeDefined();
  });

  it('keeps the ground scale when a jump changes only the position, even to a pole', async () => {
    const { globe } = await started({ view: { longitudeDeg: 0, latitudeDeg: 0, zoom: 1 } });
    const range = globe.camera.rangeMeters;
    globe.jumpTo({ latitudeDeg: 90 });
    expect(globe.camera.rangeMeters).toBeCloseTo(range, 3);
    globe.jumpTo({ latitudeDeg: 89.9, zoom: 1 });
    expect(Number.isFinite(globe.camera.rangeMeters)).toBe(true);
    expect(globe.camera.rangeMeters).toBeGreaterThan(range / 20);
  });

  it('renders only on demand and stops when nothing changes (F062)', async () => {
    const { globe, renderer } = await started();
    expect(renderer.flush()).toBe(0);
    globe.navigation.zoomAt({ xPx: 400, yPx: 300 }, 1);
    expect(renderer.flush()).toBe(1);
    expect(renderer.flush()).toBe(0);
    expect(globe.frameNumber).toBe(2);
  });

  it('asks the host for unreported size and pixel-ratio changes at the start of every frame (KB-011)', async () => {
    const { globe, renderer } = await started();
    // The host notices a change no browser event reported (a pixel ratio under some emulations).
    renderer.size = { widthPx: 640, heightPx: 480 };
    renderer.unreportedResize = true;
    globe.requestRender();
    renderer.flush();
    expect(renderer.lastResize).toEqual({ widthPx: 640, heightPx: 480 });
    expect(renderer.unreportedResize).toBe(false);
    // The frame that found the change draws at the new size itself, so no further frame is needed (KB-013).
    expect(renderer.flush()).toBe(0);
  });

  it('draws the new size in the resize callback itself, so no cleared canvas is ever shown (F070, KB-013)', async () => {
    const { globe, renderer } = await started();
    const before = renderer.drawCount;
    renderer.size = { widthPx: 500, heightPx: 400 };
    renderer.resizeListener?.();
    expect(renderer.lastResize).toEqual({ widthPx: 500, heightPx: 400 });
    expect(renderer.drawCount).toBe(before + 1);
    expect(globe.frameNumber).toBe(2);
    expect(renderer.flush()).toBe(0);
  });

  it('keeps a jump made before the renderer is ready (KB-014)', async () => {
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w.jpg', view: { zoom: 2 } });
    globe.jumpTo({ longitudeDeg: 30, latitudeDeg: 50, zoom: 6 });
    // Before the viewport is known, the camera reports the requested view.
    expect(globe.camera.longitudeDeg).toBeCloseTo(30, 9);
    expect(globe.camera.zoom).toBeCloseTo(6, 9);
    globe.jumpTo({ latitudeDeg: 0 });
    await Promise.resolve();
    await Promise.resolve();
    renderer.flush();
    await globe.ready;
    expect(globe.camera.longitudeDeg).toBeCloseTo(30, 9);
    expect(globe.camera.latitudeDeg).toBeCloseTo(0, 9);
    // A position-only jump keeps the ground scale, as after start: zoom 6 at 50° is zoom 6 + log2(1/cos 50°) at 0°.
    expect(globe.camera.zoom).toBeCloseTo(6 + Math.log2(1 / Math.cos((50 * Math.PI) / 180)), 6);
  });

  it('keeps the eye at least 0.5 m above the ground at the steepest tilt (KB-015)', async () => {
    const { globe } = await started({ view: { latitudeDeg: 45, zoom: 2 } });
    globe.jumpTo({ tiltDeg: 89, zoom: 28 });
    expect(globe.camera.altitudeMeters).toBeGreaterThanOrEqual(0.5);
  });

  it('keeps the eye at least 0.5 m above the ground when only the tilt changes (KB-027)', async () => {
    const { globe } = await started({ view: { latitudeDeg: 45, zoom: 28 } });
    globe.jumpTo({ tiltDeg: 89 });
    expect(globe.camera.altitudeMeters).toBeGreaterThanOrEqual(0.5);
  });

  it('rejects ready with a typed error when destroyed before the first frame (KB-016)', async () => {
    const { factory } = fakeRenderer();
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w.jpg' });
    globe.destroy();
    await expect(globe.ready).rejects.toMatchObject({ code: 'destroyed' });
  });

  it('draws nothing while hidden and resumes on the next frame when shown (F063)', async () => {
    const { globe, renderer } = await started();
    renderer.visibility?.(false);
    globe.jumpTo({ zoom: 3 });
    expect(renderer.flush()).toBe(0);
    renderer.visibility?.(true);
    expect(renderer.flush()).toBe(1);
  });

  it('keeps the grabbed point under the cursor when dragging (F060)', async () => {
    const { globe } = await started({ view: { longitudeDeg: 0, latitudeDeg: 30, zoom: 3 } });
    const anchor = globe.navigation.grab({ xPx: 300, yPx: 250 });
    expect(anchor).toBeDefined();
    if (!anchor) return;
    globe.navigation.dragTo(anchor, { xPx: 520, yPx: 380 });
    const now = globe.screenToGeo({ xPx: 520, yPx: 380 });
    expect(now?.longitudeDeg).toBeCloseTo(anchor.longitudeDeg, 6);
    expect(now?.latitudeDeg).toBeCloseTo(anchor.latitudeDeg, 6);
  });

  it('zooms at the cursor, keeping the point under it within one pixel, down to about 1 m (F061)', async () => {
    const { globe } = await started({ view: { longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 2 } });
    const cursor = { xPx: 250, yPx: 200 };
    for (let i = 0; i < 300; i++) {
      const anchor = globe.screenToGeo(cursor);
      if (!anchor) throw new Error('cursor left the globe');
      globe.navigation.zoomAt(cursor, 0.25);
      const moved = globe.geoToScreen(anchor);
      expect(Math.hypot((moved?.xPx ?? NaN) - cursor.xPx, (moved?.yPx ?? NaN) - cursor.yPx)).toBeLessThan(1);
    }
    expect(globe.camera.altitudeMeters).toBeGreaterThanOrEqual(0.5);
    expect(globe.camera.altitudeMeters).toBeLessThan(1.5);
    for (let i = 0; i < 300; i++) globe.navigation.zoomAt(cursor, -0.25);
    expect(globe.camera.zoom).toBeLessThan(3);
  });

  it('reports device events and frees everything on destroy (F068)', async () => {
    const { globe, renderer } = await started();
    const lost: string[] = [];
    globe.on('device-lost', ({ reason }) => lost.push(reason));
    globe.simulateDeviceLoss();
    expect(lost).toEqual(['simulated']);
    globe.destroy();
    expect(renderer.destroyed).toBe(true);
    expect(renderer.meshes.size).toBe(0);
    expect(globe.resourceCounts()).toEqual({ meshes: 0, textures: 0, gpuBytes: 0, vertexArrays: 0, contexts: 0 });
    expect(() => globe.jumpTo({ zoom: 2 })).toThrow(GlobeError);
    expect(() => globe.requestRender()).toThrowError(/destroyed/);
  });

  it('moves the controls to the new canvas after a recovery (KB-020)', async () => {
    const attached: unknown[] = [];
    let detached = 0;
    const { renderer } = await started({
      controls: (element) => {
        attached.push(element);
        return { destroy: () => detached++ };
      },
    });
    const replacement = { canvas: 'new' };
    renderer.inputElement = replacement;
    renderer.events?.deviceRestored();
    expect(attached).toHaveLength(2);
    expect(attached[1]).toBe(replacement);
    expect(detached).toBe(1);
  });

  it('lets the controls turn recorded input into intents at the start of a frame, drawn by that frame (ADR 0009)', async () => {
    let navigation: NavigationApi | undefined;
    const input: { pending?: ScreenPoint | undefined; anchor?: GeoPosition | undefined } = {};
    const { globe, renderer } = await started({
      controls: (_element, api) => {
        navigation = api;
        return {
          update: () => {
            if (!input.pending || !input.anchor) return;
            api.dragTo(input.anchor, input.pending);
            input.pending = undefined;
          },
          destroy: () => undefined,
        };
      },
    });
    const anchor = navigation?.grab({ xPx: 400, yPx: 300 });
    expect(anchor).toBeDefined();
    input.anchor = anchor;
    // A DOM handler records a position and asks for a frame; nothing moves until the frame runs.
    input.pending = { xPx: 450, yPx: 320 };
    const before = globe.camera.longitudeDeg;
    navigation?.requestUpdate();
    expect(globe.camera.longitudeDeg).toBe(before);
    expect(renderer.flush()).toBe(1);
    const shown = globe.geoToScreen(anchor as GeoPosition);
    expect(shown?.xPx).toBeCloseTo(450, 2);
    expect(shown?.yPx).toBeCloseTo(320, 2);
    // The intent was drawn by the frame that applied it: no further frame is pending.
    expect(renderer.flush()).toBe(0);
  });

  it('rejects ready with a typed error when the renderer cannot start (F055)', async () => {
    const errors: string[] = [];
    const globe = createGlobe({
      container: {},
      baseImageryUrl: 'world.jpg',
      renderer: () => Promise.reject(new GlobeError('unsupported-device', 'No WebGPU or WebGL2')),
    });
    globe.on('error', (error) => errors.push(error.code));
    await expect(globe.ready).rejects.toMatchObject({ code: 'unsupported-device' });
    expect(errors).toEqual(['unsupported-device']);
  });
});

describe('input validation (F050)', () => {
  it('rejects invalid options and coordinates with typed, descriptive errors', async () => {
    const { factory } = fakeRenderer();
    const base = { container: {}, renderer: factory, baseImageryUrl: 'world.jpg' };
    expect(() => createGlobe({ ...base, renderer: 3 } as unknown as GlobeOptions)).toThrowError(/renderer/);
    expect(() => createGlobe({ ...base, baseImageryUrl: '' })).toThrowError(/baseImageryUrl/);
    expect(() => createGlobe({ ...base, resolutionScale: -1 })).toThrowError(/resolutionScale/);
    expect(() => createGlobe({ ...base, minSurfaceLevel: 2.5 })).toThrowError(/minSurfaceLevel/);
    expect(() => createGlobe({ ...base, minSurfaceLevel: 9 })).toThrowError(/minSurfaceLevel/);
    expect(() => createGlobe({ ...base, view: { latitudeDeg: 91 } })).toThrowError(/latitudeDeg/);
    expect(() => createGlobe({ ...base, view: { zoom: Number.NaN } })).toThrowError(/zoom/);
    const { globe } = await started();
    const before = globe.camera;
    const reported: string[] = [];
    globe.on('error', (error) => reported.push(error.code));
    expect(() => globe.jumpTo({ latitudeDeg: -120 })).toThrow(GlobeError);
    expect(globe.camera).toEqual(before);
    expect(reported).toEqual(['invalid-coordinate']);
  });

  test.prop([fc.anything()])('never throws anything but a GlobeError for arbitrary options', (options) => {
    try {
      createGlobe(options as GlobeOptions).destroy();
    } catch (error) {
      expect(error).toBeInstanceOf(GlobeError);
    }
  });

  test.prop([fc.anything()])('never throws anything but a GlobeError for arbitrary views', async (view) => {
    const { globe } = await started();
    try {
      globe.jumpTo(view as never);
    } catch (error) {
      expect(error).toBeInstanceOf(GlobeError);
    }
  });

  it('rejects invalid points and positions in the coordinate queries with typed errors (KB-017)', async () => {
    const { globe } = await started();
    expect(() => globe.screenToGeo(null as never)).toThrow(GlobeError);
    expect(() => globe.screenToGeo({ xPx: Number.NaN, yPx: 0 })).toThrow(GlobeError);
    expect(() => globe.geoToScreen({ longitudeDeg: 0, latitudeDeg: 95 })).toThrowError(/latitudeDeg/);
    expect(() => globe.geoToScreen('Rome' as never)).toThrow(GlobeError);
    // Input plug-ins call navigation every frame: invalid input is ignored there, never thrown or applied.
    const before = globe.camera;
    globe.navigation.dragTo({ longitudeDeg: 0, latitudeDeg: 120 }, { xPx: 10, yPx: 10 });
    expect(globe.camera).toEqual(before);
  });

  test.prop([fc.anything(), fc.anything(), fc.anything()])(
    'ignores invalid input in the navigation calls, never throwing (KB-029)',
    async (first, second, delta) => {
      const { globe } = await started();
      expect(() => globe.navigation.grab(first as never)).not.toThrow();
      expect(() => globe.navigation.dragTo(first as never, second as never)).not.toThrow();
      expect(() => globe.navigation.zoomAt(first as never, delta as never)).not.toThrow();
      expect(() => globe.navigation.zoomAt(null as never, 1)).not.toThrow();
      expect(() => globe.navigation.dragTo(null as never, { xPx: 1, yPx: 1 })).not.toThrow();
      expect(() => globe.navigation.dragTo({ longitudeDeg: 1, latitudeDeg: 1 }, null as never)).not.toThrow();
    },
  );

  test.prop([fc.anything(), fc.anything()])(
    'never throws anything but a GlobeError from the coordinate queries',
    async (point, position) => {
      const { globe } = await started();
      for (const query of [() => globe.screenToGeo(point as never), () => globe.geoToScreen(position as never)]) {
        try {
          query();
        } catch (error) {
          expect(error).toBeInstanceOf(GlobeError);
        }
      }
    },
  );
});
