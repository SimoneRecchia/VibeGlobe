import { describe, expect, it } from 'vitest';
import { FakeTimers } from '../globe/test-renderer.js';
import { NetworkPool } from '../scheduler/network-pool.js';
import type { DecodedTile, TileRequest, TileTransport, TransportResult } from '../scheduler/types.js';
import type { WorkerPool, WorkerTaskDone } from '../scheduler/worker-pool-types.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { RamTier } from '../cache/ram-tier.js';
import { Residency } from '../cache/residency.hot.js';
import { ARRIVING, ImageryLoader } from './imagery-loader.js';
import type { ImagerySource } from './imagery-source.js';

/** A transport whose requests the test answers by URL. */
class ManualTransport implements TileTransport {
  readonly open = new Map<string, (result: TransportResult) => void>();
  readonly started: string[] = [];
  readonly aborted: string[] = [];

  start(request: TileRequest, _timeouts: unknown, done: (result: TransportResult) => void): () => void {
    this.started.push(request.url);
    this.open.set(request.url, done);
    return () => {
      this.aborted.push(request.url);
      this.open.delete(request.url);
      done({ kind: 'aborted' });
    };
  }

  answer(url: string, result: TransportResult): void {
    const done = this.open.get(url);
    this.open.delete(url);
    done?.(result);
  }
}

/** A worker pool that decodes at once into a fake tile. */
function fakeWorkers(): WorkerPool {
  let id = 0;
  return {
    url: 'fake',
    run: (request, done: WorkerTaskDone) => {
      const tile: DecodedTile = { widthPx: 256, heightPx: 256, gpuBytes: 349_524, image: request.input };
      done({ ok: true, output: tile });
      return ++id;
    },
    setPriority: () => false,
    cancel: () => false,
    update: () => undefined,
    readStats: (out) => out,
  };
}

function setUp(maxInFlight = 32, memory: { gpuBytes?: number; ramBytes?: number; pinnedLevel?: number } = {}) {
  const timers = new FakeTimers();
  const transport = new ManualTransport();
  const source: ImagerySource = {
    id: 'test',
    tiling: WEB_MERCATOR_TILING,
    minLevel: 0,
    maxLevel: 10,
    tileSizePx: 256,
    pixelRatio: 1,
    transport,
    decoder: 'image',
    request: (coord, out) => {
      if (coord.level === 9) return 'noData';
      out.url = `https://tiles.test/${coord.level}/${coord.x}/${coord.y}.png`;
      out.hostIndex = 0;
      return out;
    },
  };
  const network = new NetworkPool({
    now: () => timers.nowMs,
    setTimer: (callback, delayMs) => timers.set(callback, delayMs),
    clearTimer: (handle) => timers.clear(handle),
    queueTask: (callback) => timers.set(callback, 0),
    maxInFlight,
  });
  const uploaded: number[] = [];
  const released: number[] = [];
  let frames = 0;
  let frame = 0;
  // eslint-disable-next-line prefer-const -- assigned after the residency that calls it is built
  let loader: ImageryLoader;
  const residency = new Residency({
    budgetBytes: memory.gpuBytes ?? 1e9,
    onEvict: (handle) => loader.evicted(handle - 100),
  });
  const ram = new RamTier({ budgetBytes: memory.ramBytes ?? 1e9 });
  loader = new ImageryLoader({
    source,
    network,
    workers: fakeWorkers(),
    memory: { residency, ram, frame: () => frame },
    handleBase: 100,
    pinnedLevel: memory.pinnedLevel ?? -1,
    uploadTexture: (handle) => uploaded.push(handle),
    releaseTexture: (handle) => released.push(handle),
    requestFrame: () => frames++,
    now: () => timers.nowMs,
    setTimer: (callback, delayMs) => timers.set(callback, delayMs),
    random: () => 0.5,
  });
  const ok: TransportResult = { kind: 'ok', bytes: new ArrayBuffer(8), contentType: 'image/png' };
  /** One frame wanting `tiles` (level, x, y), the way the engine drives the loader. */
  const runFrame = (tiles: [number, number, number][]): number[] => {
    frame++;
    residency.startFrame(frame);
    loader.beginFrame();
    const handles = tiles.map(([level, x, y], i) => loader.want(level, x, y, 1024 + level + i / 1000));
    for (const handle of handles) if (handle >= 0) loader.markDrawn(handle);
    loader.endFrame();
    residency.trim(frame, 64);
    return handles;
  };
  return { timers, transport, loader, uploaded, released, residency, ram, ok, runFrame, frames: () => frames };
}

