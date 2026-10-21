import { Session } from 'node:inspector/promises';
import { Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { placeEyeRelative } from './eye-relative.js';

interface SamplingNode {
  callFrame: { url: string };
  selfSize: number;
  children: SamplingNode[];
}

/**
 * Bytes sampled in this package's sources, this test's frame loop included: V8 inlines the offset code into the loop
 * and then attributes its allocations to the loop, which itself allocates nothing.
 */
function offsetCodeBytes(node: SamplingNode): number {
  const own = node.callFrame.url.includes('/packages/renderer/src/') ? node.selfSize : 0;
  return node.children.reduce((sum, child) => sum + offsetCodeBytes(child), own);
}

const DRAWS = 5000;

describe('placeEyeRelative (ADR 0004 §3)', () => {
  it('writes T_hi into the translation and T_lo into the bottom row, leaving the rest the identity', () => {
    const mesh = new Object3D();
    placeEyeRelative(mesh, Float64Array.of(4e6 + 0.3, 3e6, 3.9e6), Float64Array.of(0.1, 0, 0));
    const e = mesh.matrixWorld.elements;
    expect(e[12]).toBe(Math.fround(4e6 + 0.2));
    expect((e[12] ?? 0) + (e[3] ?? 0)).toBeCloseTo(4e6 + 0.2, 6);
    expect([e[0], e[5], e[10], e[15]]).toEqual([1, 1, 1, 1]);
  });

  it(`updates ${DRAWS} draws a frame without allocating (ADR 0004 benchmark)`, async () => {
    const meshes = Array.from({ length: DRAWS }, () => new Object3D());
    const origins = meshes.map((_, i) => Float64Array.of(4e6 + i * 37.1, 3e6 - i * 11.3, 3.9e6 + i * 5.7));
    const eye = Float64Array.of(4e6, 3e6, 3.9e6);
    const frame = (n: number): void => {
      eye[0] = 4e6 + n * 0.013;
      for (let i = 0; i < DRAWS; i++) placeEyeRelative(meshes[i] as Object3D, origins[i] as Float64Array, eye);
    };
    for (let n = 0; n < 2000; n++) frame(n);
    const session = new Session();
    session.connect();
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', { samplingInterval: 64 });
    const frames = 1000;
    for (let n = 0; n < frames; n++) frame(n);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as { profile: { head: SamplingNode } };
    session.disconnect();
    expect(offsetCodeBytes(profile.head) / frames).toBeLessThan(0.5);
  }, 60_000);
});
