import { Session } from 'node:inspector/promises';
import { describe, expect, it } from 'vitest';
import { createGlobe } from './create-globe.js';
import { fakeRenderer } from './test-renderer.js';

interface SamplingNode {
  callFrame: { url: string; functionName: string; lineNumber: number };
  selfSize: number;
  children: SamplingNode[];
}

/** Sampled bytes per allocation site (file:function:line), including objects already collected. */
function allocationSites(node: SamplingNode, out: Map<string, number>): Map<string, number> {
  if (node.selfSize > 0) {
    const site = `${node.callFrame.url}:${node.callFrame.functionName}:${node.callFrame.lineNumber + 1}`;
    out.set(site, (out.get(site) ?? 0) + node.selfSize);
  }
  for (const child of node.children) allocationSites(child, out);
  return out;
}

/** Engine sources and the fake renderer, which must not allocate per frame either. */
const ENGINE_SOURCE = /\/packages\/core\/src\/(?!.*\.test\.ts)/;
const FRAMES = 20000;

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

describe('frame loop allocation (F064)', () => {
  it.each([
    ['orbit', { zoom: 3, latitudeDeg: 45 }],
    // Street level, tilted: tile keys pass 31 bits, where a Map would box them.
    ['street level', { zoom: 19, longitudeDeg: 9.19, latitudeDeg: 45.46, tiltDeg: 60 }],
  ])('allocates nothing per frame in steady-state motion at %s', async (_, view) => {
    const { renderer, factory } = fakeRenderer();
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', view });
    await Promise.resolve();
    await Promise.resolve();
    renderer.flush();
    await globe.ready;
    const anchor = globe.navigation.grab({ xPx: 400, yPx: 300 });
    if (!anchor) throw new Error('no anchor');
    const point = { xPx: 400, yPx: 300 };
    // Warm-up: every tile on the circular path is built and cached, and the optimizing compiler has settled.
    dragFrames(globe, renderer, anchor, point, 5000, 0);

    const session = new Session();
    session.connect();
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 64,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const drawnBefore = renderer.drawCount;
    dragFrames(globe, renderer, anchor, point, FRAMES, 5000);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as { profile: { head: SamplingNode } };
    session.disconnect();

    expect(renderer.drawCount - drawnBefore).toBe(FRAMES);
    const engine = [...allocationSites(profile.head, new Map())].filter(([site]) => ENGINE_SOURCE.test(site));
    const bytesPerFrame = engine.reduce((sum, [, bytes]) => sum + bytes, 0) / FRAMES;
    // Any object allocated every frame costs at least 12 bytes; under half a byte per frame on average means no frame
    // allocates (what remains is the test runner's module plumbing re-entering the interpreter now and then).
    expect(bytesPerFrame, JSON.stringify(engine)).toBeLessThan(0.5);
    globe.destroy();
  });
});