const url = (level: number, x: number, y: number): string => `https://tiles.test/${level}/${x}/${y}.png`;

describe('ImageryLoader', () => {
  it('requests wanted tiles in priority order and draws them once decoded and uploaded (F088)', () => {
    const { transport, loader, uploaded, ok } = setUp(2);
    loader.beginFrame();
    loader.want(5, 1, 1, 1030);
    loader.want(3, 0, 0, 1027);
    loader.want(4, 0, 0, 1028);
    loader.endFrame();
    // Two slots: the two best priorities, coarse first.
    expect(transport.started).toEqual([url(3, 0, 0), url(4, 0, 0)]);
    transport.answer(url(3, 0, 0), ok);
    loader.beginFrame();
    // Decoded, waiting for its upload: arriving, not yet drawable.
    expect(loader.want(3, 0, 0, 1027)).toBe(ARRIVING);
    loader.want(4, 0, 0, 1028);
    loader.want(5, 1, 1, 1030);
    loader.endFrame();
    expect(uploaded).toHaveLength(1);
    loader.beginFrame();
    expect(loader.want(3, 0, 0, 1027)).toBe(uploaded[0]);
    expect(loader.readyHandle(3, 0, 0)).toBe(uploaded[0]);
    expect(transport.started).toContain(url(5, 1, 1));
  });

  it('never requests a tile the source has no data for, nor one answered 404 again (F093, F094)', () => {
    const { timers, transport, loader } = setUp();
    loader.beginFrame();
    loader.want(9, 3, 3, 1);
    loader.want(6, 1, 1, 2);
    loader.endFrame();
    transport.answer(url(6, 1, 1), { kind: 'status', status: 404, retryAfterMs: undefined });
    for (let frame = 0; frame < 5; frame++) {
      timers.advance(1000);
      loader.beginFrame();
      expect(loader.want(9, 3, 3, 1)).toBe(-1);
      loader.want(6, 1, 1, 2);
      loader.endFrame();
    }
    expect(transport.started).toEqual([url(6, 1, 1)]);
  });

  it('retries a transient failure after its backoff and then loads the tile (F091)', () => {
    const { timers, transport, loader, uploaded, ok } = setUp();
    const frame = (): void => {
      loader.beginFrame();
      loader.want(4, 2, 2, 1);
      loader.endFrame();
    };
    frame();
    transport.answer(url(4, 2, 2), { kind: 'status', status: 503, retryAfterMs: undefined });
    frame();
    expect(transport.started).toHaveLength(1);
    // Full jitter with random 0.5 waits half of the first 500 ms ceiling.
    timers.advance(250);
    frame();
    expect(transport.started).toHaveLength(2);
    transport.answer(url(4, 2, 2), ok);
    frame();
    expect(uploaded).toHaveLength(1);
  });

  it('drops queued tiles at once and aborts requests unwanted for two frames (F090)', () => {
    const { timers, transport, loader } = setUp(1);
    loader.beginFrame();
    loader.want(4, 0, 0, 1);
    loader.want(4, 1, 0, 2);
    loader.endFrame();
    expect(transport.started).toEqual([url(4, 0, 0)]);
    // The camera moved on: neither tile is wanted any more.
    for (let frame = 0; frame < 3; frame++) {
      loader.beginFrame();
      loader.want(7, 9, 9, 1);
      loader.endFrame();
      timers.advance(50);
    }
    timers.advance(200);
    expect(transport.aborted).toEqual([url(4, 0, 0)]);
    loader.beginFrame();
    loader.want(7, 9, 9, 1);
    loader.endFrame();
    timers.advance(10);
    expect(transport.started).toEqual([url(4, 0, 0), url(7, 9, 9)]);
  });

  it('keeps GPU use within its budget, evicting the least recently used tile but never one drawn (F098, F102)', () => {
    const { transport, uploaded, released, residency, ok, runFrame } = setUp(32, { gpuBytes: 3 * 349_524 });
    const answer = (): void => {
      for (const url of [...transport.open.keys()]) transport.answer(url, ok);
    };
    runFrame([
      [5, 0, 0],
      [5, 1, 0],
      [5, 2, 0],
    ]);
    answer();
    runFrame([
      [5, 0, 0],
      [5, 1, 0],
      [5, 2, 0],
    ]);
    expect(uploaded).toEqual([100, 101, 102]);
    // Re-showing resident tiles uploads nothing.
    runFrame([
      [5, 0, 0],
      [5, 1, 0],
      [5, 2, 0],
    ]);
    expect(uploaded).toHaveLength(3);
    // A new tile while two old ones stay on screen: the one left off screen goes, the drawn ones stay.
    runFrame([
      [5, 3, 0],
      [5, 1, 0],
      [5, 2, 0],
    ]);
    answer();
    runFrame([
      [5, 3, 0],
      [5, 1, 0],
      [5, 2, 0],
    ]);
    expect(released).toEqual([100]);
    expect(uploaded).toEqual([100, 101, 102, 103]);
    expect(residency.usedBytes).toBeLessThanOrEqual(3 * 349_524);
  });

  it('serves a tile evicted from the GPU from the RAM tier, with no new request (F097)', () => {
    const { transport, uploaded, ram, ok, runFrame } = setUp(32, { gpuBytes: 349_524 });
    runFrame([[5, 0, 0]]);
    transport.answer(url(5, 0, 0), ok);
    runFrame([[5, 0, 0]]);
    runFrame([[5, 1, 0]]);
    transport.answer(url(5, 1, 0), ok);
    runFrame([[5, 1, 0]]);
    // Back to the first tile: decoded from its RAM copy and uploaded again, without the network.
    runFrame([[5, 0, 0]]);
    runFrame([[5, 0, 0]]);
    expect(transport.started).toEqual([url(5, 0, 0), url(5, 1, 0)]);
    expect(uploaded).toEqual([100, 101, 100]);
    expect(ram.hits).toBe(1);
  });

  it('loads the pinned base before any other tile and never evicts it (F084)', () => {
    const { transport, residency, loader, ok, runFrame } = setUp(32, { pinnedLevel: 1, gpuBytes: 6 * 349_524 });
    runFrame([[6, 30, 20]]);
    // Levels 0 and 1: five tiles requested, the visible one held back until they are resident.
    expect(transport.started.map((u) => u.split('/').slice(3, 4)[0])).toEqual(['0', '1', '1', '1', '1']);
    for (const u of [...transport.open.keys()]) transport.answer(u, ok);
    runFrame([[6, 30, 20]]);
    expect(loader.pinnedComplete).toBe(true);
    runFrame([[6, 30, 20]]);
    expect(transport.started).toContain(url(6, 30, 20));
    transport.answer(url(6, 30, 20), ok);
    runFrame([[6, 30, 20]]);
    // The budget holds six tiles: a seventh, off screen next frame, can only push out the visible one, never the base.
    runFrame([[6, 31, 20]]);
    transport.answer(url(6, 31, 20), ok);
    runFrame([[6, 31, 20]]);
    for (const handle of [100, 101, 102, 103, 104]) expect(residency.isPinned(handle)).toBe(true);
  });
});
