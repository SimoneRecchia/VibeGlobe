import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { createGlobe } from './create-globe.js';
import { GlobeError } from './errors.js';
import { fakeRenderer } from './test-renderer.js';
import type { DebugShape, GeoPosition, GlobeOptions, NavigationApi, ScreenPoint } from './types.js';

/** Any JavaScript value, including objects without a prototype, boxed values and bigints (KB-041). */
const anyValue = fc.anything({ withNullPrototype: true, withBigInt: true, withBoxedValues: true });

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
  it('hands the renderer one draw per selected tile, each on a mesh it holds and textured by the base image', async () => {
    const { globe, renderer } = await started({ view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 } });
    const draws = renderer.lastDraws;
    expect(draws?.count).toBe(renderer.lastTiles);
    const tiles = globe.surfaceTiles();
    expect(tiles).toHaveLength(draws?.count ?? -1);
    for (let i = 0; i < (draws?.count ?? 0); i++) {
      expect(renderer.meshes.has(draws?.meshKeys[i] ?? NaN)).toBe(true);
      expect(draws?.textures[i]).toBe(-1);
      expect(draws?.geographic[i]).toBe(1);
    }
  });

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

  it('rejects ready when the renderer gives up before the first frame (KB-036)', async () => {
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w.jpg' });
    const events: string[] = [];
    globe.on('ready', () => events.push('ready'));
    globe.on('error', (error) => events.push(error.code));
    await Promise.resolve();
    renderer.events?.failed(new GlobeError('renderer-failed', 'gave up'));
    await Promise.resolve();
    renderer.flush();
    await expect(globe.ready).rejects.toMatchObject({ code: 'renderer-failed' });
    expect(events).toEqual(['renderer-failed']);
  });

  it('draws and reports nothing until the requested view has a viewport (KB-040)', async () => {
    const { renderer, factory } = fakeRenderer();
    renderer.size = { widthPx: 0, heightPx: 0 };
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w.jpg', view: { zoom: 4 } });
    const zooms: number[] = [];
    let ready = false;
    globe.on('camera-change', (state) => zooms.push(state.zoom));
    void globe.ready.then(() => (ready = true));
    await Promise.resolve();
    await Promise.resolve();
    renderer.flush();
    await Promise.resolve();
    expect(renderer.drawCount).toBe(0);
    expect(ready).toBe(false);
    expect(zooms).toEqual([]);
    renderer.size = { widthPx: 800, heightPx: 600 };
    renderer.resizeListener?.();
    renderer.flush();
    await globe.ready;
    expect(zooms[0]).toBeCloseTo(4, 9);
  });

  it('resolves ready only on a frame the renderer drew (KB-040)', async () => {
    const { renderer, factory } = fakeRenderer();
    renderer.drawing = false;
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w.jpg' });
    let ready = false;
    void globe.ready.then(() => (ready = true));
    await Promise.resolve();
    await Promise.resolve();
    renderer.flush();
    await Promise.resolve();
    expect(ready).toBe(false);
    renderer.drawing = true;
    globe.requestRender();
    renderer.flush();
    await globe.ready;
    expect(ready).toBe(true);
  });

  it('keeps debug shapes set before the renderer exists (KB-042)', async () => {
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w.jpg' });
    const corner = { longitudeDeg: 0, latitudeDeg: 0 };
    globe.setDebugShapes([{ corners: [corner, corner, corner, corner], colorRgb: [1, 0, 0] }]);
    await Promise.resolve();
    await Promise.resolve();
    renderer.flush();
    await globe.ready;
    expect(renderer.debugMeshes).toBe(1);
  });

  it('keeps the requested view until the container has a size (KB-034)', async () => {
    const { renderer, factory } = fakeRenderer();
    renderer.size = { widthPx: 0, heightPx: 0 };
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w.jpg', view: { zoom: 4 } });
    await Promise.resolve();
    await Promise.resolve();
    renderer.flush();
    expect(globe.camera.zoom).toBeCloseTo(4, 9);
    renderer.size = { widthPx: 800, heightPx: 600 };
    renderer.resizeListener?.();
    expect(globe.camera.zoom).toBeCloseTo(4, 9);
    expect(globe.camera.altitudeMeters).toBeGreaterThan(1e6);
  });

  it('keeps the view while the container has no size after start (KB-046)', async () => {
    const { globe, renderer } = await started({ view: { zoom: 2 } });
    const events: string[] = [];
    globe.on('frame', () => events.push('frame'));
    globe.on('camera-change', () => events.push('camera-change'));
    renderer.size = { widthPx: 0, heightPx: 0 };
    renderer.resizeListener?.();
    renderer.flush();
    globe.jumpTo({ longitudeDeg: 10, latitudeDeg: 45, zoom: 4 });
    renderer.flush();
    expect(globe.camera.zoom).toBeCloseTo(4, 9);
    globe.navigation.zoomAt({ xPx: 0, yPx: 0 }, 1);
    renderer.flush();
    expect(events).toEqual([]);
    renderer.size = { widthPx: 800, heightPx: 600 };
    renderer.resizeListener?.();
    renderer.flush();
    expect(globe.camera.longitudeDeg).toBeCloseTo(10, 9);
    expect(globe.camera.latitudeDeg).toBeCloseTo(45, 9);
    expect(globe.camera.zoom).toBeCloseTo(4, 9);
    expect(events).toContain('camera-change');
  });

  it('keeps the view of a container that collapses and returns with the same size (KB-046)', async () => {
    const { globe, renderer } = await started({ view: { longitudeDeg: 30, latitudeDeg: -20, zoom: 5, tiltDeg: 40 } });
    const before = globe.camera;
    renderer.size = { widthPx: 0, heightPx: 0 };
    renderer.resizeListener?.();
    renderer.size = { widthPx: 800, heightPx: 600 };
    renderer.resizeListener?.();
    renderer.flush();
    const after = globe.camera;
    for (const key of ['longitudeDeg', 'latitudeDeg', 'zoom', 'headingDeg', 'tiltDeg', 'rangeMeters'] as const) {
      expect(after[key]).toBeCloseTo(before[key], 6);
    }
  });

  it('keeps the range of a container that collapses through small sizes (KB-050)', async () => {
    const { globe, renderer } = await started({ view: { zoom: 2 } });
    const before = globe.camera;
    for (const heightPx of [4, 0, 20, 600]) {
      renderer.size = { widthPx: 800, heightPx };
      renderer.resizeListener?.();
      renderer.flush();
    }
    expect(globe.camera.rangeMeters).toBeCloseTo(before.rangeMeters, 3);
    expect(globe.camera.zoom).toBeCloseTo(before.zoom, 9);
  });

  it('reports the live camera while collapsed, and NaN range only for a zoom waiting for a size (KB-061)', async () => {
    const { globe, renderer } = await started({ view: { zoom: 2 } });
    renderer.size = { widthPx: 0, heightPx: 0 };
    renderer.resizeListener?.();
    expect(Number.isFinite(globe.camera.rangeMeters)).toBe(true);
    globe.jumpTo({ zoom: 4 });
    expect(globe.camera.rangeMeters).toBeNaN();
    expect(globe.camera.zoom).toBe(4);
    renderer.size = { widthPx: 800, heightPx: 600 };
    renderer.resizeListener?.();
    expect(Number.isFinite(globe.camera.rangeMeters)).toBe(true);
    expect(globe.camera.zoom).toBeCloseTo(4, 9);
  });

  it('keeps the range of a position-only jump made while the container has no size (KB-056)', async () => {
    const { globe, renderer } = await started({ view: { zoom: 2 } });
    const range = globe.camera.rangeMeters;
    renderer.size = { widthPx: 0, heightPx: 0 };
    renderer.resizeListener?.();
    globe.jumpTo({ longitudeDeg: 10 });
    expect(globe.camera.rangeMeters).toBeCloseTo(range, 3);
    renderer.size = { widthPx: 800, heightPx: 300 };
    renderer.resizeListener?.();
    renderer.flush();
    expect(globe.camera.longitudeDeg).toBeCloseTo(10, 9);
    expect(globe.camera.rangeMeters / range).toBeCloseTo(1, 9);
  });

  it('advances the manual clock one step per drawn frame only (KB-058)', async () => {
    const { globe, renderer } = await started({ manualClockStepMs: 10 });
    renderer.drawing = false;
    for (let i = 0; i < 5; i++) {
      globe.requestRender();
      renderer.flush();
    }
    renderer.drawing = true;
    renderer.size = { widthPx: 0, heightPx: 0 };
    renderer.resizeListener?.();
    globe.requestRender();
    renderer.flush();
    renderer.size = { widthPx: 800, heightPx: 600 };
    renderer.resizeListener?.();
    renderer.flush();
    expect(globe.frameNumber).toBeGreaterThan(1);
    expect(globe.timeMs).toBe(globe.frameNumber * 10);
  });

  it('captures only a frame it drew: waits while nothing can be drawn (KB-051)', async () => {
    const { globe, renderer } = await started();
    renderer.drawing = false;
    let captured = false;
    const capture = globe.captureFrame().then(() => (captured = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderer.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captured).toBe(false);
    renderer.drawing = true;
    globe.requestRender();
    renderer.flush();
    await capture;
    expect(captured).toBe(true);
  });

  it('rejects a waiting capture when the renderer gives up or the globe is destroyed (KB-051)', async () => {
    const { globe, renderer } = await started();
    renderer.drawing = false;
    const failed = globe.captureFrame();
    await Promise.resolve();
    renderer.events?.failed(new GlobeError('renderer-failed', 'gave up'));
    await expect(failed).rejects.toMatchObject({ code: 'renderer-failed' });
    await expect(globe.captureFrame()).rejects.toMatchObject({ code: 'renderer-failed' });
    const other = await started();
    other.renderer.drawing = false;
    const destroyed = other.globe.captureFrame();
    await Promise.resolve();
    other.globe.destroy();
    await expect(destroyed).rejects.toMatchObject({ code: 'destroyed' });
  });

  it('reports the altitude as soon as the viewport has a size, before the first frame (KB-047)', async () => {
    const { renderer, factory } = fakeRenderer();
    let loaded: (() => void) | undefined;
    renderer.setBaseImagery = () => new Promise<void>((resolve) => (loaded = resolve));
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w.jpg', view: { zoom: 2 } });
    await Promise.resolve();
    await Promise.resolve();
    renderer.flush();
    expect(globe.frameNumber).toBe(0);
    const camera = globe.camera;
    expect(camera.rangeMeters).toBeGreaterThan(1e6);
    expect(camera.altitudeMeters).toBeCloseTo(camera.rangeMeters, 0);
    loaded?.();
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

  it('tells whether the globe hides a position: beyond the horizon on the globe, never on the flat map (F653)', async () => {
    const { globe, renderer } = await started({ view: { longitudeDeg: 0, latitudeDeg: 0, zoom: 2 } });
    // Straight down onto the equator: the horizon lies at the central angle whose cosine is a / (a + altitude).
    const horizonDeg = (Math.acos(6378137 / (6378137 + globe.camera.altitudeMeters)) * 180) / Math.PI;
    const near = globe.geoToScreen({ longitudeDeg: horizonDeg - 1, latitudeDeg: 0 });
    const beyond = globe.geoToScreen({ longitudeDeg: horizonDeg + 1, latitudeDeg: 0 });
    expect([near?.behindGlobe, beyond?.behindGlobe]).toEqual([false, true]);
    expect(globe.geoToScreen({ longitudeDeg: 180, latitudeDeg: 0 })?.behindGlobe).toBe(true);
    globe.jumpTo({ zoom: 9 });
    renderer.flush();
    expect(globe.camera.morphFactor).toBe(1);
    expect(globe.geoToScreen({ longitudeDeg: horizonDeg + 1, latitudeDeg: 0 })?.behindGlobe).toBe(false);
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

  it('gives the controls orbit, the engine clock and the attitude, keeps a frame asked for in their update, and interrupts them when an API movement starts (M6 input hooks)', async () => {
    let navigation: NavigationApi | undefined;
    let again = false;
    let interrupted = 0;
    const { globe, renderer } = await started({
      controls: (_element, api) => {
        navigation = api;
        return {
          update: () => {
            if (again) api.requestUpdate();
          },
          interrupt: () => void interrupted++,
          destroy: () => undefined,
        };
      },
    });
    if (!navigation) throw new Error('no navigation');
    navigation.orbit(30, 20);
    renderer.flush();
    expect(navigation.headingDeg).toBeCloseTo(30, 6);
    expect(globe.camera.headingDeg).toBeCloseTo(30, 6);
    expect(navigation.tiltDeg).toBeCloseTo(globe.camera.tiltDeg, 6);
    expect(navigation.tiltDeg).toBeGreaterThan(0);
    expect(navigation.timeMs).toBe(globe.timeMs);
    // A request made inside update is kept: the next frame comes.
    again = true;
    navigation.requestUpdate();
    expect(renderer.flush()).toBe(1);
    again = false;
    expect(renderer.flush()).toBe(1);
    expect(renderer.flush()).toBe(0);
    void globe.flyTo({ longitudeDeg: 20, latitudeDeg: 10, zoom: 3 });
    expect(interrupted).toBe(1);
    // A jump stops them too, so their inertia does not undo it (KB-125).
    void globe.jumpTo({ longitudeDeg: 139.69, latitudeDeg: 35.68 });
    expect(interrupted).toBe(2);
    // A press on the map stops a running movement before any drag (KB-127).
    const flight = globe.flyTo({ longitudeDeg: 20, latitudeDeg: 10, zoom: 3 });
    navigation.interruptMovement();
    expect(await flight).toBe('interrupted');
  });

  it('announces inertia from the controls with the cause inertia, after the drag that started it (F200)', async () => {
    let navigation: NavigationApi | undefined;
    let step: ((api: NavigationApi) => void) | undefined;
    const { globe, renderer } = await started({
      controls: (_element, api) => {
        navigation = api;
        return { update: () => step?.(api), destroy: () => undefined };
      },
    });
    if (!navigation) throw new Error('no navigation');
    const events: string[] = [];
    globe.on('movestart', ({ cause }) => events.push(`start:${cause}`));
    globe.on('move', ({ cause }) => events.push(`move:${cause}`));
    globe.on('moveend', ({ cause }) => events.push(`end:${cause}`));
    const anchor = navigation.grab({ xPx: 400, yPx: 300 });
    if (!anchor) throw new Error('off the globe');
    step = (api) => api.dragTo(anchor, { xPx: 420, yPx: 300 });
    navigation.requestUpdate();
    renderer.flush();
    step = (api) => {
      api.coasting = true;
      api.dragTo(anchor, { xPx: 430, yPx: 300 });
      api.coasting = false;
    };
    navigation.requestUpdate();
    renderer.flush();
    // The inertia's last step asks for no frame: the engine draws one more on its own, which ends the movement.
    step = undefined;
    renderer.flush();
    expect(events).toEqual(['start:user', 'move:user', 'end:user', 'start:inertia', 'move:inertia', 'end:inertia']);
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

  it('rejects invalid debug shapes and event handlers with typed errors (KB-038)', async () => {
    const { globe } = await started();
    const code = (call: () => unknown): string => {
      try {
        call();
        return 'no error';
      } catch (error) {
        return error instanceof GlobeError ? error.code : `untyped ${String(error)}`;
      }
    };
    const corner = { longitudeDeg: 0, latitudeDeg: 0 };
    const quad = [corner, corner, corner, corner];
    const shapes =
      (value: unknown): (() => void) =>
      () =>
        globe.setDebugShapes(value as DebugShape[]);
    expect(code(shapes(null))).toBe('invalid-option');
    expect(code(shapes([null]))).toBe('invalid-option');
    expect(code(shapes([{}]))).toBe('invalid-option');
    expect(code(shapes([{ corners: [], colorRgb: [1, 0, 0] }]))).toBe('invalid-option');
    expect(code(shapes([{ corners: quad, colorRgb: 'red' }]))).toBe('invalid-option');
    expect(code(shapes([{ corners: quad, colorRgb: [1, 0, 0], checkerMeters: -1 }]))).toBe('invalid-option');
    expect(
      code(shapes([{ corners: [corner, corner, corner, { latitudeDeg: 95, longitudeDeg: 0 }], colorRgb: [1, 0, 0] }])),
    ).toBe('invalid-coordinate');
    expect(code(shapes([{ corners: quad, colorRgb: [1, 0, 0] }]))).toBe('no error');
    const on = globe.on.bind(globe) as (event: unknown, handler: unknown) => unknown;
    expect(code(() => on('frame', 42))).toBe('invalid-option');
    expect(code(() => on('no-such-event', () => undefined))).toBe('invalid-option');
  });

  it('describes values without a prototype or of type bigint in typed errors (KB-041)', async () => {
    const { globe } = await started();
    const { factory } = fakeRenderer();
    const odd = Object.create(null) as unknown;
    const code = (call: () => unknown): string => {
      try {
        call();
        return 'no error';
      } catch (error) {
        return error instanceof GlobeError ? error.code : `untyped ${String(error)}`;
      }
    };
    const loose = globe as unknown as Record<string, (...args: unknown[]) => unknown>;
    const corner = { longitudeDeg: 0, latitudeDeg: 0 };
    expect(code(() => loose['on']?.call(globe, 'frame', odd))).toBe('invalid-option');
    expect(code(() => loose['on']?.call(globe, odd, () => undefined))).toBe('invalid-option');
    expect(code(() => loose['jumpTo']?.call(globe, { zoom: odd }))).toBe('invalid-coordinate');
    expect(code(() => loose['setResolutionScale']?.call(globe, odd))).toBe('invalid-option');
    expect(
      code(() =>
        createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', resolutionScale: odd as number }),
      ),
    ).toBe('invalid-option');
    expect(
      code(() =>
        loose['setDebugShapes']?.call(globe, [
          { corners: [corner, corner, corner, corner], colorRgb: [1, 0, 0], checkerMeters: odd },
        ]),
      ),
    ).toBe('invalid-option');
    expect(
      code(() =>
        loose['setDebugShapes']?.call(globe, [
          { corners: [corner, corner, corner, { longitudeDeg: 1n, latitudeDeg: 0 }], colorRgb: [1, 0, 0] },
        ]),
      ),
    ).toBe('invalid-coordinate');
  });

  test.prop([anyValue])('never throws anything but a GlobeError for arbitrary options', (options) => {
    try {
      createGlobe(options as GlobeOptions).destroy();
    } catch (error) {
      expect(error).toBeInstanceOf(GlobeError);
    }
  });

  test.prop([anyValue])('never throws anything but a GlobeError for arbitrary views', async (view) => {
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

  test.prop([anyValue, anyValue, anyValue])(
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

  test.prop([anyValue, anyValue])(
    'never throws anything but a GlobeError from on, setDebugShapes and setResolutionScale (KB-041)',
    async (first, second) => {
      const { globe } = await started();
      const loose = globe as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const call of [
        () => loose['on']?.call(globe, first, second),
        () => loose['setDebugShapes']?.call(globe, first),
        () => loose['setDebugShapes']?.call(globe, [first]),
        () => loose['setResolutionScale']?.call(globe, first),
      ]) {
        try {
          call();
        } catch (error) {
          expect(error).toBeInstanceOf(GlobeError);
        }
      }
    },
  );

  test.prop([anyValue, anyValue])(
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
