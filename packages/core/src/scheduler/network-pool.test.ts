import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEOUTS_MS,
  NO_SLOT,
  NetworkPool,
  type NetworkPoolClient,
  type NetworkPoolOptions,
  type RequestKey,
} from './network-pool.js';
import type { TileRequest, TileTransport, TimeoutsMs, TransportResult } from './types.js';

/** A fake clock with timers and a task queue, advanced explicitly. */
class FakeTime {
  nowMs = 0;
  private timers: { id: number; atMs: number; callback: () => void }[] = [];
  private tasks: (() => void)[] = [];
  private nextId = 1;

  readonly options = {
    now: (): number => this.nowMs,
    setTimer: (callback: () => void, delayMs: number): unknown => {
      const id = this.nextId++;
      this.timers.push({ id, atMs: this.nowMs + delayMs, callback });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      this.timers = this.timers.filter((timer) => timer.id !== handle);
    },
    queueTask: (callback: () => void): void => {
      this.tasks.push(callback);
    },
  };

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Runs queued tasks, including tasks they queue. */
  flush(): void {
    while (this.tasks.length > 0) this.tasks.shift()?.();
  }

  /** Advances the clock, firing due timers in time order and flushing tasks after each. */
  advance(ms: number): void {
    const endMs = this.nowMs + ms;
    for (;;) {
      this.flush();
      const due = this.timers.filter((timer) => timer.atMs <= endMs).sort((a, b) => a.atMs - b.atMs || a.id - b.id);
      const next = due[0];
      if (next === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.nowMs = next.atMs;
      next.callback();
    }
    this.nowMs = endMs;
    this.flush();
  }
}

interface Started {
  readonly request: TileRequest;
  readonly timeouts: TimeoutsMs;
  readonly done: (result: TransportResult) => void;
  aborted: boolean;
  reported: boolean;
}

/** A transport that records requests; tests end them with `respond`. Aborts report 'aborted' in a later task. */
class FakeTransport implements TileTransport {
  readonly started: Started[] = [];
  constructor(private readonly time: FakeTime) {}

  start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void): () => void {
    const entry: Started = { request, timeouts, done, aborted: false, reported: false };
    this.started.push(entry);
    return () => {
      if (entry.aborted || entry.reported) return;
      entry.aborted = true;
      this.time.options.queueTask(() => this.respond(entry, { kind: 'aborted' }));
    };
  }

  respond(entry: Started, result: TransportResult): void {
    if (entry.reported) return;
    entry.reported = true;
    entry.done(result);
  }

  /** Requests not yet reported. */
  get open(): Started[] {
    return this.started.filter((entry) => !entry.reported);
  }
}

function ok(...bytes: number[]): TransportResult {
  return { kind: 'ok', bytes: Uint8Array.from(bytes).buffer, contentType: 'image/png' };
}

function status(code: number): TransportResult {
  return { kind: 'status', status: code, retryAfterMs: undefined };
}

function setup(options: Partial<NetworkPoolOptions> = {}): {
  time: FakeTime;
  transport: FakeTransport;
  pool: NetworkPool;
  results: Map<number, TransportResult[]>;
  consume: (key: RequestKey, hostIndex: number, timeouts?: TimeoutsMs) => number;
} {
  const time = new FakeTime();
  const transport = new FakeTransport(time);
  const pool = new NetworkPool({ ...time.options, ...options });
  const results = new Map<number, TransportResult[]>();
  const consume = (key: RequestKey, hostIndex: number, timeouts?: TimeoutsMs): number => {
    const received: TransportResult[] = [];
    const request = { url: `https://host${String(hostIndex)}/${String(key)}`, hostIndex };
    const id = pool.request(key, request, transport, (result) => received.push(result), timeouts);
    if (id !== NO_SLOT) results.set(id, received);
    return id;
  };
  return { time, transport, pool, results, consume };
}

