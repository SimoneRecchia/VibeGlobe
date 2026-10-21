import { describe, expect, it } from 'vitest';
import { FakeTimers } from '../globe/test-renderer.js';
import { NetworkPool } from '../scheduler/network-pool.js';
import type { DecodedTile, TileRequest, TileTransport, TransportResult } from '../scheduler/types.js';
import type { WorkerPool, WorkerTaskDone } from '../scheduler/worker-pool-types.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { ImageryLoader } from './imagery-loader.js';
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

function setUp(maxInFlight = 32) {
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
  let frames = 0;
  const loader = new ImageryLoader({
    source,
    network,
    workers: fakeWorkers(),
    handleBase: 100,
    uploadTexture: (handle) => uploaded.push(handle),
    requestFrame: () => frames++,
    now: () => timers.nowMs,
    setTimer: (callback, delayMs) => timers.set(callback, delayMs),
    random: () => 0.5,
  });
  const ok: TransportResult = { kind: 'ok', bytes: new ArrayBuffer(8), contentType: 'image/png' };
  return { timers, transport, loader, uploaded, ok, frames: () => frames };
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
    expect(loader.want(3, 0, 0, 1027)).toBe(-1);
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
});
