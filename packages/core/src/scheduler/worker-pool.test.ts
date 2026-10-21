import { afterEach, describe, expect, it } from 'vitest';
import { acquireWorkerPool } from './worker-pool.js';
import type {
  PoolTimers,
  WorkerPool,
  WorkerPoolEvent,
  WorkerPoolLease,
  WorkerPoolOptions,
  WorkerPoolStats,
  WorkerTaskOutcome,
  WorkerTaskRequest,
} from './worker-pool-types.js';
import {
  parseWorkerMessage,
  serializeTaskError,
  WORKER_PROTOCOL_VERSION,
  type TaskTable,
  type WorkerEndpoint,
  type WorkerEndpointFactory,
  type WorkerRequest,
} from './worker-protocol.js';

const BUILD = 'build-1';

/** Timers driven by the test: `advance` runs every callback that comes due, in order. */
class ManualTimers implements PoolTimers {
  private nowMs = 0;
  private nextHandle = 1;
  private readonly due = new Map<number, { atMs: number; callback: () => void }>();

  set(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.due.set(handle, { atMs: this.nowMs + delayMs, callback });
    return handle;
  }

  clear(handle: unknown): void {
    this.due.delete(handle as number);
  }

  get pending(): number {
    return this.due.size;
  }

  advance(ms: number): void {
    const targetMs = this.nowMs + ms;
    for (;;) {
      let next: [number, { atMs: number; callback: () => void }] | undefined;
      for (const entry of this.due)
        if (entry[1].atMs <= targetMs && (!next || entry[1].atMs < next[1].atMs)) next = entry;
      if (!next) break;
      this.due.delete(next[0]);
      this.nowMs = next[1].atMs;
      next[1].callback();
    }
    this.nowMs = targetMs;
  }
}

/** A worker as the pool sees it, driven by the test. */
class FakeEndpoint implements WorkerEndpoint {
  readonly posted: { message: WorkerRequest; transfer: readonly object[] }[] = [];
  terminated = false;
  failPosts = false;

  constructor(
    private readonly onMessage: (data: unknown) => void,
    private readonly onError: (reason: string) => void,
  ) {}

