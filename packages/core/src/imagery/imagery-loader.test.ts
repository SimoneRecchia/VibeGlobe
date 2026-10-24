import { describe, expect, it } from 'vitest';
import { FakeTimers } from '../globe/test-renderer.js';
import { NetworkPool } from '../scheduler/network-pool.js';
import type { DecodedTile, TileRequest, TileTransport, TransportResult } from '../scheduler/types.js';
import { WorkerTaskError, type WorkerPool, type WorkerTaskDone } from '../scheduler/worker-pool-types.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { RamTier } from '../cache/ram-tier.js';
import { Residency } from '../cache/residency.hot.js';
import { ARRIVING, ImageryLoader, VISIBLE_CLASS } from './imagery-loader.hot.js';
import { imageryDecodeTask, LOAD_KEEP_IN_MEMORY, LOAD_PREFETCH, type ImagerySource } from './imagery-source.js';

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

/**
 * A worker pool the test drives: tasks wait until `finish` answers them, and `cancel` reports the cancel at once, as
 * the real pool does.
 */
function drivenWorkers() {
  const pending = new Map<number, WorkerTaskDone>();
  let id = 0;
  const pool: WorkerPool = {
    url: 'driven',
    run: (_request, done: WorkerTaskDone) => {
      pending.set(++id, done);
      return id;
    },
    setPriority: () => false,
    cancel: (task) => {
      const done = pending.get(task);
      pending.delete(task);
      done?.({ ok: false, error: new WorkerTaskError('cancelled', 'cancelled') });
      return done !== undefined;
    },
    update: () => undefined,
    readStats: (out) => out,
  };
  const finish = (task: number, outcome: Parameters<WorkerTaskDone>[0]): void => {
    const done = pending.get(task);
    pending.delete(task);
    done?.(outcome);
  };
  return { pool, pending, finish };
}