describe('NetworkPool host limits (F089)', () => {
  it('never exceeds per-host or overall limits and uses hosts in parallel', () => {
    const { pool, transport, consume } = setup({ maxInFlight: 5 });
    const a = pool.registerHost('https://a.example', { maxInFlight: 2 });
    const b = pool.registerHost('https://b.example', { maxInFlight: 4 });
    const accepted = [0, 1, 2, 3].map((i) => consume(`a${String(i)}`, a));
    expect(accepted.filter((id) => id !== NO_SLOT)).toHaveLength(2);
    expect(pool.inFlightOnHost(a)).toBe(2);
    expect(pool.hasFreeSlot(a)).toBe(false);
    const acceptedB = [0, 1, 2, 3].map((i) => consume(`b${String(i)}`, b));
    // The overall limit of 5 leaves 3 slots to host b although its own limit is 4.
    expect(acceptedB.filter((id) => id !== NO_SLOT)).toHaveLength(3);
    expect(pool.counters.inFlight).toBe(5);
    expect(transport.started).toHaveLength(5);
    expect(pool.hasFreeSlot(b)).toBe(false);
  });

  it('defaults to 6 per host, 16 for multiplexed hosts and 32 overall', () => {
    const { pool, consume } = setup();
    const h1 = pool.registerHost('https://h1.example');
    const h2 = pool.registerHost('https://h2.example', { multiplexed: true });
    const h3 = pool.registerHost('https://h3.example', { multiplexed: true });
    expect(pool.hostLimit(h1)).toBe(6);
    expect(pool.hostLimit(h2)).toBe(16);
    let started = 0;
    for (let i = 0; i < 40; i++) {
      for (const host of [h1, h2, h3]) if (consume(`${String(host)}-${String(i)}`, host) !== NO_SLOT) started++;
    }
    expect(started).toBe(32);
    expect(pool.inFlightOnHost(h1)).toBe(6);
  });

  it('keeps the lower limit when an origin registers again, and validates limits', () => {
    const { pool } = setup();
    const osm = pool.registerHost('https://tile.osm.example', { maxInFlight: 2 });
    expect(pool.registerHost('https://tile.osm.example', { multiplexed: true })).toBe(osm);
    expect(pool.hostLimit(osm)).toBe(2);
    pool.registerHost('https://tile.osm.example', { maxInFlight: 1 });
    expect(pool.hostLimit(osm)).toBe(1);
    pool.setHostLimit(osm, 8);
    expect(pool.hostLimit(osm)).toBe(8);
    expect(() => pool.registerHost('https://x.example', { maxInFlight: 0 })).toThrow(RangeError);
    expect(() => pool.setHostLimit(osm, 1.5)).toThrow(RangeError);
    expect(() => new NetworkPool({ ...new FakeTime().options, maxInFlight: -1 })).toThrow(RangeError);
    expect(() => pool.inFlightOnHost(9)).toThrow(/registerHost/);
  });
});

describe('NetworkPool coalescing (F095)', () => {
  it('shares one request between consumers and gives each its own bytes', () => {
    const { pool, transport, time } = setup();
    const host = pool.registerHost('https://a.example');
    const request = { url: 'https://a.example/1/0/0.png', hostIndex: host };
    const received: TransportResult[] = [];
    pool.request('src:1/0/0', request, transport, (result) => {
      // The first consumer transfers its bytes away, as a worker transfer would.
      if (result.kind === 'ok') structuredClone(result.bytes, { transfer: [result.bytes] });
      received.push(result);
    });
    pool.request('src:1/0/0', request, transport, (result) => received.push(result));
    pool.request(42, request, transport, (result) => received.push(result));
    pool.request(42, request, transport, (result) => received.push(result));
    expect(transport.started).toHaveLength(2);
    expect(pool.counters.coalesced).toBe(2);
    expect(pool.isInFlight('src:1/0/0')).toBe(true);
    transport.respond(transport.started[0] as Started, {
      ...ok(1, 2, 3),
      attribution: 'A',
      maxAgeMs: 60,
      cached: true,
    });
    time.flush();
    const second = received[1];
    expect(second?.kind).toBe('ok');
    if (second?.kind === 'ok') expect([...new Uint8Array(second.bytes)]).toEqual([1, 2, 3]);
    // The copy keeps the result's credit, freshness and cache flag.
    expect(second).toMatchObject({ attribution: 'A', maxAgeMs: 60, cached: true });
    expect(pool.isInFlight('src:1/0/0')).toBe(false);
    expect(pool.counters).toMatchObject({ started: 2, completed: 1, inFlight: 1 });
  });

  it('attaches to a request in flight even when the host is full', () => {
    const { pool, transport, consume } = setup();
    const host = pool.registerHost('https://a.example', { maxInFlight: 1 });
    expect(consume('k', host)).not.toBe(NO_SLOT);
    expect(consume('other', host)).toBe(NO_SLOT);
    expect(consume('k', host)).not.toBe(NO_SLOT);
    expect(transport.started).toHaveLength(1);
  });

  it('passes non-byte results to every consumer unchanged', () => {
    const { pool, transport, consume, results } = setup();
    const host = pool.registerHost('https://a.example');
    const first = consume('k', host);
    const second = consume('k', host);
    const failure = status(503);
    transport.respond(transport.started[0] as Started, failure);
    expect(results.get(first)).toEqual([failure]);
    expect(results.get(second)?.[0]).toBe(failure);
  });
});