  post(message: WorkerRequest, transfer: readonly object[]): void {
    if (this.terminated) throw new Error('post after terminate');
    if (this.failPosts) throw new Error('could not be cloned');
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  ready(version = WORKER_PROTOCOL_VERSION, buildId = BUILD): void {
    this.onMessage({ kind: 'ready', version, buildId });
  }

  /** Ids of the run messages received, in order. */
  runIds(): number[] {
    return this.posted.flatMap(({ message }) => (message.kind === 'run' ? [message.id] : []));
  }

  cancelIds(): number[] {
    return this.posted.flatMap(({ message }) => (message.kind === 'cancel' ? [message.id] : []));
  }

  reply(id: number, output: unknown): void {
    this.onMessage({ kind: 'reply', id, ok: true, output });
  }

  replyError(id: number, code: string, message: string): void {
    this.onMessage({ kind: 'reply', id, ok: false, error: { code, message } });
  }

  send(data: unknown): void {
    this.onMessage(data);
  }

  crash(reason = 'boom'): void {
    this.onError(reason);
  }
}

let urlCounter = 0;
const leases: WorkerPoolLease[] = [];

interface Harness {
  readonly factory: WorkerEndpointFactory;
  readonly endpoints: FakeEndpoint[];
  readonly discarded: unknown[];
  readonly events: WorkerPoolEvent[];
  readonly timers: ManualTimers;
  readonly lease: WorkerPoolLease;
  readonly pool: WorkerPool;
  /** The endpoints not terminated. */
  live(): FakeEndpoint[];
  /** Queues a task and records its outcome. */
  run(request: Partial<WorkerTaskRequest> & { priority?: number }): { id: number; outcomes: WorkerTaskOutcome[] };
  stats(): WorkerPoolStats;
}

interface HarnessOptions {
  readonly factory?: Partial<WorkerEndpointFactory>;
  readonly pool?: Partial<WorkerPoolOptions>;
  /** Makes `create` throw for the first n workers. */
  readonly failCreates?: number;
  /** Leaves the build id out of the factory. */
  readonly noBuildId?: boolean;
}

const DOUBLE: TaskTable = {
  double: (input) => ({ output: (input as number) * 2, transfer: [] }),
  asyncDouble: async (input) => ({ output: (await Promise.resolve(input as number)) * 2, transfer: [] }),
  broken: () => {
    throw Object.assign(new Error('bad bytes'), { code: 'undecodable' });
  },
};

function harness(options: HarnessOptions = {}): Harness {
  const endpoints: FakeEndpoint[] = [];
  const discarded: unknown[] = [];
  const events: WorkerPoolEvent[] = [];
  const timers = new ManualTimers();
  let createFailures = options.failCreates ?? 0;
  const factory: WorkerEndpointFactory = {
    url: `https://app.test/vibeglobe-worker-${++urlCounter}.js`,
    buildId: BUILD,
    maxWorkers: 1,
    create: (onMessage, onError) => {
      if (createFailures > 0) {
        createFailures -= 1;
        throw new Error('SecurityError: refused by worker-src');
      }
      const endpoint = new FakeEndpoint(onMessage, onError);
      endpoints.push(endpoint);
      return endpoint;
    },
    inline: () => Promise.resolve(DOUBLE),
    discard: (output) => discarded.push(output),
    ...options.factory,
  };
  if (options.noBuildId) Reflect.deleteProperty(factory, 'buildId');
  const lease = acquireWorkerPool(factory, { timers, onEvent: (event) => events.push(event), ...options.pool });
  leases.push(lease);
  const stats: WorkerPoolStats = { mode: 'workers', workers: 0, starting: 0, busy: 0, queued: 0 };
  return {
    factory,
    endpoints,
    discarded,
    events,
    timers,
    lease,
    pool: lease.pool,
    live: () => endpoints.filter((endpoint) => !endpoint.terminated),
    run: (request) => {
      const outcomes: WorkerTaskOutcome[] = [];
      const id = lease.pool.run({ task: 'double', input: 1, ...request }, (outcome) => outcomes.push(outcome));
      return { id, outcomes };
    },
    stats: () => ({ ...lease.pool.readStats(stats) }),
  };
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

function errorOf(outcome: WorkerTaskOutcome | undefined): { code: string; taskCode: string | undefined; name: string } {
  if (!outcome || outcome.ok) throw new Error(`expected a failure, got ${JSON.stringify(outcome)}`);
  return { code: outcome.error.code, taskCode: outcome.error.taskCode, name: outcome.error.name };
}

/** Lets promise callbacks and the inline executor's macrotask run. */
async function settle(timers: ManualTimers, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    timers.advance(0);
  }
}

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
});

describe('worker protocol', () => {
  it('accepts only well-formed worker messages', () => {
    expect(parseWorkerMessage({ kind: 'ready', version: 1, buildId: 'b' })).toEqual({
      kind: 'ready',
      version: 1,
      buildId: 'b',
    });
    expect(parseWorkerMessage({ kind: 'reply', id: 3, ok: true, output: undefined })).toEqual({
      kind: 'reply',
      id: 3,
      ok: true,
      output: undefined,
    });
    expect(parseWorkerMessage({ kind: 'reply', id: 3, ok: false, error: { code: 'x', message: 'y' } })).toEqual({
      kind: 'reply',
      id: 3,
      ok: false,
      error: { code: 'x', message: 'y' },
    });
    for (const bad of [
      null,
      '<!doctype html>',
      { kind: 'ready', version: '1', buildId: 'b' },
      { kind: 'reply', id: '3', ok: true, output: 1 },
      { kind: 'reply', id: 3, ok: true },
      { kind: 'reply', id: 3, ok: false, error: 'x' },
      { kind: 'reply', id: 3, ok: 'yes', output: 1 },
      { kind: 'other', id: 3 },
    ])
      expect(parseWorkerMessage(bad)).toBeUndefined();
  });

  it('serializes thrown values with their code', () => {
    expect(serializeTaskError(Object.assign(new Error('m'), { code: 'undecodable' }))).toEqual({
      code: 'undecodable',
      message: 'm',
    });
    expect(serializeTaskError(new Error('m'))).toEqual({ code: 'task-error', message: 'm' });
    expect(serializeTaskError('text')).toEqual({ code: 'task-error', message: 'text' });
  });
});

