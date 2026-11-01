// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The page-wide pool of stateless workers (ADR 0011 rules 1, 2 and 6), DOM-free against injected endpoints.
 *
 * - One pool per worker URL, shared by every engine instance through {@link acquireWorkerPool} and reference-counted:
 *   releasing the last lease terminates every worker, removes every listener and aborts every pending task.
 * - Tasks wait in a priority queue (lower priority first, equal priorities first in, first out); each worker runs one
 *   task at a time. Cancelling a queued task removes it; cancelling a dispatched one sends `cancel` to its worker.
 * - The pool starts one worker and grows by one per {@link WorkerPool.update} while the queue holds a task that has
 *   waited a whole frame, up to the worker cap. It never shrinks while in use.
 * - Workers must post a `ready` handshake with the protocol version (and build id) within the start timeout. A crashed
 *   worker is replaced and its task fails with `crash`; a task past its watchdog terminates its worker and fails with
 *   `timeout`. After `maxStartFailures` consecutive start failures with no working worker left, the pool switches to
 *   the inline executor: the same task functions, one at a time on the main thread.
 *
 * Every task's `done` callback runs exactly once: with the output, or with a {@link WorkerTaskError}.
 */
import { messageOf } from '../globe/errors.js';
import { InlineExecutor } from './inline-executor.js';
import {
  parseWorkerMessage,
  WORKER_PROTOCOL_VERSION,
  type WorkerEndpoint,
  type WorkerEndpointFactory,
} from './worker-protocol.js';
import {
  WorkerTaskError,
  type PoolTimers,
  type WorkerErrorCause,
  type WorkerPool,
  type WorkerPoolEvent,
  type WorkerPoolLease,
  type WorkerPoolMode,
  type WorkerPoolOptions,
  type WorkerPoolStats,
  type WorkerTaskDone,
  type WorkerTaskErrorCode,
  type WorkerTaskOutcome,
  type WorkerTaskRequest,
} from './worker-pool-types.js';
import { TaskQueue, type TaskRecord } from './worker-task-queue.js';

/** Default task watchdog and handshake limit (ADR 0011 rule 6). */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_START_FAILURES = 3;
const LIKELY_CAUSES =
  'check the worker URL (assets.workerUrl), the worker-src directive of the Content Security Policy, and that the ' +
  'server does not answer the worker URL with an HTML page';

interface PoolWorker {
  endpoint: WorkerEndpoint | undefined;
  state: 'starting' | 'idle' | 'busy' | 'dead';
  task: TaskRecord | undefined;
  /** Handshake timer while starting, watchdog while busy. */
  timer: unknown;
}

function failure(code: WorkerTaskErrorCode, message: string, taskCode?: string): WorkerTaskOutcome {
  return { ok: false, error: new WorkerTaskError(code, message, taskCode) };
}

class PoolImpl implements WorkerPool {
  readonly url: string;
  private readonly timers: PoolTimers;
  private readonly taskTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly maxStartFailures: number;
  private maxWorkers: number;
  private mode: WorkerPoolMode = 'workers';
  private readonly listeners = new Set<(event: WorkerPoolEvent) => void>();
  private readonly queue = new TaskQueue();
  private readonly pending = new Map<number, TaskRecord>();
  private readonly workers: PoolWorker[] = [];
  private startFailures = 0;
  private frame = 0;
  private nextId = 1;
  private inline: InlineExecutor | undefined;

  constructor(
    private readonly factory: WorkerEndpointFactory,
    options: WorkerPoolOptions,
  ) {
    this.url = factory.url;
    this.timers = options.timers;
    this.maxWorkers = Math.max(1, Math.floor(options.maxWorkers ?? factory.maxWorkers ?? 1));
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxStartFailures = options.maxStartFailures ?? DEFAULT_MAX_START_FAILURES;
  }

