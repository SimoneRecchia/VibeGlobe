import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import type { DecodedTile } from '../scheduler/types.js';
import { UploadCostModel } from './upload-cost.js';
import {
  DEFAULT_UPLOAD_BUDGET,
  type UploadBudget,
  type UploadFunction,
  UploadQueue,
  type UploadQueueOptions,
} from './upload-queue.hot.js';

interface TestTile extends DecodedTile {
  readonly id: number;
}

function tile(id: number, gpuBytes: number): TestTile {
  return { id, widthPx: 256, heightPx: 256, gpuBytes, image: undefined };
}

/** 1 ms per million bytes, compressed or not, with no warm-up averaging surprises in the predictions under test. */
function model(): UploadCostModel {
  return new UploadCostModel({ uncompressedMsPerByte: 1e-6, compressedMsPerByte: 0.25e-6 });
}

/** A queue whose uploads take the time `costMs` gives (or are not measured when it returns -1). */
function queue(costMs: (t: TestTile) => number = () => -1, costModel = model()) {
  const uploaded: number[] = [];
  const upload: UploadFunction<TestTile> = (t, measuredMs) => {
    uploaded.push(t.id);
    const ms = costMs(t);
    if (ms >= 0) measuredMs[0] = ms;
  };
  const options: UploadQueueOptions<TestTile> = { costModel, initialCapacity: 2, upload };
  return { uploads: new UploadQueue(options), uploaded };
}

describe('UploadQueue order', () => {
  it('uploads in priority order, ties in arrival order', () => {
    const { uploads, uploaded } = queue();
    uploads.enqueue(10, 1025, tile(10, 1000), false);
    uploads.enqueue(11, 1024, tile(11, 1000), false);
    uploads.enqueue(12, 2048, tile(12, 1000), false);
    uploads.enqueue(13, 1024, tile(13, 1000), false);
    uploads.enqueue(2 ** 52 + 1, 0, tile(14, 1000), false);
    expect(uploads.size).toBe(5);
    expect(uploads.pendingBytes).toBe(5000);
    expect(uploads.drain()).toBe(5);
    expect(uploaded).toEqual([14, 11, 13, 10, 12]);
    expect(uploads.size).toBe(0);
    expect(uploads.pendingBytes).toBe(0);
    expect(uploads.uploadedCount).toBe(5);
  });

  it('follows priority changes and removals', () => {
    const { uploads, uploaded } = queue();
    for (let id = 0; id < 6; id++) uploads.enqueue(id, id, tile(id, 100), false);
    // A key enqueued again takes its new priority.
    uploads.enqueue(5, -1, tile(5, 100), false);
    uploads.enqueue(0, 10, tile(0, 100), false);
    expect(uploads.remove(3)?.id).toBe(3);
    expect(uploads.remove(3)).toBeUndefined();
    expect(uploads.pendingBytes).toBe(500);
    uploads.drain();
    expect(uploaded).toEqual([5, 1, 2, 4, 0]);
  });

  it('replaces the tile of a key already waiting and hands back the old one', () => {
    const { uploads, uploaded } = queue();
    const first = tile(1, 100);
    expect(uploads.enqueue(7, 5, first, false)).toBeUndefined();
    expect(uploads.enqueue(7, 5, first, false)).toBeUndefined();
    expect(uploads.enqueue(7, 1, tile(2, 300), false)).toBe(first);
    expect(uploads.size).toBe(1);
    expect(uploads.pendingBytes).toBe(300);
    uploads.drain();
    expect(uploaded).toEqual([2]);
  });

  it('reads keys and priorities from the caller arrays', () => {
    const { uploads, uploaded } = queue();
    const keys = new Float64Array([2 ** 40, 2 ** 41, 2 ** 42]);
    const priorities = new Float64Array([3, 1, 2]);
    for (let i = 0; i < 3; i++) uploads.enqueueAt(keys, priorities, i, tile(i, 10), false);
    priorities[0] = 0;
    uploads.enqueueAt(keys, priorities, 0, tile(0, 10), false);
    expect(uploads.removeAt(keys, 2)?.id).toBe(2);
    uploads.drain();
    expect(uploaded).toEqual([0, 1]);
  });

  it('clears, handing every waiting tile back', () => {
    const { uploads, uploaded } = queue();
    for (let id = 0; id < 5; id++) uploads.enqueue(id, id, tile(id, 100), false);
    const released: number[] = [];
    uploads.clear((t) => released.push(t.id));
    expect(released.sort()).toEqual([0, 1, 2, 3, 4]);
    expect(uploads.size).toBe(0);
    expect(uploads.pendingBytes).toBe(0);
    expect(uploads.drain()).toBe(0);
    expect(uploaded).toEqual([]);
    uploads.enqueue(1, 1, tile(1, 1), false);
    uploads.clear();
    expect(uploads.size).toBe(0);
  });

  test.prop([fc.array(fc.tuple(fc.integer({ min: 0, max: 30 }), fc.double({ noNaN: true, min: -1e6, max: 1e6 })))])(
    'drains like a stable sort by priority of the last enqueue per key',
    (entries) => {
      const { uploads, uploaded } = queue();
      const latest = new Map<number, { priority: number; order: number }>();
      entries.forEach(([key, priority], order) => {
        uploads.enqueue(key, priority, tile(key, 1), false);
        latest.set(key, { priority, order: latest.get(key)?.order ?? order });
      });
      uploads.drain({ maxMs: Infinity, maxBytes: Infinity });
      const expected = [...latest]
        .sort((a, b) => a[1].priority - b[1].priority || a[1].order - b[1].order)
        .map(([key]) => key);
      expect(uploaded).toEqual(expected);
    },
  );
});