describe('worker pool', () => {
  it('starts one worker and dispatches only after the handshake', () => {
    const h = harness();
    const worker = only(h.endpoints);
    const task = h.run({ input: 21, transfer: [new ArrayBuffer(4)] });
    expect(worker.posted).toEqual([]);
    expect(h.stats()).toEqual({ mode: 'workers', workers: 1, starting: 1, busy: 0, queued: 1 });

    worker.ready();
    const run = only(worker.posted);
    expect(run.message).toEqual({ kind: 'run', id: task.id, task: 'double', input: 21 });
    expect(run.transfer).toHaveLength(1);
    expect(h.stats()).toMatchObject({ starting: 0, busy: 1, queued: 0 });

    worker.reply(task.id, 42);
    expect(task.outcomes).toEqual([{ ok: true, output: 42 }]);
    expect(h.stats()).toMatchObject({ busy: 0 });
  });

  it('dispatches by priority, lower first, and in submission order for equal priorities', () => {
    const h = harness();
    const worker = only(h.endpoints);
    const tasks = [5, 1, 3, 1, 0].map((priority) => h.run({ priority }));
    worker.ready();
    const order: number[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const id = worker.runIds()[i] as number;
      order.push(tasks.findIndex((task) => task.id === id));
      worker.reply(id, i);
    }
    expect(order).toEqual([4, 1, 3, 2, 0]);
    expect(tasks.every((task) => task.outcomes.length === 1)).toBe(true);
  });

  it('re-prioritizes queued tasks only', () => {
    const h = harness();
    const worker = only(h.endpoints);
    worker.ready();
    const running = h.run({ priority: 0 });
    const a = h.run({ priority: 1 });
    const b = h.run({ priority: 2 });
    const c = h.run({ priority: 3 });
    expect(h.pool.setPriority(c.id, 0)).toBe(true);
    expect(h.pool.setPriority(a.id, 9)).toBe(true);
    expect(h.pool.setPriority(running.id, 9)).toBe(false);
    expect(h.pool.setPriority(12345, 0)).toBe(false);
    for (const id of [running.id, c.id, b.id]) worker.reply(id, 0);
    expect(worker.runIds()).toEqual([running.id, c.id, b.id, a.id]);
  });

  it('keeps the heap ordered through random removals and priority changes', () => {
    const h = harness();
    const worker = only(h.endpoints);
    worker.ready();
    const blocker = h.run({ priority: -1 });
    let seed = 7;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const queued = new Map<number, number>();
    for (let i = 0; i < 60; i++) {
      const priority = Math.floor(random() * 10);
      queued.set(h.run({ priority }).id, priority);
    }
    for (const id of [...queued.keys()]) {
      const roll = random();
      if (roll < 0.3) {
        expect(h.pool.cancel(id)).toBe(true);
        queued.delete(id);
      } else if (roll < 0.6) {
        const priority = Math.floor(random() * 10);
        h.pool.setPriority(id, priority);
        queued.set(id, priority);
      }
    }
    const expected = [...queued].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([id]) => id);
    worker.reply(blocker.id, 0);
    for (let i = 0; i < expected.length; i++) worker.reply(worker.runIds()[i + 1] as number, 0);
    expect(worker.runIds().slice(1)).toEqual(expected);
  });

  it('removes a cancelled queued task without posting it', () => {
    const h = harness();
    const worker = only(h.endpoints);
    const cancelled = h.run({});
    const kept = h.run({});
    expect(h.pool.cancel(cancelled.id)).toBe(true);
    expect(errorOf(cancelled.outcomes[0])).toEqual({ code: 'cancelled', taskCode: undefined, name: 'AbortError' });
    expect(h.pool.cancel(cancelled.id)).toBe(false);
    worker.ready();
    expect(worker.runIds()).toEqual([kept.id]);
    expect(cancelled.outcomes).toHaveLength(1);
  });

  it('cancels a dispatched task cooperatively and discards its late output', () => {
    const h = harness();
    const worker = only(h.endpoints);
    worker.ready();
    const first = h.run({});
    const second = h.run({});
    expect(h.pool.cancel(first.id)).toBe(true);
    expect(worker.cancelIds()).toEqual([first.id]);
    expect(errorOf(first.outcomes[0]).code).toBe('cancelled');
    expect(worker.runIds()).toEqual([first.id]);

    worker.reply(first.id, { image: 'bitmap' });
    expect(h.discarded).toEqual([{ image: 'bitmap' }]);
    expect(first.outcomes).toHaveLength(1);
    expect(worker.runIds()).toEqual([first.id, second.id]);
    expect(worker.terminated).toBe(false);
  });

  it('frees the worker when a cancelled task replies with its cancellation', () => {
    const h = harness();
    const worker = only(h.endpoints);
    worker.ready();
    const task = h.run({});
    h.pool.cancel(task.id);
    worker.replyError(task.id, 'cancelled', 'stopped between stages');
    expect(task.outcomes).toHaveLength(1);
    expect(h.discarded).toEqual([]);
    expect(h.stats()).toMatchObject({ busy: 0 });
  });

  it('reports a task failure with its own code', () => {
    const h = harness();
    const worker = only(h.endpoints);
    worker.ready();
    const task = h.run({});
    worker.replyError(task.id, 'undecodable', 'not an image');
    expect(errorOf(task.outcomes[0])).toEqual({
      code: 'task-failed',
      taskCode: 'undecodable',
      name: 'WorkerTaskError',
    });
  });

  it('ignores replies for tasks the worker is not running', () => {
    const h = harness();
    const worker = only(h.endpoints);
    worker.ready();
    const task = h.run({});
    worker.reply(task.id + 100, 'stray');
    expect(task.outcomes).toEqual([]);
    worker.reply(task.id, 'ok');
    worker.reply(task.id, 'twice');
    expect(task.outcomes).toEqual([{ ok: true, output: 'ok' }]);
  });

  it('fails a task whose message cannot be posted and keeps the worker', () => {
    const h = harness();
    const worker = only(h.endpoints);
    worker.ready();
    worker.failPosts = true;
    const task = h.run({});
    expect(errorOf(task.outcomes[0])).toMatchObject({ code: 'task-failed', taskCode: 'post' });
    worker.failPosts = false;
    const next = h.run({});
    expect(worker.runIds()).toEqual([next.id]);
  });

  it('replaces a crashed worker and fails its in-flight task instead of losing it', () => {
    const h = harness();
    const first = only(h.endpoints);
    first.ready();
    const inFlight = h.run({});
    const queued = h.run({});
    first.crash('out of memory');

    expect(errorOf(inFlight.outcomes[0])).toMatchObject({ code: 'crash' });
    expect(first.terminated).toBe(true);
    expect(h.events).toEqual([expect.objectContaining({ kind: 'worker-error', cause: 'crash', url: h.factory.url })]);
    const replacement = only(h.live());
    replacement.ready();
    expect(replacement.runIds()).toEqual([queued.id]);
    replacement.reply(queued.id, 4);
    expect(queued.outcomes).toEqual([{ ok: true, output: 4 }]);
    expect(first.posted.filter(({ message }) => message.kind === 'run')).toHaveLength(1);
  });

  it('treats a message outside the protocol as a crash', () => {
    const h = harness();
    const worker = only(h.endpoints);
    worker.ready();
    const task = h.run({});
    worker.send('<html>');
    expect(errorOf(task.outcomes[0]).code).toBe('crash');
    expect(h.live()).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it('terminates a worker past the task watchdog and fails the task with timeout', () => {
    const h = harness({ pool: { taskTimeoutMs: 1000 } });
    const worker = only(h.endpoints);
    worker.ready();
    const slow = h.run({});
    const quick = h.run({ timeoutMs: 50 });
    h.timers.advance(999);
    expect(slow.outcomes).toEqual([]);
    h.timers.advance(1);
    expect(errorOf(slow.outcomes[0]).code).toBe('timeout');
    expect(worker.terminated).toBe(true);
    worker.reply(slow.id, 'too late');
    expect(slow.outcomes).toHaveLength(1);

    const replacement = only(h.live());
    replacement.ready();
    expect(replacement.runIds()).toEqual([quick.id]);
    h.timers.advance(50);
    expect(errorOf(quick.outcomes[0]).code).toBe('timeout');
    expect(h.live()).toHaveLength(1);
  });

  it('refuses a worker with another protocol version or build id', () => {
    const h = harness();
    const task = h.run({});
    only(h.endpoints).ready(WORKER_PROTOCOL_VERSION + 1);
    expect(h.endpoints[0]?.terminated).toBe(true);
    h.endpoints[1]?.ready(WORKER_PROTOCOL_VERSION, 'stale-build');
    expect(h.events.map((event) => event.kind === 'worker-error' && event.cause)).toEqual([
      'version-mismatch',
      'version-mismatch',
    ]);
    expect(h.events[0]?.message).toContain(h.factory.url);
    h.endpoints[2]?.ready();
    expect(h.endpoints[2]?.runIds()).toEqual([task.id]);
  });

  it('checks only the protocol version when the factory declares no build id', () => {
    const h = harness({ noBuildId: true });
    only(h.endpoints).ready(WORKER_PROTOCOL_VERSION, 'anything');
    expect(h.events).toEqual([]);
    expect(h.stats()).toMatchObject({ workers: 1, starting: 0 });
  });

  it('fails a start without a handshake in time or with another first message', () => {
    const h = harness({ pool: { startTimeoutMs: 500 } });
    h.timers.advance(500);
    expect(h.events).toEqual([expect.objectContaining({ cause: 'start-timeout' })]);
    h.endpoints[1]?.reply(1, 'not a handshake');
    h.endpoints[2]?.crash('Failed to load module script');
    expect(h.events.map((event) => (event.kind === 'worker-error' ? event.cause : event.kind))).toEqual([
      'start-timeout',
      'start-failed',
      'start-failed',
      'worker-fallback',
    ]);
    expect(h.events[2]?.message).toContain('Failed to load module script');
  });

  it('switches to the inline executor after three consecutive start failures', async () => {
    const h = harness({ failCreates: 3 });
    const tasks = [h.run({ input: 2 }), h.run({ task: 'asyncDouble', input: 5 }), h.run({ task: 'broken' })];
    const unknown = h.run({ task: 'missing' });
    expect(h.endpoints).toEqual([]);
    expect(h.events.map((event) => event.kind)).toEqual([
      'worker-error',
      'worker-error',
      'worker-error',
      'worker-fallback',
    ]);
    expect(h.stats()).toMatchObject({ mode: 'inline-loading', workers: 0 });

    await settle(h.timers, 10);
    expect(h.stats()).toMatchObject({ mode: 'inline', workers: 0, queued: 0, busy: 0 });
    expect(tasks[0]?.outcomes).toEqual([{ ok: true, output: 4 }]);
    expect(tasks[1]?.outcomes).toEqual([{ ok: true, output: 10 }]);
    expect(errorOf(tasks[2]?.outcomes[0])).toMatchObject({ code: 'task-failed', taskCode: 'undecodable' });
    expect(errorOf(unknown.outcomes[0])).toMatchObject({ code: 'task-failed', taskCode: 'unknown-task' });

    const later = h.run({ input: 7 });
    await settle(h.timers);
    expect(later.outcomes).toEqual([{ ok: true, output: 14 }]);
  });

  it('runs one inline task at a time and honors cancellation', async () => {
    let release: (() => void) | undefined;
    const seen: boolean[] = [];
    const table: TaskTable = {
      gate: async (input, context) => {
        await new Promise<void>((resolve) => (release = resolve));
        seen.push(context.isCancelled());
        return { output: input, transfer: [] };
      },
    };
    const h = harness({ failCreates: 3, factory: { inline: () => Promise.resolve(table) } });
    const first = h.run({ task: 'gate', input: 'a' });
    const second = h.run({ task: 'gate', input: 'b' });
    const third = h.run({ task: 'gate', input: 'c' });
    await settle(h.timers);
    expect(h.stats()).toMatchObject({ busy: 1, queued: 2 });
    expect(h.pool.cancel(third.id)).toBe(true);
    expect(h.pool.cancel(first.id)).toBe(true);
    release?.();
    await settle(h.timers);
    expect(seen).toEqual([true]);
    expect(h.discarded).toEqual(['a']);
    release?.();
    await settle(h.timers);
    expect(second.outcomes).toEqual([{ ok: true, output: 'b' }]);
    expect(errorOf(third.outcomes[0]).code).toBe('cancelled');
    expect(seen).toEqual([true, false]);
  });

  it('fails every task as unavailable when the inline executor cannot load', async () => {
    const h = harness({ failCreates: 3, factory: { inline: () => Promise.reject(new Error('chunk 404')) } });
    const queued = h.run({});
    await settle(h.timers);
    expect(errorOf(queued.outcomes[0]).code).toBe('unavailable');
    expect(h.events.at(-1)).toMatchObject({ kind: 'worker-error', cause: 'inline-unavailable' });
    const later = h.run({});
    await settle(h.timers);
    expect(errorOf(later.outcomes[0]).code).toBe('unavailable');
  });

  it('stops growing instead of falling back while a worker still runs', () => {
    const h = harness({ pool: { maxWorkers: 3 } });
    only(h.endpoints).ready();
    h.run({});
    h.run({});
    h.pool.update();
    h.pool.update();
    for (let i = 0; i < 3; i++) h.live()[1]?.crash('refused');
    expect(h.events.map((event) => event.kind)).toEqual(['worker-error', 'worker-error', 'worker-error']);
    expect(h.stats()).toMatchObject({ mode: 'workers', workers: 1, busy: 1, queued: 1 });
    h.pool.update();
    h.pool.update();
    expect(h.stats()).toMatchObject({ workers: 1 });
  });

  it('grows by one worker per frame while queued work waited a whole frame, up to the cap', () => {
    const h = harness({ pool: { maxWorkers: 3 } });
    only(h.endpoints).ready();
    h.run({});
    h.pool.update();
    expect(h.endpoints).toHaveLength(1);
    const waiting = h.run({});
    h.pool.update();
    expect(h.endpoints).toHaveLength(1);
    h.pool.update();
    expect(h.endpoints).toHaveLength(2);
    h.pool.update();
    expect(h.endpoints).toHaveLength(2);
    h.endpoints[1]?.ready();
    expect(h.endpoints[1]?.runIds()).toEqual([waiting.id]);
    h.run({});
    h.run({});
    h.pool.update();
    h.pool.update();
    h.endpoints[2]?.ready();
    h.pool.update();
    h.pool.update();
    h.pool.update();
    expect(h.endpoints).toHaveLength(3);
    expect(h.stats()).toMatchObject({ workers: 3, busy: 3, queued: 1 });
  });

  it('takes the worker cap from the factory unless the options override it', () => {
    const h = harness({ factory: { maxWorkers: 2 } });
    only(h.endpoints).ready();
    for (let i = 0; i < 4; i++) h.run({});
    for (let i = 0; i < 6; i++) h.pool.update();
    expect(h.endpoints).toHaveLength(2);
  });

  it('shares one pool per URL and leaves zero workers after the last release', () => {
    const h = harness();
    const events: WorkerPoolEvent[] = [];
    const second = acquireWorkerPool(h.factory, { timers: h.timers, onEvent: (event) => events.push(event) });
    expect(second.pool).toBe(h.pool);
    expect(h.endpoints).toHaveLength(1);
    const worker = only(h.endpoints);
    worker.ready();
    const inFlight = h.run({});
    const queued = h.run({});

    h.lease.release();
    h.lease.release();
    expect(worker.terminated).toBe(false);
    worker.crash('first');
    expect(events).toHaveLength(1);
    expect(h.events).toEqual([]);
    const replacement = only(h.live());
    replacement.ready();

    second.release();
    expect(h.live()).toEqual([]);
    expect(h.timers.pending).toBe(0);
    expect(errorOf(inFlight.outcomes[0]).code).toBe('crash');
    expect(errorOf(queued.outcomes[0])).toEqual({ code: 'aborted', taskCode: undefined, name: 'AbortError' });
    expect(h.stats()).toEqual({ mode: 'released', workers: 0, starting: 0, busy: 0, queued: 0 });

    const third = acquireWorkerPool(h.factory, { timers: h.timers });
    leases.push(third);
    expect(third.pool).not.toBe(h.pool);
    expect(h.live()).toHaveLength(1);
  });

  it('aborts in-flight and queued tasks on release and ignores late messages', async () => {
    const h = harness();
    const worker = only(h.endpoints);
    worker.ready();
    const inFlight = h.run({});
    const queued = h.run({});
    h.lease.release();
    expect(errorOf(inFlight.outcomes[0]).code).toBe('aborted');
    expect(errorOf(queued.outcomes[0]).code).toBe('aborted');
    worker.reply(inFlight.id, 'late');
    worker.crash('late');
    expect(h.events).toEqual([]);
    expect(h.live()).toEqual([]);

    const after = h.run({});
    expect(after.outcomes).toEqual([]);
    await Promise.resolve();
    expect(errorOf(after.outcomes[0]).code).toBe('aborted');
  });

  it('stops the inline executor on release and discards its late output', async () => {
    let release: (() => void) | undefined;
    const table: TaskTable = {
      gate: async (input, context) => {
        await new Promise<void>((resolve) => (release = resolve));
        expect(context.isCancelled()).toBe(true);
        return { output: input, transfer: [] };
      },
    };
    const h = harness({ failCreates: 3, factory: { inline: () => Promise.resolve(table) } });
    const running = h.run({ task: 'gate', input: 'a' });
    h.run({ task: 'gate', input: 'b' });
    await settle(h.timers);
    h.lease.release();
    expect(errorOf(running.outcomes[0]).code).toBe('aborted');
    expect(h.timers.pending).toBe(0);
    release?.();
    await settle(h.timers);
    expect(h.discarded).toEqual(['a']);
  });

  it('ignores an inline table that arrives after release', async () => {
    const h = harness({ failCreates: 3 });
    const task = h.run({});
    h.lease.release();
    await settle(h.timers);
    expect(errorOf(task.outcomes[0]).code).toBe('aborted');
    expect(h.stats().mode).toBe('released');
  });
});
