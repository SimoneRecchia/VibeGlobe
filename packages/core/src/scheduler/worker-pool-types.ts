// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Public types of the worker pool (ADR 0011): task requests and outcomes, options, events and the pool interface.
 * The implementation is in `worker-pool.ts`.
 */

/**
 * Why a task failed: `cancelled` by its owner, `aborted` because the pool was released, `timeout` past its watchdog,
 * `crash` of its worker, `unavailable` when neither workers nor the inline executor can run tasks, `task-failed` when
 * the task itself failed (its own code is in {@link WorkerTaskError.taskCode}).
 */
export type WorkerTaskErrorCode = 'cancelled' | 'aborted' | 'timeout' | 'crash' | 'unavailable' | 'task-failed';

/** A task failure. `cancelled` and `aborted` failures are named `AbortError`, like aborted fetches. */
export class WorkerTaskError extends Error {
  readonly code: WorkerTaskErrorCode;
  /** The task's own error code (for example `undecodable` or `unknown-task`) when `code` is `task-failed`. */
  readonly taskCode: string | undefined;

  constructor(code: WorkerTaskErrorCode, message: string, taskCode?: string) {
    super(message);
    this.name = code === 'cancelled' || code === 'aborted' ? 'AbortError' : 'WorkerTaskError';
    this.code = code;
    this.taskCode = taskCode;
  }
}

/** How a task ended. */
export type WorkerTaskOutcome =
  { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: WorkerTaskError };

/** Receives a task's outcome, exactly once. */
export type WorkerTaskDone = (outcome: WorkerTaskOutcome) => void;

/** One task to run. */
export interface WorkerTaskRequest {
  /** Name of the task function. */
  readonly task: string;
  readonly input: unknown;
  /** Objects in `input` to transfer to the worker (encoded tile bytes); never cloned. */
  readonly transfer?: readonly object[];
  /** Queue priority, lower first (the scheduler's priority key). Default 0. */
  readonly priority?: number;
  /** Watchdog of this task once dispatched, overriding the pool's `taskTimeoutMs`. */
  readonly timeoutMs?: number;
}

/** Timers injected into the DOM-free pool (the render host's in browsers). */
export interface PoolTimers {
  /** Calls `callback` once after `delayMs` and returns a handle for {@link PoolTimers.clear}. */
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

/** Why a worker was reported broken. */
export type WorkerErrorCause = 'start-failed' | 'start-timeout' | 'version-mismatch' | 'crash' | 'inline-unavailable';

/** What the pool reports to the engine instances holding it (they turn it into `worker-error` and `worker-fallback`). */
export type WorkerPoolEvent =
  | { readonly kind: 'worker-error'; readonly url: string; readonly cause: WorkerErrorCause; readonly message: string }
  | { readonly kind: 'worker-fallback'; readonly url: string; readonly message: string };

/** Options of a pool; the first lease of a URL creates the pool, so its options apply. */
export interface WorkerPoolOptions {
  readonly timers: PoolTimers;
  /** Worker cap (the global `workers.maxCount`); defaults to the factory's `maxWorkers`, else 1. */
  readonly maxWorkers?: number;
  /** Watchdog of a dispatched task, default 10,000 ms. */
  readonly taskTimeoutMs?: number;
  /** Time a new worker has to post its handshake, default 10,000 ms. */
  readonly startTimeoutMs?: number;
  /** Consecutive start failures before the inline executor takes over, default 3. */
  readonly maxStartFailures?: number;
  /** Receives the pool's events while this lease is held. */
  readonly onEvent?: (event: WorkerPoolEvent) => void;
}

/** `workers` while workers run tasks; the inline executor's states after the fallback; `released` at the end. */
export type WorkerPoolMode = 'workers' | 'inline-loading' | 'inline' | 'unavailable' | 'released';

/** Counters of the pool, for tests and the debug overlay. */
export interface WorkerPoolStats {
  mode: WorkerPoolMode;
  /** Live workers, starting ones included. */
  workers: number;
  starting: number;
  busy: number;
  queued: number;
}

/** The shared pool, as a lease holder uses it. */
export interface WorkerPool {
  readonly url: string;
  /** Queues a task and returns its id, the handle for {@link WorkerPool.cancel} and {@link WorkerPool.setPriority}. */
  run(request: WorkerTaskRequest, done: WorkerTaskDone): number;
  /** Changes the priority of a queued task; false when it is no longer queued. */
  setPriority(id: number, priority: number): boolean;
  /** Cancels a pending task: its `done` receives `cancelled` now. False when it already ended. */
  cancel(id: number): boolean;
  /** Called once per frame: grows the pool when queued work waited a whole frame. */
  update(): void;
  /** Writes the current counters into `out` and returns it. */
  readStats(out: WorkerPoolStats): WorkerPoolStats;
}

/** One holder's share of a pool. */
export interface WorkerPoolLease {
  readonly pool: WorkerPool;
  /** Drops this share; the last release terminates the pool. Calling it again does nothing. */
  release(): void;
}