describe('NetworkPool cancellation (F090)', () => {
  it('aborts only after the last consumer has been gone for the grace period', () => {
    const { pool, transport, time, consume, results } = setup();
    const host = pool.registerHost('https://a.example');
    const first = consume('k', host);
    const second = consume('k', host);
    expect(pool.release(first)).toBe(true);
    expect(pool.release(first)).toBe(false);
    time.advance(500);
    expect(transport.started[0]?.aborted).toBe(false);
    pool.release(second);
    time.advance(99);
    expect(transport.started[0]?.aborted).toBe(false);
    expect(pool.isInFlight('k')).toBe(true);
    time.advance(1);
    expect(transport.started[0]?.aborted).toBe(true);
    expect(pool.counters).toMatchObject({ aborted: 1, completed: 0, inFlight: 0 });
    expect(pool.inFlightOnHost(host)).toBe(0);
    expect(results.get(first)).toEqual([]);
    expect(results.get(second)).toEqual([]);
  });

  it('keeps a request a consumer wants again within the grace period, measured from the last release', () => {
    const { pool, transport, time, consume, results } = setup();
    const host = pool.registerHost('https://a.example');
    pool.release(consume('k', host));
    time.advance(60);
    const again = consume('k', host);
    expect(pool.counters.coalesced).toBe(1);
    pool.release(again);
    time.advance(50);
    expect(transport.started[0]?.aborted).toBe(false);
    const last = consume('k', host);
    time.advance(500);
    expect(transport.started[0]?.aborted).toBe(false);
    transport.respond(transport.started[0] as Started, ok(7));
    expect(results.get(last)?.[0]?.kind).toBe('ok');
    pool.release(last);
    time.advance(200);
    expect(transport.started).toHaveLength(1);
  });

  it('drops bytes that arrive while nobody wants them, and starts afresh after an abort', () => {
    const { pool, transport, time, consume } = setup();
    const host = pool.registerHost('https://a.example');
    pool.release(consume('late', host));
    transport.respond(transport.started[0] as Started, ok(1));
    expect(pool.counters.completed).toBe(1);
    pool.release(consume('gone', host));
    time.advance(100);
    expect(pool.isInFlight('gone')).toBe(false);
    consume('gone', host);
    expect(transport.started).toHaveLength(3);
    expect(transport.started[2]?.aborted).toBe(false);
    expect(pool.counters.coalesced).toBe(0);
  });

  it('aborts at once with a zero grace period', () => {
    const { pool, transport, time, consume } = setup({ abortGraceMs: 0 });
    const host = pool.registerHost('https://a.example');
    pool.release(consume('k', host));
    expect(transport.started[0]?.aborted).toBe(true);
    time.flush();
    expect(pool.counters.inFlight).toBe(0);
  });

  it('aborts every request on disposal and accepts no more', () => {
    const { pool, transport, time, consume, results } = setup();
    const host = pool.registerHost('https://a.example');
    const id = consume('a', host);
    consume('b', host);
    pool.dispose();
    time.flush();
    expect(transport.started.every((entry) => entry.aborted)).toBe(true);
    expect(results.get(id)).toEqual([]);
    expect(pool.counters).toMatchObject({ aborted: 2, inFlight: 0 });
    expect(consume('c', host)).toBe(NO_SLOT);
  });
});

