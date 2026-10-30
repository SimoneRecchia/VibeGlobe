import { Session } from 'node:inspector/promises';
import { describe, expect, it } from 'vitest';
import type { DecodedTile } from '../scheduler/types.js';
import { Residency } from './residency.hot.js';
import { UploadQueue } from './upload-queue.hot.js';

interface SamplingNode {
  callFrame: { url: string; functionName: string; lineNumber: number };
  selfSize: number;
  children: SamplingNode[];
}

/** Sampled bytes per allocation site (file:function:line), including objects already collected. */
function allocationSites(node: SamplingNode, out: Map<string, number>): Map<string, number> {
  const topLevel = node.callFrame.functionName === '' && node.callFrame.lineNumber === 0;
  if (node.selfSize > 0 && !topLevel) {
    const site = `${node.callFrame.url}:${node.callFrame.functionName}:${node.callFrame.lineNumber + 1}`;
    out.set(site, (out.get(site) ?? 0) + node.selfSize);
  }
  for (const child of node.children) allocationSites(child, out);
  return out;
}

async function profiled(run: () => void): Promise<Map<string, number>> {
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 64,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  run();
  const { profile } = (await session.post('HeapProfiler.stopSampling')) as { profile: { head: SamplingNode } };
  session.disconnect();
  return allocationSites(profile.head, new Map());
}

/** The cache modules and the key map they use. */
const CACHE_SOURCE = /\/packages\/core\/src\/(cache|collections)\/(?!.*\.test\.ts)/;
/**
 * Functions called once per frame (trim, the drain) reach the optimizing tier only after tens of thousands of calls;
 * before that, V8's interpreter and baseline code box doubles. The warm-up lets them tier up, so the measured frames
 * show what the steady state allocates.
 */
const WARM_UP_FRAMES = 40_000;
const FRAMES = 40_000;
const TILES = 300;
const ARRIVALS = 8;
const TIMEOUT_MS = 60_000;

describe('cache frame path allocation (ADR 0018)', () => {
  it(
    'touches, marks, trims, queues and drains without allocating per frame',
    async () => {
      // Deep surface tile keys, beyond 32 bits, where a Map would box them.
      const keys = new Float64Array(TILES);
      const priorities = new Float64Array(TILES);
      for (let i = 0; i < TILES; i++) keys[i] = 2 ** 50 + i * 2 ** 33;
      const gpu = new Residency({ budgetBytes: TILES * 1000, nowMs: () => 0 });
      for (let i = 0; i < TILES; i++) gpu.admitAt(keys, i, 1000);
      // A refused admission starts trimming; every frame's trim then walks to the frame marker and stops there.
      expect(gpu.admit(1, 1000)).toBe(false);

      const tiles: DecodedTile[] = [];
      for (let i = 0; i < ARRIVALS; i++) tiles.push({ widthPx: 256, heightPx: 256, gpuBytes: 349_524, image: i });
      const uploads = new UploadQueue<DecodedTile>({
        upload: (_tile, measuredMs) => {
          measuredMs[0] = 0.05;
        },
      });

      const frame = (f: number): void => {
        // Post-order touch, children before parents, and every other tile drawn.
        for (let i = TILES - 1; i >= 0; i--) gpu.touchAt(keys, i, f);
        for (let i = 0; i < TILES; i += 2) gpu.markDrawnAt(keys, i, f);
        // Tiles arrive, one again at a new priority, and the queue drains within its budget.
        for (let i = 0; i < ARRIVALS; i++) {
          priorities[i] = 1024 + ((f + i) & 7);
          uploads.enqueueAt(keys, priorities, i, tiles[i] as DecodedTile, (i & 1) === 1);
        }
        priorities[3] = 0.25;
        uploads.enqueueAt(keys, priorities, 3, tiles[3] as DecodedTile, true);
        uploads.removeAt(keys, 5);
        uploads.drain();
        gpu.trim(f, 64, 1);
      };

      for (let f = 1; f <= WARM_UP_FRAMES; f++) frame(f);
      const sites = await profiled(() => {
        for (let f = WARM_UP_FRAMES + 1; f <= WARM_UP_FRAMES + FRAMES; f++) frame(f);
      });
      expect(gpu.usedBytes).toBe(TILES * 1000);
      expect(gpu.evictedCount).toBe(0);
      expect(uploads.size).toBe(0);
      expect(uploads.uploadedCount).toBe((WARM_UP_FRAMES + FRAMES) * (ARRIVALS - 1));
      const cache = [...sites].filter(([site]) => CACHE_SOURCE.test(site));
      const bytesPerFrame = cache.reduce((sum, [, bytes]) => sum + bytes, 0) / FRAMES;
      // Any object allocated every frame costs at least 12 bytes; under half a byte per frame means none is.
      expect(bytesPerFrame, JSON.stringify(cache)).toBeLessThan(0.5);
    },
    TIMEOUT_MS,
  );
});