  run(request: WorkerTaskRequest, done: WorkerTaskDone): number {
    const id = this.nextId++;
    if (this.mode === 'released' || this.mode === 'unavailable') {
      const outcome =
        this.mode === 'released' ? failure('aborted', 'the worker pool was released') : this.unavailable();
      void Promise.resolve().then(() => done(outcome));
      return id;
    }
    const record: TaskRecord = {
      id,
      task: request.task,
      input: request.input,
      transfer: request.transfer ?? [],
      timeoutMs: request.timeoutMs ?? this.taskTimeoutMs,
      seq: id,
      enqueuedFrame: this.frame,
      priority: request.priority ?? 0,
      heapIndex: -1,
      done,
      cancelled: false,
    };
    this.pending.set(id, record);
    this.queue.push(record);
    this.pump();
    return id;
  }

  setPriority(id: number, priority: number): boolean {
    const record = this.pending.get(id);
    if (!record || record.heapIndex < 0) return false;
    record.priority = priority;
    this.queue.reorder(record);
    return true;
  }

  cancel(id: number): boolean {
    const record = this.pending.get(id);
    if (!record) return false;
    if (record.heapIndex >= 0) this.queue.remove(record);
    else this.cancelDispatched(record);
    this.settle(record, failure('cancelled', `task "${record.task}" was cancelled`));
    return true;
  }

  update(): void {
    const previous = this.frame;
    this.frame += 1;
    if (this.mode !== 'workers' || this.workers.length >= this.maxWorkers) return;
    for (const worker of this.workers) if (worker.state === 'idle' || worker.state === 'starting') return;
    for (const record of this.queue.items) {
      if (record.enqueuedFrame < previous) {
        this.spawn();
        return;
      }
    }
  }

  readStats(out: WorkerPoolStats): WorkerPoolStats {
    out.mode = this.mode;
    out.workers = this.workers.length;
    out.starting = 0;
    out.busy = this.inline?.busy ? 1 : 0;
    for (const worker of this.workers) {
      if (worker.state === 'starting') out.starting += 1;
      if (worker.state === 'busy') out.busy += 1;
    }
    out.queued = this.queue.items.length;
    return out;
  }

  addListener(listener: (event: WorkerPoolEvent) => void): void {
    this.listeners.add(listener);
  }

  removeListener(listener: (event: WorkerPoolEvent) => void): void {
    this.listeners.delete(listener);
  }

  /** Starts the first worker (ADR 0011: at runtime, by the first engine instance). */
  start(): void {
    this.spawn();
  }

  /** Terminates every worker and aborts every pending task; the pool cannot be used afterwards. */
  destroy(): void {
    this.mode = 'released';
    this.inline?.stop();
    for (const worker of this.workers.slice()) this.kill(worker);
    this.queue.drain();
    this.listeners.clear();
    const aborted = [...this.pending.values()];
    for (const record of aborted) this.settle(record, failure('aborted', 'the worker pool was released'));
  }