describe('NetworkPool timeouts (F092)', () => {
  it('passes the default or the requested timeouts to the transport', () => {
    const { pool, transport, consume } = setup();
    const host = pool.registerHost('https://a.example');
    consume('a', host);
    consume('b', host, { firstByteMs: 1000, totalMs: 2000 });
    expect(transport.started[0]?.timeouts).toEqual(DEFAULT_TIMEOUTS_MS);
    expect(transport.started[1]?.timeouts).toEqual({ firstByteMs: 1000, totalMs: 2000 });
  });

  it('frees the slot of a transport timeout and lets other tiles load', () => {
    const { pool, transport, time, consume, results } = setup();
    const host = pool.registerHost('https://a.example', { maxInFlight: 1 });
    const id = consume('stalled', host);
    expect(consume('next', host)).toBe(NO_SLOT);
    transport.respond(transport.started[0] as Started, { kind: 'timeout' });
    expect(results.get(id)).toEqual([{ kind: 'timeout' }]);
    expect(pool.counters.timedOut).toBe(1);
    expect(consume('next', host)).not.toBe(NO_SLOT);
    expect(time.pendingTimers).toBe(1);
  });

  it('enforces the total timeout plus slack when the transport never reports', () => {
    const { pool, transport, time, consume, results } = setup();
    const host = pool.registerHost('https://a.example');
    const id = consume('k', host, { firstByteMs: 100, totalMs: 1000 });
    time.advance(1999);
    expect(results.get(id)).toEqual([]);
    time.advance(1);
    expect(results.get(id)).toEqual([{ kind: 'timeout' }]);
    expect(transport.started[0]?.aborted).toBe(true);
    time.flush();
    // The transport's late 'aborted' report is ignored: the slot was released once.
    expect(pool.counters).toMatchObject({ inFlight: 0, timedOut: 1, completed: 1, aborted: 0 });
    expect(results.get(id)).toHaveLength(1);
  });

  it('settles an aborted request whose transport never reports', () => {
    const { pool, time, consume } = setup();
    const silent: TileTransport = { start: () => () => undefined };
    const host = pool.registerHost('https://a.example');
    const id = pool.request('k', { url: 'u', hostIndex: host }, silent, () => undefined);
    expect(consume('other', host)).not.toBe(NO_SLOT);
    pool.release(id);
    time.advance(100);
    expect(pool.counters.inFlight).toBe(2);
    time.advance(31_000);
    expect(pool.counters).toMatchObject({ inFlight: 0, aborted: 1, timedOut: 1 });
  });
});

describe('NetworkPool exit paths', () => {
  it('releases a slot once when a transport reports twice', () => {
    const { pool, transport, consume, results } = setup();
    const host = pool.registerHost('https://a.example');
    const id = consume('k', host);
    const entry = transport.started[0] as Started;
    entry.done(ok(1));
    entry.done({ kind: 'network-error' });
    expect(pool.counters.inFlight).toBe(0);
    expect(pool.inFlightOnHost(host)).toBe(0);
    expect(results.get(id)).toHaveLength(1);
  });

  it('reports a network error when the transport throws', () => {
    const { pool } = setup();
    const host = pool.registerHost('https://a.example');
    const throwing: TileTransport = {
      start: () => {
        throw new Error('boom');
      },
    };
    const received: TransportResult[] = [];
    pool.request('k', { url: 'u', hostIndex: host }, throwing, (result) => received.push(result));
    expect(received).toEqual([{ kind: 'network-error' }]);
    expect(pool.counters).toMatchObject({ inFlight: 0, completed: 1 });
  });

  it('handles a transport that completes synchronously', () => {
    const { pool } = setup();
    const host = pool.registerHost('https://a.example');
    let aborts = 0;
    const immediate: TileTransport = {
      start: (_request, _timeouts, done) => {
        done(ok(5));
        return () => aborts++;
      },
    };
    const received: TransportResult[] = [];
    const id = pool.request('k', { url: 'u', hostIndex: host }, immediate, (result) => received.push(result));
    expect(received).toHaveLength(1);
    expect(pool.release(id)).toBe(false);
    expect(pool.counters.inFlight).toBe(0);
    expect(aborts).toBe(0);
  });

  it('delivers to every consumer when one throws, then rethrows', () => {
    const { pool, transport, consume, results } = setup();
    const host = pool.registerHost('https://a.example');
    pool.request('k', { url: 'u', hostIndex: host }, transport, () => {
      throw new Error('consumer failed');
    });
    const other = consume('k', host);
    expect(() => transport.respond(transport.started[0] as Started, ok(1))).toThrow('consumer failed');
    expect(results.get(other)).toHaveLength(1);
    expect(pool.counters.inFlight).toBe(0);
  });

  it('rethrows a consumer error raised inside a synchronous transport', () => {
    const { pool } = setup();
    const host = pool.registerHost('https://a.example');
    const immediate: TileTransport = {
      start: (_request, _timeouts, done) => {
        done(ok(1));
        return () => undefined;
      },
    };
    const request = { url: 'u', hostIndex: host };
    expect(() =>
      pool.request('k', request, immediate, () => {
        throw new Error('consumer failed');
      }),
    ).toThrow('consumer failed');
    expect(pool.counters).toMatchObject({ inFlight: 0, completed: 1 });
  });
});

