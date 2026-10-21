/**
 * The message protocol between the worker pool (`@vibeglobe/core`, `scheduler/worker-protocol.ts`) and this worker
 * program, and the task contract (ADR 0011 rules 3, 5 and 6). Core owns the shapes; an incompatible change bumps
 * `WORKER_PROTOCOL_VERSION` on both sides at once.
 */
import type { WorkerRequest } from '@vibeglobe/core';

export { serializeTaskError, WORKER_PROTOCOL_VERSION } from '@vibeglobe/core';
export type {
  SerializedTaskError,
  TaskContext,
  TaskFunction,
  TaskOutput,
  TaskTable,
  WorkerCancelMessage,
  WorkerEndpoint,
  WorkerEndpointFactory,
  WorkerMessage,
  WorkerReadyMessage,
  WorkerReply,
  WorkerRequest,
  WorkerRunMessage,
} from '@vibeglobe/core';

/**
 * Build id announced in the handshake and expected by the factory of `createWorkers()`, so a stale cached worker file
 * of another release is refused instead of answering in a different dialect.
 */
export const WORKER_BUILD_ID = '@vibeglobe/worker@0.0.0';

/** Stable codes of task failures raised by this package's tasks. */
export type TaskErrorCode = 'invalid-input' | 'undecodable' | 'unsupported' | 'cancelled' | 'unknown-task';

/** A typed task failure; its `code` crosses the thread boundary and becomes the pool error's `taskCode`. */
export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validates a message received from the main thread; anything else gives `undefined` and is ignored. */
export function parseWorkerRequest(data: unknown): WorkerRequest | undefined {
  if (!isRecord(data) || typeof data['id'] !== 'number') return undefined;
  const id = data['id'];
  if (data['kind'] === 'cancel') return { kind: 'cancel', id };
  const task = data['task'];
  if (data['kind'] !== 'run' || typeof task !== 'string') return undefined;
  return { kind: 'run', id, task, input: data['input'] };
}