describe('UploadQueue budget (F101)', () => {
  it('stops at the byte budget', () => {
    const { uploads, uploaded } = queue(() => 0);
    for (let id = 0; id < 10; id++) uploads.enqueue(id, id, tile(id, 3_000_000), false);
    // 8,000,000 bytes per frame: two 3 MB tiles fit, a third would not.
    expect(uploads.drain()).toBe(2);
    expect(uploads.lastDrainBytes).toBe(6_000_000);
    expect(uploaded).toEqual([0, 1]);
    expect(uploads.pendingBytes).toBe(24_000_000);
  });

  it('stops when the predicted time would pass the budget', () => {
    // Unmeasured uploads: predictions stand in for the time spent. 600,000 bytes predict 0.6 ms.
    const { uploads } = queue();
    for (let id = 0; id < 10; id++) uploads.enqueue(id, id, tile(id, 600_000), false);
    expect(uploads.drain()).toBe(3);
    expect(uploads.lastDrainMs).toBeCloseTo(1.8, 9);
    // Compressed uploads predict a quarter of the time: 0.15 ms each, so 13 fit 2 ms but the bytes stop at 13 too.
    for (let id = 20; id < 40; id++) uploads.enqueue(id, -1, tile(id, 600_000), true);
    expect(uploads.drain()).toBe(13);
  });

  it('counts measured time, so slow uploads end the frame sooner', () => {
    const { uploads } = queue(() => 1.5);
    for (let id = 0; id < 10; id++) uploads.enqueue(id, id, tile(id, 100_000), false);
    // The first upload took 1.5 ms and taught the model: the second predicts 0.45 ms and fits, the third 0.8 ms not.
    expect(uploads.drain()).toBe(2);
    expect(uploads.lastDrainMs).toBe(3);
    expect(uploads.costModel.sampleCount(false)).toBe(2);
  });

  it('always uploads at least one tile, even beyond both budgets', () => {
    const { uploads, uploaded } = queue();
    uploads.enqueue(1, 0, tile(1, 20_000_000), false);
    uploads.enqueue(2, 1, tile(2, 20_000_000), false);
    expect(uploads.drain({ maxMs: 0.001, maxBytes: 1 })).toBe(1);
    expect(uploads.drain({ maxMs: 0.001, maxBytes: 1 })).toBe(1);
    expect(uploaded).toEqual([1, 2]);
    expect(uploads.drain({ maxMs: 0.001, maxBytes: 1 })).toBe(0);
  });

  it('never lets a lower priority overtake one that does not fit', () => {
    const { uploads, uploaded } = queue();
    uploads.enqueue(1, 0, tile(1, 1_000_000), false);
    uploads.enqueue(2, 1, tile(2, 7_500_000), false);
    uploads.enqueue(3, 2, tile(3, 1000), false);
    const generousTime: UploadBudget = { maxMs: 100, maxBytes: 8_000_000 };
    expect(uploads.drain(generousTime)).toBe(1);
    expect(uploaded).toEqual([1]);
  });

  it('feeds measured uploads to the cost model, which changes the next predictions', () => {
    const costModel = model();
    const { uploads } = queue(() => 0.05, costModel);
    // 256 px RGBA8 tiles with mips, measured at 0.05 ms each: bytes, not time, limit each frame to 22.
    for (let id = 0; id < 200; id++) uploads.enqueue(id, id, tile(id, 349_524), false);
    expect(uploads.drain()).toBe(22);
    let frames = 1;
    let last = 0;
    while (uploads.size > 0) {
      last = uploads.drain();
      frames++;
    }
    expect(last).toBeGreaterThan(0);
    expect(costModel.predictMs(349_524, false)).toBeCloseTo(0.05, 3);
    // 200 arrivals drained within 15 frames (docs/plan/m3-imagery-streaming.md §3).
    expect(frames).toBeLessThanOrEqual(15);
  });

  it('uses the budget of docs/plan/quality.md by default', () => {
    expect(DEFAULT_UPLOAD_BUDGET).toEqual({ maxMs: 2, maxBytes: 8_000_000 });
    expect(() => new UploadQueue<TestTile>({ upload: () => undefined, initialCapacity: 0 })).toThrow(RangeError);
    expect(new UploadQueue<TestTile>({ upload: () => undefined }).costModel).toBeInstanceOf(UploadCostModel);
  });

  test.prop([
    fc.array(fc.tuple(fc.integer({ min: 1, max: 4_000_000 }), fc.boolean()), { minLength: 1, maxLength: 60 }),
    fc.double({ min: 0, max: 3, noNaN: true }),
  ])('keeps every frame within the budget except for its first upload', (sizes, msPerMillion) => {
    const { uploads } = queue((t) => (t.gpuBytes / 1e6) * msPerMillion);
    sizes.forEach(([bytes, compressed], id) => uploads.enqueue(id, id, tile(id, bytes), compressed));
    let drained = 0;
    while (uploads.size > 0) {
      const count = uploads.drain();
      expect(count).toBeGreaterThan(0);
      if (count > 1) expect(uploads.lastDrainBytes).toBeLessThanOrEqual(8_000_000);
      drained += count;
    }
    expect(drained).toBe(sizes.length);
  });
});