/** A client with a queue of keyed priorities per host, as a tile scheduler would keep. */
class QueueClient implements NetworkPoolClient {
  readonly queues = new Map<number, { key: string; priority: number }[]>();
  readonly granted: string[] = [];
  constructor(
    private readonly pool: NetworkPool,
    private readonly transport: TileTransport,
  ) {}

  enqueue(hostIndex: number, key: string, priority: number): void {
    const queue = this.queues.get(hostIndex) ?? [];
    queue.push({ key, priority });
    queue.sort((a, b) => a.priority - b.priority);
    this.queues.set(hostIndex, queue);
  }

  bestQueuedPriority(hostIndex: number): number {
    return this.queues.get(hostIndex)?.[0]?.priority ?? Infinity;
  }

  grant(hostIndex: number): boolean {
    const best = this.queues.get(hostIndex)?.[0];
    if (best === undefined) return false;
    const id = this.pool.request(best.key, { url: best.key, hostIndex }, this.transport, () => undefined);
    if (id === NO_SLOT) return false;
    this.queues.get(hostIndex)?.shift();
    this.granted.push(best.key);
    return true;
  }
}

describe('NetworkPool slot refill', () => {
  it('grants a freed slot at once to the client with the best queued request', () => {
    const { pool, transport, time } = setup();
    const host = pool.registerHost('https://a.example', { maxInFlight: 1 });
    const left = new QueueClient(pool, transport);
    const right = new QueueClient(pool, transport);
    pool.addClient(left);
    pool.addClient(right);
    pool.request('first', { url: 'first', hostIndex: host }, transport, () => undefined);
    left.enqueue(host, 'left-prefetch', 4 * 1024 + 3);
    right.enqueue(host, 'right-visible', 1024 + 12);
    left.enqueue(host, 'left-visible', 1024 + 5);
    transport.respond(transport.started[0] as Started, ok(1));
    time.flush();
    expect(left.granted).toEqual(['left-visible']);
    expect(right.granted).toEqual([]);
    transport.respond(transport.started[1] as Started, ok(1));
    time.flush();
    expect(right.granted).toEqual(['right-visible']);
    expect(time.nowMs).toBe(0);
  });

  it('gives a slot freed on one host to another host when only the overall limit held it back', () => {
    const { pool, transport, time } = setup({ maxInFlight: 1 });
    const a = pool.registerHost('https://a.example');
    const b = pool.registerHost('https://b.example');
    const client = new QueueClient(pool, transport);
    pool.addClient(client);
    pool.request('a0', { url: 'a0', hostIndex: a }, transport, () => undefined);
    client.enqueue(b, 'b0', 1);
    client.enqueue(b, 'b1', 2);
    transport.respond(transport.started[0] as Started, ok(1));
    time.flush();
    expect(client.granted).toEqual(['b0']);
    expect(pool.inFlightOnHost(b)).toBe(1);
  });

  it('fills every free slot when a client attaches, skips clients that start nothing, and detaches', () => {
    const { pool, transport, time } = setup();
    const host = pool.registerHost('https://a.example', { maxInFlight: 2 });
    const client = new QueueClient(pool, transport);
    for (let i = 0; i < 3; i++) client.enqueue(host, `k${String(i)}`, i);
    const stubborn: NetworkPoolClient = { bestQueuedPriority: () => -1, grant: () => false };
    pool.addClient(stubborn);
    const detach = pool.addClient(client);
    time.flush();
    expect(client.granted).toEqual(['k0', 'k1']);
    detach();
    detach();
    transport.respond(transport.started[0] as Started, ok(1));
    time.flush();
    expect(client.granted).toEqual(['k0', 'k1']);
  });
});

