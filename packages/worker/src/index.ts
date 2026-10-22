/**
 * @packageDocumentation
 * The worker program of VibeGlobe and the factory that starts it (ADR 0011): `createWorkers()` returns the endpoint
 * factory the engine's worker pool uses to run decoding tasks in module workers loaded from a same-origin URL, with no
 * `blob:` workers and no generated code, so the engine runs under a strict Content Security Policy.
 * @module @vibeglobe/worker
 */
import {
  WORKER_BUILD_ID,
  type TaskTable,
  type WorkerEndpoint,
  type WorkerEndpointFactory,
  type WorkerRequest,
} from './protocol.js';

export { rgba8MipChainBytes } from './decode-image.js';
export type { DecodedImage, DecodeImageInput } from './decode-image.js';
export { createTranscodeKtx2 } from './transcode-ktx2.js';
export type { TranscodeKtx2Input, TranscoderLoader } from './transcode-ktx2.js';
export { TaskError, WORKER_BUILD_ID, WORKER_PROTOCOL_VERSION } from './protocol.js';
export type {
  SerializedTaskError,
  TaskContext,
  TaskErrorCode,
  TaskFunction,
  TaskOutput,
  TaskTable,
  WorkerEndpoint,
  WorkerEndpointFactory,
  WorkerCancelMessage,
  WorkerMessage,
  WorkerReadyMessage,
  WorkerReply,
  WorkerRequest,
  WorkerRunMessage,
} from './protocol.js';

/** Options of {@link createWorkers}. */
export interface CreateWorkersOptions {
  /**
   * URL of the worker program (`assets.workerUrl`), resolved against the page. It must be same-origin and neither
   * `blob:` nor `data:`. By default the bundler resolves `vibeglobe-worker.js` next to this module.
   */
  readonly url?: string;
  /** Most workers the pool may start; default `clamp(hardwareConcurrency − 2, 1, 4)`. */
  readonly count?: number;
}

/** Why {@link createWorkers} refused its options. */
export type WorkerConfigErrorCode = 'cross-origin-url' | 'unsupported-url' | 'invalid-count' | 'no-page';

/** A configuration error raised by {@link createWorkers} before any worker starts. */
export class WorkerConfigError extends Error {
  readonly code: WorkerConfigErrorCode;

  constructor(code: WorkerConfigErrorCode, message: string) {
    super(message);
    this.name = 'WorkerConfigError';
    this.code = code;
  }
}

/** Pool key and error label of the bundled worker, whose final URL only the bundler knows. */
const BUNDLED_WORKER_LABEL = 'vibeglobe-worker.js (bundled with @vibeglobe/worker)';
const MAX_DEFAULT_WORKERS = 4;
const RESERVED_CORES = 2;

function pageLocation(): Location {
  if (typeof location === 'undefined')
    throw new WorkerConfigError('no-page', 'createWorkers({ url }) resolves the URL against a page; call it in one');
  return location;
}

function sameOriginUrl(raw: string): string {
  const page = pageLocation();
  const url = new URL(raw, page.href);
  if (url.protocol === 'blob:' || url.protocol === 'data:')
    throw new WorkerConfigError('unsupported-url', `the worker URL ${url.protocol} is not allowed; serve the file`);
  if (url.origin !== page.origin)
    throw new WorkerConfigError(
      'cross-origin-url',
      `the worker URL ${url.href} is not on the page's origin ${page.origin}; serve the worker from the page's origin`,
    );
  return url.href;
}

function workerCount(count: number | undefined): number {
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 1)
      throw new WorkerConfigError('invalid-count', `the worker count must be a positive integer, got ${count}`);
    return count;
  }
  const cores = typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency || 0;
  return Math.min(MAX_DEFAULT_WORKERS, Math.max(1, cores - RESERVED_CORES));
}

function startBundledWorker(): Worker {
  // The literal form, so Vite, webpack 5 and Parcel find and emit the worker entry (ADR 0011 rule 5).
  return new Worker(new URL('./vibeglobe-worker.js', import.meta.url), { type: 'module', name: 'vibeglobe' });
}

function describeError(event: Event, url: string): string {
  if (event instanceof ErrorEvent && event.message !== '') return event.message;
  return (
    `the worker program at ${url} failed to load: a wrong URL, a Content Security Policy that refuses it, ` +
    'or an HTML page served in its place'
  );
}

function connect(
  worker: Worker,
  url: string,
  onMessage: (data: unknown) => void,
  onError: (reason: string) => void,
): WorkerEndpoint {
  worker.onmessage = (event: MessageEvent<unknown>) => onMessage(event.data);
  worker.onerror = (event) => onError(describeError(event, url));
  worker.onmessageerror = () => onError('a message from the worker could not be deserialized');
  return {
    post(message: WorkerRequest, transfer: readonly object[]): void {
      worker.postMessage(message, transfer as Transferable[]);
    },
    terminate(): void {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    },
  };
}

/** Closes the `ImageBitmap` of an output nobody will use, so its memory is freed at once. */
function discardOutput(output: unknown): void {
  if (typeof output !== 'object' || output === null || typeof ImageBitmap === 'undefined') return;
  const image = (output as { image?: unknown }).image;
  if (image instanceof ImageBitmap) image.close();
}

/**
 * Creates the endpoint factory of the worker pool: module workers running `vibeglobe-worker.js`, or the program at
 * `options.url`. Nothing starts until the pool asks for a worker, so calling this has no cost; it only validates the
 * options and throws a {@link WorkerConfigError} for a cross-origin, `blob:` or `data:` URL or an invalid count.
 */
export function createWorkers(options: CreateWorkersOptions = {}): WorkerEndpointFactory {
  const url = options.url === undefined ? undefined : sameOriginUrl(options.url);
  const label = url ?? BUNDLED_WORKER_LABEL;
  return {
    url: label,
    buildId: WORKER_BUILD_ID,
    maxWorkers: workerCount(options.count),
    create(onMessage, onError): WorkerEndpoint {
      const worker = url === undefined ? startBundledWorker() : new Worker(url, { type: 'module', name: 'vibeglobe' });
      return connect(worker, label, onMessage, onError);
    },
    inline(): Promise<TaskTable> {
      return import('./tasks.js').then((module) => module.TASKS);
    },
    discard: discardOutput,
  };
}
