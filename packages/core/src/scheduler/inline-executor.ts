/**
 * The main-thread executor the worker pool switches to after repeated worker start failures (ADR 0011 rule 6): the
 * same task functions, one task at a time, each started in its own macrotask so the page renders between tasks.
 */
import { WorkerTaskError, type PoolTimers, type WorkerTaskOutcome } from './worker-pool-types.js';
import { serializeTaskError, type TaskContext, type TaskOutput, type TaskTable } from './worker-protocol.js';
import type { TaskRecord } from './worker-task-queue.js';

/** Runs queued tasks on the main thread, one at a time. */
export class InlineExecutor {
  private running: TaskRecord | undefined;
  private timer: unknown;
  private stopped = false;

  /**
   * @param table - The task functions.
   * @param timers - Starts each task in a fresh macrotask.
   * @param next - Takes the next task off the queue, or gives `undefined` when none waits.
   * @param finished - Receives each started task's outcome, also after {@link InlineExecutor.stop}.
   */
  constructor(
    private readonly table: TaskTable,
    private readonly timers: PoolTimers,
    private readonly next: () => TaskRecord | undefined,
    private readonly finished: (record: TaskRecord, outcome: WorkerTaskOutcome) => void,
  ) {}

  /** True while a task runs. */
  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Starts the next task in a new macrotask, unless one runs or is about to start. */
  schedule(): void {
    if (this.stopped || this.running || this.timer !== undefined) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.runNext();
    }, 0);
  }

  /** Starts no further task; a running task sees itself cancelled. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private runNext(): void {
    const record = this.stopped ? undefined : this.next();
    if (!record) return;
    this.running = record;
    const run = Object.hasOwn(this.table, record.task) ? this.table[record.task] : undefined;
    const context: TaskContext = { isCancelled: () => record.cancelled || this.stopped };
    let result: Promise<TaskOutput>;
    try {
      if (!run) throw Object.assign(new Error(`unknown task "${record.task}"`), { code: 'unknown-task' });
      result = Promise.resolve(run(record.input, context));
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      (output) => this.finish(record, { ok: true, output: output.output }),
      (error: unknown) => {
        const { code, message } = serializeTaskError(error);
        const failure = new WorkerTaskError('task-failed', `task "${record.task}" failed: ${message}`, code);
        this.finish(record, { ok: false, error: failure });
      },
    );
  }

  private finish(record: TaskRecord, outcome: WorkerTaskOutcome): void {
    this.running = undefined;
    this.finished(record, outcome);
  }
}