describe('NetworkPool host health', () => {
  it('halves the limit on 429 down to 1 and grows it back by 1 every 20 responses', () => {
    const { pool, transport, consume } = setup();
    const host = pool.registerHost('https://a.example', { maxInFlight: 6 });
    const finish = (result: TransportResult): void => {
      consume(`k${String(transport.started.length)}`, host);
      transport.respond(transport.started[transport.started.length - 1] as Started, result);
    };
    finish(status(429));
    expect(pool.hostLimit(host)).toBe(3);
    finish(status(429));
    finish(status(429));
    expect(pool.hostLimit(host)).toBe(1);
    expect(pool.counters.rateLimited).toBe(3);
    for (let i = 0; i < 19; i++) finish(ok(1));
    expect(pool.hostLimit(host)).toBe(1);
    finish(status(404));
    expect(pool.hostLimit(host)).toBe(2);
    for (let i = 0; i < 80; i++) finish(ok(1));
    expect(pool.hostLimit(host)).toBe(6);
    pool.setHostLimit(host, 4);
    finish(status(429));
    pool.setHostLimit(host, 8);
    expect(pool.hostLimit(host)).toBe(2);
  });

  it('allows a single probe after 5 consecutive transient failures until a response arrives', () => {
    const { pool, transport, consume } = setup();
    const host = pool.registerHost('https://a.example');
    const failures: TransportResult[] = [{ kind: 'timeout' }, { kind: 'network-error' }, status(503), status(500)];
    for (const failure of failures) {
      consume(`f${String(transport.started.length)}`, host);
      transport.respond(transport.started[transport.started.length - 1] as Started, failure);
    }
    expect(pool.hostLimit(host)).toBe(6);
    consume('f5', host);
    transport.respond(transport.started[4] as Started, status(502));
    expect(pool.hostLimit(host)).toBe(1);
    expect(consume('probe', host)).not.toBe(NO_SLOT);
    expect(consume('blocked', host)).toBe(NO_SLOT);
    transport.respond(transport.started[5] as Started, ok(1));
    expect(pool.hostLimit(host)).toBe(6);
  });
});

/** Operations of the randomized invariant test. */
const operationArbitrary = fc.oneof(
  fc.record({ kind: fc.constant('request' as const), key: fc.integer({ min: 0, max: 12 }), host: fc.nat(2) }),
  fc.record({ kind: fc.constant('release' as const), pick: fc.nat() }),
  fc.record({
    kind: fc.constant('respond' as const),
    pick: fc.nat(),
    result: fc.constantFrom<TransportResult>(ok(1), status(404), status(429), status(503), { kind: 'timeout' }),
  }),
  fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 400 }) }),
);