  private emit(event: WorkerPoolEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private settle(record: TaskRecord, outcome: WorkerTaskOutcome): void {
    const done = record.done;
    if (!done) return;
    record.done = undefined;
    record.cancelled ||= !outcome.ok && outcome.error.code === 'cancelled';
    this.pending.delete(record.id);
    done(outcome);
  }

  private unavailable(): WorkerTaskOutcome {
    return failure('unavailable', `no worker could start from ${this.url} and the inline executor failed to load`);
  }

  private pump(): void {
    if (this.mode === 'inline' && this.queue.items.length > 0) this.inline?.schedule();
    while (this.mode === 'workers' && this.queue.items.length > 0) {
      const worker = this.idleWorker();
      const record = worker && this.queue.pop();
      if (!worker || !record) return;
      this.dispatch(worker, record);
    }
  }

  private idleWorker(): PoolWorker | undefined {
    for (const worker of this.workers) if (worker.state === 'idle') return worker;
    return undefined;
  }

  private dispatch(worker: PoolWorker, record: TaskRecord): void {
    worker.state = 'busy';
    worker.task = record;
    try {
      worker.endpoint?.post({ kind: 'run', id: record.id, task: record.task, input: record.input }, record.transfer);
    } catch (error) {
      worker.state = 'idle';
      worker.task = undefined;
      this.settle(record, failure('task-failed', `could not post task "${record.task}": ${messageOf(error)}`, 'post'));
      return;
    }
    worker.timer = this.timers.set(() => this.onTaskTimeout(worker, record), record.timeoutMs);
  }

  private cancelDispatched(record: TaskRecord): void {
    for (const worker of this.workers) {
      if (worker.task !== record) continue;
      try {
        worker.endpoint?.post({ kind: 'cancel', id: record.id }, []);
      } catch {
        // The worker learns about the cancel from nothing else; its reply is discarded either way.
      }
    }
  }

  private spawn(): void {
    const worker: PoolWorker = { endpoint: undefined, state: 'starting', task: undefined, timer: undefined };
    this.workers.push(worker);
    let endpoint: WorkerEndpoint;
    try {
      endpoint = this.factory.create(
        (data) => this.onMessage(worker, data),
        (reason) => this.onError(worker, reason),
      );
    } catch (error) {
      this.startFailed(worker, 'start-failed', messageOf(error));
      return;
    }
    if (worker.state === 'dead') {
      endpoint.terminate();
      return;
    }
    worker.endpoint = endpoint;
    worker.timer = this.timers.set(
      () => this.startFailed(worker, 'start-timeout', `no ready message within ${this.startTimeoutMs} ms`),
      this.startTimeoutMs,
    );
  }

  private onMessage(worker: PoolWorker, data: unknown): void {
    if (worker.state === 'dead') return;
    const message = parseWorkerMessage(data);
    if (worker.state === 'starting') {
      this.onHandshake(worker, message);
      return;
    }
    if (message?.kind !== 'reply') {
      this.crashed(worker, 'the worker posted a message outside the protocol');
      return;
    }
    const record = worker.task;
    if (!record || record.id !== message.id) return;
    this.timers.clear(worker.timer);
    worker.task = undefined;
    worker.state = 'idle';
    if (message.ok) this.deliver(record, { ok: true, output: message.output });
    else {
      const { code, message: text } = message.error;
      this.deliver(record, failure('task-failed', `task "${record.task}" failed: ${text}`, code));
    }
    this.pump();
  }

  private onHandshake(worker: PoolWorker, message: ReturnType<typeof parseWorkerMessage>): void {
    if (message?.kind !== 'ready') {
      this.startFailed(worker, 'start-failed', 'its first message was not the ready handshake');
      return;
    }
    const expectedBuild = this.factory.buildId;
    if (
      message.version !== WORKER_PROTOCOL_VERSION ||
      (expectedBuild !== undefined && message.buildId !== expectedBuild)
    )
      this.startFailed(
        worker,
        'version-mismatch',
        `it speaks protocol ${message.version} of build "${message.buildId}", the page expects protocol ` +
          `${WORKER_PROTOCOL_VERSION}${expectedBuild === undefined ? '' : ` of build "${expectedBuild}"`} ` +
          '(a stale cached or mismatched worker file)',
      );
    else {
      this.timers.clear(worker.timer);
      worker.state = 'idle';
      this.startFailures = 0;
      this.pump();
    }
  }

  private onError(worker: PoolWorker, reason: string): void {
    if (worker.state === 'starting') this.startFailed(worker, 'start-failed', reason);
    else if (worker.state !== 'dead') this.crashed(worker, reason);
  }

  private kill(worker: PoolWorker): void {
    worker.state = 'dead';
    worker.task = undefined;
    this.timers.clear(worker.timer);
    const at = this.workers.indexOf(worker);
    if (at >= 0) this.workers.splice(at, 1);
    const endpoint = worker.endpoint;
    worker.endpoint = undefined;
    try {
      endpoint?.terminate();
    } catch {
      // Termination is best effort: the endpoint is dropped either way.
    }
  }

  private startFailed(worker: PoolWorker, cause: WorkerErrorCause, reason: string): void {
    this.kill(worker);
    this.startFailures += 1;
    this.emit({
      kind: 'worker-error',
      url: this.url,
      cause,
      message: `worker ${this.url} did not start: ${reason}; ${LIKELY_CAUSES}`,
    });
    if (this.mode !== 'workers') return;
    if (this.startFailures < this.maxStartFailures) this.spawn();
    else if (this.workers.some((other) => other.state === 'idle' || other.state === 'busy'))
      this.maxWorkers = Math.max(1, this.workers.length);
    else this.fallBackInline();
  }

  private crashed(worker: PoolWorker, reason: string): void {
    const record = worker.task;
    this.kill(worker);
    this.emit({
      kind: 'worker-error',
      url: this.url,
      cause: 'crash',
      message: `worker ${this.url} crashed: ${reason}`,
    });
    if (this.mode === 'workers') this.spawn();
    if (record) this.settle(record, failure('crash', `the worker running task "${record.task}" crashed: ${reason}`));
    this.pump();
  }

  private onTaskTimeout(worker: PoolWorker, record: TaskRecord): void {
    if (worker.task !== record) return;
    this.kill(worker);
    if (this.mode === 'workers') this.spawn();
    this.settle(record, failure('timeout', `task "${record.task}" ran longer than ${record.timeoutMs} ms`));
  }

  private fallBackInline(): void {
    this.mode = 'inline-loading';
    for (const worker of this.workers.slice()) this.kill(worker);
    this.emit({
      kind: 'worker-fallback',
      url: this.url,
      message: `${this.startFailures} workers in a row failed to start from ${this.url}; tasks now run on the main thread`,
    });
    Promise.resolve()
      .then(() => this.factory.inline())
      .then(
        (table) => {
          if (this.mode !== 'inline-loading') return;
          const next = (): TaskRecord | undefined => this.queue.pop();
          this.inline = new InlineExecutor(table, this.timers, next, (record, outcome) => {
            this.deliver(record, outcome);
            this.pump();
          });
          this.mode = 'inline';
          this.pump();
        },
        (error: unknown) => {
          if (this.mode !== 'inline-loading') return;
          this.mode = 'unavailable';
          this.emit({
            kind: 'worker-error',
            url: this.url,
            cause: 'inline-unavailable',
            message: `the inline executor failed to load after the workers did: ${messageOf(error)}`,
          });
          for (const record of this.queue.drain()) this.settle(record, this.unavailable());
        },
      );
  }

  /** Delivers a late outcome to its task, or frees the output when the task was cancelled or aborted meanwhile. */
  private deliver(record: TaskRecord, outcome: WorkerTaskOutcome): void {
    if (record.done) this.settle(record, outcome);
    else if (outcome.ok) this.factory.discard?.(outcome.output);
  }
}

const pools = new Map<string, { readonly pool: PoolImpl; refs: number }>();

/**
 * Takes a share of the pool for `factory.url`, creating it (and its first worker) when none exists. Every engine
 * instance acquires once at creation and releases once in `destroy()`; the last release leaves zero workers.
 */
export function acquireWorkerPool(factory: WorkerEndpointFactory, options: WorkerPoolOptions): WorkerPoolLease {
  let entry = pools.get(factory.url);
  const created = !entry;
  if (!entry) {
    entry = { pool: new PoolImpl(factory, options), refs: 0 };
    pools.set(factory.url, entry);
  }
  entry.refs += 1;
  const { onEvent } = options;
  // A wrapper per lease, so two leases passing the same function each keep their own subscription.
  const listener = onEvent && ((event: WorkerPoolEvent): void => onEvent(event));
  if (listener) entry.pool.addListener(listener);
  if (created) entry.pool.start();
  const held = entry;
  let released = false;
  return {
    pool: held.pool,
    release(): void {
      if (released) return;
      released = true;
      if (listener) held.pool.removeListener(listener);
      held.refs -= 1;
      if (held.refs > 0) return;
      pools.delete(factory.url);
      held.pool.destroy();
    },
  };
}
