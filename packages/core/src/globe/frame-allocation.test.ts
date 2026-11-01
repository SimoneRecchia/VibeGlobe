import { Session } from 'node:inspector/promises';
import { describe, expect, it } from 'vitest';
import { createGlobe } from './create-globe.js';
import { fakeRenderer } from './test-renderer.js';
import type { ControlsFactory, GeoPosition, NavigationApi } from './types.js';

interface SamplingNode {
  callFrame: { url: string; functionName: string; lineNumber: number };
  selfSize: number;
  children: SamplingNode[];
}

/**
 * Sampled bytes per allocation site (file:function:line), including objects already collected. A module's top level
 * (no function name, line 1) runs only at import: V8 counts its own lazy compilation and coverage data there, now and
 * then during a long run, so it is left out.
 */
function allocationSites(node: SamplingNode, out: Map<string, number>): Map<string, number> {
  const topLevel = node.callFrame.functionName === '' && node.callFrame.lineNumber === 0;
  if (node.selfSize > 0 && !topLevel) {
    const site = `${node.callFrame.url}:${node.callFrame.functionName}:${node.callFrame.lineNumber + 1}`;
    out.set(site, (out.get(site) ?? 0) + node.selfSize);
  }
  for (const child of node.children) allocationSites(child, out);
  return out;
}

/** Engine sources and the fake renderer, which must not allocate per frame either. */
const ENGINE_SOURCE = /\/packages\/core\/src\/(?!.*\.test\.ts)/;
/**
 * Enough frames that a one-off allocation (a deoptimization, coverage bookkeeping under instrumentation: about 10 KB,
 * now and then) stays well under the half byte per frame that any per-frame object would exceed.
 */
const FRAMES = 60000;
/** 65,000 frames take several seconds, longer under coverage instrumentation. */
const TIMEOUT_MS = 120_000;

/** Runs `frames` frames of drag motion in a circle, driving input with reused objects as an input plug-in does. */
function dragFrames(
  globe: ReturnType<typeof createGlobe>,
  renderer: ReturnType<typeof fakeRenderer>['renderer'],
  anchor: { longitudeDeg: number; latitudeDeg: number },
  point: { xPx: number; yPx: number },
  frames: number,
  start: number,
): void {
  for (let i = 0; i < frames; i++) {
    const angle = (start + i) * 0.05;
    point.xPx = 400 + 40 * Math.cos(angle);
    point.yPx = 300 + 40 * Math.sin(angle);
    globe.navigation.dragTo(anchor, point);
    renderer.flush();
  }
}

/** Runs `frames` frames of wheel zoom in and out around a point, one zoom step per frame. */
function zoomFrames(
  globe: ReturnType<typeof createGlobe>,
  renderer: ReturnType<typeof fakeRenderer>['renderer'],
  point: { xPx: number; yPx: number },
  frames: number,
  start: number,
): void {
  for (let i = start; i < start + frames; i++) {
    globe.navigation.zoomAt(point, (i & 64) === 0 ? 0.02 : -0.02);
    renderer.flush();
  }
}

/**
 * Warms up, then samples `FRAMES` frames of `frames`: the engine's bytes per frame, its sites, and the frames drawn.
 * The warm-up leaves V8 nothing to compile during the sampled frames (KB-312): its frames run in several calls, so the
 * sampled call enters a driver already optimized as a whole (after one long warm-up call, optimized in place, the
 * sampled call compiled the driver again and then the engine functions it calls, 25 to 30 KB of code at once, charged
 * to whichever engine function ran); then the background compiler finishes, and a few frames install its code.
 */
async function measured(
  renderer: ReturnType<typeof fakeRenderer>['renderer'],
  frames: (count: number, start: number) => void,
): Promise<{ perFrame: number; sites: string; drawn: number }> {
  for (let start = 0; start < 5000; start += 1000) frames(1000, start);
  await new Promise((resolve) => setTimeout(resolve, 50));
  frames(100, 5000);
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 64,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const drawnBefore = renderer.drawCount;
  frames(FRAMES, 5100);
  const drawn = renderer.drawCount - drawnBefore;
  const { profile } = (await session.post('HeapProfiler.stopSampling')) as { profile: { head: SamplingNode } };
  session.disconnect();
  const engine = [...allocationSites(profile.head, new Map())].filter(([site]) => ENGINE_SOURCE.test(site));
  return { perFrame: engine.reduce((sum, [, bytes]) => sum + bytes, 0) / FRAMES, sites: JSON.stringify(engine), drawn };
}