describe('NetworkPool invariants', () => {
  test.prop([fc.array(operationArbitrary, { maxLength: 200 })])(
    'caps hold, no key is fetched twice at once, slots release once, released consumers stay silent',
    (operations) => {
      const { pool, transport, time } = setup({ maxInFlight: 5 });
      const limits = [1, 2, 3];
      const hosts = limits.map((limit, i) => pool.registerHost(`https://h${String(i)}`, { maxInFlight: limit }));
      const live: { id: number; key: number; calls: number; released: boolean }[] = [];
      const releasedAt = new Map<Started, number>();
      for (const operation of operations) {
        if (operation.kind === 'request') {
          const consumer = { id: 0, key: operation.key, calls: 0, released: false };
          const hostIndex = hosts[(operation.key + operation.host) % 3] ?? 0;
          consumer.id = pool.request(operation.key, { url: String(operation.key), hostIndex }, transport, () => {
            consumer.calls++;
          });
          if (consumer.id !== NO_SLOT) live.push(consumer);
        } else if (operation.kind === 'release') {
          const consumer = live.filter((c) => !c.released && c.calls === 0)[operation.pick % (live.length || 1)];
          if (consumer !== undefined && pool.release(consumer.id)) consumer.released = true;
        } else if (operation.kind === 'respond') {
          const open = transport.open.filter((entry) => !entry.aborted);
          const entry = open[operation.pick % (open.length || 1)];
          if (entry !== undefined) transport.respond(entry, operation.result);
        } else {
          time.advance(operation.ms);
        }
        time.flush();
        // Caps: per host and overall, counted from the transport's point of view.
        const open = transport.open.filter((entry) => !entry.aborted);
        for (let h = 0; h < hosts.length; h++) {
          expect(pool.inFlightOnHost(h)).toBeLessThanOrEqual(limits[h] ?? 0);
          expect(pool.inFlightOnHost(h)).toBeGreaterThanOrEqual(0);
        }
        expect(pool.counters.inFlight).toBeLessThanOrEqual(5);
        expect(pool.counters.inFlight).toBe(transport.open.length);
        const keys = open.map((entry) => entry.request.url);
        expect(new Set(keys).size).toBe(keys.length);
        for (const consumer of live) {
          expect(consumer.calls).toBeLessThanOrEqual(1);
          if (consumer.released) expect(consumer.calls).toBe(0);
        }
        // An unwanted request is aborted within the grace period.
        for (const entry of transport.open) {
          const wanted = live.some((c) => !c.released && c.calls === 0 && String(c.key) === entry.request.url);
          if (wanted || entry.aborted) releasedAt.delete(entry);
          else if (!releasedAt.has(entry)) releasedAt.set(entry, time.nowMs);
          else expect(time.nowMs - (releasedAt.get(entry) ?? 0)).toBeLessThan(100);
        }
      }
      expect(pool.counters.started).toBe(transport.started.length);
    },
  );
});

describe('NetworkPool rate limits (F222)', () => {
  it('starts no more requests per second in a rate group than its declared rate, and other hosts are not slowed', () => {
    const { pool, transport, consume, time } = setup({ maxInFlight: 100 });
    const limited = pool.registerHost('https://limited.example', { maxInFlight: 50 });
    const free = pool.registerHost('https://free.example', { maxInFlight: 50 });
    const rate = pool.registerRate(10);
    const starts: number[] = [];
    let key = 0;
    const consumeLimited = (k: string): number =>
      pool.request(k, { url: k, hostIndex: limited }, transport, () => undefined, undefined, rate);
    // Every 50 ms, try to start whatever is waiting; answer requests at once so slots never run out.
    for (let step = 0; step < 60; step++) {
      for (let i = 0; i < 4; i++) if (consumeLimited(`l${String(key++)}`) !== NO_SLOT) starts.push(time.nowMs);
      expect(consume(`f${String(key++)}`, free)).not.toBe(NO_SLOT);
      for (const entry of transport.open) transport.respond(entry, ok(1));
      time.advance(50);
    }
    for (const at of starts) expect(starts.filter((t) => t >= at && t < at + 1000).length).toBeLessThanOrEqual(10);
    // Three seconds at ten per second.
    expect(starts.length).toBeGreaterThanOrEqual(28);
  });

  it("limits a source's requests on every host it uses, and another source on the same host is not slowed (KB-109)", () => {
    const { pool, transport, time } = setup({ maxInFlight: 100 });
    const hosts = [
      pool.registerHost('https://a.example', { maxInFlight: 50 }),
      pool.registerHost('https://b.example', { maxInFlight: 50 }),
    ];
    const rate = pool.registerRate(10);
    const limited: number[] = [];
    const free: number[] = [];
    let key = 0;
    for (let step = 0; step < 60; step++) {
      for (let i = 0; i < 4; i++) {
        const hostIndex = hosts[i % 2] ?? 0;
        const request = { url: `l${String(key)}`, hostIndex };
        if (pool.request(`l${String(key++)}`, request, transport, () => undefined, undefined, rate) !== NO_SLOT)
          limited.push(time.nowMs);
        const other = { url: `f${String(key)}`, hostIndex };
        if (pool.request(`f${String(key++)}`, other, transport, () => undefined) !== NO_SLOT) free.push(time.nowMs);
      }
      for (const entry of transport.open) transport.respond(entry, ok(1));
      time.advance(50);
    }
    for (const at of limited) expect(limited.filter((t) => t >= at && t < at + 1000).length).toBeLessThanOrEqual(10);
    expect(limited.length).toBeGreaterThanOrEqual(28);
    // The other source started every request it asked for: four per step.
    expect(free).toHaveLength(240);
  });
});
