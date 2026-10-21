/**
 * The worker-side half of the protocol (ADR 0011 rules 2 and 6): announces the handshake, runs each `run` message's
 * task from the task table, answers every one with exactly one reply, and lets a `cancel` message flag the running
 * task so it stops at its next stage boundary. Kept apart from the worker entry so it can run without a worker scope.
 */
import {
  parseWorkerRequest,
  serializeTaskError,
  TaskError,
  WORKER_BUILD_ID,
  WORKER_PROTOCOL_VERSION,
  type TaskTable,
  type WorkerMessage,
  type WorkerRunMessage,
} from './protocol.js';

/** Posts a message to the main thread, transferring the listed objects. */
type PostToMain = (message: WorkerMessage, transfer: Transferable[]) => void;

/** The worker's message handling. */
interface TaskHost {
  /** Posts the `ready` handshake. */
  announce(): void;
  /** Handles one message from the main thread; messages outside the protocol are ignored. */
  receive(data: unknown): void;
}

/** Creates the message handling of a worker that runs the tasks of `table` and replies through `post`. */
export function createTaskHost(table: TaskTable, post: PostToMain): TaskHost {
  const running = new Set<number>();
  const cancelled = new Set<number>();

  async function run({ id, task, input }: WorkerRunMessage): Promise<void> {
    running.add(id);
    try {
      const fn = Object.hasOwn(table, task) ? table[task] : undefined;
      if (!fn) throw new TaskError('unknown-task', `the worker has no task "${task}"`);
      const result = await fn(input, { isCancelled: () => cancelled.has(id) });
      post({ kind: 'reply', id, ok: true, output: result.output }, [...result.transfer]);
    } catch (error) {
      post({ kind: 'reply', id, ok: false, error: serializeTaskError(error) }, []);
    } finally {
      running.delete(id);
      cancelled.delete(id);
    }
  }

  return {
    announce(): void {
      post({ kind: 'ready', version: WORKER_PROTOCOL_VERSION, buildId: WORKER_BUILD_ID }, []);
    },
    receive(data: unknown): void {
      const request = parseWorkerRequest(data);
      if (request?.kind === 'cancel') {
        if (running.has(request.id)) cancelled.add(request.id);
      } else if (request) {
        void run(request);
      }
    },
  };
}