describe('frame loop allocation (F064)', () => {
  it.each([
    ['orbit', { zoom: 3, latitudeDeg: 45 }],
    // Street level, tilted: tile keys pass 31 bits, where a Map would box them.
    ['street level', { zoom: 19, longitudeDeg: 9.19, latitudeDeg: 45.46, tiltDeg: 60 }],
  ])(
    'allocates nothing per frame in steady-state motion at %s',
    async (_, view) => {
      const { renderer, factory } = fakeRenderer();
      const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', view });
      await Promise.resolve();
      await Promise.resolve();
      renderer.flush();
      await globe.ready;
      // Heading held: a trackball drag in a circle turns the heading a little every loop, so its tiles never settle
      // (the trackball's own allocation is the next test's).
      globe.navigation.navigationMode = 'north-up';
      const anchor = globe.navigation.grab({ xPx: 400, yPx: 300 });
      if (!anchor) throw new Error('no anchor');
      const point = { xPx: 400, yPx: 300 };
      // The warm-up builds and caches every tile on the circular path.
      const { perFrame, sites, drawn } = await measured(renderer, (count, start) =>
        dragFrames(globe, renderer, anchor, point, count, start),
      );
      expect(drawn).toBe(FRAMES);
      // Any object allocated every frame costs at least 12 bytes; under half a byte per frame on average means no frame
      // allocates (what remains is the test runner's module plumbing re-entering the interpreter now and then).
      expect(perFrame, sites).toBeLessThan(0.5);
      globe.destroy();
    },
    TIMEOUT_MS,
  );
  it(
    "allocates nothing per frame in a 'free' (trackball) drag of the whole globe",
    async () => {
      const { renderer, factory } = fakeRenderer();
      const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', view: { zoom: 0.5 } });
      await Promise.resolve();
      await Promise.resolve();
      renderer.flush();
      await globe.ready;
      expect(globe.navigation.navigationMode).toBe('free');
      const anchor = globe.navigation.grab({ xPx: 400, yPx: 300 });
      if (!anchor) throw new Error('no anchor');
      const point = { xPx: 400, yPx: 300 };
      // The whole globe in view: its few coarse tiles are all built during the warm-up, whatever the heading.
      const { perFrame, sites } = await measured(renderer, (count, start) =>
        dragFrames(globe, renderer, anchor, point, count, start),
      );
      expect(perFrame, sites).toBeLessThan(0.5);
      globe.destroy();
    },
    TIMEOUT_MS,
  );
  it(
    'allocates nothing per frame in steady-state wheel zoom (KB-028)',
    async () => {
      const { renderer, factory } = fakeRenderer();
      const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', view: { zoom: 6 } });
      await Promise.resolve();
      await Promise.resolve();
      renderer.flush();
      await globe.ready;
      const point = { xPx: 430, yPx: 280 };
      const { perFrame, sites } = await measured(renderer, (count, start) =>
        zoomFrames(globe, renderer, point, count, start),
      );
      expect(perFrame, sites).toBeLessThan(0.5);
      globe.destroy();
    },
    TIMEOUT_MS,
  );
  it(
    'allocates nothing per frame when a controls plug-in drives the drag and a listener reads the camera (KB-037)',
    async () => {
      // An input plug-in as `@vibeglobe/controls` is one: input arrives through requestUpdate and the drag is applied
      // in update(), inside the frame (ADR 0009).
      const point = { xPx: 400, yPx: 300 };
      const motion = { angle: 0 };
      let navigation: NavigationApi | undefined;
      const controls: ControlsFactory = (_element, api) => {
        navigation = api;
        // Heading held, as above: the circle then repeats the same views.
        api.navigationMode = 'north-up';
        let anchor: GeoPosition | undefined;
        return {
          update() {
            anchor ??= api.grab(point);
            motion.angle += 0.05;
            point.xPx = 400 + 40 * Math.cos(motion.angle);
            point.yPx = 300 + 40 * Math.sin(motion.angle);
            if (anchor) api.dragTo(anchor, point);
          },
          destroy: () => undefined,
        };
      };
      const { renderer, factory } = fakeRenderer();
      const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', view: { zoom: 3 }, controls });
      const seen = { zoom: 0.5 };
      globe.on('camera-change', (state) => {
        seen.zoom = state.zoom;
      });
      await Promise.resolve();
      await Promise.resolve();
      renderer.flush();
      await globe.ready;
      const frames = (count: number): void => {
        for (let i = 0; i < count; i++) {
          navigation?.requestUpdate();
          renderer.flush();
        }
      };
      const { perFrame, sites, drawn } = await measured(renderer, frames);
      expect(drawn).toBe(FRAMES);
      expect(seen.zoom).toBeGreaterThan(2);
      expect(perFrame, sites).toBeLessThan(0.5);
      globe.destroy();
    },
    TIMEOUT_MS,
  );
});