/** A worker pool that decodes at once into a fake tile; `tasks` records each task name and input. */
function fakeWorkers(tasks: { task: string; input: unknown }[] = []): WorkerPool {
  let id = 0;
  return {
    url: 'fake',
    run: (request, done: WorkerTaskDone) => {
      tasks.push({ task: request.task, input: request.input });
      // One byte stands for a payload that does not decode, two for data the device cannot use.
      const length = (request.input as { bytes: ArrayBuffer }).bytes.byteLength;
      if (length === 1) {
        done({ ok: false, error: new WorkerTaskError('task-failed', 'not an image', 'undecodable') });
        return ++id;
      }
      if (length === 2) {
        done({ ok: false, error: new WorkerTaskError('task-failed', 'no transcoder', 'format-unsupported') });
        return ++id;
      }
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

function setUp(
  maxInFlight = 32,
  memory: {
    gpuBytes?: number;
    ramBytes?: number;
    pinnedLevel?: number;
    decoder?: 'image' | 'ktx2';
    workers?: WorkerPool;
    source?: Partial<ImagerySource>;
    prefetchRing?: boolean;
  } = {},
) {
  const tasks: { task: string; input: unknown }[] = [];
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
    decoder: memory.decoder ?? 'image',
    request: (coord, out) => {
      if (coord.level === 9) return 'noData';
      out.url = `https://tiles.test/${coord.level}/${coord.x}/${coord.y}.png`;
      out.hostIndex = 0;
      return out;
    },
    ...memory.source,
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
  const errors: string[] = [];
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
    workers: memory.workers ?? fakeWorkers(tasks),
    memory: { residency, ram, frame: () => frame },
    handleBase: 100,
    pinnedLevel: memory.pinnedLevel ?? -1,
    ...(memory.prefetchRing === undefined ? {} : { prefetchRing: memory.prefetchRing }),
    decodeTask: imageryDecodeTask(source, ['bc']),
    uploadTexture: (handle) => uploaded.push(handle),
    releaseTexture: (handle) => released.push(handle),
    tileError: (_source, level, x, y, reason) => errors.push(`${reason} ${level}/${x}/${y}`),
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
  return {
    timers,
    transport,
    loader,
    uploaded,
    released,
    errors,
    residency,
    ram,
    ok,
    runFrame,
    tasks,
    frames: () => frames,
  };
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

  it('asks for the frames that cancel a request no longer wanted, even when nothing else draws (KB-105)', () => {
    const { timers, transport, loader, frames } = setUp();
    loader.beginFrame();
    loader.want(4, 0, 0, 1);
    loader.endFrame();
    // The view left the tile and the engine would go idle: the loader keeps asking for frames until it cancels it.
    let drawn = 0;
    while (transport.aborted.length === 0 && drawn < 5) {
      const before = frames();
      loader.beginFrame();
      loader.endFrame();
      timers.advance(20);
      drawn++;
      if (frames() === before) break;
    }
    // The network pool aborts a released request after its grace period.
    timers.advance(1000);
    expect(transport.aborted).toEqual([url(4, 0, 0)]);
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

  it('reuses a tile only while its cache headers allow it when the provider asks (F260)', () => {
    const { transport, released, ok, runFrame, timers } = setUp(32, {
      source: { profile: { respectCacheHeaders: true } },
    });
    const fresh: TransportResult = { ...ok, maxAgeMs: 1000 } as TransportResult;
    runFrame([[5, 0, 0]]);
    transport.answer(url(5, 0, 0), fresh);
    runFrame([[5, 0, 0]]);
    const [handle] = runFrame([[5, 0, 0]]);
    expect(handle).toBe(100);
    // Within its lifetime: drawn without a new request.
    timers.advance(900);
    expect(runFrame([[5, 0, 0]])).toEqual([100]);
    expect(transport.started).toEqual([url(5, 0, 0)]);
    // Expired: released, requested again; nothing is drawn from it meanwhile (its ancestors are).
    timers.advance(200);
    expect(runFrame([[5, 0, 0]])).toEqual([-1]);
    expect(released).toContain(100);
    expect(transport.started).toEqual([url(5, 0, 0), url(5, 0, 0)]);
  });

  it('ignores cache headers for sources whose provider does not ask (F260)', () => {
    const { transport, ok, runFrame, timers } = setUp();
    runFrame([[5, 0, 0]]);
    transport.answer(url(5, 0, 0), { ...ok, maxAgeMs: 0 } as TransportResult);
    runFrame([[5, 0, 0]]);
    timers.advance(10_000);
    expect(runFrame([[5, 0, 0]])).toEqual([100]);
    expect(transport.started).toEqual([url(5, 0, 0)]);
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

  it('reports a corrupt tile once and never requests it again; its ancestor stays drawn (F112)', () => {
    const { transport, errors, timers, runFrame } = setUp();
    runFrame([
      [4, 1, 1],
      [3, 0, 0],
    ]);
    transport.answer(url(3, 0, 0), { kind: 'ok', bytes: new ArrayBuffer(8), contentType: 'image/png' });
    transport.answer(url(4, 1, 1), { kind: 'ok', bytes: new ArrayBuffer(1), contentType: 'image/png' });
    for (let frame = 0; frame < 4; frame++) {
      timers.advance(5000);
      runFrame([
        [4, 1, 1],
        [3, 0, 0],
      ]);
    }
    expect(errors).toEqual(['corrupt 4/1/1']);
    expect(transport.started.filter((u) => u === url(4, 1, 1))).toHaveLength(1);
  });

  it('transcodes KTX2 sources for the device formats and reports data it cannot use once (F104)', () => {
    const { transport, errors, timers, runFrame, tasks, uploaded } = setUp(32, { decoder: 'ktx2' });
    runFrame([
      [4, 1, 1],
      [3, 0, 0],
    ]);
    transport.answer(url(3, 0, 0), { kind: 'ok', bytes: new ArrayBuffer(8), contentType: 'image/ktx2' });
    transport.answer(url(4, 1, 1), { kind: 'ok', bytes: new ArrayBuffer(2), contentType: 'image/ktx2' });
    for (let frame = 0; frame < 4; frame++) {
      timers.advance(5000);
      runFrame([
        [4, 1, 1],
        [3, 0, 0],
      ]);
    }
    expect(tasks.map((task) => task.task)).toEqual(['transcode-ktx2', 'transcode-ktx2']);
    expect((tasks[0]?.input as { formats: string[] }).formats).toEqual(['bc']);
    expect(uploaded).toHaveLength(1);
    expect(errors).toEqual(['unsupported 4/1/1']);
    expect(transport.started.filter((u) => u === url(4, 1, 1))).toHaveLength(1);
  });

  it('gives up after the last retry and reports the tile as failed (F091)', () => {
    const { transport, errors, timers, runFrame } = setUp();
    for (let attempt = 0; attempt < 8; attempt++) {
      runFrame([[4, 2, 2]]);
      transport.answer(url(4, 2, 2), { kind: 'status', status: 500, retryAfterMs: undefined });
      timers.advance(40_000);
    }
    // The first request and four retries.
    expect(transport.started).toHaveLength(5);
    expect(errors).toEqual(['failed 4/2/2']);
  });

  it('gives a tile that loaded after retries its full retries again when it is next requested (KB-160)', () => {
    const { transport, errors, timers, runFrame, loader, uploaded, ok } = setUp(6, { ramBytes: 0 });
    const fail = { kind: 'status', status: 500, retryAfterMs: undefined } as const;
    for (let attempt = 0; attempt < 4; attempt++) {
      runFrame([[4, 2, 2]]);
      transport.answer(url(4, 2, 2), fail);
      timers.advance(40_000);
    }
    runFrame([[4, 2, 2]]);
    transport.answer(url(4, 2, 2), ok);
    runFrame([[4, 2, 2]]);
    expect(uploaded).toHaveLength(1);
    loader.evicted((uploaded[0] ?? 0) - 100);
    for (let attempt = 0; attempt < 8; attempt++) {
      runFrame([[4, 2, 2]]);
      transport.answer(url(4, 2, 2), fail);
      timers.advance(40_000);
    }
    // Five requests before the success, then the first request and four retries again.
    expect(transport.started).toHaveLength(10);
    expect(errors).toEqual(['failed 4/2/2']);
  });

  it('requests a tile whose retries ran out during an outage again once the source answers another tile (KB-162)', () => {
    const { transport, errors, timers, runFrame, loader, ok } = setUp();
    for (let attempt = 0; attempt < 8; attempt++) {
      runFrame([[4, 2, 2]]);
      transport.answer(url(4, 2, 2), { kind: 'network-error' });
      timers.advance(40_000);
    }
    expect(loader.failed(4, 2, 2)).toBe(true);
    // The source is back: another tile loads, and the dead one is requested again.
    runFrame([[4, 2, 3]]);
    transport.answer(url(4, 2, 3), ok);
    expect(loader.failed(4, 2, 2)).toBe(false);
    runFrame([[4, 2, 2]]);
    expect(transport.started.filter((u) => u === url(4, 2, 2))).toHaveLength(6);
    expect(errors).toEqual(['failed 4/2/2']);
  });

  it('never requests a corrupt tile again, even once the source answers others (F112, KB-162)', () => {
    const { transport, timers, runFrame, loader, ok } = setUp();
    runFrame([[4, 2, 2]]);
    transport.answer(url(4, 2, 2), { kind: 'ok', bytes: new ArrayBuffer(1), contentType: 'image/png' });
    expect(loader.failed(4, 2, 2)).toBe(true);
    runFrame([[4, 2, 3]]);
    transport.answer(url(4, 2, 3), ok);
    timers.advance(5000);
    runFrame([[4, 2, 2]]);
    expect(transport.started.filter((u) => u === url(4, 2, 2))).toHaveLength(1);
  });

  it('shares one request between two loaders wanting the same tile (F095)', () => {
    const timers = new FakeTimers();
    const transport = new ManualTransport();
    const network = new NetworkPool({
      now: () => timers.nowMs,
      setTimer: (callback, delayMs) => timers.set(callback, delayMs),
      clearTimer: (handle) => timers.clear(handle),
      queueTask: (callback) => timers.set(callback, 0),
    });
    const uploaded: number[] = [];
    const loaders = [0, 1000].map((handleBase) => {
      const residency = new Residency({ budgetBytes: 1e9 });
      return new ImageryLoader({
        source: {
          id: 'shared',
          tiling: WEB_MERCATOR_TILING,
          minLevel: 0,
          maxLevel: 10,
          transport,
          request: (coord, out) => {
            out.url = url(coord.level, coord.x, coord.y);
            return out;
          },
        },
        network,
        workers: fakeWorkers(),
        memory: { residency, ram: new RamTier({ budgetBytes: 1e9 }), frame: () => 1 },
        handleBase,
        pinnedLevel: -1,
        decodeTask: (bytes, contentType) => ({ task: 'decode-image', input: { bytes, contentType } }),
        uploadTexture: (handle) => uploaded.push(handle),
        releaseTexture: () => undefined,
        requestFrame: () => undefined,
        tileError: () => undefined,
        now: () => timers.nowMs,
        setTimer: (callback, delayMs) => timers.set(callback, delayMs),
        random: () => 0.5,
      });
    });
    for (const loader of loaders) {
      loader.beginFrame();
      loader.want(6, 3, 3, 1);
      loader.endFrame();
    }
    transport.answer(url(6, 3, 3), { kind: 'ok', bytes: new ArrayBuffer(8), contentType: 'image/png' });
    for (const loader of loaders) {
      loader.beginFrame();
      loader.want(6, 3, 3, 1);
      loader.endFrame();
    }
    expect(transport.started).toEqual([url(6, 3, 3)]);
    expect(uploaded).toEqual([0, 1000]);
  });

  it('loads the whole pinned base even when its tiles are also wanted as visible ancestors (KB-067)', () => {
    const { transport, loader, residency, ok } = setUp(2, { pinnedLevel: 1 });
    for (let frame = 1; frame <= 6 && !loader.pinnedComplete; frame++) {
      residency.startFrame(frame);
      loader.beginFrame();
      // A pinned level-1 tile wanted as the ancestor of an edge tile gets a larger key (1024 + 1 + 2 · distance) than
      // a visible tile at the center (1024 + 6).
      loader.want(1, 1, 1, 1027);
      loader.want(6, 30, 20, 1030 - 4);
      loader.endFrame();
      for (const u of [...transport.open.keys()]) transport.answer(u, ok);
    }
    expect(loader.pinnedComplete).toBe(true);
  });

  it('cancelling a decoding tile keeps every other active tile tracked, so it is cancelled when unwanted (M3 review)', () => {
    const workers = drivenWorkers();
    const { transport, ok, runFrame, timers } = setUp(32, { workers: workers.pool });
    runFrame([
      [5, 1, 1],
      [5, 2, 2],
    ]);
    // 5/1/1 is decoding; 5/2/2 is still loading.
    transport.answer(url(5, 1, 1), ok);
    for (let frame = 0; frame < 3; frame++) runFrame([[5, 2, 2]]);
    for (let frame = 0; frame < 3; frame++) runFrame([]);
    timers.advance(5000);
    expect(transport.aborted).toContain(url(5, 2, 2));
  });

  it('a tile of a full host steps aside for a tile of a free host (M3 review)', () => {
    const { transport, runFrame } = setUp(32, {
      source: {
        maxRequestsPerHost: 1,
        request: (coord, out) => {
          out.url = `https://${coord.x === 9 ? 'b' : 'a'}.tiles.test/${coord.level}/${coord.x}/${coord.y}.png`;
          out.hostIndex = 0;
          return out;
        },
      },
    });
    runFrame([
      [6, 1, 1],
      [6, 2, 1],
      [6, 9, 1],
    ]);
    expect(transport.started.map((u) => new URL(u).host)).toEqual(['a.tiles.test', 'b.tiles.test']);
  });

  it('a tile the GPU budget refuses is not counted as an upload and waits before it is decoded again (M3 review)', () => {
    const { transport, loader, ok, runFrame, tasks, timers } = setUp(32, { gpuBytes: 1000 });
    runFrame([[4, 1, 1]]);
    transport.answer(url(4, 1, 1), ok);
    for (let frame = 0; frame < 5; frame++) runFrame([[4, 1, 1]]);
    const stats = { queued: 0, loading: 0, decoding: 0, ready: 0, failed: 0, noData: 0, requested: 0, uploads: 0 };
    loader.addStats(stats as Parameters<ImageryLoader['addStats']>[0]);
    expect(stats.uploads).toBe(0);
    expect(tasks).toHaveLength(1);
    expect(loader.busy).toBe(false);
    timers.advance(1000);
    runFrame([[4, 1, 1]]);
    expect(tasks).toHaveLength(2);
  });

  it('a decode the worker cannot finish is retried with backoff, then reported (M3 review)', () => {
    const workers = drivenWorkers();
    const { transport, ok, runFrame, errors, timers } = setUp(32, { workers: workers.pool });
    runFrame([[4, 1, 1]]);
    transport.answer(url(4, 1, 1), ok);
    for (let attempt = 0; attempt < 4; attempt++) {
      const [task] = [...workers.pending.keys()];
      workers.finish(task ?? -1, { ok: false, error: new WorkerTaskError('crash', 'worker crashed') });
      runFrame([[4, 1, 1]]);
      expect(workers.pending.size).toBe(0);
      timers.advance(10_000);
      runFrame([[4, 1, 1]]);
    }
    expect(errors).toEqual(['failed 4/1/1']);
    // From the RAM copy: the tile was downloaded once.
    expect(transport.started.filter((u) => u === url(4, 1, 1))).toHaveLength(1);
  });

  it('prefetches the ring around the visible tiles after them, and nothing beyond the view without prefetch (F284, F285)', () => {
    for (const flags of [LOAD_KEEP_IN_MEMORY | LOAD_PREFETCH, LOAD_KEEP_IN_MEMORY]) {
      const { transport, runFrame } = setUp(32, {
        prefetchRing: true,
        source: { loadingFlags: () => flags, maxRequestsPerHost: 16 },
      });
      runFrame([[5, 10, 10]]);
      if (flags & LOAD_PREFETCH) {
        expect(transport.started[0]).toBe(url(5, 10, 10));
        expect(new Set(transport.started.slice(1))).toEqual(
          new Set(
            [-1, 0, 1].flatMap((dy) => [-1, 0, 1].filter((dx) => dx || dy).map((dx) => url(5, 10 + dx, 10 + dy))),
          ),
        );
      } else expect(transport.started).toEqual([url(5, 10, 10)]);
    }
  });

  it('during a flight requests a visible tile only once it stays wanted, never one the view shows for a moment (F287)', () => {
    const { timers, transport, loader } = setUp();
    loader.settleMs = 400;
    const frame = (tiles: [number, number, number][]): void => {
      loader.beginFrame();
      for (const [level, x, y] of tiles) loader.want(level, x, y, VISIBLE_CLASS + level);
      loader.endFrame();
      timers.advance(100);
    };
    // Wanted for 300 ms, then gone: never requested.
    for (let i = 0; i < 3; i++) frame([[6, 1, 1]]);
    frame([]);
    // Wanted again from scratch: requested once it has been wanted in every frame for 400 ms.
    for (let i = 0; i < 4; i++) frame([[6, 1, 1]]);
    expect(transport.started).toEqual([]);
    frame([[6, 1, 1]]);
    expect(transport.started).toEqual([url(6, 1, 1)]);
  });

  it('keeps tiles that left the view in memory with memory reuse, and releases them at once without it (F281, F282)', () => {
    for (const flags of [LOAD_KEEP_IN_MEMORY, 0]) {
      const { transport, released, ram, ok, runFrame } = setUp(32, { source: { loadingFlags: () => flags } });
      runFrame([[5, 0, 0]]);
      transport.answer(url(5, 0, 0), ok);
      runFrame([[5, 0, 0]]);
      // The tile leaves the view: kept on the GPU and in RAM with reuse, released from both without it.
      runFrame([[5, 3, 3]]);
      expect(released, `flags ${flags}`).toEqual(flags ? [] : [100]);
      expect(ram.has(100), `flags ${flags}`).toBe(flags !== 0);
    }
  });

  it('forgets every tile on reload: textures and RAM copies released, and the tiles requested again (KB-PT-19, F279)', () => {
    const { transport, loader, released, ram, ok, runFrame } = setUp(32);
    runFrame([[5, 0, 0]]);
    transport.answer(url(5, 0, 0), ok);
    runFrame([[5, 0, 0]]);
    expect(runFrame([[5, 0, 0]])).toEqual([100]);
    loader.reload();
    expect(released).toEqual([100]);
    expect(ram.has(100)).toBe(false);
    // The next frame wants it again: a new request, not the old texture or bytes.
    expect(runFrame([[5, 0, 0]])).toEqual([-1]);
    expect(transport.started).toEqual([url(5, 0, 0), url(5, 0, 0)]);
  });

  it('cancels the prefetch requests of a view the camera left (F284)', () => {
    const { transport, timers, runFrame } = setUp(32, { prefetchRing: true, source: { maxRequestsPerHost: 16 } });
    runFrame([[5, 10, 10]]);
    const ring = transport.started.slice(1);
    expect(ring).toHaveLength(8);
    for (let i = 0; i < 3; i++) {
      runFrame([[5, 30, 30]]);
      timers.advance(100);
    }
    expect(transport.aborted).toEqual(expect.arrayContaining(ring));
  });
});
