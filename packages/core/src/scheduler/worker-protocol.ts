/**
 * Messages between the worker pool and the worker program, and the task contract shared by the worker program and the
 * inline executor (ADR 0011 rules 2, 3, 5 and 6). `@vibeglobe/worker` mirrors these shapes in its `protocol.ts`: both
 * sides change together, and any incompatible change bumps {@link WORKER_PROTOCOL_VERSION}.
 *
 * Main thread to worker: `run` (`{ id, task, input }`) and `cancel` (`{ id }`). Worker to main thread: one `ready`
 * handshake with the protocol version and build id, then one `reply` (`{ id, ok, output | error }`) per `run`.
 */

/** Version of the message protocol; the pool refuses a worker whose `ready` message names another one. */
export const WORKER_PROTOCOL_VERSION = 1;

/** The handshake a worker posts once its program has loaded. */
export interface WorkerReadyMessage {
  readonly kind: 'ready';
  /** {@link WORKER_PROTOCOL_VERSION} of the worker program. */
  readonly version: number;
  /** Build id of the worker program, compared with the factory's when it declares one. */
  readonly buildId: string;
}

/** Runs one task in the worker. */
export interface WorkerRunMessage {
  readonly kind: 'run';
  /** Task id, unique within the pool. */
  readonly id: number;
  /** Name of the task function in the worker's task table. */
  readonly task: string;
  /** Task input; buffers in it are transferred, never cloned. */
  readonly input: unknown;
}

/** Asks the worker to stop a dispatched task at its next stage boundary; it still replies. */
export interface WorkerCancelMessage {
  readonly kind: 'cancel';
  readonly id: number;
}

/** A message from the main thread to a worker. */
export type WorkerRequest = WorkerRunMessage | WorkerCancelMessage;

/** A task failure as it crosses the thread boundary: a stable code and a human-readable message. */
export interface SerializedTaskError {
  /** Stable code, for example `undecodable`, `unknown-task` or `cancelled`. */
  readonly code: string;
  readonly message: string;
}

/** The answer to one {@link WorkerRunMessage}. */
export type WorkerReply =
  | { readonly kind: 'reply'; readonly id: number; readonly ok: true; readonly output: unknown }
  | { readonly kind: 'reply'; readonly id: number; readonly ok: false; readonly error: SerializedTaskError };

/** A message from a worker to the main thread. */
export type WorkerMessage = WorkerReadyMessage | WorkerReply;

/** What a task checks between its stages (decode, mesh, pack) to stop early after a cancel. */
export interface TaskContext {
  /** True once the task was cancelled; the task then throws or returns as soon as it can. */
  isCancelled(): boolean;
}

/** A task result: the output and the objects in it to transfer (buffers, `ImageBitmap`s). */
export interface TaskOutput {
  readonly output: unknown;
  readonly transfer: readonly object[];
}

/** A pure task function (ADR 0011 rule 3). It throws an error with a string `code` property to fail with that code. */
export type TaskFunction = (input: unknown, context: TaskContext) => TaskOutput | Promise<TaskOutput>;

/** Task functions by name: what the worker program registers, and what the inline executor runs. */
export type TaskTable = Readonly<Record<string, TaskFunction>>;

/** One worker as the pool sees it; `@vibeglobe/worker` implements it over a module `Worker`. */
export interface WorkerEndpoint {
  /** Posts a message, transferring the listed objects. May throw when a message cannot be cloned. */
  post(message: WorkerRequest, transfer: readonly object[]): void;
  /** Terminates the worker and removes every listener it registered; no callback fires afterwards. */
  terminate(): void;
}

/** Creates the pool's workers (ADR 0011 rule 5); `createWorkers()` of `@vibeglobe/worker` returns one. */
export interface WorkerEndpointFactory {
  /** The resolved worker URL: one pool exists per URL, and errors name it. */
  readonly url: string;
  /** Build id the workers must announce; when absent, only the protocol version is checked. */
  readonly buildId?: string;
  /** Upper bound of the worker count, unless the pool options override it. */
  readonly maxWorkers?: number;
  /**
   * Starts one worker. `onMessage` receives every message the worker posts; `onError` reports a load failure, an
   * uncaught error or a message that could not be deserialized. May throw when the worker cannot be created at all.
   */
  create(onMessage: (data: unknown) => void, onError: (reason: string) => void): WorkerEndpoint;
  /** Loads the task functions for the main-thread executor, after repeated start failures and in Node tests. */
  inline(): Promise<TaskTable>;
  /** Frees an output nobody will use (a cancelled task's late result), for example by closing its `ImageBitmap`. */
  discard?(output: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseError(value: unknown): SerializedTaskError | undefined {
  if (!isRecord(value) || typeof value['code'] !== 'string' || typeof value['message'] !== 'string') return undefined;
  return { code: value['code'], message: value['message'] };
}

/** Validates a message received from a worker; anything that does not follow the protocol gives `undefined`. */
export function parseWorkerMessage(data: unknown): WorkerMessage | undefined {
  if (!isRecord(data)) return undefined;
  if (data['kind'] === 'ready') {
    const { version, buildId } = data;
    return typeof version === 'number' && typeof buildId === 'string' ? { kind: 'ready', version, buildId } : undefined;
  }
  const id = data['id'];
  if (data['kind'] !== 'reply' || typeof id !== 'number') return undefined;
  if (data['ok'] === true)
    return 'output' in data ? { kind: 'reply', id, ok: true, output: data['output'] } : undefined;
  const error = data['ok'] === false ? parseError(data['error']) : undefined;
  return error ? { kind: 'reply', id, ok: false, error } : undefined;
}

/** Turns anything a task threw into a {@link SerializedTaskError}; errors without a string `code` get `task-error`. */
export function serializeTaskError(error: unknown): SerializedTaskError {
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'task-error';
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}
